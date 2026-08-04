import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryPage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// E3 — DirectoryPane unit suite. Covers:
//   * mount with undefined page → calls loadDirectory(slug)
//   * rows from directoryPage render (name + user_count + topic)
//   * clicking an UNjoined row calls postJoin(token, slug, name, null)
//     AND foregrounds its window (#244 amends #125's original no-auto-open)
//   * postJoin failure surfaces inline + does NOT foreground (#244)
//   * a row whose channelKey maps to "joined" is tappable-to-open
//     (setSelectedChannel, NOT disabled) + badged (#125)
//   * close button calls closeToPreviousWindow(slug) (#125)
//   * a color-coded topic renders as styled spans via MircBody (#125)
//   * refresh button calls triggerRefresh(slug)
//   * search input calls setQuery(slug, <text>)
//   * sort toggle calls setSort(slug, next)
//
// Mocks: channelDirectory (all exports), api (postJoin + ApiError),
//        auth (token), windowState (windowStateByChannel), friendlyApiError,
//        selection (setSelectedChannel + closeToPreviousWindow).
// channelKey is NOT mocked — uses the real implementation per spec requirement
// ("Use the production channelKey + constants").

const SLUG = "azzurra";

const directoryPageMock = vi.fn<(slug: string) => DirectoryPage | undefined>(() => undefined);
const loadDirectoryMock = vi.fn<(slug: string) => Promise<void>>(() => Promise.resolve());
const setSortMock = vi.fn<(slug: string, sort: "users" | "name") => Promise<void>>(() =>
  Promise.resolve(),
);
const setQueryMock = vi.fn<(slug: string, q: string) => Promise<void>>(() => Promise.resolve());
const triggerRefreshMock = vi.fn<(slug: string) => Promise<void>>(() => Promise.resolve());
const postJoinMock = vi.fn<
  (t: string, slug: string, name: string, key: string | null) => Promise<void>
>(() => Promise.resolve());
// vi.hoisted: tokenMock is read at MODULE-IMPORT time (not just during
// render) — DirectoryPane now imports MircBody, whose transitive
// audioPlayer/mediaViewer identity-scoped stores call auth.token() in
// their module-init createRoot. ESM hoists the `import DirectoryPane`
// above the plain `const` mocks, so a regular const would be in the TDZ
// when that import-time token() fires. Hoisting initializes it first.
const { tokenMock } = vi.hoisted(() => ({
  tokenMock: vi.fn<() => string | null>(() => "test-token"),
}));
const windowStateByChannelMock = vi.fn<() => Record<string, string>>(() => ({}));
// #677 — new store verbs the pane consumes. directorySort seeds the sort
// toggle's rehydration; isLoadingMore drives the sentinel spinner; loadMore
// is the append verb the IntersectionObserver calls (observer is inert in
// jsdom — see setupTests); resetDirectory is the on-close filter clear.
const directorySortMock = vi.fn<(slug: string) => "users" | "name">(() => "users");
// #738 — the store's active filter, SIGNAL-backed so a test can set it from
// outside the pane (what compose.ts's `/list <pattern>` does) both before and
// after mount, and the pane's rehydration has something reactive to follow.
const [directoryQuerySignal, setDirectoryQuerySignal] = createSignal("");
const directoryQueryMock = vi.fn<(slug: string) => string>(() => directoryQuerySignal());
const isLoadingMoreMock = vi.fn<(slug: string) => boolean>(() => false);
const loadMoreMock = vi.fn<(slug: string) => Promise<void>>(() => Promise.resolve());
const resetDirectoryMock = vi.fn<(slug: string) => void>(() => {});
// #732 — per-slug load error the pane renders with a retry affordance.
const directoryErrorMock = vi.fn<(slug: string) => string | null>(() => null);

vi.mock("../lib/channelDirectory", () => ({
  directoryError: (slug: string) => directoryErrorMock(slug),
  directoryPage: (slug: string) => directoryPageMock(slug),
  directoryQuery: (slug: string) => directoryQueryMock(slug),
  directorySort: (slug: string) => directorySortMock(slug),
  isLoadingMore: (slug: string) => isLoadingMoreMock(slug),
  loadDirectory: (slug: string) => loadDirectoryMock(slug),
  loadMore: (slug: string) => loadMoreMock(slug),
  resetDirectory: (slug: string) => resetDirectoryMock(slug),
  setSort: (slug: string, sort: "users" | "name") => setSortMock(slug, sort),
  setQuery: (slug: string, q: string) => setQueryMock(slug, q),
  triggerRefresh: (slug: string) => triggerRefreshMock(slug),
  onDirectoryProgress: vi.fn(),
  onDirectoryComplete: vi.fn(),
  onDirectoryFailed: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  // Minimal ApiError stub matching the shape friendlyApiError consumes
  // (status + code + Error prototype). In-factory because vi.mock hoists
  // above top-level declarations.
  class ApiError extends Error {
    status: number;
    code: string;
    info: Record<string, unknown>;
    constructor(status: number, code: string) {
      super(`${status} ${code}`);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.info = {};
    }
  }
  return {
    postJoin: (t: string, slug: string, name: string, key: string | null) =>
      postJoinMock(t, slug, name, key),
    ApiError,
  };
});

vi.mock("../lib/auth", () => ({
  token: () => tokenMock(),
}));

vi.mock("../lib/windowState", () => ({
  windowStateByChannel: () => windowStateByChannelMock(),
}));

vi.mock("../lib/friendlyApiError", () => ({
  // Identity stub so failure-path tests can assert routing through the
  // helper without re-testing its mapping logic (covered in friendlyApiError.test.ts).
  friendlyApiError: (err: { message: string }) => `friendly: ${err.message}`,
}));

// #125 — tapping a joined row opens its window; the close button returns
// to the previously active window. Mock the selection verbs at the
// boundary; their behaviour is covered in selection.test.ts.
const setSelectedChannelMock = vi.fn();
const closeToPreviousWindowMock = vi.fn();
vi.mock("../lib/selection", () => ({
  setSelectedChannel: (...args: unknown[]) => setSelectedChannelMock(...args),
  closeToPreviousWindow: (...args: unknown[]) => closeToPreviousWindowMock(...args),
}));

const FRESH_PAGE: DirectoryPage = {
  entries: [
    { name: "#grappa", topic: "IRC bouncer in Elixir", user_count: 42, featured: true },
    { name: "#elixir", topic: null, user_count: 123, featured: false },
    { name: "#help", topic: "Get help here", user_count: 7, featured: false },
  ],
  next_cursor: null,
  total: 3,
  captured_at: "2026-06-26T12:00:00Z",
  status: "fresh",
};

const STALE_PAGE: DirectoryPage = {
  ...FRESH_PAGE,
  status: "stale",
};

const REFRESHING_PAGE: DirectoryPage = {
  ...FRESH_PAGE,
  status: "refreshing",
};

import DirectoryPane, { timeAgo } from "../DirectoryPane";

describe("DirectoryPane", () => {
  beforeEach(() => {
    directoryPageMock.mockReturnValue(undefined);
    loadDirectoryMock.mockClear();
    setSortMock.mockClear();
    setQueryMock.mockClear();
    triggerRefreshMock.mockClear();
    postJoinMock.mockClear();
    tokenMock.mockReturnValue("test-token");
    windowStateByChannelMock.mockReturnValue({});
    setSelectedChannelMock.mockClear();
    closeToPreviousWindowMock.mockClear();
    directorySortMock.mockReturnValue("users");
    setDirectoryQuerySignal("");
    directoryErrorMock.mockReturnValue(null);
    isLoadingMoreMock.mockReturnValue(false);
    loadMoreMock.mockClear();
    resetDirectoryMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("load-on-mount", () => {
    it("calls loadDirectory(slug) when directoryPage is undefined", () => {
      directoryPageMock.mockReturnValue(undefined);
      render(() => <DirectoryPane networkSlug={SLUG} />);
      expect(loadDirectoryMock).toHaveBeenCalledWith(SLUG);
    });

    it("does NOT call loadDirectory when directoryPage is already defined", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);
      expect(loadDirectoryMock).not.toHaveBeenCalled();
    });
  });

  describe("row rendering", () => {
    it("renders a row per entry with name, user_count, and topic", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      expect(screen.getByText("#grappa")).toBeInTheDocument();
      expect(screen.getByText("42")).toBeInTheDocument();
      expect(screen.getByText("IRC bouncer in Elixir")).toBeInTheDocument();

      expect(screen.getByText("#elixir")).toBeInTheDocument();
      expect(screen.getByText("123")).toBeInTheDocument();

      expect(screen.getByText("#help")).toBeInTheDocument();
      expect(screen.getByText("Get help here")).toBeInTheDocument();
    });

    it("renders the featured label only on featured rows (#85)", () => {
      // FRESH_PAGE: #grappa featured: true; #elixir / #help featured: false.
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);
      const labels = screen.getAllByTestId("directory-row-featured");
      expect(labels).toHaveLength(1);
      expect(labels[0]).toHaveTextContent("featured");
    });

    it("renders total count", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);
      expect(screen.getByText(/3 channels/i)).toBeInTheDocument();
    });

    it("renders nothing when directoryPage is undefined (no rows)", () => {
      directoryPageMock.mockReturnValue(undefined);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);
      // No list items should be present
      expect(container.querySelectorAll("li")).toHaveLength(0);
    });
  });

  describe("join action", () => {
    it("clicking join button calls postJoin(token, slug, name, null)", async () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const joinBtn = screen.getByRole("button", { name: /join #grappa/i });
      fireEvent.click(joinBtn);

      await waitFor(() => {
        expect(postJoinMock).toHaveBeenCalledWith("test-token", SLUG, "#grappa", null);
      });
    });

    it("no-op when token is null (logout race)", async () => {
      tokenMock.mockReturnValue(null);
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const joinBtn = screen.getByRole("button", { name: /join #grappa/i });
      fireEvent.click(joinBtn);

      await new Promise((r) => setTimeout(r, 0));
      expect(postJoinMock).not.toHaveBeenCalled();
    });

    it("surfaced friendlyApiError inline on postJoin failure", async () => {
      const { ApiError } = await import("../lib/api");
      postJoinMock.mockRejectedValueOnce(new ApiError(422, "forbidden"));
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const joinBtn = screen.getByRole("button", { name: /join #grappa/i });
      fireEvent.click(joinBtn);

      await waitFor(() => {
        expect(screen.getByText(/friendly: 422 forbidden/)).toBeInTheDocument();
      });
    });
  });

  describe("joined-state detection", () => {
    it("joined row is NOT disabled — it is tappable to open the window (#125)", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      windowStateByChannelMock.mockReturnValue({
        [channelKey(SLUG, "#grappa")]: "joined",
      });
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const openBtn = screen.getByRole("button", { name: /open #grappa/i });
      expect(openBtn).not.toBeDisabled();
    });

    it("tapping a joined row opens its window (setSelectedChannel, no postJoin) (#125)", async () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      windowStateByChannelMock.mockReturnValue({
        [channelKey(SLUG, "#grappa")]: "joined",
      });
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const openBtn = screen.getByRole("button", { name: /open #grappa/i });
      fireEvent.click(openBtn);

      await waitFor(() => {
        expect(setSelectedChannelMock).toHaveBeenCalledWith({
          networkSlug: SLUG,
          channelName: "#grappa",
          kind: "channel",
        });
      });
      // Joined tap must NOT re-join.
      expect(postJoinMock).not.toHaveBeenCalled();
    });

    it("joined row renders the 'joined' badge", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      windowStateByChannelMock.mockReturnValue({
        [channelKey(SLUG, "#grappa")]: "joined",
      });
      render(() => <DirectoryPane networkSlug={SLUG} />);

      expect(screen.getByText("joined")).toBeInTheDocument();
    });

    it("non-joined row is enabled and has no badge", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      windowStateByChannelMock.mockReturnValue({});
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const joinBtn = screen.getByRole("button", { name: /join #grappa/i });
      expect(joinBtn).not.toBeDisabled();
      expect(screen.queryByText("joined")).toBeNull();
    });

    // #244 amends #125: a USER-INITIATED tap on an unjoined directory row
    // now JOINs *and* foregrounds the new channel window (irssi-like: you
    // asked for it, you land in it). The focus is set at the tap issuing
    // boundary, mirroring compose.ts `/join` — NOT via the WS join-complete
    // broadcast (which would also fire on automatic re-joins → focus steal).
    it("tapping an UNjoined row joins it AND foregrounds its window (#244 amends #125)", async () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      windowStateByChannelMock.mockReturnValue({});
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const joinBtn = screen.getByRole("button", { name: /join #grappa/i });
      fireEvent.click(joinBtn);

      await waitFor(() => {
        expect(postJoinMock).toHaveBeenCalledWith("test-token", SLUG, "#grappa", null);
      });
      // Foreground the tapped channel — same verb + shape compose.ts /join uses.
      await waitFor(() => {
        expect(setSelectedChannelMock).toHaveBeenCalledWith({
          networkSlug: SLUG,
          channelName: "#grappa",
          kind: "channel",
        });
      });
    });

    // Focus follows a SUCCESSFUL join only. If postJoin rejects (e.g. +i
    // channel), the window never opens server-side, so foregrounding a
    // phantom window would be a lie — mirror compose.ts, where the
    // setSelectedChannel sits after the awaited postJoin inside the try.
    it("does NOT foreground when postJoin fails (focus only on successful join) (#244)", async () => {
      const { ApiError } = await import("../lib/api");
      postJoinMock.mockRejectedValueOnce(new ApiError(473, "channel is invite-only"));
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      windowStateByChannelMock.mockReturnValue({});
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const joinBtn = screen.getByRole("button", { name: /join #grappa/i });
      fireEvent.click(joinBtn);

      await waitFor(() => {
        expect(screen.getByText(/friendly: 473 channel is invite-only/)).toBeInTheDocument();
      });
      expect(setSelectedChannelMock).not.toHaveBeenCalled();
    });
  });

  describe("close button (#125)", () => {
    it("renders a close button that returns to the previous window", async () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const closeBtn = screen.getByRole("button", { name: /close directory/i });
      fireEvent.click(closeBtn);

      await waitFor(() => {
        expect(closeToPreviousWindowMock).toHaveBeenCalledWith(SLUG);
      });
    });
  });

  describe("topic mIRC color rendering (#125)", () => {
    it("renders a color-coded topic as styled spans, not raw control chars", () => {
      // \x03 04 = mIRC red. The directory topic must render through the
      // same typed-formatting path as scrollback (MircBody) — the parser
      // strips the control bytes and emits a colored run.
      const COLORED: DirectoryPage = {
        ...FRESH_PAGE,
        entries: [{ name: "#c", topic: "04alert", user_count: 1, featured: false }],
        total: 1,
      };
      directoryPageMock.mockReturnValue(COLORED);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      const topic = container.querySelector(".directory-row-topic");
      expect(topic).not.toBeNull();
      // Control bytes are consumed by the parser — never present in the DOM.
      expect(topic?.textContent ?? "").not.toContain("");
      expect(topic?.textContent).toContain("alert");
      // The colored run carries an inline color style.
      expect(topic?.querySelector("span[style*='color']")).not.toBeNull();
    });
  });

  // #220 — a /list row's topic can carry a link. Tapping the LINK just
  // browses (opens the URL); it must NOT join/open the channel. Tapping
  // the rest of the row still activates it. The link anchor uses the
  // "link-wins" policy → stopPropagation keeps the row's onActivate from
  // firing when the anchor is clicked.
  describe("link in a topic does not join the row (#220)", () => {
    const LINKED: DirectoryPage = {
      ...FRESH_PAGE,
      entries: [
        { name: "#linky", topic: "docs at https://example.com/x", user_count: 1, featured: false },
      ],
      total: 1,
    };

    it("clicking a link inside the row topic does NOT postJoin (browses, no join)", async () => {
      directoryPageMock.mockReturnValue(LINKED);
      windowStateByChannelMock.mockReturnValue({});
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      const link = container.querySelector(".scrollback-link") as HTMLAnchorElement;
      expect(link).not.toBeNull();
      expect(link.href).toBe("https://example.com/x");

      // Real bubbling click, as the browser dispatches it. If the anchor
      // failed to stopPropagation, the click would reach the row button's
      // onActivate → postJoin.
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
      link.dispatchEvent(ev);

      await new Promise((r) => setTimeout(r, 0));
      expect(postJoinMock).not.toHaveBeenCalled();
      expect(setSelectedChannelMock).not.toHaveBeenCalled();
      // The link is free to navigate — nothing prevents its default.
      expect(ev.defaultPrevented).toBe(false);
    });

    it("clicking the row body (not the link) still joins", async () => {
      directoryPageMock.mockReturnValue(LINKED);
      windowStateByChannelMock.mockReturnValue({});
      render(() => <DirectoryPane networkSlug={SLUG} />);

      // The channel-name span is part of the row button, away from the link.
      const name = screen.getByText("#linky");
      fireEvent.click(name);

      await waitFor(() => {
        expect(postJoinMock).toHaveBeenCalledWith("test-token", SLUG, "#linky", null);
      });
    });
  });

  describe("refresh button", () => {
    it("calls triggerRefresh(slug) on click", async () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const btn = screen.getByRole("button", { name: /^refresh$/i });
      fireEvent.click(btn);

      await waitFor(() => {
        expect(triggerRefreshMock).toHaveBeenCalledWith(SLUG);
      });
    });

    it("is disabled and relabeled when status is 'refreshing'", () => {
      directoryPageMock.mockReturnValue(REFRESHING_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const btn = screen.getByRole("button", { name: /refreshing/i });
      expect(btn).toBeDisabled();
    });
  });

  describe("search input", () => {
    it("typing calls setQuery(slug, text)", async () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const input = screen.getByPlaceholderText(/search channels/i);
      fireEvent.input(input, { target: { value: "grappa" } });

      await waitFor(() => {
        expect(setQueryMock).toHaveBeenCalledWith(SLUG, "grappa");
      });
    });

    // #738 — `/list <pattern>` calls setQuery from compose.ts, so the store's
    // filter is settable from OUTSIDE the pane with no window close in
    // between. A box hard-initialised to "" then shows a short filtered list
    // with no visible reason for it, and no way to clear it but typing a
    // character and deleting it again.
    describe("filter set from outside the pane (#738)", () => {
      it("mounts showing the store's active filter", () => {
        setDirectoryQuerySignal("rust");
        directoryPageMock.mockReturnValue(FRESH_PAGE);
        render(() => <DirectoryPane networkSlug={SLUG} />);

        expect(screen.getByPlaceholderText(/search channels/i)).toHaveValue("rust");
      });

      // compose.ts selects the $list window FIRST and calls setQuery after,
      // and a second `/list <pattern>` reaches an already-mounted pane — so a
      // one-shot seed at mount is not enough. The box must FOLLOW the store.
      it("follows a filter set after mount", async () => {
        directoryPageMock.mockReturnValue(FRESH_PAGE);
        render(() => <DirectoryPane networkSlug={SLUG} />);
        const input = screen.getByPlaceholderText(/search channels/i);
        expect(input).toHaveValue("");

        setDirectoryQuerySignal("rust");

        await waitFor(() => {
          expect(input).toHaveValue("rust");
        });
      });

      // The box LEADS the store by SEARCH_DEBOUNCE_MS (#732): binding the
      // input straight to the store would undo that and make typing lag a
      // quarter second behind the keyboard.
      it("keeps the typed text while the debounced store filter still lags", () => {
        vi.useFakeTimers();
        try {
          directoryPageMock.mockReturnValue(FRESH_PAGE);
          render(() => <DirectoryPane networkSlug={SLUG} />);
          const input = screen.getByPlaceholderText(/search channels/i);

          fireEvent.input(input, { target: { value: "ru" } });

          expect(setQueryMock).not.toHaveBeenCalled();
          expect(input).toHaveValue("ru");
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });

  describe("sort toggle", () => {
    it("clicking sort toggle calls setSort(slug, 'name') when current is 'users'", async () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      // Default sort is "users"
      const sortBtn = screen.getByRole("button", { name: /sort:.*users/i });
      fireEvent.click(sortBtn);

      await waitFor(() => {
        expect(setSortMock).toHaveBeenCalledWith(SLUG, "name");
      });
    });

    it("clicking sort toggle a second time calls setSort(slug, 'users')", async () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const sortBtn = screen.getByRole("button", { name: /sort:.*users/i });
      fireEvent.click(sortBtn);

      await waitFor(() => {
        expect(setSortMock).toHaveBeenLastCalledWith(SLUG, "name");
      });

      const sortBtnAfter = screen.getByRole("button", { name: /sort:.*name/i });
      fireEvent.click(sortBtnAfter);

      await waitFor(() => {
        expect(setSortMock).toHaveBeenLastCalledWith(SLUG, "users");
      });
    });
  });

  describe("stale status", () => {
    it("renders 'stale' class on captured-at when status is stale", () => {
      directoryPageMock.mockReturnValue(STALE_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      const staleEl = container.querySelector(".directory-stale");
      expect(staleEl).not.toBeNull();
    });

    it("does NOT render stale class when status is fresh", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      const staleEl = container.querySelector(".directory-stale");
      expect(staleEl).toBeNull();
    });
  });

  describe("no compose affordance", () => {
    it("renders no textarea or compose-box (view+action pane only)", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      expect(container.querySelector("textarea")).toBeNull();
      expect(container.querySelector(".compose-box")).toBeNull();
    });
  });

  // #677 — the search key is cleared on window close. The pane's local
  // searchText dies with the unmount; resetDirectory clears the store's
  // sticky `q` (and drops the cached page) so a reopened directory is
  // unfiltered with an empty box. Asserted here at the unmount boundary; the
  // reopen-shows-unfiltered outcome is covered end-to-end in the e2e.
  describe("clear-filter-on-close (#677)", () => {
    it("resets the directory store for its slug on unmount", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { unmount } = render(() => <DirectoryPane networkSlug={SLUG} />);
      expect(resetDirectoryMock).not.toHaveBeenCalled();
      unmount();
      expect(resetDirectoryMock).toHaveBeenCalledWith(SLUG);
    });
  });

  // #677 — sort is a sticky PREFERENCE (unlike the filter). A reopened pane
  // rehydrates its toggle from the store's persisted sort so the label
  // matches the order the store re-fetches. Without this, the drop-page
  // reset would re-fetch by the stored sort while the toggle showed the
  // local default — a sibling of the filter desync #677 fixes.
  describe("sort rehydration (#677)", () => {
    it("initializes the sort toggle from the store's persisted sort", () => {
      directorySortMock.mockReturnValue("name");
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);
      expect(screen.getByRole("button", { name: /sort:.*name/i })).toBeInTheDocument();
    });
  });

  // #677 — the sentinel renders only while the server reports another page
  // (next_cursor). Exhausted list → no sentinel (nothing left to observe).
  describe("load-more sentinel (#677)", () => {
    it("renders the sentinel when next_cursor is present", () => {
      directoryPageMock.mockReturnValue({ ...FRESH_PAGE, next_cursor: "CURSOR2" });
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);
      expect(container.querySelector(".directory-sentinel")).not.toBeNull();
    });

    it("omits the sentinel when next_cursor is null (last page)", () => {
      directoryPageMock.mockReturnValue({ ...FRESH_PAGE, next_cursor: null });
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);
      expect(container.querySelector(".directory-sentinel")).toBeNull();
    });

    it("shows the loading-more indicator while a next page is in flight", () => {
      isLoadingMoreMock.mockReturnValue(true);
      directoryPageMock.mockReturnValue({ ...FRESH_PAGE, next_cursor: "CURSOR2" });
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);
      expect(container.querySelector(".directory-loading-more")).not.toBeNull();
    });
  });

  // #732 — a failed GET used to leave the pane blank forever: no message,
  // no retry, and the mount effect only re-fires on a slug change. The
  // store now records the failure per slug; the pane renders it with the
  // retry the operator otherwise doesn't have.
  describe("load error (#732)", () => {
    it("renders the store's error with a retry affordance", () => {
      directoryErrorMock.mockReturnValue("The service is momentarily busy. Please try again.");
      directoryPageMock.mockReturnValue(undefined);
      render(() => <DirectoryPane networkSlug={SLUG} />);
      expect(screen.getByRole("alert")).toHaveTextContent(/momentarily busy/i);
      expect(screen.getByRole("button", { name: /reload/i })).toBeInTheDocument();
    });

    it("renders no alert when there is no error", () => {
      directoryErrorMock.mockReturnValue(null);
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);
      expect(screen.queryByRole("alert")).toBeNull();
    });

    it("reload re-runs loadDirectory for the slug", () => {
      directoryErrorMock.mockReturnValue("nope");
      directoryPageMock.mockReturnValue(undefined);
      render(() => <DirectoryPane networkSlug={SLUG} />);
      loadDirectoryMock.mockClear();
      fireEvent.click(screen.getByRole("button", { name: /reload/i }));
      expect(loadDirectoryMock).toHaveBeenCalledWith(SLUG);
    });
  });

  // #732 — every keystroke used to fire its own GET, and the responses
  // raced. Debouncing collapses a burst into one GET for the final text
  // (the store's request-ordering guard covers the rest).
  describe("search debounce (#732)", () => {
    it("a burst of keystrokes fires one setQuery with the final text", () => {
      vi.useFakeTimers();
      try {
        directoryPageMock.mockReturnValue(FRESH_PAGE);
        render(() => <DirectoryPane networkSlug={SLUG} />);
        const input = screen.getByPlaceholderText(/search channels/i);

        fireEvent.input(input, { target: { value: "ru" } });
        fireEvent.input(input, { target: { value: "rust" } });
        expect(setQueryMock).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1000);
        expect(setQueryMock).toHaveBeenCalledTimes(1);
        expect(setQueryMock).toHaveBeenCalledWith(SLUG, "rust");
      } finally {
        vi.useRealTimers();
      }
    });

    it("a pending keystroke never fires against a pane that switched networks", () => {
      vi.useFakeTimers();
      try {
        directoryPageMock.mockReturnValue(FRESH_PAGE);
        // An A-$list → B-$list switch reuses this component INSTANCE (Shell's
        // <Match> stays true), so onCleanup never runs for A — the slug
        // effect is the only thing that can cancel A's pending timer.
        const [slug, setSlug] = createSignal(SLUG);
        render(() => <DirectoryPane networkSlug={slug()} />);
        fireEvent.input(screen.getByPlaceholderText(/search channels/i), {
          target: { value: "rust" },
        });
        setSlug("other-net");
        vi.advanceTimersByTime(1000);
        expect(setQueryMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a pending keystroke never fires after the pane closes", () => {
      vi.useFakeTimers();
      try {
        directoryPageMock.mockReturnValue(FRESH_PAGE);
        const { unmount } = render(() => <DirectoryPane networkSlug={SLUG} />);
        fireEvent.input(screen.getByPlaceholderText(/search channels/i), {
          target: { value: "rust" },
        });
        unmount();
        vi.advanceTimersByTime(1000);
        // Firing here would re-populate the store for a slug resetDirectory
        // just cleared — the closed pane resurrecting its own state.
        expect(setQueryMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

describe("timeAgo (pure formatter)", () => {
  it("returns 'just now' for sub-60-second diffs", () => {
    const now = new Date().toISOString();
    expect(timeAgo(now)).toBe("just now");
  });

  it("returns 'Nm ago' for diffs under an hour", () => {
    const past = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(timeAgo(past)).toBe("5m ago");
  });

  it("returns 'Nh ago' for diffs under a day", () => {
    const past = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    expect(timeAgo(past)).toBe("3h ago");
  });

  it("returns 'Nd ago' for diffs of a day or more", () => {
    const past = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    expect(timeAgo(past)).toBe("2d ago");
  });
});
