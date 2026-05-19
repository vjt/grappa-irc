import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// UX-4 bucket L (2026-05-19) — ShellChrome unit tests.
// Cluster-wide rule: settings cog visible from EVERY window kind. The
// archive button is visible only when the selected window carries a
// network context (channel/query/server); home/mentions/empty hide it.
//
// UX-5 bucket A (2026-05-19) — the hamburger slot was dropped from
// ShellChrome entirely. Pre-bucket the chrome rendered a hamburger
// that duplicated TopicBar's `.topic-bar-hamburger` on mobile and
// toggled a no-op `.open` class on desktop. Hamburger-related tests
// moved out; only the cog + archive-button surfaces remain.

const mockSetArchiveModalNetwork = vi.fn();
vi.mock("../lib/archive", () => ({
  setArchiveModalNetwork: (...args: unknown[]) => mockSetArchiveModalNetwork(...args),
}));

// Selection is mocked per test. Returning null = empty (no window).
let mockSelected: {
  networkSlug: string;
  channelName: string;
  kind: "channel" | "query" | "server" | "home" | "mentions";
} | null = null;
vi.mock("../lib/selection", () => ({
  selectedChannel: () => mockSelected,
}));

import ShellChrome, { ChromeButtons } from "../ShellChrome";

beforeEach(() => {
  vi.clearAllMocks();
  mockSelected = null;
});

describe("ShellChrome (bucket L)", () => {
  it("always renders the settings cog (no window selected)", () => {
    const onOpenSettings = vi.fn();
    render(() => <ShellChrome onOpenSettings={onOpenSettings} />);
    const cog = screen.getByTestId("shell-chrome-cog");
    expect(cog).toBeInTheDocument();
  });

  it("clicking the cog fires onOpenSettings", () => {
    const onOpenSettings = vi.fn();
    render(() => <ShellChrome onOpenSettings={onOpenSettings} />);
    fireEvent.click(screen.getByTestId("shell-chrome-cog"));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("UX-5 bucket A — does NOT render a hamburger button (slot dropped)", () => {
    mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
    const { container } = render(() => <ShellChrome onOpenSettings={vi.fn()} />);
    expect(container.querySelectorAll(".shell-chrome-hamburger").length).toBe(0);
    expect(screen.queryByLabelText(/open channel sidebar/i)).toBeNull();
    expect(screen.queryByLabelText(/open members sidebar/i)).toBeNull();
  });

  describe("archive button visibility (per window kind)", () => {
    it("hides archive button when no window is selected", () => {
      mockSelected = null;
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.queryByTestId("shell-chrome-archive")).not.toBeInTheDocument();
    });

    it("hides archive button when home window is selected", () => {
      mockSelected = { networkSlug: "home", channelName: "home", kind: "home" };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.queryByTestId("shell-chrome-archive")).not.toBeInTheDocument();
    });

    it("hides archive button when mentions window is selected", () => {
      mockSelected = { networkSlug: "freenode", channelName: "mentions", kind: "mentions" };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.queryByTestId("shell-chrome-archive")).not.toBeInTheDocument();
    });

    it("shows archive button when a channel window is selected", () => {
      mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.getByTestId("shell-chrome-archive")).toBeInTheDocument();
    });

    it("shows archive button when a query window is selected", () => {
      mockSelected = { networkSlug: "freenode", channelName: "alice", kind: "query" };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.getByTestId("shell-chrome-archive")).toBeInTheDocument();
    });

    it("shows archive button when a server window is selected", () => {
      mockSelected = { networkSlug: "freenode", channelName: "$server", kind: "server" };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.getByTestId("shell-chrome-archive")).toBeInTheDocument();
    });

    it("clicking archive button calls setArchiveModalNetwork with the selected window's slug", () => {
      mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      fireEvent.click(screen.getByTestId("shell-chrome-archive"));
      expect(mockSetArchiveModalNetwork).toHaveBeenCalledWith("freenode");
    });
  });

  // UX-5 bucket BT (2026-05-19) — ChromeButtons named export. Re-uses
  // the same archive + cog buttons (same visibility rules, same
  // onOpenSettings + setArchiveModalNetwork wiring) WITHOUT the outer
  // .shell-chrome wrapper. Lets Shell.tsx's mobile-channel branch pass
  // these buttons through TopicBar's `inlineChromeSlot` prop, so the
  // chrome row collapses into the topic row on iPhone — one fewer
  // ~32px-tall row above the scrollback area.
  describe("UX-5 bucket BT — ChromeButtons inline export", () => {
    it("renders the cog (no .shell-chrome wrapper)", () => {
      const onOpenSettings = vi.fn();
      const { container } = render(() => <ChromeButtons onOpenSettings={onOpenSettings} />);
      expect(screen.getByTestId("shell-chrome-cog")).toBeInTheDocument();
      expect(container.querySelector(".shell-chrome")).toBeNull();
    });

    it("clicking the cog fires onOpenSettings", () => {
      const onOpenSettings = vi.fn();
      render(() => <ChromeButtons onOpenSettings={onOpenSettings} />);
      fireEvent.click(screen.getByTestId("shell-chrome-cog"));
      expect(onOpenSettings).toHaveBeenCalled();
    });

    it("hides archive button when no window has network context (home)", () => {
      mockSelected = { networkSlug: "home", channelName: "home", kind: "home" };
      render(() => <ChromeButtons onOpenSettings={vi.fn()} />);
      expect(screen.queryByTestId("shell-chrome-archive")).not.toBeInTheDocument();
    });

    it("shows archive button when a channel window is selected", () => {
      mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
      render(() => <ChromeButtons onOpenSettings={vi.fn()} />);
      expect(screen.getByTestId("shell-chrome-archive")).toBeInTheDocument();
    });
  });
});
