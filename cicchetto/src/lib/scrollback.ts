import { batch, createEffect, createSignal } from "solid-js";
import {
  sendMessage as apiSendMessage,
  countMessagesAfter,
  type GapProbe,
  isContentKind,
  listMessages,
  listMessagesAfter,
  type MessageRelay,
  type ScrollbackMessage,
} from "./api";
import { token } from "./auth";
import { type ChannelKey, channelKey, decodeChannelKey } from "./channelKey";
import { identityMoved } from "./identityMoved";
import { identityScopedStore } from "./identityScopedStore";
import { getReadCursor, setReadCursor } from "./readCursor";
import { getResumeCursor, recordSeen } from "./reconnectBackfill";
import type { UnreadMeasurement } from "./unreadCount";

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
// Identity-scoped state via identityScopedStore (dup-A3 close): thirteen
// resets registered (see the registration block below, which is the SSOT for
// the count — this line has been stale before). The factory preserves the A1
// invariant — registration runs before any verb fires, so no rotation can be
// missed for want of a registered reset.
//
// #788 — what the resets do NOT buy, and what this comment used to claim they
// did ("a logout/rotation between `loadInitialScrollback` start and finish
// always wins the race"): they clear STATE, they do not cancel a verb already
// in flight. Every ASYNC verb here captures `token()` at entry and then
// awaits, and nothing used to re-check it afterwards — so a continuation
// resuming past a rotation still held the bearer it captured, and the per-key
// in-flight guards that were NOT in the reset list (`refreshInFlight`,
// `jumpInFlight`) still held their keys. Ordering-with-cancellation was never
// implemented; the wording promised it anyway.
//
// That was not theoretical: delaying the reconnect backfill 400ms in a browser
// put a `/messages/count` on the wire 10ms AFTER the detach, carrying the
// revoked bearer. (#769, which surfaced it, turned out to be a spec race and
// is NOT that bug.) See `identityMoved` for the rule that closes it.
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
//     unread (id > cursor) → all protected. #1229 bounds that case too — see
//     `UNREAD_RETENTION_CAP` below; up to one page of unread is still exempt,
//     so this cap remains a soft ceiling by exactly that much.
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

// #1229 — the ceiling S20's cursor exemption never had. Every row at/after the
// read cursor was unevictable, so a channel the operator does not read holds
// ALL of them and the ring cap above does nothing. Measured on the reporter's
// window: 1084 unread rows; and because the pane renders every retained row
// (`<For each={rows()}>`, no virtualisation) each one costs ~19-26 KB of
// renderer memory, i.e. ~26 MB in ONE window against a ceiling iOS applies per
// web process. Retention and rendered DOM are the same curve, so bounding the
// store IS the DOM fix.
//
// The number is PAGE_LIMIT and deliberately not a new constant: `isFarBehind`
// already draws the line at "more than one page behind", so past this bound the
// client ALREADY classifies the window as far behind, and already has the whole
// apparatus for it — `anchorAtTail` keeps exactly one page, the divider is
// suppressed (`ScrollbackPane`'s `injectMarker` gate), and the
// "N unread — jump back" banner + `jumpToUnread` rebuild the region from the
// server, which owns it. A second threshold here would be a second answer to
// the same question, free to drift from the first.
//
// So the rule is: retain one page of unread and enter that existing state,
// rather than invent a pruned-window UX. Below the bound nothing changes — the
// divider contract is byte-identical to S20.
export const UNREAD_RETENTION_CAP = PAGE_LIMIT;

// Canonical scrollback ordering: `server_time` ASC, `id` ASC tie-break —
// the client mirror of the server's `[desc: server_time, desc: id]`
// (`Scrollback.fetch/5`). Single source so `mergeIntoScrollback` and
// `renameScrollbackKey` (#373) can never drift on the tie-break rule.
const byServerTimeThenId = (a: ScrollbackMessage, b: ScrollbackMessage): number => {
  if (a.server_time !== b.server_time) return a.server_time - b.server_time;
  return a.id - b.id;
};

// #1288 — the rows of `page` the pane does not already hold, in arrival order.
// First-write-wins, including WITHIN the page: an id repeated twice in one
// page yields the first occurrence, which is what the per-row loop this
// replaced did by deduping against a list it was growing as it went.
//
// One row SCANS and a page INDEXES, deliberately. The live WS append is the
// hot path and arrives one row at a time; it pays a single O(n) comparison
// pass and allocates nothing, where building a Set of every loaded id would
// cost it two allocations per message on a busy channel — more GC churn, which
// is the thing the profile complained about. A page cannot afford the scan:
// doing it P times IS the O(P*n) this exists to remove.
const freshRows = (
  existing: ScrollbackMessage[],
  page: ScrollbackMessage[],
): ScrollbackMessage[] => {
  const only = page.length === 1 ? page[0] : undefined;
  if (only !== undefined) return existing.some((m) => m.id === only.id) ? [] : page;
  const ids = new Set<number>();
  for (const m of existing) ids.add(m.id);
  return page.filter((m) => {
    if (ids.has(m.id)) return false;
    ids.add(m.id);
    return true;
  });
};

// Are these rows already in the order the store keeps them? Gates the
// append-without-sorting fast path below.
const isCanonicallyOrdered = (rows: ScrollbackMessage[]): boolean => {
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1];
    const cur = rows[i];
    if (prev !== undefined && cur !== undefined && byServerTimeThenId(prev, cur) > 0) return false;
  }
  return true;
};

// Trim `rows` (ASC by id) to the bounds below, ALWAYS by dropping a PREFIX —
// never a block out of the interior (#1538; the invariant is enforced by a test
// on this function, because global `messages.id` makes a hole undetectable from
// the outside afterwards).
//
// Two bounds, in order:
//   * the #1229 unread ceiling — past one page of unread the window collapses
//     to the newest page and the caller arms far-behind. See below.
//   * the S20 ring cap — under that ceiling, drop the OLDEST but NEVER a row
//     at/after the read cursor: the in-pane `── XX unread ──` divider anchors
//     on the cursor and its unread rows (CLAUDE.md "Read state is
//     server-owned"), so the evictable region is exactly the read context
//     strictly below the divider. With no cursor (fresh channel, no divider)
//     eviction is unconstrained.
//
// What the cap did, so the caller can arm the far-behind state without the
// pure updater reaching for a signal. `unreadDropped > 0` is the ONLY way a row
// at/after the cursor ever leaves the store on this path.
type CappedRing = {
  rows: ScrollbackMessage[];
  unreadDropped: number;
  // Unread rows (id > cursor) held BEFORE the drop — the banner's count the
  // first time the bound bites. Afterwards the caller accumulates.
  unreadHeld: number;
  // #2037 — the same figure restricted to `@content_kinds`. The banner's
  // number is the MESSAGES bucket, so accounting in raw row counts would mix
  // units: 200 evicted JOINs would move a figure the sidebar's bold pill
  // reports without them.
  //
  // The ARMING condition stays on the raw `unreadDropped`, deliberately. What
  // arms far-behind is "a row at/after the cursor left the store", which is
  // true of a JOIN too — the divider can no longer be placed either way. Only
  // the DISPLAYED quantity is content-only.
  //
  // issue 2069 deleted the `contentDropped` sibling this pair used to carry.
  // The far-behind count is maintained from ARRIVALS now, not from evictions —
  // see `appendPageToScrollback`. These two are still what ARMS the state and
  // what it opens at.
  contentHeld: number;
  cursor: number | null;
};

// #1538 — exported for its structural contiguity test, and for nothing else:
// no production caller outside this module. Same reason
// `shouldRescueUnderfillLoadOlder` is exported from `ScrollbackPane` — the
// decision is where the defect lives, so the decision is what a test must be
// able to address. See the invariant's own comment in `scrollback.test.ts`
// for why it CANNOT be checked from the outside after the fact.
export const capScrollbackRing = (key: ChannelKey, rows: ScrollbackMessage[]): CappedRing => {
  const decoded = decodeChannelKey(key);
  const cursor = decoded ? getReadCursor(decoded.slug, decoded.name) : null;
  // Rows are ASC by id, so the first index with id >= cursor bounds the
  // evictable prefix (everything before it is read-context below the divider).
  const firstProtected = cursor === null ? -1 : rows.findIndex((m) => m.id >= cursor);
  // The UNREAD region is `id > cursor` — one row narrower than the protected
  // region, which also holds the boundary row the divider anchors on. The
  // ceiling below is on THIS count, so both numbers are needed and they are
  // not interchangeable: measuring the ceiling against the protected region
  // instead spends the boundary row as the first eviction and moves the bite
  // one row early (see the two invariants restated below).
  const firstUnread = cursor === null ? -1 : rows.findIndex((m) => m.id > cursor);
  const unreadCount = firstUnread === -1 ? 0 : rows.length - firstUnread;
  // #2037 — the content-only twins, over the SAME slice the raw counts use so
  // the two can never describe different regions.
  const unreadRows = firstUnread === -1 ? [] : rows.slice(firstUnread);
  const contentCount = unreadRows.filter((m) => isContentKind(m.kind)).length;

  // #1229 — the protected region has a ceiling of its own, applied BEFORE the
  // ring cap because it can bite while the total is still under it (900 unread
  // and no read history is 900 rows the operator cannot see the top of).
  //
  // The ceiling is crossed at `unreadCount > UNREAD_RETENTION_CAP`, the SAME
  // comparison `isFarBehind` makes, because the bound's job is to deliver the
  // window into that state. Biting at `=== CAP` would arm the banner for a
  // window the reload path's gap probe still calls near, and the shared
  // constant exists precisely so those two cannot disagree.
  const overflowUnread =
    unreadCount > UNREAD_RETENTION_CAP ? unreadCount - UNREAD_RETENTION_CAP : 0;

  // #1538 — past the ceiling the window COLLAPSES to a contiguous tail window.
  //
  // It used to excise the oldest unread instead — `[...slice(0, firstUnread),
  // ...slice(firstUnread + overflowUnread)]`, two slices, a block lifted out of
  // the INTERIOR — on the argument that those rows are "off-screen BELOW,
  // leaving scrollTop and everything above it intact". That argument reads the
  // read cursor as a proxy for where the operator is looking, and the proxy
  // fails in exactly one case: the operator has scrolled DOWN past the divider
  // into the unread region. Then the rows just under the divider are the rows
  // on screen, and the excision cut them out from under them — two reporters,
  // #sniffo, nine rows out of the middle of a rendered range (#1538).
  //
  // So: keep the newest page, drop a PREFIX, never an interior block. What the
  // operator loses is the read context above the divider — and that is a cost
  // the pane ANNOUNCES, because the same transition arms far-behind: the
  // "N unread — jump back" banner goes up and `jumpToUnread` rebuilds the
  // region from the server. The excision's cost was a hole nothing declared and
  // scrolling up could not repair (`loadMore` pages before `rows[0]`, which sits
  // ABOVE the hole). An announced loss and a silent one are not comparable.
  //
  // This is also the shape `anchorAtTail` already produces, and for the reason
  // it already states: a non-contiguous loaded set "renders a silent hole — two
  // regions abutting as if they were consecutive". That verb refuses to create
  // one; this one no longer does either. Contiguity is now a property of every
  // path (`loadMore`, `loadNewer`, `jumpToUnread`, `anchorAtTail`, this), which
  // is what makes it an invariant worth a test rather than a habit.
  //
  // The BOUNDARY row (`id === cursor`) goes too, and that is deliberate: it is
  // exempt only because the divider anchors on it, and the far-behind state
  // this same transition arms SUPPRESSES the divider (`ScrollbackPane`'s
  // `injectMarker` gate). Keeping an anchor for a divider that is not drawn
  // would be keeping it for nobody. Below the ceiling the exemption is
  // untouched and S20's contract is byte-identical.
  //
  // Returning here leaves the ring cap below to the one case it still owns.
  // The kept slice is `UNREAD_RETENTION_CAP` rows and that constant is
  // `PAGE_LIMIT`, an order of magnitude under `SCROLLBACK_RING_CAP`, so the
  // ring cap has nothing left to say about this window.
  if (overflowUnread > 0) {
    return {
      rows: rows.slice(rows.length - UNREAD_RETENTION_CAP),
      unreadDropped: overflowUnread,
      unreadHeld: unreadCount,
      contentHeld: contentCount,
      cursor,
    };
  }

  const surplus = rows.length - SCROLLBACK_RING_CAP;
  let dropCount = surplus > 0 ? surplus : 0;
  if (cursor !== null && dropCount > 0) {
    // The evictable region is the read context strictly below the divider.
    const maxDroppable = firstProtected === -1 ? rows.length : firstProtected;
    if (dropCount > maxDroppable) dropCount = maxDroppable;
  }
  return {
    rows: dropCount > 0 ? rows.slice(dropCount) : rows,
    unreadDropped: 0,
    unreadHeld: unreadCount,
    contentHeld: contentCount,
    cursor,
  };
};

// #788 — how THE identity rule applies to this module. The predicate itself,
// and why a continuation that outlived its identity must do nothing further
// (the wire half and the store half), live in `identityMoved.ts`; below is
// only what is specific to these verbs.
//
// The store half is why the check sits after the await rather than in front of
// each REST call: a guard wrapped around the requests alone would not catch it
// — the poisoning happens between the resolved fetch and the next request.
//
// So: eleven of this module's fifteen awaits are followed by this check, and
// the bail is whatever "did nothing" means for that verb's return type. Two
// classes of await are exempt, four sites in all — the ones whose await is
// their last act (`probeGap`, and the two tail calls into `anchorAtTail`), and
// `resolveJumpTarget`, whose only successor is a pure value returned to a
// caller that checks immediately. A new verb that awaits and skips the check
// reopens the defect for its own call path only — which is exactly how this
// one survived: it was never a whole-module property, just an unwritten habit
// that the three verbs with a single await happened to keep.
//
// An await has THREE exits and all three are the verb's own conduct, so the
// check belongs at each one that touches state:
//
//   * resolve — the eleven above.
//   * reject — `api.ts` throws on any non-ok response, so a bearer revoked
//     WHILE the request was in flight comes back as a 401 throw, which is the
//     likelier arrival than a clean resolve. Only one catch in this module
//     writes state (`loadInitialScrollback` releasing its load-once gate); the
//     rest log and return, so only that one carries the check.
//   * finally — the per-key in-flight locks. Past a rotation the reset has
//     already cleared the Set, so an entry under this key belongs to the
//     identity that replaced us: deleting it unlocks a fetch that is still
//     running. Same for the `refreshScrollback` completion stamp, which would
//     tell a spec that ITS backfill had landed.
//
// The sibling adopters (`networks`, `displayPrefs`, `customTheme`) use the
// same predicate to drop a stale RESPONSE; this module uses it one step
// earlier, to refuse a stale REQUEST.

/**
 * #1094 — the synchronous seam `loadMore` wraps around its prepend.
 *
 * Called with no arguments IMMEDIATELY BEFORE the store write that prepends
 * the older page, and the function it returns (when it returns one) called
 * IMMEDIATELY AFTER that write, with nothing awaited in between.
 *
 * Why a seam and not a return value the caller acts on. What the pane has to
 * preserve across a prepend is GEOMETRY — the container's `scrollHeight` and
 * `scrollTop` — and geometry is only true at an instant. Read before the verb
 * is called it is stale by a whole network round trip: the operator carries on
 * scrolling past the threshold that armed the fetch, and live rows keep
 * appending at the tail, so BOTH terms of the height-delta correction move
 * under the snapshot and the pane restores the reader to where they were
 * rather than where they are. Read after the verb RESOLVES it is correct but
 * late by however many awaits the verb happens to have left, which is not a
 * number the caller can know and not one that stays fixed as the verb grows.
 * Bracketing the mutation is the only reading that is neither.
 *
 * `lib/scrollback.ts` stays DOM-free: the store says WHEN, the pane reads
 * WHAT. Returning nothing is legitimate — a caller that only wants the "about
 * to prepend" edge (or neither) says so by returning `undefined`.
 */
export type PrependCommitSeam = () => (() => void) | undefined;

const exports = identityScopedStore((onIdentityChange) => {
  const loadedChannels = new Set<ChannelKey>();
  // CP14 B2: per-key in-flight Set guards against scroll-burst fan-out
  // (the user flicks the scrollbar; the browser fires `scroll` 5+ times
  // in a frame and the onScroll handler would otherwise dispatch 5+
  // identical REST requests). While a key is in `loadMoreInFlight`, a
  // second `loadMore` call for the same key is a no-op. Released on every
  // terminal so a transient REST error doesn't permanently lock out
  // future retries — only the exhausted-latch is forward-only.
  //
  // #1094 — and it is a SIGNAL rather than a plain Set, unlike its four
  // siblings below, because the pane RENDERS from it: the older-page fetch
  // now has a loading affordance, and "is a page on the wire for this key"
  // is precisely this state. A second boolean mirroring it would be a
  // parallel structure with its own housekeeping to drift (CLAUDE.md: derive,
  // don't duplicate) — and it would drift on exactly the paths that matter,
  // the ones where the fetch ends badly. Reading it from `loadMore` creates
  // no reactive dependency: the verb runs outside any tracking scope.
  const [loadMoreInFlight, setLoadMoreInFlight] = createSignal<ReadonlySet<ChannelKey>>(new Set());
  const holdLoadMoreInFlight = (key: ChannelKey): void => {
    setLoadMoreInFlight((prev) => new Set(prev).add(key));
  };
  const releaseLoadMoreInFlight = (key: ChannelKey): void => {
    setLoadMoreInFlight((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  };
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
  //   * `missed` — the MESSAGES the operator has not read after the anchor
  //     (`@content_kinds`), at the moment of the decision. What the jump
  //     affordance shows. #2037 narrowed it from the raw row count: the raw
  //     figure is still what decides `isFarBehind`, but it is no longer
  //     rendered, because the bar was reporting a quantity nothing else on
  //     screen shared. This is now the SAME number the sidebar's bold pill
  //     carries — and literally so: `selection.ts` reads THIS field for a
  //     far-behind key rather than the seed, so the two cannot drift.
  //   * `events` — its sibling bucket. Not rendered by the bar; carried so
  //     the sidebar's faint pill has one origin with the bold one (#2037 B
  //     puts it behind an opt-in).
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
    Record<ChannelKey, { missed: number; events: number; resumeFrom: number }>
  >({});

  // #947 — "the pane's unread region is TRUNCATED, and here is what the server
  // said it really holds." Set by a jump that could only carry one page back
  // out of a gap that is >200 by the definition of far-behind: the flag comes
  // off, the #693 divider suppression lifts, and a count recomputed from the
  // loaded rows would read exactly the page size. The operator taps
  // "3000 unread — jump back" and lands on "── 200 unread messages ──" — the
  // fetch cap leaking into a user-visible number, one notch after the case
  // #693 suppressed.
  //
  //   * `through` — the newest id the pane can ACCOUNT for out of that
  //     measurement: the top of the contiguous run the jump loaded, extended
  //     by `loadNewer` as the pane pages forward into the region. issue 2069
  //     added it, and it is what lets the record survive a cursor that moves:
  //     `unreadMessagesAfter` subtracts the rows the cursor passed, which is
  //     only sound while the pane HELD them. A cursor that leaves the run —
  //     an own send lands at the tip, a peer device reads ahead — is past
  //     `through`, and the record stands down instead of answering with a
  //     number it cannot support. Without it the badge collapsed to the fetch
  //     page and then to ZERO on a window with thousands unread (measured on
  //     `b7989f4ba`: 3750 → 150 → 0 against a server answer of 3600).
  //   * `count` — the same server measurement the jump affordance advertised
  //     (`far.missed`). Deliberately the SAME number and not a second one:
  //     the alternative is showing the operator a third figure for one
  //     question, which is the whole of #2037.
  //     #2037 also narrowed what that number IS. It used to be the raw row
  //     count, which ran high against the divider's predicate (own-presence,
  //     operator echoes) and was tolerated for it; it is now the MESSAGES
  //     bucket, own-authored already excluded server-side, so the two agree
  //     on the same population instead of merely being one figure.
  //   * `at` — the cursor it was measured after. The record is spent only
  //     while the frozen divider is still anchored there, which is what makes
  //     it self-invalidating rather than a cache somebody has to remember to
  //     sweep: once the freeze re-latches, the answer stops applying on its
  //     own and the pane falls back to counting rows.
  const [measuredUnreadByChannel, setMeasuredUnreadByChannel] = createSignal<
    Record<ChannelKey, UnreadMeasurement>
  >({});

  const clearMeasuredUnread = (key: ChannelKey): void => {
    setMeasuredUnreadByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  };

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

  // Identity-transition cleanup, and the SSOT for what an identity transition
  // clears. Thirteen registered resets fired by the factory's
  // createEffect(on(token, ...)) — eight Set.clear() (loadedChannels +
  // loadMore{InFlight,Exhausted} + loadNewer{InFlight,Exhausted}, #161 +
  // refreshInFlight + refreshQueued, #1593 + jumpInFlight, #788) + five
  // signal flushes
  // (scrollbackByChannel + lastOwnSend + ownSendSubmitted, #580 +
  // farBehindByChannel, #693 + measuredUnreadByChannel, #947). Order matches
  // the pre-A3 inline shape.
  //
  // #788 — the last two are registered here, away from their declarations
  // beside the verbs that own them, precisely BECAUSE that distance is how
  // they came to be missed: this list is the thing to read when asking "what
  // survives a rotation", so a lock that is not on it is a lock nobody will
  // remember. Left held, they were a real defect and not merely untidy — an
  // in-flight refresh for identity A keeps A's key until its continuation
  // reaches the `finally`, and B's `refreshScrollback` for the same key
  // short-circuits in the meantime, so B's window silently never backfills.
  //
  // Clearing a Set mid-flight would otherwise let A's `finally` delete a key B
  // has since re-added, unlocking a fetch that is still running. Every one of
  // the four in-flight `finally` blocks therefore releases its key only while
  // the identity still holds — past a rotation the reset owns the Set and the
  // continuation owns nothing. (An id-dedupe argument covers only the two
  // merge paths; `jumpToUnread` REPLACES the key's rows, so a second concurrent
  // jump would discard whatever landed between the two writes.)
  onIdentityChange(() => loadedChannels.clear());
  onIdentityChange(() => setLoadMoreInFlight(new Set()));
  onIdentityChange(() => loadMoreExhausted.clear());
  onIdentityChange(() => loadNewerInFlight.clear());
  onIdentityChange(() => loadNewerExhausted.clear());
  onIdentityChange(() => refreshInFlight.clear());
  onIdentityChange(() => refreshQueued.clear());
  onIdentityChange(() => jumpInFlight.clear());
  onIdentityChange(() => setScrollbackByChannel({}));
  onIdentityChange(() => setLastOwnSend(null));
  onIdentityChange(() => setOwnSendSubmitted(null));
  onIdentityChange(() => setFarBehindByChannel({}));
  onIdentityChange(() => setMeasuredUnreadByChannel({}));

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
  //
  // #1288 — this is the PAGE-shaped verb, and `appendToScrollback` below is
  // its P=1 case. The live WS handler ingests one row; `refreshScrollback`
  // ingests a whole REST catch-up page, and used to do it by calling the
  // single-row verb once per row. That cost O(page * pane) array work and —
  // the part that reaches the DOM — one Solid signal write, hence one reactive
  // pass, PER MESSAGE. A reporter's Firefox Profiler trace (desktop, 9 s
  // capture) put 1917 of 2002 cicchetto samples under `refreshScrollback`, in
  // 21 bursts of 20-180 ms, with DOM construction/teardown and cycle
  // collection as the native leaves. One write per page collapses that to
  // O(page + pane) and a single pass.
  //
  // Why NOT `mergeIntoScrollback`, which is already batched and sits right
  // below: it is a different verb, not a faster spelling of this one. It
  // applies no S20 ring cap — deliberately, so a scroll-up prepend is not
  // truncated mid-scroll — and therefore never invalidates the loadMore
  // exhausted latch an eviction implies. Reusing it here would have silently
  // dropped the cap from the reconnect catch-up path, which is one of the two
  // paths S20 was written for.
  //
  // The cap is applied ONCE over the union instead of after every row. Same
  // result on every ordinary ingest: eviction only ever drops from the head,
  // the protected suffix is decided by the same read cursor either way, and
  // the arithmetic (drop min(surplus, unprotected-prefix)) does not care
  // whether the surplus arrived in one step or P. The two differ only when a
  // page carries rows OLDER than what the cap is evicting, where the batch
  // keeps the newest CAP rows of the union and the loop could keep a late
  // arrival while having already dropped a newer row.
  const appendPageToScrollback = (key: ChannelKey, page: ScrollbackMessage[]): void => {
    if (page.length === 0) return;
    // S20: track whether the ring cap evicted older rows so we can reset the
    // loadMore exhausted latch below. Computed inside the pure updater,
    // consumed after it runs (Solid calls a plain-signal updater exactly once,
    // synchronously) — keeps the setter body free of the Set side-effect.
    let evicted = false;
    // #1229 — same shape as `evicted` above, for the other side effect the cap
    // can imply: rows at/after the cursor were dropped, so the window is now
    // far behind and the pane must say so instead of drawing a divider it can
    // no longer place.
    let unreadDropped = 0;
    let unreadHeld = 0;
    let contentHeld = 0;
    let prunedCursor = 0;
    // issue 2069 — what ARRIVED: fresh rows newer than everything the pane
    // already held. This is the quantity a far-behind window's count grows by,
    // and it is deliberately measured BEFORE the ring cap runs, because the cap
    // is why the pane cannot answer the question afterwards.
    let arrivedContent = 0;
    let arrivedEvents = 0;
    // #1229 — the rows and the far-behind flag are ONE state transition and must
    // reach consumers in ONE flush. Published as two writes, Solid runs every
    // effect of the rows change FIRST, in a world where the window has already
    // been pruned but is not yet far behind — a state that never logically
    // exists. `ScrollbackPane`'s content-change gate is one such consumer and it
    // read exactly that: it admitted a divider activation (divider still
    // rendered, far-behind not yet set) whose deferred write landed two frames
    // later with the divider suppressed, and tail-snapped a reader parked in
    // their history.
    batch(() => {
      setScrollbackByChannel((prev) => {
        const existing = prev[key] ?? [];
        const fresh = freshRows(existing, page);
        // Nothing new: return the SAME object so Solid's equality check skips
        // the write entirely. A wholly-duplicate page (every row already live)
        // must not re-render the pane.
        if (fresh.length === 0) return prev;
        const tail = existing[existing.length - 1];
        const head = fresh[0];
        // #423 order-safe insert, generalised from one row to a page: append
        // without sorting when the arriving rows are themselves in canonical
        // order AND start at/after the current tail — true of every live append
        // and of every ASC catch-up page. Re-sort only when they interleave with
        // rows the pane already holds.
        const next =
          head !== undefined &&
          (tail === undefined || byServerTimeThenId(head, tail) >= 0) &&
          isCanonicallyOrdered(fresh)
            ? [...existing, ...fresh]
            : [...existing, ...fresh].sort(byServerTimeThenId);
        // issue 2069 — an ARRIVAL is a fresh row above the pane's previous
        // newest. Rows at or below it are backfill: already inside whatever
        // measurement the far-behind record carries, so counting them would
        // report the same message twice.
        const previousNewest = tail?.id ?? 0;
        for (const m of fresh) {
          if (m.id <= previousNewest) continue;
          if (isContentKind(m.kind)) arrivedContent++;
          else arrivedEvents++;
        }
        const capped = capScrollbackRing(key, next);
        evicted = capped.rows.length < next.length;
        unreadDropped = capped.unreadDropped;
        unreadHeld = capped.unreadHeld;
        contentHeld = capped.contentHeld;
        prunedCursor = capped.cursor ?? 0;
        return { ...prev, [key]: capped.rows };
      });
      // Eviction removed older history → the loadMore exhausted latch (if set)
      // is now stale: the server DOES have rows older than the new oldest. Clear
      // it so a scroll-to-top re-pages the evicted region.
      if (evicted) loadMoreExhausted.delete(key);
      // #1229 — the pruned window joins the #693 far-behind state: divider
      // suppressed, "N unread — jump back" banner up, `jumpToUnread` rebuilding
      // the region from the server around this same `resumeFrom`. The count
      // ACCUMULATES once the state is up: after the first bite the store only
      // ever holds one page, so a recount would report 200 forever while the
      // operator is thousands behind.
      //
      // 🔴 issue 2069 — it accumulates by what ARRIVED, not by what was
      // EVICTED, and the difference is the whole of symptom A. Counting
      // evictions is wrong twice over: below the retention cap nothing is
      // evicted, so an entire page of arrivals is invisible; above it the
      // increment carries the KIND OF THE ROW THAT LEFT, which on a mixed log
      // is not the kind of the row that came in. Measured on `b7989f4ba` with
      // a 3:1 message:JOIN log, 500 arrivals moved the count to 4012 against a
      // server answer of 4125 — and the drift was invisible until the next
      // FULL `?after=` page fired the gap probe and `anchorAtTail` overwrote
      // the number with a fresh measurement. That correction is what the
      // report saw as "the badge changed on a re-select": no scroll, no read,
      // +113 in one step. Arrivals are exact, independent of the cap, and
      // leave the probe nothing to correct.
      if (unreadDropped > 0 || arrivedContent + arrivedEvents > 0) {
        setFarBehindByChannel((prev) => {
          const current = prev[key];
          // Arrivals alone never ARM the state — that stays keyed on the raw
          // `unreadDropped` (a JOIN leaving the store unplaces the divider
          // exactly as a message does). An ordinary live append to an ordinary
          // window returns `prev` unchanged and Solid skips the write.
          if (current === undefined) {
            if (unreadDropped === 0) return prev;
            return {
              ...prev,
              [key]: {
                // #2037 — opens in the CONTENT unit, the same one the probe
                // writes and the pill reads. The rows that arrived in THIS
                // batch are already inside `contentHeld`, so they are not
                // added again.
                missed: contentHeld,
                events: unreadHeld - contentHeld,
                resumeFrom: prunedCursor,
              },
            };
          }
          if (arrivedContent + arrivedEvents === 0) return prev;
          return {
            ...prev,
            [key]: {
              missed: current.missed + arrivedContent,
              events: current.events + arrivedEvents,
              // The anchor tracks the frozen cursor exactly as it did before.
              // The `> 0` guard is new because the arrivals-only path can now
              // reach this line with no read cursor at all, where `?? 0` would
              // overwrite a real anchor with zero; the eviction-only path could
              // not, since a cap bite at/after the cursor implies one exists.
              resumeFrom: prunedCursor > 0 ? prunedCursor : current.resumeFrom,
            },
          };
        });
      }
    });
  };

  const appendToScrollback = (key: ChannelKey, msg: ScrollbackMessage) => {
    appendPageToScrollback(key, [msg]);
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
    // #947 — same argument, same migration set (CLAUDE.md #373: a new
    // nick-keyed store that skips this strands its old-nick rows). The count
    // is about a conversation, not about a spelling of the peer's nick;
    // stranded, the relabeled pane falls back to counting its truncated rows
    // and shows the page size — the number this record exists to replace.
    setMeasuredUnreadByChannel((prev) => {
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
  //
  // Three callers reach this verb and they are indistinguishable on the wire —
  // same URL shape, and two of the three anchor at the read cursor. They are
  // also NOT symmetric with respect to identity, which is what #788 turned on:
  // the cold-open call below runs with NO await between its `token()` capture
  // and this request (`getReadCursor` is a synchronous signal read), so it
  // cannot reach the wire under anything but the current bearer, while the two
  // reconnect callers await first and could carry a revoked one. Each of those
  // two now checks `identityMoved` before it gets here; this verb takes no
  // check of its own because its await is its last act.
  const probeGap = async (
    t: string,
    slug: string,
    name: string,
    anchor: number,
  ): Promise<GapProbe | null> => {
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
    events: number,
    resumeFrom: number,
  ): Promise<void> => {
    const key = channelKey(slug, name);
    const page = await listMessages(t, slug, name);
    if (identityMoved(t)) return;
    const rows = [...page].sort(byServerTimeThenId);
    const newest = rows[rows.length - 1]?.id ?? 0;
    setScrollbackByChannel((prev) => {
      const live = (prev[key] ?? []).filter((m) => m.id > newest);
      return { ...prev, [key]: [...rows, ...live].sort(byServerTimeThenId) };
    });
    for (const msg of rows) recordSeen(key, msg);
    loadMoreExhausted.delete(key);
    setFarBehindByChannel((prev) => ({ ...prev, [key]: { missed, events, resumeFrom } }));
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
  //
  // #788 exemption: no `identityMoved` check after the await here. This verb
  // has no successor of its own — it returns two numbers, and the caller
  // checks before spending them. Adding one would mean inventing a bail value
  // for a function that cannot do harm.
  const resolveJumpTarget = async (
    t: string,
    slug: string,
    name: string,
    anchor: number,
    probeAtAnchor: GapProbe,
  ): Promise<{ missed: number; events: number; resumeFrom: number }> => {
    const atAnchor = {
      missed: probeAtAnchor.messages,
      events: probeAtAnchor.events,
      resumeFrom: anchor,
    };
    const cursor = getReadCursor(slug, name);
    if (cursor === null || cursor >= anchor) return atAnchor;
    const probe = await probeGap(t, slug, name, cursor);
    return probe === null
      ? atAnchor
      : { missed: probe.messages, events: probe.events, resumeFrom: cursor };
  };

  const clearFarBehind = (key: ChannelKey): void => {
    setFarBehindByChannel((prev) => {
      if (!(key in prev)) return prev;
      const { [key]: _drop, ...rest } = prev;
      return rest;
    });
  };

  // issue 2050 — the record retires itself when the read cursor catches up.
  //
  // Before this, the three exits above were the whole list (`jumpToUnread`,
  // `dismissFarBehind`, `purgeScrollback`) and NONE of them was keyed on the
  // cursor. That is the hole: both consumers of the record — the badge memo,
  // which discards local truth for the frozen `serverSeedCounts` value
  // (`selection.ts` `perChannelUnread`), and `setCursorIfAdvances`, which
  // freezes the cursor — are sound only while the cursor sits where it did
  // when the record was written, and it does not stay there. Measured: one
  // `sendMessage` puts the cursor at the tip with nothing unread while the
  // badge holds 5000 across a visit, a read at the tail, a reopen and the
  // activation refetch, clearing only on the next app restart.
  //
  // An EFFECT rather than a call at the doors that move it, because the doors
  // are not a closed set. Two bypass the frozen one today — `sendMessage`'s
  // direct `setReadCursor` (deliberately not routed through
  // `setCursorIfAdvances`; see its comment) and `applyReadCursorSet`, the
  // unconditional cross-device echo — and the hydration paths (`/me`, the
  // join reply) are two more. Patching the known ones cures the instances and
  // leaves the next one to be found in production. Watching the cursor cures
  // the class: whatever moves it, the record is re-examined.
  //
  // THE BOUND is "the loaded window already reaches down to the read
  // position", i.e. nothing is missing between the cursor and what the pane
  // holds. That is the record's own claim — "the unread region is NOT in this
  // pane" — stated rather than approximated. The two alternatives were
  // measured and rejected:
  //
  //   * `cursor >= resumeFrom + missed` adds an ID to a per-channel row
  //     COUNT. `messages.id` is one global autoincrement across every network
  //     and channel (a single `messages` table), so the sum is not an id at
  //     all: with two channels interleaved on that sequence it fires at HALF
  //     the region, and the error scales to ~1/N with N busy channels — worst
  //     exactly when the absence was longest. Measured retiring the record
  //     with 2500 rows still unread, which is the destructive unfreeze #693
  //     exists to refuse.
  //   * `cursor >= newest loaded` is not wrong, it says less: it closes only
  //     at the very newest row, so an operator who has scrolled INTO the
  //     loaded window keeps a "jump back" bar over a pane with no hole left.
  //
  // CAVEAT, named rather than discovered later: `loadMore` prepends older
  // rows and LOWERS the oldest loaded id, so scrolling up far enough
  // satisfies this bound. That is correct, and the reason is that clearing
  // here THAWS — it does not mark anything read. The badge stops publishing
  // the frozen seed and goes back to LOCAL truth, which is still N if N rows
  // follow the cursor; the difference is that it is now a live number the
  // operator retires by reading. Re-paging the region back into the pane IS
  // closing the hole, so the far-behind apparatus has nothing left to do.
  // What T1 would have done is the opposite: unfreeze while the pane was
  // still holed, leaving local truth incomplete and the count under-reported.
  //
  // That was an ARGUMENT when this shipped and is now a measurement: the last
  // arm of `unreadBadgeFarBehindStale.test.ts` scrolls the window down to a
  // cursor that never moves and pins the badge to local truth (5003) rather
  // than to zero, to the frozen seed, or to a short count. A bound that
  // retired one page into the scroll passed every other arm in that file.
  //
  // `measuredUnreadByChannel` (#947) is deliberately NOT cleared alongside:
  // the pane spends it only while `measured.at === cursor`, so a cursor that
  // moved has already expired it.
  createEffect(() => {
    const far = farBehindByChannel();
    const sb = scrollbackByChannel();
    batch(() => {
      for (const rawKey of Object.keys(far)) {
        const key = rawKey as ChannelKey;
        // No rows loaded says nothing about where the region is — keep the
        // record. Same for an unreadable key and for a channel with no read
        // position at all: absence of evidence, not evidence of catching up.
        const oldestLoaded = sb[key]?.[0]?.id;
        if (oldestLoaded === undefined) continue;
        const decoded = decodeChannelKey(key);
        if (decoded === null) continue;
        const cursor = getReadCursor(decoded.slug, decoded.name);
        if (cursor === null) continue;
        // `oldestLoaded - 1` and not `oldestLoaded`: the boundary case is a
        // cursor sitting exactly one row below the oldest loaded, where the
        // first unread row IS `rows[0]` and the pane is already contiguous.
        if (cursor >= oldestLoaded - 1) clearFarBehind(key);
      }
    });
  });

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
      if (identityMoved(t)) return false;
      // Disjoint by construction — `after(cursor)` is `id > cursor`,
      // `before(cursor + 1)` is `id <= cursor` — so concat + sort needs no
      // dedupe pass.
      const rows = [...afterPage, ...beforePage].sort(byServerTimeThenId);
      setScrollbackByChannel((prev) => ({ ...prev, [key]: rows }));
      // The pane no longer holds the tail, and there IS older history below
      // the new oldest row — both latches are stale.
      loadNewerExhausted.delete(key);
      loadMoreExhausted.delete(key);
      // #947 — a FULL page says the unread region did not fit, so the divider
      // about to be un-suppressed cannot count it. Hand it the number we
      // already measured rather than dropping it here and letting the pane
      // report the page size. A SHORT page drained the whole region: the rows
      // ARE the count, and a carried number could only go stale against them.
      if (afterPage.length === PAGE_LIMIT) {
        setMeasuredUnreadByChannel((prev) => ({
          ...prev,
          [key]: {
            at: far.resumeFrom,
            count: far.missed,
            // issue 2069 — the top of the run this jump can account for. The
            // page is contiguous from `at` by construction (`after(at)` ASC,
            // no cap in play at one page), so every row between the two is in
            // the pane and a cursor moving through them is subtractable.
            through: afterPage[afterPage.length - 1]?.id ?? far.resumeFrom,
          },
        }));
      } else {
        clearMeasuredUnread(key);
      }
      clearFarBehind(key);
      return true;
    } catch (err) {
      console.error("[scrollback] jumpToUnread failed", slug, name, err);
      return false;
    } finally {
      if (!identityMoved(t)) jumpInFlight.delete(key);
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
        if (identityMoved(t)) return;
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
        const probe = await probeGap(t, slug, name, cursor);
        if (identityMoved(t)) return;
        // #2037 — the THRESHOLD reads `probe.gap` (raw rows, the #693
        // question: is contiguous paging achievable) and the DISPLAY reads
        // `probe.messages`. Two questions, two fields, one round trip.
        if (probe !== null && isFarBehind(probe.gap)) {
          await anchorAtTail(t, slug, name, probe.messages, probe.events, cursor);
        } else {
          const [afterPage, beforePage] = await Promise.all([
            listMessagesAfter(t, slug, name, cursor, PAGE_LIMIT),
            listMessages(t, slug, name, cursor + 1),
          ]);
          if (identityMoved(t)) return;
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
      //
      // #788 — the reject path is the likelier arrival for a bearer revoked
      // in flight (`api.ts` throws the 401), and this gate is identity-scoped
      // state. Releasing it past a rotation releases the NEW identity's gate:
      // its next re-select reads `wasLoaded` false, takes the fresh-open arm
      // that deliberately does NOT fire `refreshScrollback` (#159), and so
      // skips one live-delivery catch-up while re-paying for a cold load.
      if (identityMoved(t)) return;
      loadedChannels.delete(key);
    }
  };

  // #1094 — the fetch half of `loadMore`, split out so the `catch` that
  // deliberately swallows a transient REST failure covers the REQUEST and
  // nothing else. What follows it is a DOM-visible scroll write supplied by
  // the pane, and a boundary that absorbs an exception from that would hide
  // the next bug to fall into it (CLAUDE.md: no silent-swallow at boundaries).
  //
  // `null` is the failure; it is NOT `[]`, which is the server answering "no
  // older rows" and is what latches `loadMoreExhausted`. Collapsing the two
  // would latch the channel permanently on one flaky request.
  const fetchOlderPage = async (
    t: string,
    slug: string,
    name: string,
    before: number,
  ): Promise<ScrollbackMessage[] | null> => {
    try {
      return await listMessages(t, slug, name, before);
    } catch {
      return null;
    }
  };

  const loadMore = async (
    slug: string,
    name: string,
    aroundCommit: PrependCommitSeam,
  ): Promise<void> => {
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
    if (loadMoreInFlight().has(key)) return;
    const current = scrollbackByChannel()[key];
    if (!current || current.length === 0) return;
    const oldest = current[0];
    if (!oldest) return;
    // Held SYNCHRONOUSLY, before the first await: the pane's loading
    // affordance reads this, and one set a microtask later is one the
    // operator's own next scroll event beats to the draw.
    holdLoadMoreInFlight(key);
    // CP29 R-2: cursor flipped from `oldest.server_time` to
    // `oldest.id`. The server-side `?before=` parameter now expects
    // a `messages.id` value, eliminating same-ms ties that straddled
    // page boundaries pre-flip.
    const page = await fetchOlderPage(t, slug, name, oldest.id);
    // Past a rotation the identity reset already emptied the in-flight set, so
    // releasing here would unlock a fetch belonging to whoever replaced us.
    if (identityMoved(t)) return;
    try {
      // issue 2050 — the WINDOW moved under the fetch. This page was computed
      // as "older than `oldest.id`", and it only abuts the pane while that row
      // is still the head. `anchorAtTail` (#693) replaces the whole window
      // mid-flight and the ring cap can evict the head, so prepending here
      // splices two non-adjacent regions — the silent hole `anchorAtTail`
      // refuses to create and #1538 made an invariant of every path. Same
      // sentence `loadInitialScrollback` already applies to its own two pages:
      // the loser drops them, they describe a window the pane has left.
      //
      // Before the empty-page latch on purpose: a window that moved says
      // nothing about whether the NEW head has older rows.
      if (scrollbackByChannel()[key]?.[0]?.id !== oldest.id) return;
      // A transient failure does NOT latch as exhausted: the operator can
      // retry by scrolling again, and the in-flight guard releases below.
      if (page === null) return;
      // CP14 B2: empty page from the server means there's no older
      // history to load. Latch the channel so subsequent scroll-to-
      // top events don't re-fetch. No prepend, so the seam stays shut —
      // there is no mutation for the pane to compensate for.
      if (page.length === 0) {
        loadMoreExhausted.add(key);
        return;
      }
      // #1094 — the commit seam, wrapped tight around the ONE store write
      // that prepends the page. Solid flushes a signal write's render effects
      // and user effects before the setter returns, so `settled` runs with the
      // new rows already in the DOM, in this same task, with no frame between
      // it and the mutation. See `PrependCommitSeam`.
      const settled = aroundCommit();
      mergeIntoScrollback(key, page);
      settled?.();
    } finally {
      releaseLoadMoreInFlight(key);
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
      if (identityMoved(t)) return;
      // Empty forward page = the local tail IS the live server tail. Latch
      // so subsequent scroll-to-bottom events (including the auto-follow
      // scroll that fires when a live row appends at the tail) are no-ops.
      if (page.length === 0) {
        loadNewerExhausted.add(key);
      } else {
        mergeIntoScrollback(key, page);
        // issue 2069 — paging forward EXTENDS the run a carried measurement
        // can account for. The fetch is `after(<newest loaded>)`, so the page
        // abuts what the pane already holds and the union stays contiguous;
        // without this the record stands down the moment the operator reads
        // past the page the jump landed them on, which is the one gesture the
        // record exists to survive.
        const top = page.reduce((max, m) => (m.id > max ? m.id : max), newest.id);
        setMeasuredUnreadByChannel((prev) => {
          const current = prev[key];
          if (current === undefined || top <= current.through) return prev;
          return { ...prev, [key]: { ...current, through: top } };
        });
      }
    } catch {
      // Transient error — do NOT latch. The user can retry by scrolling;
      // the in-flight guard releases via the `finally` below.
    } finally {
      if (!identityMoved(t)) loadNewerInFlight.delete(key);
    }
  };

  // #640/#1225 — `relay` (optional) makes this a send whose WIRE recipient is
  // someone other than the window: a CTCP QUERY (/ctcp, /ping) or a NOTICE
  // (/notice). `name` is the SOURCE window the echo renders in (where the
  // operator typed the command), `relay.target` is the wire recipient. All the
  // own-send bookkeeping (submit-snap, cursor advance, divider re-latch) is
  // keyed on `name` = the source window — exactly where the echo lands — so it
  // is byte-identical to a plain send once `name` is the source. That cursor
  // advance is also what keeps the operator's OWN notice from badging them:
  // `notice` is an unread-counting content kind, and the echo is a real row.
  // Absent, it is a normal PRIVMSG to the window itself.
  const sendMessage = async (
    slug: string,
    name: string,
    body: string,
    relay?: MessageRelay,
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
    const row = await apiSendMessage(t, slug, name, body, relay);
    // #788 — the cursor POST below was already unreachable past a rotation, but
    // only by accident: the store purge empties the pane, `hasRenderedRow`
    // goes false, and the anti-poison gate declines. That is a guarantee owed
    // to an unrelated invariant, one refactor away from evaporating. State it.
    if (identityMoved(t)) return;
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
    // #1430 — `null` is the server's 202 "accepted, no row": a `*Serv` target,
    // `/notice` to a service, a no-persist CTCP. Nothing was persisted, so
    // there is no id to advance the cursor TO and no row to advance it PAST.
    // The gate is skipped whole rather than run against an absent id — which
    // is what the old cast produced, since `{ok: true} as ScrollbackMessage`
    // reaches here with `id` undefined and a null cursor lets the disjunct
    // through. The send-relatch below still fires: the operator did send in
    // this window, and that is unchanged by whether a row came back.
    if (row !== null && hasRenderedRow && (current === null || row.id > current)) {
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
  // In-flight guard: per-key Set prevents two `?after=` fetches for the same
  // key being on the wire CONCURRENTLY under bursty rejoin sequences
  // (phoenix.js's `Push.resend()` can fire `.receive("ok")` twice for stale
  // outbound pushes that succeed post-rejoin — see socket.ts moduledoc).
  // Released in `finally` so a transient REST error doesn't latch out future
  // retries.
  //
  // #1593 — the guard QUEUES the loser, it does not DROP it. A caller that
  // arrives mid-flight asked AFTER the running fetch issued its query, so it
  // is the only one that can observe rows written since; dropping it throws
  // away the observation and nothing ever goes back for those rows. That is
  // not hypothetical — it is the reconnect's normal shape, because
  // `subscribe.ts` fires TWO refreshes per already-joined key and they
  // reliably overlap:
  //
  //   * the socket-open sweep (`socketHealth().state` → "open", #159 item 3)
  //     runs over `joined.keys()` the moment the transport is back — BEFORE
  //     any per-channel topic has rejoined, so by construction it cannot
  //     cover rows written after its own query;
  //   * the per-channel join-ok refresh (CP29 R-5) runs once that topic's
  //     subscription is live, and is the only one whose fetch is ordered
  //     after the subscription that will carry everything later.
  //
  // Measured on CI run 32351074283 (`0-trace.network` of the failing
  // `issue254-own-echo-live.spec.ts:235`): the sweep put three GETs on the
  // wire at 09:08:32.725/.726/.727, each still unresolved when its own
  // topic's join completed (.737, .749, .754 server-side) — all three join-ok
  // refreshes were dropped, and the row persisted at .751 into a topic that
  // had no subscriber was never fetched again by any later request in the
  // whole trace.
  //
  // The re-run closes the hole rather than narrowing it: it is triggered BY
  // the post-subscription caller, so its response covers the server up to a
  // point after the subscription went live, and everything past that arrives
  // over the WS. Cost is at most one extra short `?after=` per in-flight
  // window per key — and a caller arriving during the re-run coalesces into
  // the same single slot, so the chain is bounded by the arrival of new
  // events, not by the number of callers.
  //
  // High-water mark rolls forward as we ingest so a SECOND disconnect
  // mid-refresh resumes from the new highest id rather than the
  // original cursor — same property the pre-CP29-R5 reconnectBackfill
  // ran inside `runBackfill`, preserved here for the same reason.
  const refreshInFlight = new Set<ChannelKey>();
  const refreshQueued = new Set<ChannelKey>();

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
    if (refreshInFlight.has(key)) {
      // #1593 — queue, never drop. See the `refreshQueued` declaration.
      refreshQueued.add(key);
      return;
    }
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
      if (identityMoved(t)) return;
      // #1288 — ONE store write for the whole page (see
      // `appendPageToScrollback`). `recordSeen` still walks it row by row: it
      // is a plain Map high-water mark with no reactive surface, so iterating
      // it costs nothing the profile can see, and no await separates it from
      // the ingest — the "second disconnect mid-refresh" its roll-forward
      // exists for cannot land between the two.
      appendPageToScrollback(key, page);
      for (const msg of page) recordSeen(key, msg);
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
        const probe = await probeGap(t, slug, name, anchor);
        if (identityMoved(t)) return;
        if (probe !== null && isFarBehind(probe.gap)) {
          const target = await resolveJumpTarget(t, slug, name, anchor, probe);
          if (identityMoved(t)) return;
          await anchorAtTail(t, slug, name, target.missed, target.events, target.resumeFrom);
        }
      }
    } catch (err) {
      // Transient error — leave the cursor alone so the next reconnect
      // retries. Log to console for operator diagnosis; Phase 5
      // telemetry hook will replace this.
      console.error("[scrollback] refreshScrollback failed", slug, name, err);
    } finally {
      if (!identityMoved(t)) {
        refreshInFlight.delete(key);
        if (refreshQueued.delete(key)) {
          // #1593 — a caller landed while this fetch was on the wire. Run it
          // now, from a freshly resolved resume cursor (the page we just
          // ingested has already rolled the high-water mark forward, so this
          // asks only for what is still missing). Fire-and-forget: the
          // re-run owns its own errors, and awaiting it here would make the
          // LEADING caller's promise mean something different from every
          // other caller's.
          void refreshScrollback(slug, name);
        } else {
          // #552 — mark this backfill DONE (success or error): no more
          // in-flight DOM recreation for this key, so a spec awaiting it can
          // safely proceed. Deliberately NOT stamped when a re-run is owed —
          // the seam means "and none is about to start", so stamping here
          // would hand `waitForScrollbackRefreshed` the false all-clear the
          // seam exists to remove.
          stampScrollbackRefreshed(key);
        }
      }
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
    releaseLoadMoreInFlight(key);
    loadNewerExhausted.delete(key);
    loadNewerInFlight.delete(key);
    // #693 — the rows the far-behind record points back to were just deleted
    // server-side; offering to jump into them would 404 the affordance.
    clearFarBehind(key);
    // #947 — and the count of those rows is now a count of nothing.
    clearMeasuredUnread(key);
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

  // #1094 — "an older page is on the wire for this window". The pane renders
  // its loading affordance from this and nothing else, so the flag and the
  // guard that makes the fetch idempotent are the SAME state: an affordance
  // derived from a second boolean would be the one that hangs when a fetch
  // ends on a path whoever added it forgot about.
  const isLoadingOlder = (slug: string, name: string): boolean =>
    loadMoreInFlight().has(channelKey(slug, name));

  return {
    scrollbackByChannel,
    appendToScrollback,
    dismissFarBehind,
    farBehindByChannel,
    isLoadingOlder,
    jumpToUnread,
    loadInitialScrollback,
    loadMore,
    loadNewer,
    measuredUnreadByChannel,
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
export const isLoadingOlder = exports.isLoadingOlder;
export const jumpToUnread = exports.jumpToUnread;
export const loadInitialScrollback = exports.loadInitialScrollback;
export const loadMore = exports.loadMore;
export const loadNewer = exports.loadNewer;
export const measuredUnreadByChannel = exports.measuredUnreadByChannel;
export const purgeScrollback = exports.purgeScrollback;
export const renameScrollbackKey = exports.renameScrollbackKey;
export const refreshScrollback = exports.refreshScrollback;
export const sendMessage = exports.sendMessage;
export const lastOwnSend = exports.lastOwnSend;
export const ownSendSubmitted = exports.ownSendSubmitted;
export const wasLoaded = exports.wasLoaded;
