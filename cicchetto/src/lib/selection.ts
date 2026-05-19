import { createEffect, createSignal, on, untrack } from "solid-js";
import { token } from "./auth";
import { type ChannelKey, channelKey, decodeChannelKey } from "./channelKey";
import { isDocumentVisible } from "./documentVisibility";
import { identityScopedStore } from "./identityScopedStore";
import { clearMentionsForKey } from "./mentions";
import { evictFromMru, pickLiveMru, recordFocus } from "./mru";
import { channelsBySlug, networkBySlug, networks } from "./networks";
import { queryWindowsByNetwork } from "./queryWindows";
import { setReadCursor } from "./readCursor";
import { loadInitialScrollback, scrollbackByChannel } from "./scrollback";
import {
  HOME_WINDOW_NAME,
  HOME_WINDOW_SLUG,
  SERVER_WINDOW_NAME,
  type WindowKind,
} from "./windowKinds";

// Per-channel selection store: which channel is currently focused +
// per-channel unread counters. Module-singleton signal store mirroring
// `auth.ts` / `socket.ts` / `scrollback.ts`.
//
// Lifted out of the original `networks.ts` god-module per A4. Owns:
//   * `selectedChannel` — the (slug, name, kind) tuple of the focused pane.
//   * `unreadCounts` — per-ChannelKey count of WS-received messages
//     while that channel was NOT selected. Cleared when a channel
//     becomes selected.
//   * `bumpUnread(key)` — cross-module ingestion verb consumed by
//     `subscribe.ts`'s WS event handler when a message arrives on a
//     non-selected channel.
//   * Selection-change effect: clears unread for the newly-selected
//     channel AND fires `scrollback.loadInitialScrollback` to backfill
//     history (the load-once gate lives in scrollback.ts).
//
// Identity-scoped via identityScopedStore (dup-A3 close): four resets
// registered, one per signal. The two business createEffects (selection
// transition cursor-set + isDocumentVisible visibility transitions)
// stay inline — orthogonal to identity rotation.
//
// C4.0: `SelectedChannel` gains a `kind: WindowKind` discriminator,
// replacing the band-aid `channelName !== ":server"` literal used in
// Shell.tsx's TopicBar guard (Hotfix #2, 50a3d88). The TopicBar guard
// now reads `sel().kind === "channel"` — directly asserts spec #20.
// Every setSelectedChannel call site passes `kind` explicitly; no
// defaults.
//
// C7.5: msg-vs-events badge split. Per-window unread state is split into
// two independent counters:
//   * `messagesUnread` — bumped only on PRIVMSG / NOTICE / ACTION
//     (content kinds). Bold/prominent badge in Sidebar + BottomBar.
//   * `eventsUnread` — bumped only on JOIN / PART / QUIT / MODE / NICK /
//     TOPIC (presence kinds). Dimmer indicator.
// Both reset to zero when the window is focused (same as unreadCounts).
// `bumpUnread` is kept for the mention-count side-effect path in
// subscribe.ts that still needs the aggregate count for bumpMention.
// `bumpMessageUnread` and `bumpEventUnread` are the new routed verbs.

export type SelectedChannel = {
  networkSlug: string;
  channelName: string;
  kind: WindowKind;
} | null;

const exports = identityScopedStore((onIdentityChange) => {
  const [unreadCounts, setUnreadCounts] = createSignal<Record<ChannelKey, number>>({});
  const [messagesUnread, setMessagesUnread] = createSignal<Record<ChannelKey, number>>({});
  const [eventsUnread, setEventsUnread] = createSignal<Record<ChannelKey, number>>({});
  const [selectedChannel, setSelectedChannelRaw] = createSignal<SelectedChannel>(null);

  onIdentityChange(() => setUnreadCounts({}));
  onIdentityChange(() => setMessagesUnread({}));
  onIdentityChange(() => setEventsUnread({}));
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
  // consolidated into clearBadgesForWindow (gated by the visibility +
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

  const bumpUnread = (key: ChannelKey) => {
    setUnreadCounts((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  };

  // C7.5: content kinds bump messagesUnread.
  const bumpMessageUnread = (key: ChannelKey) => {
    setMessagesUnread((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  };

  // C7.5: presence kinds bump eventsUnread.
  const bumpEventUnread = (key: ChannelKey) => {
    setEventsUnread((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  };

  // Shared cursor-set helper used by both the cicchetto-leave arm
  // (selectedChannel transitions away from a window) and the browser-blur
  // arm (the focused window's browser tab loses focus). Both arms have
  // identical semantics: the operator settled here, then moved on; record
  // the last visible row's id as the cursor.
  //
  // POSTs the current scrollback tail's `id` to the server's
  // `Grappa.ReadCursor.set/4`. Last-write-wins; the verb absorbs
  // duplicates and out-of-order delivery from rapid focus thrashing.
  // Token guard: if the bearer somehow vanished mid-effect (logout race),
  // skip the POST — the identity-rotation cleanup will reset the signal
  // map anyway.
  const setCursorForWindow = (networkSlug: string, channelName: string): void => {
    const k = channelKey(networkSlug, channelName);
    const msgs = scrollbackByChannel()[k];
    if (!msgs || msgs.length === 0) return;
    const last = msgs[msgs.length - 1];
    if (last === undefined) return;
    const bearer = untrack(token);
    if (!bearer) return;
    void setReadCursor(bearer, networkSlug, channelName, last.id);
  };

  // Shared badge-clear helper used by both the cicchetto-select arm
  // (focus arrives via selection change) and the browser-focus-regain arm
  // (focus arrives via visibility transition). Same semantic: "user is now
  // actively reading this window; nothing should be unread." Wipes all
  // four badge stores for the (slug, channel) pair.
  //
  // UX-5 bucket BU (2026-05-19): mentionCounts joined the unified clear.
  // Prior shape had `mentions.ts`'s own `on(selectedChannel)` effect doing
  // the mention clear — but that arm did NOT fire on visibility-regain,
  // leaving the red badge stale after blur-then-focus on the selected
  // window. Now ALL FOUR sinks derive from the same "is operator reading?"
  // gate (selected AND tab visible+focused).
  const clearBadgesForWindow = (networkSlug: string, channelName: string): void => {
    const key = channelKey(networkSlug, channelName);
    setUnreadCounts((prev) => {
      if (!(key in prev) || prev[key] === 0) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
    setMessagesUnread((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
    setEventsUnread((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
    clearMentionsForKey(key);
  };

  createEffect(
    on(selectedChannel, (sel, prev) => {
      // Cursor-set on focus-leave. When the user moves focus AWAY from
      // a window (or to null), POST the last visible row's id as the
      // cursor for THAT window. Next visit shows no marker (everything
      // seen up to that point); subsequent inbound msgs sit above the
      // cursor → marker reappears on next visit.
      //
      // Why on leave rather than on focus or on every WS append:
      //   * On focus: would hide the marker before the user could
      //     read past it.
      //   * On WS append while focused: same problem one tick later.
      //   * On leave: the user has demonstrably moved on; "I've seen
      //     what was here" is the right semantic.
      //
      // Guards:
      //   * `prev === undefined` → initial run on mount; nothing to
      //     leave from.
      //   * `prev === null` → previous selection was already null;
      //     nothing to leave from (cold start, post-logout).
      //   * `prev.key === sel?.key` → re-selecting the same window
      //     (e.g. component re-render fires the effect with identical
      //     value); not a leave.
      //   * No msgs in prev's scrollback → setCursorForWindow no-ops
      //     internally.
      if (prev !== undefined && prev !== null) {
        const prevKey = channelKey(prev.networkSlug, prev.channelName);
        const selKey = sel ? channelKey(sel.networkSlug, sel.channelName) : null;
        if (prevKey !== selKey) {
          setCursorForWindow(prev.networkSlug, prev.channelName);
        }
      }

      if (!sel) return;
      // C7.5: clear all three badge stores on focus.
      clearBadgesForWindow(sel.networkSlug, sel.channelName);
      // UX-4 bucket E: record channel/query focus into MRU. Only
      // channel + query enter MRU — home is the final fallback target
      // (recording it would make it the default next-pick and short-
      // circuit the chain). Server windows are the second-tier fallback
      // (skipped for the same reason). list / mentions are ephemeral
      // and shouldn't take focus when an unrelated window closes.
      if (sel.kind === "channel" || sel.kind === "query") {
        recordFocus(channelKey(sel.networkSlug, sel.channelName));
      }
      // Fire-and-forget: the verb guards itself via scrollback's
      // loadedChannels Set.
      void loadInitialScrollback(sel.networkSlug, sel.channelName);
    }),
  );

  // Browser visibility arm — symmetric pair of transitions on the same
  // signal:
  //
  //   TRUE → FALSE (browser blur): set the selected window's cursor to
  //     the current scrollback tail. Same semantic as a cicchetto-leave;
  //     the user has demonstrably moved on. Without this, returning to
  //     the browser would show no marker for msgs that landed while the
  //     user was away (subscribe.ts skips the live cursor-set on hidden
  //     tabs, so msgs accumulate above the stale cursor — the cursor
  //     must be set at the moment of leave so the marker surfaces at
  //     the right boundary).
  //
  //   FALSE → TRUE (browser focus regain): clear the selected window's
  //     badges. Same semantic as cicchetto-select; the user is now reading
  //     and badges sitting on the focused window are immediately stale.
  //     Without this, badges accumulated by subscribe.ts during the blur
  //     period would persist until the user navigated away and back.
  //
  // Guards (both arms):
  //   * `prev === undefined` → initial run on module load; not a transition.
  //   * No selected window → nothing to act on.
  //   * setCursorForWindow / clearBadgesForWindow no-op internally on
  //     empty scrollback / absent badges.
  createEffect(
    on(isDocumentVisible, (visible, prev) => {
      if (prev === undefined) return;
      const sel = untrack(selectedChannel);
      if (!sel) return;
      if (prev === true && visible === false) {
        setCursorForWindow(sel.networkSlug, sel.channelName);
      } else if (prev === false && visible === true) {
        clearBadgesForWindow(sel.networkSlug, sel.channelName);
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
        return list.some((c) => c.name === name);
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
    selectedChannel,
    setSelectedChannel,
    bumpUnread,
    bumpMessageUnread,
    bumpEventUnread,
  };
});

export const unreadCounts = exports.unreadCounts;
export const messagesUnread = exports.messagesUnread;
export const eventsUnread = exports.eventsUnread;
export const selectedChannel = exports.selectedChannel;
export const setSelectedChannel = exports.setSelectedChannel;
export const bumpUnread = exports.bumpUnread;
export const bumpMessageUnread = exports.bumpMessageUnread;
export const bumpEventUnread = exports.bumpEventUnread;
