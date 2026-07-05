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
//
// UX-5 bucket BM (2026-05-20) — the `ChromeButtons` named export was
// dropped (BT introduced it for the mobile-channel `inlineChromeSlot`
// path; BM moved that surface into the members drawer footer, so the
// only consumer is gone and the export folded back into the default
// ShellChrome body). The `describe("ChromeButtons inline export")`
// block was deleted with the export.

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
const mockSetSelectedChannel = vi.fn();
vi.mock("../lib/selection", () => ({
  selectedChannel: () => mockSelected,
  setSelectedChannel: (...args: unknown[]) => mockSetSelectedChannel(...args),
  applySeedEnvelope: vi.fn(),
}));

// #188 — the open-mentions button only surfaces when a bundle exists for
// the selected window's network. A mutable holder lets each test control
// which slugs have a bundle.
const mentionsBundles = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock("../lib/mentionsWindow", () => ({
  mentionsBundleBySlug: () => mentionsBundles.value,
}));

// Post-bundle desktop fix — ShellChrome's archive button is now gated on
// `isMobile()` so desktop doesn't render it (Sidebar's `<details
// class="sidebar-archive">` already exposes parked rows inline). Mirror
// the Shell.test.tsx pattern: a mutable hoisted holder so individual
// describe blocks can flip mobile/desktop.
const mobileState = vi.hoisted(() => ({ value: true }));
vi.mock("../lib/theme", () => ({
  isMobile: () => mobileState.value,
}));

import ShellChrome from "../ShellChrome";

beforeEach(() => {
  vi.clearAllMocks();
  mockSelected = null;
  mobileState.value = true;
  mentionsBundles.value = {};
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

  // Post-bundle desktop fix — on desktop the archive button is
  // suppressed: Sidebar's `<details class="sidebar-archive">` already
  // exposes parked/archived rows inline so a separate chrome button
  // is redundant. The mobile assertions above keep the rule that on
  // narrow viewports the button surfaces (the sidebar is collapsed
  // behind a drawer there).
  describe("archive button visibility (desktop mode)", () => {
    beforeEach(() => {
      mobileState.value = false;
    });

    it("hides archive button on desktop even when a channel window is selected", () => {
      mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.queryByTestId("shell-chrome-archive")).toBeNull();
    });

    it("hides archive button on desktop even when a query window is selected", () => {
      mockSelected = { networkSlug: "freenode", channelName: "alice", kind: "query" };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.queryByTestId("shell-chrome-archive")).toBeNull();
    });

    it("hides archive button on desktop even when a server window is selected", () => {
      mockSelected = { networkSlug: "freenode", channelName: "$server", kind: "server" };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.queryByTestId("shell-chrome-archive")).toBeNull();
    });
  });

  // #188 item 6 — a button next to the cog opens the mentions panel. It
  // derives the network from the current selection (like the archive
  // button) and renders ONLY when that network has a bundle to consult.
  describe("open-mentions button (#188)", () => {
    it("shows the button when the selected network has a mentions bundle", () => {
      mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
      mentionsBundles.value = { freenode: {} };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.getByTestId("shell-chrome-mentions")).toBeInTheDocument();
    });

    it("hides the button when the selected network has no bundle", () => {
      mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
      mentionsBundles.value = {};
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.queryByTestId("shell-chrome-mentions")).toBeNull();
    });

    it("hides the button when no window carries a network context (home)", () => {
      mockSelected = { networkSlug: "home", channelName: "home", kind: "home" };
      mentionsBundles.value = { home: {} };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.queryByTestId("shell-chrome-mentions")).toBeNull();
    });

    it("shows on desktop too (not mobile-gated like archive)", () => {
      mobileState.value = false;
      mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
      mentionsBundles.value = { freenode: {} };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      expect(screen.getByTestId("shell-chrome-mentions")).toBeInTheDocument();
    });

    it("clicking it opens the mentions pseudo-window for the selected network", () => {
      mockSelected = { networkSlug: "freenode", channelName: "#italia", kind: "channel" };
      mentionsBundles.value = { freenode: {} };
      render(() => <ShellChrome onOpenSettings={vi.fn()} />);
      fireEvent.click(screen.getByTestId("shell-chrome-mentions"));
      expect(mockSetSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "",
        kind: "mentions",
      });
    });
  });
});
