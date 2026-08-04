import { type Component, createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { ApiError, type DirectoryEntry, postJoin } from "./lib/api";
import { token } from "./lib/auth";
import {
  directoryError,
  directoryPage,
  directoryQuery,
  directorySort,
  isLoadingMore,
  loadDirectory,
  loadMore,
  resetDirectory,
  setQuery,
  setSort,
  triggerRefresh,
} from "./lib/channelDirectory";
import { channelKey } from "./lib/channelKey";
import { friendlyApiError } from "./lib/friendlyApiError";
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
      setSelectedChannel({
        networkSlug: props.networkSlug,
        channelName: props.entry.name,
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
      setSelectedChannel({
        networkSlug: props.networkSlug,
        channelName: props.entry.name,
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

  const page = () => directoryPage(props.networkSlug);
  const status = () => page()?.status;

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
    if (p.captured_at === null) return p.status === "refreshing" ? "refreshing…" : "never";
    return timeAgo(p.captured_at);
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
        <button
          type="button"
          class="directory-refresh"
          disabled={status() === "refreshing"}
          onClick={onRefresh}
        >
          {status() === "refreshing" ? "Refreshing…" : "Refresh"}
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
              ref={(el) => {
                containerRef = el;
              }}
              class="directory-list"
              onScroll={() => {
                if (containerRef) savedScrollTop = containerRef.scrollTop;
              }}
            >
              <ul class="directory-list-inner">
                <For each={p().entries}>
                  {(entry) => <DirectoryRow entry={entry} networkSlug={props.networkSlug} />}
                </For>
              </ul>
              {/* #677 — load-more sentinel: present only while the server
                  reports another page (next_cursor). IntersectionObserver on
                  it drives loadMore; it unmounts when the list is exhausted. */}
              <Show when={p().next_cursor !== null}>
                <div class="directory-sentinel" aria-hidden="true" ref={attachSentinel} />
              </Show>
              <Show when={isLoadingMore(props.networkSlug)}>
                <div class="directory-loading-more muted" role="status">
                  Loading more…
                </div>
              </Show>
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

export default DirectoryPane;
