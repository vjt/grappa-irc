import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirectoryPage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// E3 — DirectoryPane unit suite. Covers:
//   * mount with undefined page → calls loadDirectory(slug)
//   * rows from directoryPage render (name + user_count + topic)
//   * clicking an UNjoined row calls postJoin(token, slug, name, null)
//     and does NOT open a window (#125)
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

vi.mock("../lib/channelDirectory", () => ({
  directoryPage: (slug: string) => directoryPageMock(slug),
  loadDirectory: (slug: string) => loadDirectoryMock(slug),
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

    it("tapping an UNjoined row joins it and does NOT open a window (#125)", async () => {
      directoryPageMock.mockReturnValue(FRESH_PAGE);
      windowStateByChannelMock.mockReturnValue({});
      render(() => <DirectoryPane networkSlug={SLUG} />);

      const joinBtn = screen.getByRole("button", { name: /join #grappa/i });
      fireEvent.click(joinBtn);

      await waitFor(() => {
        expect(postJoinMock).toHaveBeenCalledWith("test-token", SLUG, "#grappa", null);
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
