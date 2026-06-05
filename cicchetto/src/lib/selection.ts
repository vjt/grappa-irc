import { createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import { isContentKind } from "./api";
import { token } from "./auth";
import { type ChannelKey, channelKey, decodeChannelKey } from "./channelKey";
import { isDocumentVisible } from "./documentVisibility";
import { identityScopedStore } from "./identityScopedStore";
import { saveLastFocused } from "./lastFocusedChannel";
import { clearMentionsForKey } from "./mentions";
import { evictFromMru, pickLiveMru, recordFocus } from "./mru";
import { channelsBySlug, networkBySlug, networks, user } from "./networks";
import { queryWindowsByNetwork } from "./queryWindows";
import { getReadCursor, readCursors, setReadCursor } from "./readCursor";
import { loadInitialScrollback, scrollbackByChannel } from "./scrollback";
import {
  HOME_WINDOW_NAME,
  HOME_WINDOW_SLUG,
  SERVER_WINDOW_NAME,
  type WindowKind,
} from "./windowKinds";
import { windowIsPresent } from "./windowState";

// Per-channel selection store: which channel is currently focused +
// per-channel unread counters. Module-singleton signal store mirroring
// `auth.ts` / `socket.ts` / `scrollback.ts`.
//
// Lifted out of the original `networks.ts` god-module per A4. Owns:
//   * `selectedChannel` — the (slug, name, kind) tuple of the focused pane.
//   * `serverSeedCounts` — the per-channel `{messages, events}` count
//     pair seeded from the server's per-channel join reply
//     (`unread_count`) and `/me` envelope (`unread_counts`). Used as a
//     fallback when local scrollback hasn't been hydrated for a
//     channel (cold start or never-opened channel).
//   * `unreadCounts` / `messagesUnread` / `eventsUnread` — DERIVED memos
//     over `(scrollbackByChannel, readCursors, serverSeedCounts)`. For
//     each known channel, the memo counts local rows with `id > cursor`
//     split by content vs presence kind. When local scrollback is empty
//     for a channel, falls back to `serverSeedCounts[key]`.
//   * Selection-change effect: fires `scrollback.loadInitialScrollback`
//     to backfill history (the load-once gate lives in scrollback.ts)
//     + clears mention counts for the focused window. As the cursor
//     advances (via scroll-settle, focus-leave, browser-blur, send, and
//     fresh-channel load-baseline in scrollback.ts) the derived counts
//     fall on their own. The ONE count the cursor can't drop on its own
//     is the focused-AND-visible window's: its cursor only moves on the
//     NEXT settle, so `perChannelUnread` zeros that window's
//     `{messages, events}` as a final overwrite (RC1, decouple-unread-
//     badge) keyed on `selectedChannel` + `isDocumentVisible` — a
//     backgrounded-but-selected tab keeps accruing.
//
// 2026-06-01 (unread-badges-from-cursor cluster, bucket B2): the four
// increment stores (`unreadCounts`, `messagesUnread`, `eventsUnread`,
// `mentionCounts`) used to drift any time the bump-on-receive
// predicate diverged from the in-pane cursor-vs-tail predicate. Two
// bugs surfaced from this:
//   1. Cross-session own-message bump — sending on phone bumped the
//      laptop badge because the WS broadcast filter caught own
//      presence + own server-numeric echoes but NOT own content.
//   2. Marker-stuck-on-send-in-focused — sending in the focused window
//      didn't reset the in-pane `── XX unread ──` marker because the
//      cursor only advanced on focus-leave + browser-blur.
// Server-derived counts collapse both structurally: cursor advances on
// send (bucket D), broadcasts `read_cursor_set`, both devices' derived
// counts drop in unison. `mentionCounts` stays bump-based — it's a
// body-text predicate, not pure count-after-cursor — but the bump
// path now gates on own-sender too (`mentions.ts`).
//
// Identity-scoped via identityScopedStore: two resets registered — one
// for `serverSeedCounts`, one for `selectedChannel`. The derived memos
// auto-reset when their upstream signals (scrollback, cursors, seeds)
// reset on identity transition. Selection-effect arms (selection
// transition, visibility transition, network connection-state, close-
// watcher) stay inline — orthogonal to identity rotation.

export type SelectedChannel = {
  networkSlug: string;
  channelName: string;
  kind: WindowKind;
} | null;

/**
 * Per-channel seed count pair: `messages` (content kinds) + `events`
 * (presence kinds). Hydrated from the server's join reply (`unread_count`
 * — total, not split) and the `/me` envelope (`unread_counts` — split).
 *
 * `unread_count` from the per-channel join reply is summed against
 * `messages` for simplicity: the join-time seed is a one-shot fallback
 * value, and the memo prefers local scrollback the moment any row for
 * that channel lands. The split-by-kind precision comes from `/me`
 * (bucket C) — until that lands, the join-reply seed treats every
 * unread row as a "messages" count which slightly overcounts the bold
 * badge on cold-start for never-opened channels. Acceptable interim
 * because cic loads scrollback the moment the operator focuses a
 * channel, at which point the local-derived count takes over.
 */
export type ServerSeedCount = { messages: number; events: number };

const exports = identityScopedStore((onIdentityChange) => {
  const [serverSeedCounts, setServerSeedCountsRaw] = createSignal<
    Record<ChannelKey, ServerSeedCount>
  >({});
  const [selectedChannel, setSelectedChannelRaw] = createSignal<SelectedChannel>(null);

  onIdentityChange(() => setServerSeedCountsRaw({}));
  onIdentityChange(() => setSelectedChannelRaw(null));

  // UX-5 bucket BU (2026-05-19): idempotent setter. Re-clicking an
  // already-active sidebar row passed a new object literal to the raw
  // setter, which made Solid's `===` equality compare by identity and
  // re-fired the on(selectedChannel) consumer in `mentions.ts` (a
  // standalone `on(selectedChannel)` effect that cleared mentionCounts
  // on every fire). The leave-arm below + ScrollbackPane's on(key, …)
  // already guarded on string-key equality and were safe; only the
  // mentions arm crossed the invariant. Operator perception: clicking
  // the open channel "did something" (red badge cleared without the
  // operator having read anything new). Post-BU the mentions clear is
  // consolidated into the focus arm (gated by the visibility +
  // selection arms in this file), AND the setter short-circuits at
  // its boundary so no observer sees a non-transition.
  //
  // Exact-tuple equality: any change in slug, name, or kind is a real
  // transition. null vs non-null is also a transition (covers logout +
  // identity reset paths).
  const setSelectedChannel = (next: SelectedChannel): void => {
    const cur = untrack(selectedChannel);
    if (cur === null && next === null) return;
    if (
      cur !== null &&
      next !== null &&
      cur.networkSlug === next.networkSlug &&
      cur.channelName === next.channelName &&
      cur.kind === next.kind
    ) {
      return;
    }
    setSelectedChannelRaw(next);
  };

  /**
   * Seeds the per-channel `{messages, events}` count. Called from
   * `subscribe.ts`'s `applyJoinReply` arm with `{messages:
   * unread_count, events: 0}` (the join reply doesn't split), and
   * from `readCursor.ts`'s `applyMeEnvelope` arm with the split shape
   * directly (bucket C). Replaces the existing key; the memo derives
   * from this map only when local scrollback is absent for the key.
   */
  const setServerSeedCount = (key: ChannelKey, seed: ServerSeedCount): void => {
    setServerSeedCountsRaw((prev) => {
      const existing = prev[key];
      if (existing && existing.messages === seed.messages && existing.events === seed.events) {
        return prev;
      }
      return { ...prev, [key]: seed };
    });
  };

  /**
   * Bulk-hydrate the seed map from the `/me` envelope's
   * `unread_counts` nested map (`%{slug => %{chan => {messages,
   * events}}}`). Replaces the entire map — same cold-load semantic as
   * `applyMeEnvelope` in `readCursor.ts`. Bucket C wires the call
   * site.
   */
  const applySeedEnvelope = (envelope: Record<string, Record<string, ServerSeedCount>>): void => {
    const next: Record<ChannelKey, ServerSeedCount> = {};
    for (const [slug, perChannel] of Object.entries(envelope)) {
      for (const [chan, counts] of Object.entries(perChannel)) {
        if (counts && typeof counts.messages === "number" && typeof counts.events === "number") {
          next[channelKey(slug, chan)] = counts;
        }
      }
    }
    setServerSeedCountsRaw(next);
  };

  // Bucket C (2026-06-01) — wire `/me` `unread_counts` envelope into
  // `serverSeedCounts`. The hand-off lives here (not in networks.ts's
  // `/me` resource fetcher) because networks.ts ↔ selection.ts is a
  // circular import pair: a top-level `import { applySeedEnvelope }
  // from "./selection"` in networks.ts captures `undefined` under
  // vitest re-entry (selection.ts is mid-eval when networks.ts pulls
  // the binding). Reading `user()` reactively from this side is the
  // one-way arrow that avoids the cycle — selection.ts already imports
  // `networks`/`channelsBySlug`/`networkBySlug`, so adding `user` to
  // the same import doesn't grow the surface.
  //
  // The effect fires on every `user()` change: cold-load login, token
  // rotation, refetch after admin-mid-session demote. On the null
  // arms (logout, pre-login resource still resolving) the seed map
  // resets via the identity-rotation `onIdentityChange` arm above; no
  // explicit clear needed here.
  createEffect(
    on(user, (m) => {
      if (m == null) return;
      applySeedEnvelope(m.unread_counts ?? {});
    }),
  );

  // ---------------------------------------------------------------
  // Derived memos: messages/events/total unread per channel.
  //
  // For each known channel (union of `serverSeedCounts` keys + any
  // `scrollbackByChannel` keys), compute `{messages, events}` from
  //   * local scrollback rows with id > cursor split by isContentKind,
  //   * OR the seed value when local scrollback is empty for the key.
  //
  // The memos return plain `Record<ChannelKey, number>` to keep the
  // export shape byte-identical to the pre-refactor signals — every
  // consumer (Sidebar, BottomBar, Shell, focus-rule) continues to read
  // `messagesUnread()[key] ?? 0` without changes.
  // ---------------------------------------------------------------
  type Computed = { messages: number; events: number };

  const perChannelUnread = createMemo((): Record<ChannelKey, Computed> => {
    const sb = scrollbackByChannel();
    const cursors = readCursors();
    const seeds = serverSeedCounts();

    const result: Record<ChannelKey, Computed> = {};

    // Seed-only channels — the cold-start path where the operator
    // hasn't opened the channel yet so local scrollback is empty.
    // Keep the seed as the displayed count; once they focus and we
    // hydrate scrollback, the local-derived branch below takes over
    // automatically (and the cursor write that follows drops the
    // count to zero, dropping the key from the displayed map).
    for (const [rawKey, seed] of Object.entries(seeds)) {
      const key = rawKey as ChannelKey;
      result[key] = { messages: seed.messages, events: seed.events };
    }

    // Locally-hydrated channels — count rows past the cursor by kind.
    // Override any seed entry: local truth wins because the seed is
    // a sync-time snapshot that may be stale by the time we render.
    for (const [rawKey, rows] of Object.entries(sb)) {
      const key = rawKey as ChannelKey;
      const decoded = decodeChannelKey(key);
      if (decoded === null) continue;
      const cursorMapKey = `${decoded.slug} ${decoded.name}`;
      const cursor = cursors[cursorMapKey] ?? 0;

      let msgs = 0;
      let evts = 0;
      for (const row of rows) {
        if (row.id <= cursor) continue;
        if (isContentKind(row.kind)) msgs++;
        else evts++;
      }
      result[key] = { messages: msgs, events: evts };
    }

    // 2026-06-02 — focused-window badge suppression. The operator is
    // looking at this window (and the browser tab is visible), so it has
    // nothing unread TO THEM right now: zero its count. Derived from
    // selectedChannel + isDocumentVisible — the read cursor is NOT
    // advanced, so the in-pane `── N unread ──` marker survives the
    // select and clears on its own settle events (scroll / defocus /
    // send). Gating on isDocumentVisible keeps a selected-but-backgrounded
    // tab accruing its badge so a returning operator sees activity.
    // Final overwrite so it covers both the seed-only and hydrated
    // branches above. Spec:
    // docs/superpowers/specs/2026-06-02-decouple-unread-badge-design.md
    const focused = selectedChannel();
    if (focused !== null && isDocumentVisible()) {
      result[channelKey(focused.networkSlug, focused.channelName)] = {
        messages: 0,
        events: 0,
      };
    }

    return result;
  });

  const messagesUnread = createMemo((): Record<ChannelKey, number> => {
    const out: Record<ChannelKey, number> = {};
    for (const [rawKey, c] of Object.entries(perChannelUnread())) {
      const key = rawKey as ChannelKey;
      if (c.messages > 0) out[key] = c.messages;
    }
    return out;
  });

  const eventsUnread = createMemo((): Record<ChannelKey, number> => {
    const out: Record<ChannelKey, number> = {};
    for (const [rawKey, c] of Object.entries(perChannelUnread())) {
      const key = rawKey as ChannelKey;
      if (c.events > 0) out[key] = c.events;
    }
    return out;
  });

  const unreadCounts = createMemo((): Record<ChannelKey, number> => {
    const out: Record<ChannelKey, number> = {};
    for (const [rawKey, c] of Object.entries(perChannelUnread())) {
      const key = rawKey as ChannelKey;
      const total = c.messages + c.events;
      if (total > 0) out[key] = total;
    }
    return out;
  });

  // UX-8 (b): scroll-settle cursor update — forward-only gate.
  // Reads the current cursor for (slug, name) via getReadCursor; POSTs
  // only when `candidateId` strictly exceeds it. Today's cursor is
  // monotonic (focus-leave + browser-blur always write the tail id);
  // this helper preserves that invariant when scroll-settle becomes
  // the third trigger. Server (Grappa.ReadCursor.set/4) supports
  // backward moves via last-write-wins, but cic does not exercise
  // them — kept as a single-source guard at the client boundary.
  //
  // Token guard: identity-rotation can null the bearer mid-effect.
  const setCursorIfAdvances = (
    networkSlug: string,
    channelName: string,
    candidateId: number,
  ): void => {
    const current = getReadCursor(networkSlug, channelName);
    if (current !== null && candidateId <= current) return;
    const bearer = untrack(token);
    if (!bearer) return;
    void setReadCursor(bearer, networkSlug, channelName, candidateId);
  };

  // Mention-only focus clear — counterpart to the deleted
  // `clearBadgesForWindow`. The three unread memos derive from
  // `(scrollbackByChannel, readCursors, serverSeedCounts)` and drop
  // automatically as the cursor advances, so the focus arm doesn't
  // need to touch them. `mentionCounts` IS body-text-predicate-based
  // (`mentions.ts`) and stays incrementally tracked — clear it
  // explicitly when the operator's eyes land on the window.
  //
  // Fired from both the cicchetto-select arm AND the visibility-regain
  // arm — same "is operator actively reading?" gate, single helper.
  const clearMentionsForFocus = (networkSlug: string, channelName: string): void => {
    clearMentionsForKey(channelKey(networkSlug, channelName));
  };

  createEffect(
    on(selectedChannel, (sel) => {
      // BUGHUNT-2: focus-leave cursor write moved to ScrollbackPane's
      // `on(key, …)` effect + `onCleanup` — the pane owns its DOM
      // geometry and writes the honest `lastFullyVisibleRowId`, not
      // the store-tail. This effect retains the orthogonal arms:
      // mention-clear, MRU-record, scrollback hydrate.

      if (!sel) return;
      clearMentionsForFocus(sel.networkSlug, sel.channelName);
      // UX-4 bucket E: record channel/query focus into MRU. Only
      // channel + query enter MRU — home is the final fallback target
      // (recording it would make it the default next-pick and short-
      // circuit the chain). Server windows are the second-tier fallback
      // (skipped for the same reason). list / mentions are ephemeral
      // and shouldn't take focus when an unrelated window closes.
      if (sel.kind === "channel" || sel.kind === "query") {
        recordFocus(channelKey(sel.networkSlug, sel.channelName));
      }
      // Issue #35 — persist the focused window per identity, so a
      // PWA reload / browser restart lands the operator back on the
      // last viewed channel instead of the cold-load `$home` default.
      // Only restorable kinds (channel / query / server) are saved;
      // `home` is the existing fallback target, `admin` is gated on
      // is_admin (and would redirect home on demote anyway),
      // `mentions` / `list` are ephemeral surfaces.
      const me = untrack(user);
      if (me && (sel.kind === "channel" || sel.kind === "query" || sel.kind === "server")) {
        saveLastFocused(me.id, {
          networkSlug: sel.networkSlug,
          channelName: sel.channelName,
          kind: sel.kind,
        });
      }
      // Fire-and-forget: the verb guards itself via scrollback's
      // loadedChannels Set.
      void loadInitialScrollback(sel.networkSlug, sel.channelName);
    }),
  );

  // Browser visibility arm — focus-regain mention clear only. The
  // TRUE→FALSE (browser blur) cursor-write moved to ScrollbackPane's
  // own visibility effect (BUGHUNT-2) — the pane owns its DOM
  // geometry and writes the honest lastFullyVisibleRowId.
  //
  //   FALSE → TRUE (browser focus regain): clear the selected window's
  //     mention badge. The unread/messages/events memos derive from
  //     cursor + scrollback and drop on their own as the cursor
  //     advances (scroll-settle / focus-leave / send). Mentions need
  //     an explicit clear because they're body-text predicate, not
  //     count-after-cursor.
  //
  // Guards:
  //   * `prev === undefined` → initial run on module load; not a transition.
  //   * No selected window → nothing to act on.
  createEffect(
    on(isDocumentVisible, (visible, prev) => {
      if (prev === undefined) return;
      const sel = untrack(selectedChannel);
      if (!sel) return;
      if (prev === false && visible === true) {
        clearMentionsForFocus(sel.networkSlug, sel.channelName);
      }
    }),
  );

  // UX-4 bucket D — redirect selection to home when a network the
  // user is currently looking at transitions INTO `:parked` or
  // `:failed`. Subscribing here (one place, on `networks()`) means
  // the redirect fires uniformly across:
  //   * Server-window × button (`disconnectNetwork` in windowClose.ts)
  //   * /disconnect typed in the compose box
  //   * Server-side circuit-breaker park (admission control trips)
  //   * Operator `bin/grappa disconnect` admin verb
  // Per CLAUDE.md "Don't duplicate state — derive it": one effect,
  // one transition observer, all triggers route through it.
  //
  // Transition-only: `lastConnectionState` tracks the previous value
  // per network slug so the operator can still navigate BACK to a
  // parked window (to view history) without bouncing back to home.
  // Identity rotation clears the map so a re-login doesn't carry
  // stale state from the previous identity's networks.
  //
  // Home and visitor windows have no network credential so
  // `networkBySlug` returns undefined → no entry in the map → no
  // redirect (correct: home is the redirect TARGET, never the source).
  const lastConnectionState = new Map<string, string>();
  onIdentityChange(() => lastConnectionState.clear());

  createEffect(() => {
    const nets = networks();
    if (!nets) return;
    // Prune entries for slugs no longer in the live list (a DELETE
    // /networks unbinds a slug — without this the Map would carry
    // dead keys for the lifetime of the identity).
    const live = new Set(nets.map((n) => n.slug));
    for (const slug of lastConnectionState.keys()) {
      if (!live.has(slug)) lastConnectionState.delete(slug);
    }
    for (const net of nets) {
      if (net.kind !== "user") continue;
      const prev = lastConnectionState.get(net.slug);
      const curr = net.connection_state;
      lastConnectionState.set(net.slug, curr);
      if (prev === undefined) continue;
      if (curr === prev) continue;
      if (curr !== "parked" && curr !== "failed") continue;
      untrack(() => {
        const sel = selectedChannel();
        if (!sel) return;
        if (sel.networkSlug !== net.slug) return;
        setSelectedChannel({
          networkSlug: HOME_WINDOW_SLUG,
          channelName: HOME_WINDOW_NAME,
          kind: "home",
        });
      });
    }
  });

  // UX-4 bucket E — close-window auto-focus picker.
  //
  // Fires when the currently-selected window vanishes from its live
  // store (channelsBySlug drops the channel after a PART/kick/server-
  // side close; queryWindowsByNetwork drops the query after a
  // close_query_window broadcast). The picker shifts focus to:
  //
  //   1. The most-recently-viewed live channel/query window (MRU).
  //   2. The closed window's network server window, IF that network
  //      is still :connected (parked/failed networks would re-trigger
  //      bucket D's home-redirect — pre-empt the fight by routing
  //      straight to home).
  //   3. Home as the universal last resort.
  //
  // One reactive effect covers ALL close triggers — × button, /part
  // typed in compose, server-side kick, /disconnect cascade, query
  // close_query_window. Per CLAUDE.md "Don't duplicate state — derive
  // it": one observer, all triggers funnel through it.
  //
  // The just-closed key is evicted from MRU BEFORE the picker runs —
  // per `feedback_target_window_ux_rule` ("SOURCE state must clear at
  // switch BEFORE TARGET decisions"). Without eviction, pickLiveMru
  // would see the just-closed window at MRU head and short-circuit to
  // it (which by definition is no longer live, but the predicate would
  // need to know that — eviction is simpler than encoding the
  // exclude in the predicate).
  //
  // Race with bucket D: when /disconnect parks a network, the server
  // emits both per-channel PART (closes channels → bucket E fires) AND
  // a network-state flip to :parked (bucket D's home-redirect fires).
  // Both terminate at home; no infinite loop. Bucket E's server-window
  // fallback guard (`connection_state !== "connected"`) ensures bucket
  // E doesn't pick the just-parked network's server window only to
  // have bucket D bounce it to home on the next tick.
  //
  // Ordering note: if channelsBySlug refetches BEFORE the networks()
  // flip lands, bucket E sees `connection_state === "connected"` and
  // picks the parking network's server window momentarily; then bucket
  // D fires on the parked-transition and bounces to home. A brief
  // server-pane flash is visible. If networks() flips first, bucket D
  // fires (sel matches the parking net) → home; bucket E then early-
  // returns because sel.kind === "home". Both paths converge at home;
  // the flash is the cost of decoupling the two effects via the
  // signal-driven `connection_state` guard rather than peeking at
  // bucket D's `lastConnectionState` Map.
  //
  // Transition-only firing: the picker MUST NOT fire just because the
  // operator selected a window that isn't yet in channelsBySlug (e.g.
  // optimistic pending channels via the windowState branch). The effect
  // tracks `wasLive`: the previous-run result of the stillLive check
  // for the current selection key. Only when wasLive=true AND now
  // stillLive=false does the picker fire — that's the "window vanished"
  // transition. A fresh selection that starts not-live keeps wasLive
  // at false; the picker waits until the channel arrives in
  // channelsBySlug (then wasLive=true) before becoming armed.
  const lastSeenLive = new Map<ChannelKey, boolean>();
  onIdentityChange(() => lastSeenLive.clear());

  createEffect(() => {
    const sel = selectedChannel();
    if (!sel) return;
    if (sel.kind !== "channel" && sel.kind !== "query") return;

    const cbs = channelsBySlug() ?? {};
    const qwbn = queryWindowsByNetwork();
    const selKey = channelKey(sel.networkSlug, sel.channelName);

    const stillLive = (() => {
      if (sel.kind === "channel") {
        const list = cbs[sel.networkSlug] ?? [];
        // Decode the canonical name via selKey rather than reusing
        // sel.channelName raw — bucket A canonicalises channel names
        // end-to-end, but a stray non-canonical setSelectedChannel
        // would otherwise stale-fire this check. Defensive parity with
        // the symmetric MRU lookup at the picker step (decoded from
        // a canonicalised ChannelKey).
        const decoded = decodeChannelKey(selKey);
        const name = decoded?.name ?? sel.channelName;
        if (list.some((c) => c.name === name)) return true;
        // UX-7-E: non-joined window states (pending|failed|kicked)
        // keep the row in the sidebar via pseudoChannelsForNetwork.
        // Selection must mirror that membership predicate so peer KICK
        // or JOIN-failed doesn't yank focus away before the operator
        // sees the reason / kick metadata in the (greyed) compose box.
        return windowIsPresent(selKey);
      }
      const net = networkBySlug(sel.networkSlug);
      if (!net) return false;
      const queries = qwbn[net.id] ?? [];
      const lower = sel.channelName.toLowerCase();
      return queries.some((q) => q.targetNick.toLowerCase() === lower);
    })();

    const wasLive = lastSeenLive.get(selKey) ?? false;
    lastSeenLive.set(selKey, stillLive);

    if (stillLive) return;
    if (!wasLive) return;

    // Selection's window WAS live and now is not — transition fired.
    // Evict from MRU and pick next via fallback chain.
    untrack(() => {
      evictFromMru(selKey);
      lastSeenLive.delete(selKey);

      const isLiveKey = (key: ChannelKey): boolean => {
        const decoded = decodeChannelKey(key);
        if (decoded === null) return false;
        const { slug, name } = decoded;
        const chans = cbs[slug] ?? [];
        if (chans.some((c) => c.name === name)) return true;
        const net = networkBySlug(slug);
        if (net) {
          const qs = qwbn[net.id] ?? [];
          const lower = name.toLowerCase();
          if (qs.some((q) => q.targetNick.toLowerCase() === lower)) return true;
        }
        return false;
      };

      const next = pickLiveMru(selKey, isLiveKey);
      if (next !== null) {
        const decoded = decodeChannelKey(next);
        if (decoded !== null) {
          const { slug, name } = decoded;
          const chans = cbs[slug] ?? [];
          if (chans.some((c) => c.name === name)) {
            setSelectedChannel({ networkSlug: slug, channelName: name, kind: "channel" });
            return;
          }
          const net = networkBySlug(slug);
          if (net) {
            const qs = qwbn[net.id] ?? [];
            const lower = name.toLowerCase();
            const match = qs.find((q) => q.targetNick.toLowerCase() === lower);
            if (match !== undefined) {
              setSelectedChannel({
                networkSlug: slug,
                channelName: match.targetNick,
                kind: "query",
              });
              return;
            }
          }
        }
      }

      // No live MRU candidate. Fall back to the closed window's network
      // server window IF still connected. Visitor networks have no
      // connection_state field — always assume connected (visitor close
      // paths terminate the whole session via quitAll; bucket E never
      // sees a "visitor server closed" trigger in isolation).
      const closedNet = networkBySlug(sel.networkSlug);
      if (closedNet !== undefined) {
        const isConnected =
          closedNet.kind === "visitor" || closedNet.connection_state === "connected";
        if (isConnected) {
          setSelectedChannel({
            networkSlug: sel.networkSlug,
            channelName: SERVER_WINDOW_NAME,
            kind: "server",
          });
          return;
        }
      }

      // Last resort: home. Always present per bucket B.
      setSelectedChannel({
        networkSlug: HOME_WINDOW_SLUG,
        channelName: HOME_WINDOW_NAME,
        kind: "home",
      });
    });
  });

  return {
    unreadCounts,
    messagesUnread,
    eventsUnread,
    serverSeedCounts,
    selectedChannel,
    setSelectedChannel,
    setServerSeedCount,
    applySeedEnvelope,
    setCursorIfAdvances,
  };
});

export const unreadCounts = exports.unreadCounts;
export const messagesUnread = exports.messagesUnread;
export const eventsUnread = exports.eventsUnread;
export const serverSeedCounts = exports.serverSeedCounts;
export const selectedChannel = exports.selectedChannel;
export const setSelectedChannel = exports.setSelectedChannel;
export const setServerSeedCount = exports.setServerSeedCount;
export const applySeedEnvelope = exports.applySeedEnvelope;
export const setCursorIfAdvances = exports.setCursorIfAdvances;
