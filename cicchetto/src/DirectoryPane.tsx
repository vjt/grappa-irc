import { type Component, createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { ApiError, type DirectoryEntry, postJoin } from "./lib/api";
import { token } from "./lib/auth";
import {
  directoryError,
  directoryPage,
  directoryQuery,
  directorySort,
  isLoadingMore,
  isRefreshPending,
  loadDirectory,
  loadMore,
  resetDirectory,
  setQuery,
  setSort,
  triggerRefresh,
} from "./lib/channelDirectory";
import { canonicalChannel, channelKey } from "./lib/channelKey";
import { friendlyApiError } from "./lib/friendlyApiError";
import { bindPullGesture, PULL_COMMIT_PX } from "./lib/pullGesture";
import { closeToPreviousWindow, setSelectedChannel } from "./lib/selection";
import { windowStateByChannel } from "./lib/windowState";
import { MircBody } from "./MircText";

// E3 (#84) — Per-network channel directory pane ($list window).
//
// Shows a search box, refresh button, a close button (#125), total count,
// "last refreshed N ago" with a stale CTA, a sort toggle, and a scrollable
// list of channels. Tapping an UNjoined row JOINs it AND foregrounds its
// window (#244, amending #125's original no-auto-open); tapping an already-
// joined row OPENS its window (#125, consistent with the HomePane
// featured-link behaviour from #85). Joined rows carry a
// "joined" badge; featured rows a "featured" label (sorted by user count
// like everything else, not pinned). Topics render through MircBody (the
// shared mIRC formatter) — color codes show as styled spans, not raw
// control chars — and wrap fully. The row layout is responsive (see the
// .directory-row-join grid in default.css): no horizontal scroll. The
// close button returns to the previously active window.
//
// Data layer: channelDirectory.ts (directoryPage / loadDirectory / loadMore /
// resetDirectory / directoryQuery / directorySort / isLoadingMore / setSort /
// setQuery / triggerRefresh). DirectoryPane owns LOCAL signals for the search
// text and active sort (to render the controls) but every control change
// routes through the store verbs so subsequent ping-driven re-GETs use the
// correct view.
//
// Pagination (#677): the server keyset-paginates (100/page); the pane drives
// load-more via a bottom sentinel + IntersectionObserver → loadMore, which
// APPENDS the next page. Search text is cleared on window close
// (resetDirectory in onCleanup) so a reopened directory is unfiltered; sort is
// a sticky preference. Neither control holds an opinion of its own: the sort
// toggle rehydrates from directorySort, and the box mirrors directoryQuery
// (#738) so a filter set from outside the pane — `/list <pattern>` — is
// visible and clearable.
//
// Failure + ordering (#732): the store never rejects — it parks per-slug
// failure copy the pane renders as an alert with a Retry. The search box
// debounces its GET (SEARCH_DEBOUNCE_MS) so a burst of keystrokes costs one
// request instead of one per character; the store's request-id guard is what
// makes the surviving races correct, the debounce just stops making them.
//
// Scroll preservation: the row container tracks scrollTop on scroll. A
// createEffect on the page's entry COUNT restores it via queueMicrotask so
// the viewport stays steady while rows update from a progress ping or an
// append; a REPLACE that shrinks the list snaps back to the top.

// #1658 point 3 — the pull moves the TRACK, and the track carries everything:
// the parked slot AND the rows. That is the whole design, and it is worth
// stating as geometry because the geometry is what makes the strong invariant
// free.
//
// Inside the track the slot occupies `[-slotHeight, 0]` (its own
// `translateY(-100%)`, which lives in the stylesheet) and the rows start at 0.
// Translate the track by `dy` and the slot's bottom edge lands on `dy` — which
// is exactly where the first row's top edge lands. So:
//
//   slot bottom ≡ first row top, at EVERY dy
//
// Not a bound that holds at the distances a test happens to sample: an
// identity, because the two are one rigid body under one transform. The
// spinner rides in the space the rows open and cannot be made to overlap them
// by any later edit to either one — there is no second number to keep in step.
//
// What this REPLACED, and why none of it is a loss:
//
//   * The paint used to go on the slot as `translateY(-100%) translateY(...)`,
//     re-stating the parked offset because an inline transform replaces the
//     rule wholesale (the #1438 trap). The pane writes no transform to the slot
//     at all now, so the parked offset stays in the stylesheet where nothing
//     can replace it and the trap is gone rather than guarded.
//   * The travel used to cap at `min(dy, 100%)`, the slot's own height. That
//     cap existed for ONE reason — keeping the spinner off rows that stood
//     still — and with the rows moving there is no collision left to bound.
//     🔴 Removed rather than retuned, deliberately: any HARD cap makes the list
//     stop dead under a still-moving finger, which is the defect this issue is
//     about, in smaller print. What #1669 adds below is not that cap coming
//     back — an asymptote never stops following, it only ever buys less.

// #1669 — the travel PAST the commit point, and vjt's call on the feel question
// #1658 left open above ("where the travel should ease off past the commit
// distance is a FEEL question … damping is additive afterwards"). This is the
// additive half; the floor it is added to is unchanged.
//
// Three properties, and they are what the tests pin — NOT the two numbers,
// which are provisional. A property survives a recalibration; a number does not.
//
//   1. Below the commit point the finger goes through 1:1. That stretch is the
//      one a user crosses to decide whether to spend a refresh, so it is the
//      one place the affordance must not lie about distance — and #1658's
//      geometry (slot bottom ≡ first row top) is an identity at EVERY offset,
//      so damping it would buy nothing.
//   2. Past it the gain only ever falls: each further pixel of finger buys
//      strictly less than the pixel before it. Resistance, not a wall.
//   3. The offset approaches `PULL_MAX_OFFSET_PX` and never reaches it, while
//      STILL increasing at every distance. An asymptote, not a clamp — and that
//      distinction is the whole of why the old cap was deleted rather than
//      retuned, so it is asserted directly.
//
// The curve is the ordinary rubber-band shape (UIScrollView's, and every
// pull-to-refresh built after it): the slack above the commit point is spent
// down a reciprocal, so the first pixel past the seam buys `PULL_DAMPING` of
// itself and the ten-thousandth buys nothing measurable.

// 🔴 A FEEL NUMBER. PROVISIONAL, and NOT MEASURED ON A DEVICE. It no longer
// shares that standing with `PULL_COMMIT_PX`, which vjt measured on a phone in
// #1671 — this one has still never been near one. No gate in this repo can say
// it is right, only that it is bounded and monotone: jsdom drives no compositor
// and Playwright's WebKit does not reproduce real iOS scroll physics (this
// pane's e2e header says so at length). **iOS parity is claimed nowhere.**
//
// STILL DERIVED, deliberately, even though its base stopped being derived. What
// #1671 approved on the device is the commit DISTANCE; what is approved here is
// the RATIO — the list travels at most twice as far as the finger must go to
// spend a refresh — so the ceiling follows the commit point and the elastic
// keeps the shape vjt has just signed off. Freezing a literal here would pin
// that shape against the next recalibration instead of tracking it. That is the
// whole of the rule `PULL_COMMIT_PX` now states at its own declaration: derive
// the ratio, write the measured distance. If the doubled 320px turns out to be
// too much travel on the device, that is its own measurement and its own issue.
export const PULL_MAX_OFFSET_PX = PULL_COMMIT_PX * 2;

// 🔴 The second feel number, provisional on exactly the same terms.
//
// Read it as the gain AT THE SEAM: the share of the finger's next pixel the
// track still travels the instant it crosses the commit point. Every pixel
// after that one buys less whatever this is set to — the falling gain is the
// curve's doing, not this constant's.
//
// 1 is the value that leaves NO STEP at the seam: the damped stretch departs at
// exactly the rate the 1:1 stretch arrives, so resistance builds instead of
// switching on. It is the honest floor #1658 asked to calibrate FROM. Lower it
// for a firmer wall right at the threshold. Above 1 the pull would ACCELERATE
// past the commit point, which is the one direction the property tests refuse.
const PULL_DAMPING = 1;

/**
 * The track's offset for a finger that has travelled `dy` downward.
 *
 * @spec pulledOffset(number) :: number — the identity below `PULL_COMMIT_PX`;
 * strictly increasing everywhere; gain non-increasing everywhere; bounded above
 * by `PULL_MAX_OFFSET_PX`, which it approaches and never reaches.
 *
 * Exported for its property tests the way `timeAgo` below is: the three
 * guarantees are statements about a NUMBER, and asserting them through a
 * transform string would be asserting them through a parser as well.
 */
export function pulledOffset(dy: number): number {
  if (dy <= PULL_COMMIT_PX) return dy;
  const slack = PULL_MAX_OFFSET_PX - PULL_COMMIT_PX;
  const past = dy - PULL_COMMIT_PX;
  return PULL_COMMIT_PX + slack * (1 - 1 / ((past * PULL_DAMPING) / slack + 1));
}

const pulledTransform = (dy: number): string => `translateY(${pulledOffset(dy)}px)`;

// The spinner is legible before the commit point, not after it: the ramp
// reaches full exactly where the release starts spending a capture, so the
// affordance itself says where the line is.
//
// #1658 — a DIFFERENT axis from the travel above and it keeps its own
// distance. The travel is the placement, the ramp is the affordance; tying the
// ramp to the capped travel would top the spinner out at
// slotHeight/PULL_COMMIT_PX (0.22 at the default font size, halved from 0.44 by
// #1671's doubling) and it would never reach full at the one distance where
// full is the point.
//
// #1669 — which is why this reads the RAW `dy` and not `pulledOffset(dy)`, now
// that the two differ. What the ramp announces is that the RELEASE will spend a
// capture, and the binder decides that on the finger's own travel
// (`swipeDirection(…, PULL_COMMIT_PX)` in pullGesture.ts), which damping does
// not touch. Ramp the damped offset instead and the spinner reaches full at a
// distance that does not commit — the affordance lying about the threshold it
// exists to announce.
const pulledOpacity = (dy: number): number => Math.min(dy, PULL_COMMIT_PX) / PULL_COMMIT_PX;

// Quiet window after the last keystroke before the filter GET fires. Long
// enough to swallow a burst of typing, short enough that a deliberate pause
// feels immediate.
const SEARCH_DEBOUNCE_MS = 250;

// Pure relative-time formatter. No external deps, exported for unit tests.
// Thresholds: <60s → "just now", <60m → "Nm ago", <24h → "Nh ago", else "Nd ago".
export function timeAgo(iso: string): string {
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  return `${Math.floor(diffHour / 24)}d ago`;
}

type DirectoryRowProps = {
  entry: DirectoryEntry;
  networkSlug: string;
};

// Per-row sub-component so the join error signal is scoped to each row
// and doesn't bleed across rows (same pattern as HomePane's DisconnectedRow).
const DirectoryRow: Component<DirectoryRowProps> = (props) => {
  const [error, setError] = createSignal<string | null>(null);

  const isJoined = () =>
    windowStateByChannel()[channelKey(props.networkSlug, props.entry.name)] === "joined";

  const onJoin = async () => {
    const t = token();
    if (!t) return;
    setError(null);
    try {
      await postJoin(t, props.networkSlug, props.entry.name, null);
      // Server broadcasts window_pending on the user topic → cic's
      // existing dispatch sets the window state. No local pending state
      // needed here — the windowStateByChannel signal drives the badge.
      //
      // #244 — foreground the newly-joined channel. Focus originates HERE,
      // at the user's tap gesture (the issuing boundary), mirroring
      // compose.ts `/join` — NOT from the WS join-complete broadcast. That
      // decoupling is the #200/#125 invariant: WS window-state arms
      // (userTopic.ts `joined`, subscribe.ts self-JOIN) NEVER originate
      // selection, so an AUTOMATIC re-join (reconnect auto-rejoin, cross-
      // device broadcast, pending→joined transition) can't steal focus. The
      // tap is the ONLY new focus origin. After the awaited postJoin so a
      // failed join (e.g. +i) never foregrounds a phantom window.
      //
      // #731 — the FOLDED name, like channelJoin.switchTo and compose.ts
      // `/join`. `entry.name` is the raw `/LIST` spelling (the directory is
      // the documented verbatim-casing exception) while selection and
      // window_states are keyed folded, so a raw target focuses a window the
      // sidebar can't match. Only the KEY folds: postJoin above and the
      // rendered label below keep the display casing.
      setSelectedChannel({
        networkSlug: props.networkSlug,
        channelName: canonicalChannel(props.entry.name),
        kind: "channel",
      });
    } catch (err) {
      setError(err instanceof ApiError ? friendlyApiError(err) : "join failed");
    }
  };

  // #125 — a joined row opens its window (consistent with the HomePane
  // featured-link behaviour from #85); an unjoined row JOINs it. #244
  // amends #125: a user-initiated tap on an unjoined row now JOINs *and*
  // foregrounds the new window (see onJoin) — irssi-like, you land in the
  // channel you asked for. Automatic re-joins still never steal focus.
  const onActivate = () => {
    if (isJoined()) {
      // #731 — folded, for the same reason as onJoin: `isJoined()` above
      // already folds through `channelKey`, so focusing the raw name targets
      // a different key than the one that just answered "joined".
      setSelectedChannel({
        networkSlug: props.networkSlug,
        channelName: canonicalChannel(props.entry.name),
        kind: "channel",
      });
      return;
    }
    void onJoin();
  };

  // Layout (#125): the button is a responsive grid. `.directory-row-head`
  // groups the name with the featured + joined labels — beside the name on
  // mobile (flex row), below it on desktop (flex column) via CSS. The
  // topic renders through MircBody (the shared mIRC formatter) so color
  // codes show as styled spans, not raw control chars, and wraps fully.
  return (
    <li class="directory-row">
      <button
        type="button"
        class="directory-row-join"
        aria-label={`${isJoined() ? "Open" : "Join"} ${props.entry.name}`}
        onClick={onActivate}
      >
        <span class="directory-row-head">
          <span class="directory-row-name">{props.entry.name}</span>
          <Show when={props.entry.featured}>
            <span class="directory-row-featured" data-testid="directory-row-featured">
              featured
            </span>
          </Show>
          <Show when={isJoined()}>
            <span class="directory-row-badge">joined</span>
          </Show>
        </span>
        <span class="directory-row-count">{props.entry.user_count}</span>
        <Show when={props.entry.topic}>
          {(topic) => (
            <span class="directory-row-topic muted">
              {/* #220 — a topic link browses; it must NOT join the row.
                  "link-wins" makes the anchor stopPropagation so this
                  row button's onActivate never fires on a link tap. */}
              <MircBody body={topic()} linkPolicy="link-wins" />
            </span>
          )}
        </Show>
      </button>
      <Show when={error()}>
        <span class="directory-row-error" role="alert">
          {error()}
        </span>
      </Show>
    </li>
  );
};

const DirectoryPane: Component<{ networkSlug: string }> = (props) => {
  // #738 — the box renders this; the store's filter SEEDS it and keeps
  // seeding it, via the mirror effect below (which runs before the first
  // paint, so this initial value is never seen). Not a second rehydration
  // point: one mechanism, or the two drift.
  const [searchText, setSearchText] = createSignal("");
  // #677 — sort is a sticky PREFERENCE: rehydrate the toggle from the store so
  // a reopened pane's label matches the sorted list the store re-fetches (the
  // drop-page reset would otherwise re-fetch the stored sort while the toggle
  // showed the local default — a sibling of the very desync #677 fixes for
  // the filter).
  const [activeSort, setActiveSort] = createSignal<"users" | "name">(
    directorySort(props.networkSlug),
  );
  // Callback-ref so TypeScript accepts potential undefined (element is inside
  // <Show when={page()}> and only rendered once a page is in the store).
  let containerRef: HTMLDivElement | undefined;
  let pullSlotRef: HTMLDivElement | undefined;
  let pullTrackRef: HTMLDivElement | undefined;
  let savedScrollTop = 0;
  // The slug currently shown — kept in sync by the effect so onCleanup can
  // reset the right slug without reading props during disposal.
  let mountedSlug = props.networkSlug;
  // Tracks the rendered row count across page-signal updates so the scroll
  // restore can tell an APPEND (grows → keep position) from a top-of-view
  // REPLACE (shrinks → jump to top; a deep saved scrollTop is meaningless
  // against the shorter list a ping reset produces). #677 constraint 4.
  let prevEntryCount = 0;

  // #732 — debounce the filter GET. The local text updates on every
  // keystroke (the box stays responsive); only the request waits. The slug is
  // captured at keystroke time so a pending timer can never fire against a
  // pane that has since switched networks, and both the slug switch and the
  // unmount cancel it — a fire after resetDirectory would re-populate the
  // store the close just cleared.
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const cancelSearchTimer = () => {
    if (searchTimer !== undefined) clearTimeout(searchTimer);
    searchTimer = undefined;
  };
  onCleanup(cancelSearchTimer);

  // Load on mount / slug change. `on` makes networkSlug the sole reactive
  // trigger — reading directoryPage(s) inside does NOT create a directoryPage
  // dependency, so a successful load (page transitions from undefined to
  // defined) does NOT re-fire the effect (no feedback loop).
  createEffect(
    on(
      () => props.networkSlug,
      (s, prevS) => {
        // #677 — an A-$list → B-$list direct switch reuses this component
        // instance (the Shell <Match> stays true), so onCleanup does NOT
        // fire for A. Reset A's browse state here so reopening A later starts
        // fresh + unfiltered, exactly like closing via ✕ / switch-away.
        if (prevS !== undefined && prevS !== s) {
          cancelSearchTimer();
          resetDirectory(prevS);
        }
        mountedSlug = s;
        setActiveSort(directorySort(s));
        prevEntryCount = directoryPage(s)?.entries.length ?? 0;
        if (directoryPage(s) === undefined) void loadDirectory(s);
      },
    ),
  );

  // #738 — the box FOLLOWS the store's filter, it does not just sample it at
  // mount: compose.ts's `/list <pattern>` selects the $list window FIRST and
  // calls setQuery after, and a second `/list <pattern>` reaches a pane that
  // is already mounted. Typing still LEADS — the debounced setQuery echoes
  // the same text back ~250ms later, so the mirror write is a no-op — which
  // is why the box keeps a local signal instead of binding to the store.
  createEffect(
    on(
      () => directoryQuery(props.networkSlug),
      (q) => setSearchText(q),
    ),
  );

  // #677 — clear the search key + drop the accumulated pages when the
  // directory window closes. DirectoryPane lives under Shell's
  // <Match when={selKind() === "list"}>, so ANY dismissal (the ✕, a
  // switch-away, bucket-D park redirect, bucket-E close picker) unmounts it
  // and fires this. A reopened directory is then unfiltered with an empty
  // box — the box tells the truth.
  onCleanup(() => resetDirectory(mountedSlug));

  // Scroll preservation across live re-GETs (progress pings) and appends.
  // After the page signal updates, restore the saved scroll position so the
  // viewport stays steady while the row list repaints. A REPLACE that
  // shrinks the list (a ping reset to page 1) invalidates a deep saved
  // position, so snap back to the top in that case. queueMicrotask defers
  // the write to after Solid commits DOM updates.
  createEffect(
    on(
      () => directoryPage(props.networkSlug)?.entries.length ?? 0,
      (len) => {
        if (len < prevEntryCount) savedScrollTop = 0;
        prevEntryCount = len;
        const el = containerRef;
        if (!el) return;
        queueMicrotask(() => {
          el.scrollTop = savedScrollTop;
        });
      },
    ),
  );

  // #677 — infinite scroll. A zero-height sentinel sits at the bottom of the
  // scroll list; when it enters the container's viewport (with a 200px
  // pre-fetch margin) we ask the store for the next keyset page, which
  // APPENDS. loadMore self-guards (no next_cursor / already loading), so a
  // burst of observer fires is harmless. The observer is (re)created on each
  // sentinel mount — the sentinel is inside <Show when next_cursor>, so it
  // unmounts once the list is exhausted — and disconnected on pane unmount.
  let sentinelObserver: IntersectionObserver | undefined;
  const attachSentinel = (el: HTMLDivElement): void => {
    sentinelObserver?.disconnect();
    const root = el.closest(".directory-list");
    sentinelObserver = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore(props.networkSlug);
      },
      { root, rootMargin: "200px" },
    );
    sentinelObserver.observe(el);
  };
  onCleanup(() => sentinelObserver?.disconnect());

  // #1445 — pull down from the top of the list to ask for a re-capture.
  //
  // Painted straight into the DOM rather than through a signal: nothing else
  // RENDERS from the pulled distance, and a signal here would run the reactive
  // graph once per touchmove to move one element. Same call MediaViewerModal
  // makes for the dismiss drag it mirrors.
  // #1658 point 3 — TWO elements, one per axis, and the split is the point.
  // The TRACK carries the placement (slot + rows together, so they cannot
  // disagree); the SLOT carries the ramp, which is a different axis with a
  // different distance and must not be recomputed from the travel.
  const paintPull = (dy: number): void => {
    const track = pullTrackRef;
    const slot = pullSlotRef;
    if (track === undefined || slot === undefined) return;
    track.style.transform = pulledTransform(dy);
    slot.style.opacity = String(pulledOpacity(dy));
  };

  // Both, always. The travel and the ramp are painted on different elements
  // now, so a cleanup that clears one and forgets the other does not leave a
  // hung spinner — it leaves the whole channel list parked down the pane for
  // as long as it lives, which is a louder version of the bug `onCommit` was
  // taught to clear.
  const unpaintPull = (): void => {
    pullTrackRef?.style.removeProperty("transform");
    pullSlotRef?.style.removeProperty("opacity");
  };

  // Bound in the ref callback and disposed there too, mirroring
  // `attachSentinel` above: `.directory-list` lives inside <Show when={page()}>
  // and can unmount and come back, and Solid does NOT re-invoke a function ref
  // with undefined at unmount the way React does (#308 landmine 3).
  let pullDispose: (() => void) | undefined;
  const attachList = (el: HTMLDivElement): void => {
    containerRef = el;
    pullDispose?.();
    pullDispose = bindPullGesture(el, {
      // Read LIVE by the binder on every move, never snapshotted: anywhere but
      // the top of the list the same drag is native scrolling.
      canPull: () => el.scrollTop === 0,
      onProgress: paintPull,
      // THE SAME DOOR the button and the stale CTA use. A second refresh path
      // would sidestep the store latch that makes those two honest (F1), and
      // re-open the double-capture this issue closed.
      //
      // #1658 — and it unpaints FIRST, because a committing release is a
      // terminal the binder does not report through `onRelease`: it calls
      // `onCommit()` and returns. `onRelease: unpaintPull` alone therefore
      // cleared the paint on every path EXCEPT the one the user takes when the
      // gesture works, and the slot kept the last touchmove's transform and
      // full opacity for as long as the pane lived — vjt's hung spinner on
      // 1.3.0. The paint belongs to this pane (the binder writes none of its
      // own), so ending it on both terminals belongs here too.
      onCommit: () => {
        unpaintPull();
        onRefresh();
      },
      onRelease: unpaintPull,
    });
  };
  onCleanup(() => pullDispose?.());

  const page = () => directoryPage(props.networkSlug);
  const status = () => page()?.status;

  // #1445 — the ONE "a re-capture is under way" reading, because neither half
  // covers the whole of it: `status` is a SERVER field that only arrives with
  // a page GET, and the store's latch only spans the gap before that GET
  // lands. Read by all three affordances below so they cannot disagree about
  // whether the pane is busy.
  //
  // Issue 2046 — the server half is `loading`, which replaced `refreshing`
  // and is NARROWER by construction: it means a capture is running AND there
  // is nothing earlier to show. A re-capture over an existing snapshot no
  // longer reports busy through `status` at all, because the server keeps
  // serving the old list; that gap is exactly what the store's latch spans,
  // so the OR below is what still makes the button honest during a refresh.
  const busy = () => status() === "loading" || isRefreshPending(props.networkSlug);

  const onSearchInput = (e: Event) => {
    const val = (e.currentTarget as HTMLInputElement).value;
    const slug = props.networkSlug;
    setSearchText(val);
    cancelSearchTimer();
    searchTimer = setTimeout(() => {
      searchTimer = undefined;
      void setQuery(slug, val);
    }, SEARCH_DEBOUNCE_MS);
  };

  const onRefresh = () => void triggerRefresh(props.networkSlug);

  const onToggleSort = () => {
    const next: "users" | "name" = activeSort() === "users" ? "name" : "users";
    setActiveSort(next);
    void setSort(props.networkSlug, next);
  };

  const capturedAt = () => {
    const p = page();
    if (!p) return null;
    if (p.captured_at === null) return p.status === "loading" ? "loading…" : "never";
    return timeAgo(p.captured_at);
  };

  // Issue 2046 — the copy for an empty list, and WHICH empty it is. The three
  // states the server now separates were one `empty` before, so the pane had
  // nothing to say and said nothing: a search matching no channel rendered as
  // a blank box under "0 channels / never", indistinguishable from a network
  // that had never been LISTed.
  //
  // `fresh` / `stale` deliberately fall through to null: an empty page under
  // a real snapshot is a cursor that has run past the end of a list the user
  // can still see above it, and a "no channels" line under visible rows would
  // be the new lie.
  const emptyCopy = (): string | null => {
    const p = page();
    if (!p || p.entries.length > 0) return null;
    switch (p.status) {
      case "loading":
        return "Fetching the channel list…";
      case "unknown":
        return "No channel list yet.";
      case "no_results":
        return "No channels match your search.";
      default:
        return null;
    }
  };

  return (
    <div class="directory-pane">
      <div class="directory-pane-header">
        <input
          type="search"
          class="directory-search"
          placeholder="Search channels…"
          value={searchText()}
          onInput={onSearchInput}
        />
        <button type="button" class="directory-refresh" disabled={busy()} onClick={onRefresh}>
          {busy() ? "Refreshing…" : "Refresh"}
        </button>
        {/* #125 — close the directory and return to the previously
            active window (restore the prior selection, not a blank pane). */}
        <button
          type="button"
          class="directory-close"
          aria-label="Close directory"
          onClick={() => closeToPreviousWindow(props.networkSlug)}
        >
          ✕
        </button>
      </div>
      {/* #732 — a failed GET used to leave the pane blank with no message and
          no way to ask again: the mount effect only re-fires on a slug
          change. Sits above the list so it is visible whether or not a
          previous page is still on screen. */}
      <Show when={directoryError(props.networkSlug)}>
        {(message) => (
          <div class="directory-error" role="alert">
            <span class="directory-error-message">{message()}</span>
            {/* "Reload", not "Retry": this always re-fetches page 1, which
                after a failed APPEND discards the pages already scrolled
                through. The label names what the button does. */}
            <button
              type="button"
              class="directory-error-retry"
              onClick={() => void loadDirectory(props.networkSlug)}
            >
              Reload
            </button>
          </div>
        )}
      </Show>
      <Show when={page()}>
        {(p) => (
          <>
            <div class="directory-pane-meta">
              <span class="directory-total">{p().total} channels</span>
              <Show when={capturedAt()}>
                {/* When stale, render a button for a11y (keyboard +
                    screen-reader accessible CTA). When not stale, a
                    plain span suffices — the Refresh button above is
                    the canonical action affordance. */}
                <Show
                  when={p().status === "stale"}
                  fallback={<span class="directory-captured-at">{capturedAt()}</span>}
                >
                  <button
                    type="button"
                    class="directory-captured-at directory-stale"
                    disabled={busy()}
                    onClick={onRefresh}
                  >
                    {capturedAt()} — refresh now
                  </button>
                </Show>
              </Show>
              <button type="button" class="directory-sort-toggle" onClick={onToggleSort}>
                Sort: {activeSort()} ▾
              </button>
            </div>
            <div
              ref={attachList}
              class="directory-list"
              onScroll={() => {
                if (containerRef) savedScrollTop = containerRef.scrollTop;
              }}
            >
              {/* #1658 point 3 — the pull TRACK: everything the finger drags,
                  in one box, moved by one transform. It wraps the slot AND the
                  rows on purpose — that is what makes "the spinner never
                  covers a row" a property of the markup instead of an
                  arithmetic relation between two paints that a later edit
                  could break. It is the containing block for the absolutely
                  positioned slot below (`position: relative` in the
                  stylesheet), which puts the slot's origin at the top of the
                  content — the same place `.directory-list` put it before, so
                  nothing moves at rest.
                  A wrapper level is safe here, checked rather than assumed: no
                  rule in default.css selects a DIRECT child of
                  `.directory-list`, `attachSentinel` reaches its observer root
                  through `closest()`, and a transform does not touch layout,
                  so scrollHeight and the pane's scroll-preservation effect are
                  untouched. */}
              <div class="directory-pull-track" ref={pullTrackRef}>
                {/* #1445 — the pulled affordance. Absolutely positioned, and
                    it keeps its parked `translateY(-100%)` in the STYLESHEET:
                    the pane no longer writes a transform here, so the #1438
                    trap (an inline transform replacing the rule wholesale) has
                    nothing left to catch. Only the opacity ramp is painted
                    inline. aria-hidden: the outcome it announces is the
                    Refresh button going to "Refreshing…", which is already in
                    the a11y tree. */}
                <div class="directory-pull-slot" aria-hidden="true" ref={pullSlotRef}>
                  <span class="directory-pull-spinner" />
                </div>
                <ul class="directory-list-inner">
                  <For each={p().entries}>
                    {(entry) => <DirectoryRow entry={entry} networkSlug={props.networkSlug} />}
                  </For>
                </ul>
                {/* #677 — load-more sentinel: present only while the server
                    reports another page (next_cursor). IntersectionObserver on
                    it drives loadMore; it unmounts when the list is
                    exhausted. */}
                <Show when={p().next_cursor !== null}>
                  <div class="directory-sentinel" aria-hidden="true" ref={attachSentinel} />
                </Show>
                <Show when={emptyCopy()}>
                  {(copy) => (
                    <div class="directory-empty muted" role="status">
                      {copy()}
                    </div>
                  )}
                </Show>
                <Show when={isLoadingMore(props.networkSlug)}>
                  <div class="directory-loading-more muted" role="status">
                    Loading more…
                  </div>
                </Show>
              </div>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

export default DirectoryPane;
