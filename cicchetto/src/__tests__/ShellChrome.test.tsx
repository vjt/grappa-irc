import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// UX-4 bucket L (2026-05-19) — ShellChrome unit tests.
// Cluster-wide rule: settings cog visible from EVERY window kind. The
// archive button is visible only when the selected window carries a
// network context (channel/query/server); home/mentions/empty hide it.

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

import ShellChrome from "../ShellChrome";

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

  it("renders the hamburger when onToggleSidebar is provided", () => {
    const onToggleSidebar = vi.fn();
    render(() => <ShellChrome onToggleSidebar={onToggleSidebar} onOpenSettings={vi.fn()} />);
    expect(screen.getByLabelText(/open channel sidebar/i)).toBeInTheDocument();
  });

  it("hides the hamburger when onToggleSidebar is omitted", () => {
    render(() => <ShellChrome onOpenSettings={vi.fn()} />);
    expect(screen.queryByLabelText(/open channel sidebar/i)).not.toBeInTheDocument();
  });

  it("clicking the hamburger fires onToggleSidebar", () => {
    const onToggleSidebar = vi.fn();
    render(() => <ShellChrome onToggleSidebar={onToggleSidebar} onOpenSettings={vi.fn()} />);
    fireEvent.click(screen.getByLabelText(/open channel sidebar/i));
    expect(onToggleSidebar).toHaveBeenCalled();
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
});
