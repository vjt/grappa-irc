import { type Component, createEffect, createSignal, For, on, Show } from "solid-js";
import { ApiError, type DirectoryEntry, postJoin } from "./lib/api";
import { token } from "./lib/auth";
import {
  directoryPage,
  loadDirectory,
  setQuery,
  setSort,
  triggerRefresh,
} from "./lib/channelDirectory";
import { channelKey } from "./lib/channelKey";
import { friendlyApiError } from "./lib/friendlyApiError";
import { windowStateByChannel } from "./lib/windowState";

// E3 (#84) — Per-network channel directory pane ($list window).
//
// Shows a search box, refresh button, total count, "last refreshed N ago"
// with a stale CTA, a sort toggle, and a scrollable list of channels where
// tapping a row JOINs it. Already-joined rows are badged + disabled.
//
// Data layer: channelDirectory.ts (directoryPage / loadDirectory / setSort /
// setQuery / triggerRefresh). DirectoryPane owns LOCAL signals for the search
// text and active sort (to render the controls) but every control change
// routes through the store verbs so subsequent ping-driven re-GETs use the
// correct view.
//
// Scroll preservation: the row container tracks scrollTop on scroll. A
// createEffect on the page signal restores it via queueMicrotask so the
// viewport stays steady while rows update from a progress ping.

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
    } catch (err) {
      setError(err instanceof ApiError ? friendlyApiError(err) : "join failed");
    }
  };

  return (
    <li class="directory-row">
      <button
        type="button"
        class="directory-row-join"
        disabled={isJoined()}
        aria-label={`Join ${props.entry.name}`}
        onClick={() => void onJoin()}
      >
        <span class="directory-row-name">{props.entry.name}</span>
        <span class="directory-row-count">{props.entry.user_count}</span>
        <Show when={props.entry.topic}>
          <span class="directory-row-topic muted">{props.entry.topic}</span>
        </Show>
        <Show when={isJoined()}>
          <span class="directory-row-badge">joined</span>
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
  const [searchText, setSearchText] = createSignal("");
  const [activeSort, setActiveSort] = createSignal<"users" | "name">("users");
  // Callback-ref so TypeScript accepts potential undefined (element is inside
  // <Show when={page()}> and only rendered once a page is in the store).
  let containerRef: HTMLDivElement | undefined;
  let savedScrollTop = 0;

  // Load on mount / slug change. `on` makes networkSlug the sole reactive
  // trigger — reading directoryPage(s) inside does NOT create a directoryPage
  // dependency, so a successful load (page transitions from undefined to
  // defined) does NOT re-fire the effect (no feedback loop).
  createEffect(
    on(
      () => props.networkSlug,
      (s) => {
        if (directoryPage(s) === undefined) void loadDirectory(s);
      },
    ),
  );

  // Scroll preservation across live re-GETs (progress pings). After the
  // page signal updates, restore the saved scroll position so the viewport
  // stays steady while the row list repaints. queueMicrotask defers the
  // write to after Solid commits DOM updates.
  createEffect(
    on(
      () => directoryPage(props.networkSlug),
      () => {
        const el = containerRef;
        if (!el) return;
        queueMicrotask(() => {
          el.scrollTop = savedScrollTop;
        });
      },
    ),
  );

  const page = () => directoryPage(props.networkSlug);
  const status = () => page()?.status;

  const onSearchInput = (e: Event) => {
    const val = (e.currentTarget as HTMLInputElement).value;
    setSearchText(val);
    void setQuery(props.networkSlug, val);
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
      </div>
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
            </div>
          </>
        )}
      </Show>
    </div>
  );
};

export default DirectoryPane;
