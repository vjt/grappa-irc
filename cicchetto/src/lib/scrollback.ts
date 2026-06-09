import { createSignal } from "solid-js";
import {
  sendMessage as apiSendMessage,
  listMessages,
  listMessagesAfter,
  type ScrollbackMessage,
} from "./api";
import { token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import { getReadCursor, setReadCursor } from "./readCursor";
import { getResumeCursor, recordSeen } from "./reconnectBackfill";

// Per-channel scrollback store: the source of truth for messages
// rendered in `ScrollbackPane`. Module-singleton signal store mirroring
// `auth.ts` / `socket.ts`; one fine-grained subscription per consumer,
// no provider boilerplate.
//
// Lifted out of the original `networks.ts` god-module per A4. Owns:
//   * `scrollbackByChannel` — the signal map keyed on `ChannelKey`.
//   * `loadedChannels` — a Set guarding the load-once REST gate.
//   * Verbs `loadInitialScrollback`, `loadMore`, `sendMessage`.
//   * The cross-module ingestion verb `appendToScrollback` consumed by
//     `subscribe.ts` (the WS event handler) — public so the producer
//     can mutate the signal without re-importing the setter.
//
// Scrollback ordering: stored ASCENDING by `server_time` so `<For>`
// keys (message id) stay stable and render is natural top-to-bottom.
// REST returns DESC; we reverse on ingestion. WS appends arrive
// newest-last and append to the tail. Dedupe by `id` because the REST
// initial-load and the WS broadcast for a recently-sent message can
// overlap in a small race window — the same row would otherwise
// appear twice. `id` is monotonic per the schema's auto-increment column.
//
// Identity-scoped state via identityScopedStore (dup-A3 close): four
// resets registered (3 Set.clear() + the signal flush). The factory
// preserves the A1 invariant — registration runs before any verb fires,
// so a logout/rotation between `loadInitialScrollback` start and finish
// always wins the race.
//
// ---------------------------------------------------------------------------
// CP14 B3 — DM history is now bidirectional server-side.
// ---------------------------------------------------------------------------
//
// Pre-CP14-B3 this module carried `shouldKeepInOwnNickQuery` /
// `ownNickIfOwnNickQuery` to filter the own-nick query window down to
// only self-msgs. That was a band-aid for the broken DM fetch
// semantics: the server persisted inbound DMs on `channel = own_nick`,
// so `loadInitialScrollback(own_nick)` would dump every inbound DM,
// every NickServ NOTICE, and every server-origin notice into the own-
// nick window. The client kept only self-msgs to hide the noise.
//
// CP14 B3 ships `:dm_with` on the server-side `messages` schema.
// `Scrollback.fetch/5` for a peer-shaped channel name now returns
// inbound (channel = own_nick AND dm_with = peer) UNION outbound
// (channel = peer) — server is now authoritative; cic doesn't filter.
// Service NOTICEs land at $server (the dedicated server-messages
// window) per existing routing, so the noise that motivated the
// filter is already absent from the DM fetch surface.

const exports = identityScopedStore((onIdentityChange) => {
  const loadedChannels = new Set<ChannelKey>();
  // CP14 B2: per-key in-flight Set guards against scroll-burst fan-out
  // (the user flicks the scrollbar; the browser fires `scroll` 5+ times
  // in a frame and the onScroll handler would otherwise dispatch 5+
  // identical REST requests). While a key is in `loadMoreInFlight`, a
  // second `loadMore` call for the same key is a no-op. Released in
  // `finally` so a transient REST error doesn't permanently lock out
  // future retries — only the exhausted-latch is forward-only.
  const loadMoreInFlight = new Set<ChannelKey>();
  // CP14 B2: end-of-history latch. When `loadMore` returns 0 fresh
  // rows, the channel is exhausted — the server has no rows older than
  // our current oldest. Subsequent calls are no-ops. Latch is forward-
  // only; cleared on identity transition alongside `loadedChannels`.
  const loadMoreExhausted = new Set<ChannelKey>();
  const [scrollbackByChannel, setScrollbackByChannel] = createSignal<
    Record<ChannelKey, ScrollbackMessage[]>
  >({});

  // Send-relatch (2026-06-09): the channel-key of THIS device's most
  // recent own send. `sendMessage` writes it; ScrollbackPane reads it to
  // hide the frozen unread-marker on a focused send ("marker showing +
  // you send → hide it"). It carries the send across the module boundary
  // — nothing else marks "this advance was a send, not a passive cursor
  // move", which is why scroll-settle / cross-device stay frozen.
  //
  // `equals: false` — this is an EVENT signal, not a state cell. Two
  // sends to the SAME channel write the same key string; with the default
  // Object.is dedup the second set would be a no-op and the marker
  // wouldn't re-hide. Real case: send in #foo (hides) → switch away →
  // peer messages #foo → switch back (marker re-shows) → reply in #foo
  // (same key) → must hide again. Every send must notify.
  const [lastOwnSend, setLastOwnSend] = createSignal<ChannelKey | null>(null, {
    equals: false,
  });

  // Identity-transition cleanup. Five registered resets fired by the
  // factory's createEffect(on(token, ...)) — three Set.clear() + two
  // signal flushes. Order matches the pre-A3 inline shape.
  onIdentityChange(() => loadedChannels.clear());
  onIdentityChange(() => loadMoreInFlight.clear());
  onIdentityChange(() => loadMoreExhausted.clear());
  onIdentityChange(() => setScrollbackByChannel({}));
  onIdentityChange(() => setLastOwnSend(null));

  // Insert an incoming message into the per-channel ascending list,
  // deduping by id. REST + WS can overlap: the row inserted by POST
  // arrives both as the HTTP 201 body (we ignore that body) and as a
  // WS push from the per-channel PubSub broadcast. Both paths route
  // through here; whichever lands first wins, the second is dropped.
  const appendToScrollback = (key: ChannelKey, msg: ScrollbackMessage) => {
    setScrollbackByChannel((prev) => {
      const existing = prev[key];
      if (existing?.some((m) => m.id === msg.id)) return prev;
      const next = existing ? [...existing, msg] : [msg];
      return { ...prev, [key]: next };
    });
  };

  // Merge a freshly-fetched REST page into the per-channel list. Server
  // returns DESC; we reverse to ASC then dedupe + sort. Used by both
  // initial-load (replaces the empty seed) and load-more (prepends
  // older history to the head).
  //
  // Codebase audit cic M3 — secondary sort by `id` ASC. Server-side
  // `Scrollback.fetch/5` orders by `[desc: m.server_time, desc: m.id]`,
  // so client mirrors with `[asc: server_time, asc: id]`. Without the
  // tie-breaker, same-millisecond message bursts from the REST DESC page
  // could land in arbitrary order vs the WS append stream — visible
  // reorder of bursty traffic on reload. `id` is monotonic per
  // sqlite's auto-increment column.
  const mergeIntoScrollback = (key: ChannelKey, page: ScrollbackMessage[]) => {
    setScrollbackByChannel((prev) => {
      const existing = prev[key] ?? [];
      const ids = new Set(existing.map((m) => m.id));
      const fresh = page.filter((m) => !ids.has(m.id));
      if (fresh.length === 0) return prev;
      const merged = [...existing, ...fresh].sort((a, b) => {
        if (a.server_time !== b.server_time) return a.server_time - b.server_time;
        return a.id - b.id;
      });
      return { ...prev, [key]: merged };
    });
  };

  const loadInitialScrollback = async (slug: string, name: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const key = channelKey(slug, name);
    if (loadedChannels.has(key)) return;
    loadedChannels.add(key);
    // Seed an empty list so the pane renders immediately while the
    // REST page is in flight; WS events arriving in the meantime
    // append to this seed via `appendToScrollback`.
    setScrollbackByChannel((prev) => (key in prev ? prev : { ...prev, [key]: [] }));
    try {
      const page = await listMessages(t, slug, name);
      mergeIntoScrollback(key, page);
      // RC2 (decouple-unread-badge) — baseline the read cursor to this
      // backlog's tail when the channel has no cursor yet. Opening a
      // fresh channel auto-scrolls to the newest row, so "cursor = tail"
      // is the honest "you've seen the newest." Without it, a channel
      // visited then defocused BEFORE the backlog hydrated leaves the
      // cursor nil and the server's nil-cursor `unread_count` counts the
      // whole backlog (m2-irssi-to-chan-defocused: 200 backlog + 1 → "201"
      // instead of "1").
      //
      // Tail is the page's MAX id, not page[0] — `listMessages` returns
      // server-DESC, but reduce-max is order-independent so the contract
      // doesn't depend on page ordering.
      //
      // Gated on `getReadCursor === null` (NOT the forward-only gate
      // sendMessage uses): a channel that already has a read position
      // keeps it, so the in-pane `── XX unread ──` marker survives a
      // re-open. The completion-time fire is robust to the leave-race —
      // the load was triggered by focus; finishing after the operator
      // navigated away still marks the backlog read. `loadInitialScrollback`
      // only fires on focus, so unfocused new DMs stay unmarked (m4).
      const head = page[0];
      if (head && getReadCursor(slug, name) === null) {
        const tail = page.reduce((max, m) => (m.id > max ? m.id : max), head.id);
        void setReadCursor(t, slug, name, tail);
      }
    } catch {
      // First-load failure leaves the empty seed in place; the pane
      // shows "no messages yet". A retry mechanism is Phase 5+.
      loadedChannels.delete(key);
    }
  };

  const loadMore = async (slug: string, name: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const key = channelKey(slug, name);
    // CP14 B2 gates — order matters:
    //   1. Exhausted latch first: if the channel has no older rows on
    //      the server, every scroll-to-top would otherwise hit REST
    //      and get an empty page back. One-line short-circuit.
    //   2. In-flight guard second: a parallel scroll-burst converges
    //      onto a single REST request; the second call returns void
    //      while the first is still pending.
    if (loadMoreExhausted.has(key)) return;
    if (loadMoreInFlight.has(key)) return;
    const current = scrollbackByChannel()[key];
    if (!current || current.length === 0) return;
    const oldest = current[0];
    if (!oldest) return;
    loadMoreInFlight.add(key);
    try {
      // CP29 R-2: cursor flipped from `oldest.server_time` to
      // `oldest.id`. The server-side `?before=` parameter now expects
      // a `messages.id` value, eliminating same-ms ties that straddled
      // page boundaries pre-flip.
      const page = await listMessages(t, slug, name, oldest.id);
      // CP14 B2: empty page from the server means there's no older
      // history to load. Latch the channel so subsequent scroll-to-
      // top events don't re-fetch.
      if (page.length === 0) {
        loadMoreExhausted.add(key);
      } else {
        mergeIntoScrollback(key, page);
      }
    } catch {
      // Transient error — do NOT latch as exhausted. The user can
      // retry by scrolling again; the in-flight guard releases via
      // the finally clause below.
    } finally {
      loadMoreInFlight.delete(key);
    }
  };

  const sendMessage = async (slug: string, name: string, body: string): Promise<void> => {
    const t = token();
    if (!t) return;
    // Server persists+broadcasts atomically — the WS push will deliver
    // the same row to this socket and `appendToScrollback` will display
    // it. The 201 body is the same persisted row; we keep ONLY its `id`
    // (not its body) for the post-success cursor advance below. The
    // render path is still WS-driven, so reading the id here does not
    // introduce a second insert.
    //
    // Unread-badges-from-cursor cluster, bucket D — auto-advance the
    // read cursor on send-in-focused-window. Without this advance the
    // in-pane `── XX unread ──` marker and the sidebar badge would stay
    // stale until focus-leave / browser-blur / scroll-settle wrote the
    // cursor; worse, on a second device the operator's own send would
    // bump THEIR derived count (the WS broadcast filter catches own-
    // presence rows but not own-content). The server's
    // `read_cursor_set` WS event fans the new cursor to all of this
    // user's other devices, dropping the just-sent message from their
    // derived `unreadCounts` memo in selection.ts.
    //
    // Mirrors selection.ts:291 `setCursorIfAdvances`'s forward-only
    // gate inline rather than importing — scrollback ↔ selection
    // already has a one-way edge (selection imports
    // loadInitialScrollback from here) and closing the cycle would
    // re-introduce the vitest `undefined` capture observed in bucket C
    // (networks ↔ selection). Three-line inline body + the doc here
    // is cheaper than hoisting `setCursorIfAdvances` to a leaf module
    // for a single second caller.
    const row = await apiSendMessage(t, slug, name, body);
    const current = getReadCursor(slug, name);
    if (current === null || row.id > current) {
      void setReadCursor(t, slug, name, row.id);
    }
    // Send-relatch: fire AFTER the optimistic cursor advance above so the
    // pane's hide-on-send effect reads the fresh cursor. Always fires on
    // a successful send (even when the POST was skipped) — the marker
    // must hide regardless.
    setLastOwnSend(channelKey(slug, name));
  };

  // CP29 R-5 — refresh-on-WS-join-ok. Called from `subscribe.ts`'s 5
  // join callbacks on EVERY successful per-channel join (initial AND
  // every auto-rejoin after a socket disconnect). Closes the cp13-S5
  // race class by construction: once the WS join completes, this verb
  // pulls every row whose id > the resume cursor and ingests via
  // `appendToScrollback` (id-deduped, so any row that ALSO arrives via
  // the live WS during/after the fetch is a no-op on the second
  // arrival).
  //
  // Resume cursor source order:
  //   1. `reconnectBackfill.getResumeCursor` — live high-water mark
  //      from `recordSeen` (definitive when cic has rendered any row
  //      this session); falls back to the server-side read cursor.
  //   2. Tail id of the local `scrollbackByChannel[key]` — covers the
  //      cp13-S5 race shape: a freshly-opened window (e.g. query
  //      window from `/msg`) whose `loadInitialScrollback` returned
  //      a possibly-empty page BEFORE the WS subscribe completed; the
  //      reconnectBackfill cursor sources are both null but the local
  //      pane has the REST seed's tail id (or 0 for an empty seed) we
  //      can resume from. Fetching `?after=<tail_id>` recovers any row
  //      whose persist landed between the REST page response and the
  //      WS-subscribe completion.
  //   3. `0` — pane never opened locally either (rare: a join callback
  //      firing for a pane the operator hasn't focused yet). Fetch
  //      from the beginning; the per-key in-flight guard +
  //      appendToScrollback id-dedupe preclude duplication if
  //      `loadInitialScrollback` later races the same rows. Limit is
  //      capped at 200 server-side so this is bounded even on a busy
  //      channel.
  //
  // In-flight guard: per-key Set prevents double-fetch under bursty
  // rejoin sequences (phoenix.js's `Push.resend()` can fire
  // `.receive("ok")` twice for stale outbound pushes that succeed
  // post-rejoin — see socket.ts moduledoc). Released in `finally` so a
  // transient REST error doesn't latch out future retries.
  //
  // High-water mark rolls forward as we ingest so a SECOND disconnect
  // mid-refresh resumes from the new highest id rather than the
  // original cursor — same property the pre-CP29-R5 reconnectBackfill
  // ran inside `runBackfill`, preserved here for the same reason.
  const refreshInFlight = new Set<ChannelKey>();
  const REFRESH_LIMIT = 200;

  const refreshScrollback = async (slug: string, name: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const key = channelKey(slug, name);
    if (refreshInFlight.has(key)) return;
    let cursor = getResumeCursor(slug, name);
    if (cursor === null) {
      // Local-pane fallback (cp13-S5 race shape). The REST seed has
      // landed (or is in flight as an empty seed); resume from
      // whatever's at the tail. `0` covers both an empty seed AND a
      // pane that hasn't been opened locally yet — the per-key
      // in-flight guard + appendToScrollback id-dedupe make a
      // racing `loadInitialScrollback` safe.
      const local = scrollbackByChannel()[key];
      cursor = local && local.length > 0 ? (local[local.length - 1]?.id ?? 0) : 0;
    }
    refreshInFlight.add(key);
    try {
      // CP29 R-2 unified surface: ASC by id when ?after=<id>. Caller
      // limit kept explicit at the call site so a future tuning (e.g.
      // dynamic per-channel cap) doesn't have to thread through the
      // api.ts helper signature.
      const page = await listMessagesAfter(t, slug, name, cursor, REFRESH_LIMIT);
      for (const msg of page) {
        appendToScrollback(key, msg);
        // Roll the high-water mark forward as we ingest so a second
        // disconnect mid-refresh resumes from the new highest id
        // rather than the original cursor.
        recordSeen(key, msg);
      }
    } catch (err) {
      // Transient error — leave the cursor alone so the next reconnect
      // retries. Log to console for operator diagnosis; Phase 5
      // telemetry hook will replace this.
      console.error("[scrollback] refreshScrollback failed", slug, name, err);
    } finally {
      refreshInFlight.delete(key);
    }
  };

  // UX-7-B (2026-05-22) — destructive cache invalidation for the
  // `archive_purged` userTopic event. Drops the per-channel signal
  // entry + clears the load-once gate + clears the load-more
  // exhausted latch. WITHOUT this verb cic's `scrollbackByChannel[key]`
  // survived a server-side DELETE + re-JOIN: `refreshScrollback`
  // fetches `?after=cursor` (high-water mark) which is past every
  // deleted row, so the pre-delete rows persisted in the live Solid
  // store and re-appeared in the pane on re-JOIN.
  //
  // Caller is `userTopic.ts` archive_purged arm; the deleting tab
  // ALSO receives the broadcast over its own user-topic so the same
  // code path covers both the initiator and any other open tabs.
  // No need for a separate REST-204 client-side hook.
  //
  // No-op guard: tabs with NO local trace of this key (no signal
  // entry, no load-once gate) skip every mutation — honours "purge
  // what's there, don't touch what isn't". Note `loadedChannels.has`
  // ALONE is insufficient: auto-joined channels populate
  // `scrollbackByChannel[key]` via `refreshScrollback` (subscribe.ts
  // WS join-ok callback) WITHOUT touching `loadedChannels` — that
  // Set is only added by user-initiated `loadInitialScrollback`.
  // The signal store is the actual cache; the load-once Set is the
  // REST-deduplication gate. Both can carry state; either having
  // the key means there's something to purge.
  //
  // The high-water mark in `reconnectBackfill.lastSeenIdByKey` is
  // cleared via the sibling `clearSeen(key)` from that module — kept
  // separate so this verb stays cohesive with the scrollback-store
  // boundary (and so test mocks for reconnectBackfill stay decoupled
  // from scrollback's internals).
  const purgeScrollback = (key: ChannelKey): void => {
    const hasSignal = key in scrollbackByChannel();
    const hasGate = loadedChannels.has(key);
    if (!hasSignal && !hasGate) return;
    loadedChannels.delete(key);
    loadMoreExhausted.delete(key);
    loadMoreInFlight.delete(key);
    if (hasSignal) {
      setScrollbackByChannel((prev) => {
        const { [key]: _drop, ...rest } = prev;
        return rest;
      });
    }
  };

  return {
    scrollbackByChannel,
    appendToScrollback,
    loadInitialScrollback,
    loadMore,
    purgeScrollback,
    refreshScrollback,
    sendMessage,
    lastOwnSend,
  };
});

export const scrollbackByChannel = exports.scrollbackByChannel;
export const appendToScrollback = exports.appendToScrollback;
export const loadInitialScrollback = exports.loadInitialScrollback;
export const loadMore = exports.loadMore;
export const purgeScrollback = exports.purgeScrollback;
export const refreshScrollback = exports.refreshScrollback;
export const sendMessage = exports.sendMessage;
export const lastOwnSend = exports.lastOwnSend;
