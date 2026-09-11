import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryPage } from "../lib/api";
import { channelKey } from "../lib/channelKey";
import { PULL_COMMIT_PX } from "../lib/pullGesture";
import { fireTouch } from "./helpers/touchEvents";

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
// #1445 — the store's refresh latch, spanning the POST→first-page-GET gap.
// SIGNAL-backed so a test can raise it the way the store does (from outside
// the pane, between renders) and the pane's `busy()` has something reactive
// to follow.
const [refreshPendingSignal, setRefreshPendingSignal] = createSignal(false);
const isRefreshPendingMock = vi.fn<(slug: string) => boolean>(() => refreshPendingSignal());
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
  isRefreshPending: (slug: string) => isRefreshPendingMock(slug),
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

// Issue 2046 — `loading` is what `refreshing` became, and it is narrower:
// the server only sends it when a capture is running AND there is no earlier
// snapshot to serve. So the fixture drops the entries and the stamp with the
// status; a `loading` page carrying rows is a shape the server cannot emit.
const LOADING_PAGE: DirectoryPage = {
  ...FRESH_PAGE,
  entries: [],
  total: 0,
  captured_at: null,
  status: "loading",
};

const UNKNOWN_PAGE: DirectoryPage = {
  ...LOADING_PAGE,
  status: "unknown",
};

const NO_RESULTS_PAGE: DirectoryPage = {
  ...FRESH_PAGE,
  entries: [],
  total: 0,
  status: "no_results",
};

import DirectoryPane, { PULL_MAX_OFFSET_PX, pulledOffset, timeAgo } from "../DirectoryPane";

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
    setRefreshPendingSignal(false);
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

  // #731 — `channel_directory.name` is the documented verbatim-casing
  // exception: it stores the `/LIST` spelling, and bahamut preserves the
  // creation casing (`#Sniffo`). Selection + window_states are keyed FOLDED,
  // so a raw focus target opens a phantom window the sidebar can't match.
  // Same split every sibling uses (channelJoin.switchTo, compose.ts /join):
  // the KEY folds, the wire argument and the visible label stay RAW.
  //
  // The folded expectation is a LITERAL, not `canonicalChannel(...)`: routing
  // both sides through the same helper would keep this green if the helper
  // itself regressed. `#Sniffo` → `#sniffo` is the whole contract, spelled out.
  describe("focus folds the /LIST casing (#731)", () => {
    const MIXED_PAGE: DirectoryPage = {
      ...FRESH_PAGE,
      entries: [{ name: "#Sniffo", topic: null, user_count: 5, featured: false }],
      total: 1,
    };

    it("join-then-foreground focuses the FOLDED name while postJoin gets the RAW one", async () => {
      directoryPageMock.mockReturnValue(MIXED_PAGE);
      windowStateByChannelMock.mockReturnValue({});
      render(() => <DirectoryPane networkSlug={SLUG} />);

      fireEvent.click(screen.getByRole("button", { name: /join #Sniffo/i }));

      await waitFor(() => {
        expect(setSelectedChannelMock).toHaveBeenCalledWith({
          networkSlug: SLUG,
          channelName: "#sniffo",
          kind: "channel",
        });
      });
      // The wire keeps the display spelling — the server does its own casemapping.
      expect(postJoinMock).toHaveBeenCalledWith("test-token", SLUG, "#Sniffo", null);
    });

    it("tapping an already-joined mixed-case row focuses the FOLDED name", async () => {
      directoryPageMock.mockReturnValue(MIXED_PAGE);
      // channelKey folds internally, so this is the same entry window_states
      // holds for the joined `#sniffo`.
      windowStateByChannelMock.mockReturnValue({
        [channelKey(SLUG, "#Sniffo")]: "joined",
      });
      render(() => <DirectoryPane networkSlug={SLUG} />);

      fireEvent.click(screen.getByRole("button", { name: /open #Sniffo/i }));

      await waitFor(() => {
        expect(setSelectedChannelMock).toHaveBeenCalledWith({
          networkSlug: SLUG,
          channelName: "#sniffo",
          kind: "channel",
        });
      });
      expect(postJoinMock).not.toHaveBeenCalled();
    });

    it("renders the RAW /LIST casing as the row label", () => {
      directoryPageMock.mockReturnValue(MIXED_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);
      expect(screen.getByText("#Sniffo")).toBeInTheDocument();
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

    it("is disabled and relabeled when status is 'loading'", () => {
      directoryPageMock.mockReturnValue(LOADING_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const btn = screen.getByRole("button", { name: /refreshing/i });
      expect(btn).toBeDisabled();
    });

    // The other side of the narrowing, and the reason the latch still
    // matters: a re-capture over an existing snapshot keeps serving `fresh`,
    // so `status` alone would leave the button enabled through the whole
    // thing. Asserted here so a later "simplification" that drops the latch
    // in favour of the server field reds.
    it("is NOT disabled by a status a re-capture over a live snapshot produces", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      expect(screen.getByRole("button", { name: /^refresh$/i })).toBeEnabled();
    });

    // #1445 — the gap the server field cannot cover. `status` only changes
    // when a page GET lands, so across the POST→first-GET window the page
    // still reads "fresh" and the button used to re-enable itself there. The
    // page fixture stays FRESH_PAGE on purpose: it is what makes this test
    // fail on the pre-latch pane rather than duplicate the one above.
    it("is disabled and relabeled while the store's latch is up, on a 'fresh' page", async () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      // Pre-state: the same page, latch down, is an enabled "Refresh".
      expect(screen.getByRole("button", { name: /^refresh$/i })).toBeEnabled();

      setRefreshPendingSignal(true);

      await waitFor(() => {
        expect(screen.getByRole("button", { name: /refreshing/i })).toBeDisabled();
      });
    });

    // The stale CTA is the pane's SECOND door onto the same verb (#732). A
    // door that stays live while the first is disabled is the silent no-op
    // that issue closed — the store guard would swallow its POST and nothing
    // would tell the reader why.
    it("the stale CTA is disabled while the latch is up", async () => {
      directoryPageMock.mockReturnValue(STALE_PAGE);
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const cta = screen.getByRole("button", { name: /refresh now/i });
      expect(cta).toBeEnabled();

      setRefreshPendingSignal(true);

      await waitFor(() => expect(cta).toBeDisabled());
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
        // Mirrored before the first paint: the effect flushes inside render().
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

  // Issue 2046 — the three states that used to be one `empty`, and the copy
  // that tells them apart. Before this the pane rendered NOTHING for an empty
  // list, so "your search matched no channel" and "this network has never
  // been LISTed" looked identical: a blank box under "0 channels / never".
  describe("empty-list copy per status (issue 2046)", () => {
    it("says the search found nothing, and keeps the snapshot's stamp", () => {
      directoryPageMock.mockReturnValue(NO_RESULTS_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      expect(container.querySelector(".directory-empty")?.textContent).toMatch(
        /no channels match/i,
      );
      // The stamp survives a search miss — the list it searched was real.
      expect(container.querySelector(".directory-captured-at")?.textContent).not.toMatch(/never/i);
    });

    it("says a capture is on the way when there is nothing earlier to show", () => {
      directoryPageMock.mockReturnValue(LOADING_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      expect(container.querySelector(".directory-empty")?.textContent).toMatch(/fetching/i);
      expect(container.querySelector(".directory-captured-at")?.textContent).toMatch(/loading/i);
    });

    it("says there is no list yet when nobody is capturing one", () => {
      directoryPageMock.mockReturnValue(UNKNOWN_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      expect(container.querySelector(".directory-empty")?.textContent).toMatch(
        /no channel list yet/i,
      );
      expect(container.querySelector(".directory-captured-at")?.textContent).toMatch(/never/i);
    });

    // The negative control, and it is the case the copy must NOT claim: a
    // page with rows is not empty, whatever else it says. Without it every
    // assertion above would also pass on a pane that printed the line
    // unconditionally.
    it("prints no empty-list line when the page has rows", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      expect(container.querySelector(".directory-empty")).toBeNull();
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
  // #1445 F3 — the pull gesture on the row list. The binder's own decision
  // table (what it claims, what it refuses) is covered against a bare element
  // in pullGesture.test.ts; these are the pane's WIRING: that the pull reaches
  // the same door the button reaches, that the slot is painted, and that the
  // listeners die with the pane.
  //
  // What jsdom cannot say: whether any of this feels like a pull. A synthetic
  // touch drives no compositor and jsdom resolves no `touch-action`, so this
  // pins the transform STRING the pane writes, not that anything tracked a
  // finger. That half is Playwright's, and the FEEL is a device call.
  describe("pull to refresh (#1445)", () => {
    const X = 120;
    const Y0 = 300;

    const listIn = (container: HTMLElement): HTMLElement => {
      const el = container.querySelector<HTMLElement>(".directory-list");
      if (el === null) throw new Error("no directory list rendered");
      return el;
    };

    const slotIn = (container: HTMLElement): HTMLElement => {
      const el = container.querySelector<HTMLElement>(".directory-pull-slot");
      if (el === null) throw new Error("no pull slot rendered");
      return el;
    };

    // #1658 point 3 — the one element the pull moves. The slot and the rows
    // live INSIDE it, so the single transform written here carries both and
    // they cannot drift apart.
    const trackIn = (container: HTMLElement): HTMLElement => {
      const el = container.querySelector<HTMLElement>(".directory-pull-track");
      if (el === null) throw new Error("no pull track rendered");
      return el;
    };

    // #1669 — the painted travel as a NUMBER, because the damped one is not a
    // literal any more and an equality against a string would be an equality
    // against a re-implementation of the curve.
    //
    // It THROWS on a shape it cannot read rather than returning NaN: every
    // caller compares with an inequality, and `NaN < x` is false, so a silent
    // parse failure would read as a passing bound. An empty transform (the pane
    // painted nothing) fails here too, which is the point.
    const trackOffset = (container: HTMLElement): number => {
      const written = trackIn(container).style.transform;
      const m = /^translateY\((-?\d+(?:\.\d+)?)px\)$/.exec(written);
      if (m?.[1] === undefined) {
        throw new Error(`unreadable track transform: ${JSON.stringify(written)}`);
      }
      return Number(m[1]);
    };

    // Finger down and dragged to `dy`, still on the glass — the mid-pull paint
    // exists only before the release wipes it. TWO moves because the binder
    // claims LATE: it decides on a touchmove, never on the touchstart.
    const pullTo = (target: HTMLElement, dy: number): void => {
      fireTouch(target, "touchstart", { clientX: X, clientY: Y0 });
      fireTouch(target, "touchmove", { clientX: X, clientY: Y0 + Math.min(dy, 20) });
      fireTouch(target, "touchmove", { clientX: X, clientY: Y0 + dy });
    };

    const pullAndLift = (target: HTMLElement, dy: number): void => {
      pullTo(target, dy);
      fireTouch(target, "touchend", { clientX: X, clientY: Y0 + dy });
    };

    it("a pull past the commit distance asks for the refresh through the SAME door as the button", async () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      pullAndLift(listIn(container), PULL_COMMIT_PX * 3);

      // triggerRefresh, not a second refresh path: the store latch that makes
      // the button honest (#1445 F1) only guards THAT verb, so a gesture on
      // any other door would re-open the double-POST this issue closed.
      await waitFor(() => {
        expect(triggerRefreshMock).toHaveBeenCalledWith(SLUG);
      });
      expect(triggerRefreshMock).toHaveBeenCalledTimes(1);
    });

    it("a pull short of the commit distance asks for nothing", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      pullAndLift(listIn(container), Math.round(PULL_COMMIT_PX / 2));

      expect(triggerRefreshMock).not.toHaveBeenCalled();
      // Positive control: the same pane, pulled far enough, DOES ask. Without
      // it a binder that never armed at all would pass the assertion above.
      pullAndLift(listIn(container), PULL_COMMIT_PX * 3);
      expect(triggerRefreshMock).toHaveBeenCalledWith(SLUG);
    });

    // #1658 point 3 — the whole of the defect vjt kept seeing: only the
    // spinner moved. What the finger drags now is the TRACK, and the rows are
    // inside it, so "the list follows the finger" is the same statement as
    // "the paint happened".
    it("the list's CONTENT follows the finger, not just the slot", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      pullTo(listIn(container), 20);

      const track = trackIn(container);
      expect(track.style.transform).toBe("translateY(20px)");
      // The rows are INSIDE the element that moved. Without this the assertion
      // above is satisfied by a track that translates an empty box beside a
      // list standing still — which is the defect, wearing the fix's name.
      expect(track.querySelector(".directory-list-inner")).not.toBeNull();
      // And so is the slot: ONE transform carries both, which is why the
      // spinner cannot land on top of a row. The geometry that follows from it
      // is asserted in the browser (e2e), where there is layout to measure.
      expect(track.querySelector(".directory-pull-slot")).not.toBeNull();
    });

    // #1658 point 3 — the inverse of the test this replaces. The pane used to
    // write `translateY(-100%) translateY(min(dy, 100%))` onto the SLOT: the
    // parked offset had to be re-stated because an inline transform replaces
    // the rule wholesale (the #1438 lesson), and the `min(…, 100%)` capped the
    // travel at the slot's own height to keep the spinner off the rows.
    //
    // Both are gone, and neither is a loss. The slot is carried by its
    // ancestor now, so the parked `translateY(-100%)` stays in the stylesheet
    // where nothing can replace it, and the cap has nothing left to prevent.
    it("writes no inline transform to the slot — the parked offset stays in the stylesheet", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      pullTo(listIn(container), Math.round(PULL_COMMIT_PX / 2));

      expect(slotIn(container).style.transform).toBe("");
    });

    // #1669 — the pane's WIRING half of the elastic travel: that the damped
    // number is the one that reaches the DOM. The curve's own guarantees are
    // properties of a number and are pinned as such, over a sweep, in
    // "pulledOffset" at the bottom of this file.
    //
    // This REPLACES #1658 point 3's "the travel is UNCAPPED", which asserted
    // `translateY(${PULL_COMMIT_PX * 4}px)` — the finger's raw distance, going
    // through whole. That test pinned the deliberate ABSENCE of the feel
    // constant #1658 declined to invent; #1669 is vjt making that call, so the
    // assertion it pinned is now the defect. What survives of it is the part
    // that was never about the cap: the list must still be MOVING at four times
    // the commit distance, and it is, which is why the third assertion below is
    // a strict inequality against the ceiling and not an equality with it.
    it("the travel past the commit point is damped, and bounded by the ceiling", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      // Pre-state, and the half that must NOT have changed: below the commit
      // point the finger still goes through 1:1. Without it every assertion
      // below is satisfied by a pane that damped the whole gesture to nothing.
      pullTo(listIn(container), 20);
      expect(trackOffset(container)).toBe(20);

      const far = PULL_COMMIT_PX * 4;
      pullTo(listIn(container), far);
      const offset = trackOffset(container);

      // Damped: the visible outcome #1669 asks for. 320px of finger moved the
      // list by less than 320px.
      expect(offset).toBeLessThan(far);
      // Still moving, and past the commit distance — this is what separates
      // resistance from the hard cap #1658 deleted.
      expect(offset).toBeGreaterThan(PULL_COMMIT_PX);
      // Under the ceiling, strictly: it is an asymptote, so no finite finger
      // ever lands on it.
      expect(offset).toBeLessThan(PULL_MAX_OFFSET_PX);
    });

    // #1658 — the ramp and the travel are INDEPENDENT axes, and the fix for
    // the travel is what puts the ramp at risk: computing opacity from the
    // capped travel would top the spinner out at slotHeight/PULL_COMMIT_PX —
    // 0.22 at the default font size, halved from 0.44 when #1671 doubled the
    // commit distance — so it would never reach full at the one distance where
    // reaching full is the whole point. The ramp says where the
    // release starts spending a capture; the travel says where the slot sits.
    //
    // Green before this issue and green after it, deliberately: its oracle is
    // the naive fix, not the defect. Compute the opacity from the capped
    // travel and it goes red on the last two assertions.
    it("the opacity ramp still reaches full at the commit distance", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      const list = listIn(container);
      pullTo(list, Math.round(PULL_COMMIT_PX / 2));
      expect(slotIn(container).style.opacity).toBe("0.5");

      pullTo(list, PULL_COMMIT_PX);
      expect(slotIn(container).style.opacity).toBe("1");

      pullTo(list, PULL_COMMIT_PX * 4);
      expect(slotIn(container).style.opacity).toBe("1");
    });

    it("the release wipes the paint", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      const list = listIn(container);
      pullTo(list, Math.round(PULL_COMMIT_PX / 2));
      expect(trackIn(container).style.transform).not.toBe("");

      fireTouch(list, "touchend", { clientX: X, clientY: Y0 + Math.round(PULL_COMMIT_PX / 2) });

      expect(trackIn(container).style.transform).toBe("");
    });

    // #1658 — the release that COMMITS is a terminal too, and the pane hangs
    // `unpaintPull` off `onRelease` alone, which the binder skips on exactly
    // that path (`onCommit()` then `return`). The slot keeps the inline
    // transform and opacity the last touchmove wrote, at full opacity, for as
    // long as the pane lives — the spinner vjt saw hung after the refresh on
    // 1.3.0.
    //
    // A separate test from "the release wipes the paint" above rather than a
    // widening of it: that one lifts SHORT of the commit distance, which is
    // precisely why it stayed green through the whole defect.
    //
    // #1658 point 3 — and the guarantee now spans TWO elements. The travel
    // moved to the track while the ramp stayed on the slot, so a cleanup that
    // clears one and forgets the other leaves the list itself parked 240px
    // down the pane for the rest of its life: a worse version of the hung
    // spinner this test was written for. Both are asserted, separately.
    it("a release that COMMITS wipes the paint too", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      pullAndLift(listIn(container), PULL_COMMIT_PX * 3);

      // Pre-state, not decoration: without it a binder that never armed would
      // satisfy both assertions below by having painted nothing at all.
      expect(triggerRefreshMock).toHaveBeenCalledWith(SLUG);
      expect(trackIn(container).style.transform).toBe("");
      expect(slotIn(container).style.opacity).toBe("");
      // The third reading, and a MUTANT found the hole it fills: paint the
      // travel onto the slot instead of the track — the pre-point-3 defect,
      // exactly — and the two assertions above stay GREEN, because the track
      // is trivially unpainted and the ramp is still cleared. This one is the
      // one that sees it. The pane must write no transform to this element at
      // any point, so "" here is the same statement at rest and after a
      // commit.
      expect(slotIn(container).style.transform).toBe("");
    });

    it("a drag that starts scrolled away from the top is left to native scroll", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container } = render(() => <DirectoryPane networkSlug={SLUG} />);

      const list = listIn(container);
      list.scrollTop = 200;
      pullAndLift(list, PULL_COMMIT_PX * 3);

      expect(triggerRefreshMock).not.toHaveBeenCalled();
      expect(slotIn(container).style.transform).toBe("");
      // Positive control: the same distance at the top of the list DOES ask,
      // so this measures the scroll guard and not a dead binder.
      list.scrollTop = 0;
      pullAndLift(list, PULL_COMMIT_PX * 3);
      expect(triggerRefreshMock).toHaveBeenCalledWith(SLUG);
    });

    // #308 landmine 3 — Solid does NOT re-invoke a function ref with undefined
    // at unmount the way React does, so a binder whose disposer is never
    // called keeps its listeners on a detached element and a stray touch
    // still spends a server capture.
    it("unmounting the pane disposes the binder", () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      const { container, unmount } = render(() => <DirectoryPane networkSlug={SLUG} />);
      const list = listIn(container);

      // Pre-state: while mounted, this exact gesture on this exact element
      // reaches the door. Without it the assertion below cannot tell a
      // disposed listener from a gesture that never worked.
      pullAndLift(list, PULL_COMMIT_PX * 3);
      expect(triggerRefreshMock).toHaveBeenCalledTimes(1);

      unmount();
      pullAndLift(list, PULL_COMMIT_PX * 3);

      expect(triggerRefreshMock).toHaveBeenCalledTimes(1);
    });
  });
});

// #1669 — the elastic pull curve, asserted as PROPERTIES and never as the two
// numbers that shape it. Both are declared provisional feel constants that vjt
// calibrates on a device; a suite that pinned them would go red on the
// calibration it exists to permit, and would say nothing about the shape.
//
// What jsdom (and Playwright, and this whole repo) cannot say: whether any of
// this feels like an iOS scroller. No assertion below is about parity, and
// nothing here has been near a phone.
//
// The three properties are each other's controls, which is why they are one
// sweep and not three unrelated numbers:
//
//   * STRICTLY INCREASING alone permits the undamped 1:1 travel (the defect).
//   * NON-INCREASING GAIN alone permits a hard clamp (gain drops to 0 and
//     stays there) — the #1658 defect wearing #1669's name.
//   * BOUNDED alone permits a clamp too.
//
// Together only an asymptote satisfies all three, and each of the two mutants
// above was run and reds — see the DESIGN_NOTES entry for which assertion
// catches which.
describe("pulledOffset (#1669 — the elastic pull curve)", () => {
  // 0…2000px of finger at 1px resolution: past four ceilings, and fine enough
  // that a gain reversal anywhere in the interesting region lands between two
  // samples. Whole pixels because that is the resolution a touchmove reports.
  const SWEEP = Array.from({ length: 2001 }, (_, i) => i);
  const offsets = SWEEP.map(pulledOffset);
  // IEEE noise on these magnitudes is ~1e-13. Anything this tolerance hides is
  // below a millionth of a pixel and cannot be a gain reversal anyone designed.
  const EPS = 1e-9;

  it("is the identity below the commit point — the deciding stretch is not damped", () => {
    for (let dy = 0; dy <= PULL_COMMIT_PX; dy++) {
      expect(pulledOffset(dy), `pulledOffset(${dy})`).toBe(dy);
    }
    // The seam is INSIDE the identity, not past it: the commit point itself is
    // the last undamped pixel, so the ramp and the travel agree exactly at the
    // one distance the release changes meaning.
    expect(pulledOffset(PULL_COMMIT_PX)).toBe(PULL_COMMIT_PX);
  });

  it("never stops following the finger — strictly increasing at every distance", () => {
    for (let i = 1; i < offsets.length; i++) {
      expect(
        offsets[i] as number,
        `pulledOffset(${SWEEP[i]}) must exceed pulledOffset(${SWEEP[i - 1]})`,
      ).toBeGreaterThan(offsets[i - 1] as number);
    }
  });

  it("resists: every pixel of finger buys no more than the pixel before it", () => {
    const gain = offsets.slice(1).map((v, i) => v - (offsets[i] as number));
    for (let i = 1; i < gain.length; i++) {
      expect(
        gain[i] as number,
        `gain over px ${SWEEP[i]}→${SWEEP[i + 1]} must not exceed the one before it`,
      ).toBeLessThanOrEqual((gain[i - 1] as number) + EPS);
    }
    // Not merely NON-increasing: past the seam it actually falls, or "damping"
    // would be satisfied by the undamped travel, whose gain is a flat 1.
    const past = SWEEP.findIndex((dy) => dy > PULL_COMMIT_PX);
    expect(gain[past + 10] as number).toBeLessThan((gain[past] as number) - EPS);
  });

  it("is bounded by the ceiling, which it approaches and never reaches", () => {
    for (const [i, v] of offsets.entries()) {
      expect(v, `pulledOffset(${SWEEP[i]})`).toBeLessThan(PULL_MAX_OFFSET_PX);
    }
    // An absurd finger, to read the asymptote rather than a distant sample:
    // within a hundredth of a pixel of the ceiling and still under it.
    expect(pulledOffset(1e7)).toBeLessThan(PULL_MAX_OFFSET_PX);
    expect(pulledOffset(1e7)).toBeGreaterThan(PULL_MAX_OFFSET_PX - 0.01);
  });

  it("is SPENT well before the arm runs out — the travel still on offer collapses", () => {
    // The user-facing half of "a ceiling", and the honest way to state it: not
    // "one more pixel buys nothing" (at any reachable distance it still buys a
    // pixel or so — MEASURED: 1.35px per 100px of finger at four ceilings out,
    // which is why the first draft of this assertion was wrong), but "there is
    // almost nothing LEFT to buy". `PULL_MAX_OFFSET_PX - pulledOffset(dy)` is
    // everything an arbitrarily long drag could still add, from here to
    // infinity, and past four ceilings of finger it is under a tenth of the
    // ceiling.
    //
    // Stated as a FRACTION of the ceiling rather than in pixels so it survives
    // a recalibration of either constant, which is the whole posture of this
    // block.
    const far = PULL_MAX_OFFSET_PX * 4;
    expect(PULL_MAX_OFFSET_PX - pulledOffset(far)).toBeLessThan(PULL_MAX_OFFSET_PX / 10);
    // Control against vacuity: at the commit point there is still most of the
    // ceiling to play for. Without it a function that returns the ceiling flat
    // passes the assertion above.
    expect(PULL_MAX_OFFSET_PX - pulledOffset(PULL_COMMIT_PX)).toBeGreaterThan(
      PULL_MAX_OFFSET_PX / 10,
    );
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
