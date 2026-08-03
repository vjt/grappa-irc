import { createSignal } from "solid-js";
import {
  sendMessage as apiSendMessage,
  countMessagesAfter,
  listMessages,
  listMessagesAfter,
  type ScrollbackMessage,
} from "./api";
import { token } from "./auth";
import { type ChannelKey, channelKey, decodeChannelKey } from "./channelKey";
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

// S20 (codebase review 2026-07-08) — per-channel ring cap. The live-append
// path (`appendToScrollback`, fed by the WS handler + reconnect refresh) was
// the unbounded growth vector for a passively-open PWA: a channel accumulated
// every live row with no prune (archive-delete + identity reset aside). Cap
// the per-channel row count, evicting the OLDEST rows on live append — but
// NEVER a row at/after the read cursor (see `capScrollbackRing`): the in-pane
// `── XX unread ──` divider anchors on the cursor + its unread rows, and
// dropping the boundary would break the read-state contract.
//
// Honest scope of the bound (the divider constraint is load-bearing, so the
// cap is NOT an unconditional ceiling):
//   * `mergeIntoScrollback` (loadMore prepends OLDER rows on explicit
//     scroll-up) is not capped at the prepend, so a scroll-up burst isn't
//     truncated mid-scroll. But the WHOLE list IS bounded on the NEXT live
//     append, which can evict the oldest READ rows a deep scroll-up loaded.
//     Recoverable: eviction resets the loadMore exhausted latch, so scrolling
//     up re-pages them.
//   * A channel that is BUSY but never focused this session, carrying a stale
//     non-null cursor (e.g. set on another device), holds every live row as
//     unread (id > cursor) → all protected → the buffer can grow past the
//     cap. That is the cost of the divider invariant, not an oversight: those
//     rows can't be dropped without corrupting the (server-authoritative)
//     unread count + divider. It bounds the moment the operator reads the
//     channel — the cursor advances and the now-read rows become evictable.
export const SCROLLBACK_RING_CAP = 1000;

// #693 — ONE page. The server's `@max_http_limit`, and the ceiling on every
// recovery fetch: the #156 anchored `after(cursor)` page, the reconnect
// `refreshScrollback` page, and the #161 forward page. It used to be three
// separate literal 200s; the far-behind decision below has to compare a gap
// against exactly this number, and three copies of a threshold's twin is how
// thresholds drift apart.
//
// `loadMore` (the older end) deliberately does NOT use it: a human scrolling
// UP rarely wants 200 rows at once, so that path takes the server default
// (~50). The forward end is recovering unread that can run to the hundreds.
const PAGE_LIMIT = 200;

// #693 — "more than one page behind". Above this many rows after the anchor,
// resuming contiguously from the anchor is a lie: the client would load the
// OLDEST 200 rows of the gap and the operator would have to scroll to the
// bottom (200 rows a gesture) to reach the present. At or below it, one more
// fetch drains the rest, so contiguity is cheap and worth keeping.
const isFarBehind = (gap: number): boolean => gap > PAGE_LIMIT;

// Canonical scrollback ordering: `server_time` ASC, `id` ASC tie-break —
// the client mirror of the server's `[desc: server_time, desc: id]`
// (`Scrollback.fetch/5`). Single source so `mergeIntoScrollback` and
// `renameScrollbackKey` (#373) can never drift on the tie-break rule.
const byServerTimeThenId = (a: ScrollbackMessage, b: ScrollbackMessage): number => {
  if (a.server_time !== b.server_time) return a.server_time - b.server_time;
  return a.id - b.id;
};

// Trim `rows` (ASC by id) to the ring cap by dropping the OLDEST, but NEVER a
// row at/after the read cursor: the in-pane `── XX unread ──` divider anchors
// on the cursor and its unread rows (CLAUDE.md "Read state is server-owned"),
// so dropping the boundary would break the unread contract. The evictable
// region is exactly the read-context strictly below the divider (id <
// cursor); a pathological all-unread channel simply holds above the cap until
// the operator reads (advancing the cursor makes those rows evictable). With
// no cursor (fresh channel, no divider) eviction is unconstrained.
const capScrollbackRing = (key: ChannelKey, rows: ScrollbackMessage[]): ScrollbackMessage[] => {
  if (rows.length <= SCROLLBACK_RING_CAP) return rows;
  let dropCount = rows.length - SCROLLBACK_RING_CAP;
  const decoded = decodeChannelKey(key);
  const cursor = decoded ? getReadCursor(decoded.slug, decoded.name) : null;
  if (cursor !== null) {
    // Rows are ASC by id, so the first index with id >= cursor bounds the
    // evictable prefix (everything before it is read-context below the divider).
    const firstProtected = rows.findIndex((m) => m.id >= cursor);
    const maxDroppable = firstProtected === -1 ? rows.length : firstProtected;
    if (dropCount > maxDroppable) dropCount = maxDroppable;
  }
  return dropCount > 0 ? rows.slice(dropCount) : rows;
};

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
  // #161: forward-paging in-flight guard, symmetric to `loadMoreInFlight`.
  // Scroll-to-bottom bursts converge onto a single `?after=` REST request;
  // while a key is in-flight a second `loadNewer` for it is a no-op.
  // Released in `finally` so a transient error doesn't lock out retries.
  const loadNewerInFlight = new Set<ChannelKey>();
  // #161: forward end-of-history latch — "this key reached the LIVE server
  // tail." Set when `loadNewer` gets an empty forward page.
  //
  // The 20% that does NOT mirror `loadMoreExhausted` (CLAUDE.md "reuse the
  // verbs, not the nouns"): the OLDER end never grows, so its latch is
  // permanent. The NEWER end GROWS via live WS `appendToScrollback`. But
  // ordinary live appends are CONTIGUOUS — each appended row IS the
  // server's newest, so `after(max)` stays empty and this latch stays
  // CORRECT even as `max` advances (we're still at the live tail). The
  // way a forward gap re-opens after latching is a `refreshScrollback` batch
  // that hit its 200-row cap on a >200-message reconnect: it appended a full
  // page but the tail may be further ahead. So the latch is invalidated
  // THERE — and, since #693, in `jumpToUnread`, the one verb that walks the
  // pane AWAY from the tail on purpose. Nowhere else: invalidating on every
  // append would re-fire an empty forward probe on every auto-follow scroll
  // at a busy live tail (a fetch-per-message storm). Cleared on identity
  // transition alongside `loadedChannels`.
  const loadNewerExhausted = new Set<ChannelKey>();
  const [scrollbackByChannel, setScrollbackByChannel] = createSignal<
    Record<ChannelKey, ScrollbackMessage[]>
  >({});

  // #693 — "this pane holds the TAIL, and the region the operator left off in
  // is NOT in it." Set when a resume found the gap too large to drain (see
  // `anchorAtTail`), cleared when the operator jumps back into that region or
  // the window is purged.
  //
  //   * `missed` — the server's true row count after the anchor, at the
  //     moment of the decision. What the jump affordance shows.
  //   * `resumeFrom` — the anchor itself: the newest row the pane held before
  //     it gave up on contiguity (the read cursor on a cold open, the last
  //     backfilled row on a reconnect). Where the jump lands.
  //
  // State that cannot be derived: with the tail loaded and the anchor far
  // below the oldest loaded row, nothing local says how much is missing —
  // that is exactly the measurement the client had to ask the server for.
  // ScrollbackPane reads it to render the jump affordance and to suppress the
  // in-pane unread divider (whose count would otherwise describe the loaded
  // rows rather than the unread region).
  const [farBehindByChannel, setFarBehindByChannel] = createSignal<
    Record<ChannelKey, { missed: number; resumeFrom: number }>
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

  // #580 — submit-time send signal. `lastOwnSend` above fires only AFTER
  // the POST resolves, and it drove BOTH the network-dependent work (divider
  // re-latch + cursor advance, which genuinely need the persisted row id) AND
  // the network-INDEPENDENT bottom-snap + follow-state reset (the response to
  // the operator pressing enter). Binding the snap to the POST meant a slow /
  // failed round-trip left the pane parked while the WS echo rendered the row
  // ("own send sometimes doesn't scroll"). This signal is set SYNCHRONOUSLY at
  // submit time — before the await — so ScrollbackPane snaps to the bottom the
  // instant enter is pressed, independent of the network outcome (which is
  // also correct when the send FAILS: you want to be at the bottom to watch
  // it). `equals: false` for the same reason as `lastOwnSend` — a repeat send
  // to the same channel must re-fire the snap.
  const [ownSendSubmitted, setOwnSendSubmitted] = createSignal<ChannelKey | null>(null, {
    equals: false,
  });

  // Identity-transition cleanup. Nine registered resets fired by the
  // factory's createEffect(on(token, ...)) — five Set.clear() (loadedChannels
  // + loadMore{InFlight,Exhausted} + loadNewer{InFlight,Exhausted}, #161) +
  // four signal flushes (scrollbackByChannel + lastOwnSend + ownSendSubmitted,
  // #580 + farBehindByChannel, #693). Order matches the pre-A3 inline shape.
  onIdentityChange(() => loadedChannels.clear());
  onIdentityChange(() => loadMoreInFlight.clear());
  onIdentityChange(() => loadMoreExhausted.clear());
  onIdentityChange(() => loadNewerInFlight.clear());
  onIdentityChange(() => loadNewerExhausted.clear());
  onIdentityChange(() => setScrollbackByChannel({}));
  onIdentityChange(() => setLastOwnSend(null));
  onIdentityChange(() => setOwnSendSubmitted(null));
  onIdentityChange(() => setFarBehindByChannel({}));

  // Insert an incoming message into the per-channel ascending list at its
  // (server_time, id) position, deduping by id. REST + WS can overlap: the
  // row inserted by POST arrives both as the HTTP 201 body (we ignore that
  // body) and as a WS push from the per-channel PubSub broadcast. Both paths
  // route through here; whichever lands first wins, the second is dropped.
  //
  // #423 — order-safe insert. The live WS path appends the server's NEWEST
  // row (contiguous with the tail — the hot common case), but
  // `refreshScrollback` feeds a REST gap page whose rows can sort BEFORE a
  // live row that already landed at the tail during a reconnect. Store order
  // IS display order (`ScrollbackPane` renders `scrollbackByChannel` verbatim,
  // no re-sort), so push only when the row is at/after the tail; otherwise
  // re-sort it into position. Costs one comparison against the tail on the hot
  // path and a re-sort only on the rare out-of-order row.
  const appendToScrollback = (key: ChannelKey, msg: ScrollbackMessage) => {
    // S20: track whether the ring cap evicted older rows so we can reset the
    // loadMore exhausted latch below. Computed inside the pure updater,
    // consumed after it runs (Solid calls a plain-signal updater exactly once,
    // synchronously) — keeps the setter body free of the Set side-effect.
    let evicted = false;
    setScrollbackByChannel((prev) => {
      const existing = prev[key];
      if (existing?.some((m) => m.id === msg.id)) return prev;
      let next: ScrollbackMessage[];
      if (!existing || existing.length === 0) {
        next = [msg];
      } else {
        const tail = existing[existing.length - 1];
        next =
          tail && byServerTimeThenId(msg, tail) < 0
            ? [...existing, msg].sort(byServerTimeThenId)
            : [...existing, msg];
      }
      const capped = capScrollbackRing(key, next);
      evicted = capped.length < next.length;
      return { ...prev, [key]: capped };
    });
    // Eviction removed older history → the loadMore exhausted latch (if set)
    // is now stale: the server DOES have rows older than the new oldest. Clear
    // it so a scroll-to-top re-pages the evicted region.
    if (evicted) loadMoreExhausted.delete(key);
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
      const merged = [...existing, ...fresh].sort(byServerTimeThenId);
      return { ...prev, [key]: merged };
    });
  };

  // #373 — a query window's peer renamed; move its in-memory scrollback
  // from `oldKey` (slug, oldNick) to `newKey` (slug, newNick), merging into
  // any rows already under the new key (dedup by id, canonical order). The
  // server migrated the DM rows in the DB (`Scrollback.rename_dm_peer/4`)
  // and broadcasts the new window list; this keeps the LIVE Solid cache in
  // step so the relabeled window shows its history instantly instead of
  // flickering empty until the next refresh. cic-owned cache maintenance —
  // the sidebar row list stays server-authoritative. No-op when the old key
  // holds nothing (a member rename with no query window costs one lookup).
  const renameScrollbackKey = (oldKey: ChannelKey, newKey: ChannelKey): void => {
    if (oldKey === newKey) return;
    // #693 — the far-behind record is nick-keyed for a DM, so it belongs to
    // the #373 migration set (CLAUDE.md: a new nick-keyed store that skips it
    // strands its old-nick rows). Stranded, the renamed pane loses its jump
    // affordance AND its divider suppression — the marker comes back labelled
    // with the loaded rows while thousands are missing, which is the wrong
    // number the suppression exists to prevent.
    setFarBehindByChannel((prev) => {
      if (!(oldKey in prev)) return prev;
      const { [oldKey]: moved, ...rest } = prev;
      return moved === undefined ? rest : { ...rest, [newKey]: moved };
    });
    setScrollbackByChannel((prev) => {
      if (!(oldKey in prev)) return prev;
      const oldRows = prev[oldKey] ?? [];
      const { [oldKey]: _drop, ...rest } = prev;
      if (oldRows.length === 0) return rest;
      const existing = rest[newKey] ?? [];
      const ids = new Set(existing.map((m) => m.id));
      const merged = [...existing, ...oldRows.filter((m) => !ids.has(m.id))].sort(
        byServerTimeThenId,
      );
      return { ...rest, [newKey]: merged };
    });
  };

  // #693 — how many rows sit after `anchor` on the server, or `null` when the
  // question could not be answered (an older server with no
  // `/messages/count` route, a transient error). `null` is NOT zero and NOT
  // "far behind": callers fall back to the pre-#693 cursor-anchored resume,
  // which is wrong-but-familiar rather than a destructive guess.
  const probeGap = async (
    t: string,
    slug: string,
    name: string,
    anchor: number,
  ): Promise<number | null> => {
    try {
      return await countMessagesAfter(t, slug, name, anchor);
    } catch (err) {
      console.warn("[scrollback] gap probe failed — keeping the anchored resume", slug, name, err);
      return null;
    }
  };

  // #693 — REPLACE this key's rows with the server's newest page and record
  // that the unread region is no longer in the pane.
  //
  // Replace, not merge: store order IS display order (`ScrollbackPane` renders
  // the array verbatim) and there is no gap-marker row, so merging a tail page
  // beside rows from hundreds of messages ago renders a silent hole — two
  // regions abutting as if they were consecutive. Dropping the stale region is
  // both honest and recoverable: scroll-up re-pages it through `loadMore`,
  // which is why the exhausted latch is cleared here.
  //
  // The high-water mark rolls to the tail (`recordSeen`) so the NEXT
  // `refreshScrollback` resumes from the present instead of re-fetching the
  // abandoned region and re-deciding it is far behind, forever.
  //
  // The replace KEEPS any row newer than the page it just fetched. A live WS
  // row can land during the await, and `appendToScrollback` has already rolled
  // the high-water mark past it — a blind overwrite would drop it from the
  // pane while making it unfetchable by the very path meant to recover it
  // (the next `?after=` starts above it). Those rows sit at/after the tail, so
  // keeping them opens no hole; everything OLDER than the page is the
  // abandoned region and must go.
  const anchorAtTail = async (
    t: string,
    slug: string,
    name: string,
    missed: number,
    resumeFrom: number,
  ): Promise<void> => {
    const key = channelKey(slug, name);
    const page = await listMessages(t, slug, name);
    const rows = [...page].sort(byServerTimeThenId);
    const newest = rows[rows.length - 1]?.id ?? 0;
    setScrollbackByChannel((prev) => {
      const live = (prev[key] ?? []).filter((m) => m.id > newest);
      return { ...prev, [key]: [...rows, ...live].sort(byServerTimeThenId) };
    });
    for (const msg of rows) recordSeen(key, msg);
    loadMoreExhausted.delete(key);
    setFarBehindByChannel((prev) => ({ ...prev, [key]: { missed, resumeFrom } }));
  };

  // #693 — the DECISION is measured at the anchor the resume was about to use
  // (never at the read cursor: see `refreshScrollback`). The LABEL and the
  // jump target belong to the operator's READ POSITION, which on the reconnect
  // path sits further back — the anchor there is the high-water mark, one
  // ingested page ahead of it.
  //
  // Conflating the two costs both honesty and the divider: the row would
  // undercount by up to a page, and jumping to the high-water mark lands a
  // window whose every row is already past the cursor, so the marker injects
  // at index 0 labelled with the loaded count — the exact failure the
  // suppression exists to prevent, relocated. So re-probe at the cursor when
  // it differs. One extra small GET, only on the reconnect path, only when
  // already far behind. A failed re-probe keeps the anchor: a slightly
  // conservative jump target beats no affordance at all.
  const resolveJumpTarget = async (
    t: string,
    slug: string,
    name: string,
    anchor: number,
    missedAtAnchor: number,
  ): Promise<{ missed: number; resumeFrom: number }> => {
    const cursor = getReadCursor(slug, name);
    if (cursor === null || cursor >= anchor) {
      return { missed: missedAtAnchor, resumeFrom: anchor };
    }
    const missed = await probeGap(t, slug, name, cursor);
    return missed === null
      ? { missed: missedAtAnchor, resumeFrom: anchor }
      : { missed, resumeFrom: cursor };
  };

  const clearFarBehind = (key: ChannelKey): void => {
    setFarBehindByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  };

  // #693 — the operator took the "N unread — jump back" affordance. Swap the
  // tail window for the one anchored at their read position: exactly the fetch
  // shape #156 does on a small gap, so the in-pane divider lands between read
  // context and the first unread row.
  //
  // Replace rather than merge, for the same reason `anchorAtTail` does — the
  // two windows are not contiguous. Unlike `anchorAtTail` this DROPS rows
  // newer than the fetched region instead of keeping them: there they abutted
  // the tail, here they would sit thousands of rows above it. Leaving the tail
  // is the point of the gesture; getting back is `loadNewer` (scroll to the
  // bottom), the same as any other window sitting on old history.
  //
  // Returns whether the swap happened, so the caller can stand down whatever
  // it armed for the arriving rows. A failed fetch leaves the pane untouched.
  const jumpInFlight = new Set<ChannelKey>();
  const jumpToUnread = async (slug: string, name: string): Promise<boolean> => {
    const t = token();
    if (!t) return false;
    const key = channelKey(slug, name);
    const far = farBehindByChannel()[key];
    if (!far) return false;
    if (jumpInFlight.has(key)) return false;
    jumpInFlight.add(key);
    try {
      const [afterPage, beforePage] = await Promise.all([
        listMessagesAfter(t, slug, name, far.resumeFrom, PAGE_LIMIT),
        listMessages(t, slug, name, far.resumeFrom + 1),
      ]);
      // Disjoint by construction — `after(cursor)` is `id > cursor`,
      // `before(cursor + 1)` is `id <= cursor` — so concat + sort needs no
      // dedupe pass.
      const rows = [...afterPage, ...beforePage].sort(byServerTimeThenId);
      setScrollbackByChannel((prev) => ({ ...prev, [key]: rows }));
      // The pane no longer holds the tail, and there IS older history below
      // the new oldest row — both latches are stale.
      loadNewerExhausted.delete(key);
      loadMoreExhausted.delete(key);
      clearFarBehind(key);
      return true;
    } catch (err) {
      console.error("[scrollback] jumpToUnread failed", slug, name, err);
      return false;
    } finally {
      jumpInFlight.delete(key);
    }
  };

  // #693 — the other exit: "I don't care about those, I'm caught up now."
  //
  // Needed because the far-behind state FREEZES the read cursor (see
  // `setCursorIfAdvances`): reading at the tail must not silently mark the
  // abandoned region read, so without a deliberate exit the operator would
  // chat at the tail under a permanent "3000 unread". This is that exit, and
  // it is the ONE place the cursor jumps a region the operator never read —
  // by their own explicit gesture, which is the only thing that makes it
  // honest. Advancing to the newest LOADED row (not to `missed`) keeps the
  // existing forward-only cursor contract intact.
  //
  // Returns the id it marked read (null if it did nothing), so the caller can
  // re-latch its frozen divider to the same position. Without that the pane
  // would un-suppress the marker against a cursor snapshot taken thousands of
  // rows ago and draw "50 unread" across the top of the buffer — the wrong
  // number the suppression existed to prevent, arriving the moment the
  // operator dismisses it.
  const dismissFarBehind = (slug: string, name: string): number | null => {
    const t = token();
    if (!t) return null;
    const key = channelKey(slug, name);
    if (!farBehindByChannel()[key]) return null;
    const rows = scrollbackByChannel()[key] ?? [];
    const newest = rows[rows.length - 1];
    clearFarBehind(key);
    if (!newest) return null;
    void setReadCursor(t, slug, name, newest.id);
    return newest.id;
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
    // #156 — the read cursor (if any) decides the fetch shape. Read it
    // ONCE up front: it selects the branch; the cursor-null branch
    // re-checks at write time to stay robust against a cursor that
    // hydrates mid-fetch (see its comment).
    const cursor = getReadCursor(slug, name);
    try {
      if (cursor === null) {
        // No read position yet — a fresh channel. The tail-only page
        // (server default ~50 newest rows) is the cheapest correct load:
        // a brand-new window auto-scrolls to the tail, so the newest
        // rows are exactly what's wanted and there's no divider to anchor.
        const page = await listMessages(t, slug, name);
        mergeIntoScrollback(key, page);
        // RC2 (decouple-unread-badge) — baseline the read cursor to this
        // backlog's tail. Opening a fresh channel auto-scrolls to the
        // newest row, so "cursor = tail" is the honest "you've seen the
        // newest." Without it, a channel visited then defocused BEFORE
        // the backlog hydrated leaves the cursor nil and the server's
        // nil-cursor `unread_count` counts the whole backlog
        // (m2-irssi-to-chan-defocused: 200 backlog + 1 → "201" not "1").
        //
        // Tail is the page's MAX id, not page[0] — `listMessages` returns
        // server-DESC, but reduce-max is order-independent so the contract
        // doesn't depend on page ordering.
        //
        // Re-check `getReadCursor === null` at write time (NOT the value
        // read above): a join-reply / `/me` cursor can land DURING the
        // fetch; the re-check keeps an arrived cursor from being clobbered
        // (and preserves its in-pane `── XX unread ──` marker). The
        // completion-time fire is robust to the leave-race — finishing
        // after the operator navigated away still marks the backlog read.
        const head = page[0];
        if (head && getReadCursor(slug, name) === null) {
          const tail = page.reduce((max, m) => (m.id > max ? m.id : max), head.id);
          void setReadCursor(t, slug, name, tail);
        }
      } else {
        // A read position exists, so the in-pane divider must land between
        // the last-read row and the first-unread row WITH read-context
        // above it. A tail-only page loses that anchor whenever unread
        // exceeds the window: the cursor is OLDER than every loaded row,
        // so the divider slams to the pane top with the wrong count (or
        // fails to inject). Fetch the region AROUND the cursor instead:
        //   * after(cursor, 200) → the unread region (id > cursor, ASC),
        //     capped at the server max (@max_http_limit = 200).
        //   * before(cursor + 1) → the read-context page (id <= cursor;
        //     integer ids, so the strict `< cursor+1` cursor is exactly
        //     `<= cursor`), i.e. the last-read row + ~50 rows above the
        //     divider.
        // Both merge via `mergeIntoScrollback` (id-dedupe + ASC sort), so
        // the loaded set is contiguous around the anchor and `loadMore`'s
        // oldest-id paging keeps working. Never re-baseline the cursor —
        // the existing read position (and its marker) is preserved.
        //
        // For a fully-read channel after(...) returns 0 rows and the load is
        // just the before page; for the common few-unread case the two pages
        // cover the newest rows.
        //
        // #693 note on the gate below: the branch is no longer unconditional,
        // but it is still NOT gated on the sidebar's unread seed. That number
        // lives in selection.ts (reaching it from here is an import cycle),
        // it is anchored at the read cursor rather than at an arbitrary
        // anchor, and it counts a different row set than a fetch returns
        // (own-presence / operator-echo). The gap probe asks the server about
        // the exact anchor this branch is about to use, so the answer
        // describes the rows this fetch would receive.
        //
        // #693 — the >200 case is NO LONGER handled by loading the oldest
        // page of the gap and hoping. That was the bug: the anchored fetch
        // returns `[cursor .. cursor+200]`, the tail stays hundreds or
        // thousands of rows further on, and nothing but repeated
        // scroll-to-bottom gestures walks forward to it. Coming back after a
        // long absence therefore landed 200 rows into the past — reliably,
        // and a reload only replayed the same window.
        //
        // So ask how big the gap really is, and when it is more than one page
        // stop pretending contiguity is achievable: anchor at the tail and
        // surface the unread region as a jump affordance instead of as the
        // default viewport. Below the threshold nothing changes — the
        // anchored fetch is right there, and the divider is worth keeping.
        //
        // The probe is ONE extra small GET per cursor-present channel-open,
        // behind the load-once gate, on a human click; the pane is empty here
        // so `anchorAtTail` has nothing to discard.
        const gap = await probeGap(t, slug, name, cursor);
        if (gap !== null && isFarBehind(gap)) {
          await anchorAtTail(t, slug, name, gap, cursor);
        } else {
          const [afterPage, beforePage] = await Promise.all([
            listMessagesAfter(t, slug, name, cursor, PAGE_LIMIT),
            listMessages(t, slug, name, cursor + 1),
          ]);
          // A rejoin's `refreshScrollback` can have re-anchored this key at
          // the tail while these two pages were in flight (nothing serialises
          // the cold-load and the reconnect path for one key). Splicing the
          // anchored region into a tail-anchored pane is exactly the silent
          // hole `anchorAtTail` refuses to create, so the loser drops its
          // pages — they describe a window the pane has deliberately left.
          if (farBehindByChannel()[key] === undefined) {
            mergeIntoScrollback(key, afterPage);
            mergeIntoScrollback(key, beforePage);
          }
        }
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

  // #161: forward-paging verb — symmetric to `loadMore` but pages NEWER
  // rows on scroll-to-bottom. After #156's anchored fetch, a channel with
  // more unread than one page loaded only the region [cursor .. cursor+200];
  // the rows past that (up to the true server tail) were UNREACHABLE —
  // `loadMore` pages older on scroll-to-top and nothing paged newer, and the
  // WS join-ok `refreshScrollback` hit the SAME cap from the same resume
  // cursor. #693 removed the need to WALK that gap (a resume that cannot
  // drain it now anchors at the tail outright), but this verb still owns the
  // ordinary forward end: a jumped-back pane, and any gap under the
  // threshold. It pulls `listMessagesAfter(highestLoadedId, 200)` and
  // merges via `mergeIntoScrollback` (id-dedupe + ASC — the SAME merge as
  // loadMore/refresh), so the loaded set stays contiguous and grows toward
  // the tail one page per scroll-to-bottom.
  //
  // Guards mirror `loadMore`'s, with ONE domain difference — the growing-
  // tail latch (see `loadNewerExhausted`):
  //   1. Exhausted latch: once an empty forward page proves we reached the
  //      live tail, scroll-to-bottom is a no-op — no fetch-per-scroll storm
  //      while the operator sits at the tail auto-following live traffic.
  //   2. In-flight guard: a scroll-to-bottom burst converges to one REST.
  // `highestLoadedId` is the local tail id — NOT the read cursor, NOT any
  // scroll signal (ScrollbackPane's `atBottom` is unreliable across a
  // key-change batch, #163): the gap is derived from loaded-id vs the
  // fetched page, so a genuinely-at-tail pane fetches one empty page then
  // latches instead of guessing from geometry.
  const loadNewer = async (slug: string, name: string): Promise<void> => {
    const t = token();
    if (!t) return;
    const key = channelKey(slug, name);
    if (loadNewerExhausted.has(key)) return;
    if (loadNewerInFlight.has(key)) return;
    const current = scrollbackByChannel()[key];
    if (!current || current.length === 0) return;
    const newest = current[current.length - 1];
    if (!newest) return;
    loadNewerInFlight.add(key);
    try {
      const page = await listMessagesAfter(t, slug, name, newest.id, PAGE_LIMIT);
      // Empty forward page = the local tail IS the live server tail. Latch
      // so subsequent scroll-to-bottom events (including the auto-follow
      // scroll that fires when a live row appends at the tail) are no-ops.
      if (page.length === 0) {
        loadNewerExhausted.add(key);
      } else {
        mergeIntoScrollback(key, page);
      }
    } catch {
      // Transient error — do NOT latch. The user can retry by scrolling;
      // the in-flight guard releases via the `finally` below.
    } finally {
      loadNewerInFlight.delete(key);
    }
  };

  // #640 — `ctcpTarget` (optional) makes this a CTCP QUERY send: `name` is the
  // SOURCE window the echo renders in (where the operator typed /ctcp or /ping),
  // and `ctcpTarget` is the wire recipient. All the own-send bookkeeping
  // (submit-snap, cursor advance, divider re-latch) is keyed on `name` = the
  // source window — exactly where the echo + RTT land — so it is byte-identical
  // to a plain send once `name` is the source. Absent, it is a normal PRIVMSG.
  const sendMessage = async (
    slug: string,
    name: string,
    body: string,
    ctcpTarget?: string,
  ): Promise<void> => {
    const t = token();
    if (!t) return;
    const key = channelKey(slug, name);
    // #580 — publish the submit-time snap authority SYNCHRONOUSLY, before the
    // POST. This is the response to the operator pressing enter (bottom-snap +
    // follow-state reset in ScrollbackPane) and must not wait on — or be lost
    // to — the network round-trip. It fires even if `apiSendMessage` below
    // rejects: the row can still arrive over WS, and the operator wants to be
    // at the bottom to watch the send land or fail. The network-DEPENDENT
    // half (divider re-latch + cursor advance) stays on `lastOwnSend` after
    // the await, gated on the persisted row id.
    setOwnSendSubmitted(key);
    // Server persists+broadcasts atomically — the WS push will deliver
    // the same row to this socket and `appendToScrollback` will display
    // it. The 201 body is the same persisted row; we keep ONLY its `id`
    // (not its body) for the post-success cursor advance below. The
    // render path is still WS-driven, so reading the id here does not
    // introduce a second insert.
    //
    // Unread-badges-from-cursor cluster, bucket D — auto-advance the
    // read cursor on send-in-focused-window (gated below on a non-empty
    // pane per issue #50). Without this advance the
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
    const row = await apiSendMessage(t, slug, name, body, ctcpTarget);
    // Anti-poison gate (issue #50 / m6, 2026-06-09): only advance the
    // cursor when the local pane already holds a rendered row. Advancing
    // PAST an unrendered row poisons `refreshScrollback`'s resume cursor —
    // `getResumeCursor` falls back to the read cursor when nothing was ever
    // `recordSeen`'d, so on a brand-new query window (empty pane, own send)
    // the join-ok recovery fetches `?after=<own-id>` → empty and the row
    // never renders ("no messages yet" until reload). With rows present the
    // advance is honest (predecessors are in the DOM); with an empty pane we
    // leave the cursor put so refreshScrollback resumes from 0 and recovers
    // the send. The marker-hide intent the advance also served is moot on an
    // empty pane — there is no `── XX unread ──` divider to collapse.
    const local = scrollbackByChannel()[key];
    const hasRenderedRow = local !== undefined && local.length > 0;
    const current = getReadCursor(slug, name);
    if (hasRenderedRow && (current === null || row.id > current)) {
      void setReadCursor(t, slug, name, row.id);
    }
    // Send-relatch (post-resolve half): fire AFTER the optimistic cursor
    // advance above so the pane's marker re-latch effect reads the fresh
    // cursor and collapses the `── XX unread ──` divider. #580 moved the
    // network-independent bottom-snap to `ownSendSubmitted` (submit time);
    // this signal now drives ONLY the divider re-latch, which legitimately
    // needs the confirmed row id. Reached only on a resolved POST — a
    // rejected send never confirms, so it correctly does not re-latch.
    setLastOwnSend(key);
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

  // #552 — pure test seam: stamp `__cic_scrollbackRefreshed` (a Set of the
  // module composite key) when a refreshScrollback COMPLETES for a key.
  // subscribe.ts fires `void refreshScrollback` in the join-ok callback and
  // stamps `__cic_channelReady` SYNCHRONOUSLY right after, so waitForChannelReady
  // (used by selectChannel) returns while THIS REST backfill is still in flight.
  // A spec that then acts on scroll geometry (issue168 send-snap) races the
  // backfill's late DOM recreation, which resets scrollTop → onScroll flips
  // atBottom=false → the send-snap is undone. This is the REST-catch-up twin of
  // `__cic_channelReady`: specs await backfill COMPLETION via
  // `waitForScrollbackRefreshed`. Production never reads it (mirror of
  // subscribe.ts `stampChannelReady`).
  const stampScrollbackRefreshed = (key: ChannelKey): void => {
    if (typeof window === "undefined") return;
    const w = window as Window & { __cic_scrollbackRefreshed?: Set<ChannelKey> };
    if (!w.__cic_scrollbackRefreshed) w.__cic_scrollbackRefreshed = new Set();
    w.__cic_scrollbackRefreshed.add(key);
  };

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
      const page = await listMessagesAfter(t, slug, name, cursor, PAGE_LIMIT);
      for (const msg of page) {
        appendToScrollback(key, msg);
        // Roll the high-water mark forward as we ingest so a second
        // disconnect mid-refresh resumes from the new highest id
        // rather than the original cursor.
        recordSeen(key, msg);
      }
      // #161: a FULL-cap refresh page means the server tail may be further
      // ahead than what we just appended (a >200-message reconnect re-opens
      // the forward gap). Invalidate the forward-tail latch so the next
      // scroll-to-bottom pages forward again. A short page drained
      // everything after the resume cursor → no gap → the latch (if set)
      // stays valid. Ordinary live `appendToScrollback` rows are contiguous
      // with the tail and must NOT thrash the latch (see
      // `loadNewerExhausted`); the only other site that may clear it is
      // `jumpToUnread` (#693), which deliberately leaves the tail.
      if (page.length === PAGE_LIMIT) {
        loadNewerExhausted.delete(key);
        // #693 — a full page says "at least one more page", which is not a
        // measurement. Ask for the real remainder, measured from what we just
        // ingested (NOT from the read cursor: a busy window the operator
        // never focused holds every one of its "unread" rows already, and
        // deciding off the cursor there would throw away a perfectly good
        // pane). More than a page still missing means scroll-to-bottom
        // paging cannot realistically close it — land at the tail instead.
        //
        // Measured AFTER the fetch, so the probe costs nothing on the
        // ordinary short-page reconnect, which is nearly all of them.
        const last = page[page.length - 1];
        const anchor = last ? last.id : cursor;
        const gap = await probeGap(t, slug, name, anchor);
        if (gap !== null && isFarBehind(gap)) {
          const target = await resolveJumpTarget(t, slug, name, anchor, gap);
          await anchorAtTail(t, slug, name, target.missed, target.resumeFrom);
        }
      }
    } catch (err) {
      // Transient error — leave the cursor alone so the next reconnect
      // retries. Log to console for operator diagnosis; Phase 5
      // telemetry hook will replace this.
      console.error("[scrollback] refreshScrollback failed", slug, name, err);
    } finally {
      refreshInFlight.delete(key);
      // #552 — mark this backfill DONE (success or error): no more in-flight
      // DOM recreation for this key, so a spec awaiting it can safely proceed.
      stampScrollbackRefreshed(key);
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
    loadNewerExhausted.delete(key);
    loadNewerInFlight.delete(key);
    // #693 — the rows the far-behind record points back to were just deleted
    // server-side; offering to jump into them would 404 the affordance.
    clearFarBehind(key);
    if (hasSignal) {
      setScrollbackByChannel((prev) => {
        const { [key]: _drop, ...rest } = prev;
        return rest;
      });
    }
  };

  // #159 regression guard — synchronous "was this channel already loaded
  // BEFORE now?" probe for selection.ts's activation-freshness gate.
  // `loadedChannels` is the single source of truth for "cic has run the
  // cold-load for this key this session"; expose a read-only view rather
  // than letting selection.ts keep a parallel tracker (CLAUDE.md: derive
  // state, don't duplicate it). Callers MUST read this BEFORE calling
  // `loadInitialScrollback` — that verb adds the key to `loadedChannels`
  // SYNCHRONOUSLY (see its load-once gate), so a post-call read is always
  // `true`, even on a first open. Reads a plain Set (not a signal) so it
  // creates no reactive dependency in the caller's effect.
  const wasLoaded = (slug: string, name: string): boolean =>
    loadedChannels.has(channelKey(slug, name));

  return {
    scrollbackByChannel,
    appendToScrollback,
    dismissFarBehind,
    farBehindByChannel,
    jumpToUnread,
    loadInitialScrollback,
    loadMore,
    loadNewer,
    purgeScrollback,
    renameScrollbackKey,
    refreshScrollback,
    sendMessage,
    lastOwnSend,
    ownSendSubmitted,
    wasLoaded,
  };
});

export const scrollbackByChannel = exports.scrollbackByChannel;
export const appendToScrollback = exports.appendToScrollback;
export const dismissFarBehind = exports.dismissFarBehind;
export const farBehindByChannel = exports.farBehindByChannel;
export const jumpToUnread = exports.jumpToUnread;
export const loadInitialScrollback = exports.loadInitialScrollback;
export const loadMore = exports.loadMore;
export const loadNewer = exports.loadNewer;
export const purgeScrollback = exports.purgeScrollback;
export const renameScrollbackKey = exports.renameScrollbackKey;
export const refreshScrollback = exports.refreshScrollback;
export const sendMessage = exports.sendMessage;
export const lastOwnSend = exports.lastOwnSend;
export const ownSendSubmitted = exports.ownSendSubmitted;
export const wasLoaded = exports.wasLoaded;
