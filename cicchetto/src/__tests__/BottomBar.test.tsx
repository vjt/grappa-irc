import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// BottomBar: mobile-only window picker rendered UNDER ComposeBox.
// Horizontally scrollable strip with per-network sections, each containing
// a server tab, channel tabs, and query tabs with unread + mention badges.

vi.mock("../lib/networks", () => ({
  networks: () => [
    { id: 1, slug: "freenode", inserted_at: "", updated_at: "" },
    { id: 2, slug: "libera", inserted_at: "", updated_at: "" },
  ],
  channelsBySlug: () => ({
    freenode: [
      { name: "#italia", joined: true, source: "autojoin" },
      { name: "#bnc", joined: false, source: "autojoin" },
    ],
    libera: [{ name: "#solids", joined: true, source: "autojoin" }],
  }),
}));

vi.mock("../lib/selection", () => ({
  selectedChannel: () => null,
  setSelectedChannel: vi.fn(),
  unreadCounts: () => ({ "freenode #bnc": 5 }),
  messagesUnread: () => ({ "freenode #bnc": 5, "freenode $server": 4 }),
  eventsUnread: () => ({ "freenode $server": 1 }),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({ "freenode #italia": 2, "freenode $server": 3 }),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

vi.mock("../lib/queryWindows", () => ({
  queryWindowsByNetwork: () => ({
    1: [{ targetNick: "alice", openedAt: "2026-05-04T10:00:00Z" }],
  }),
  closeQueryWindowState: vi.fn(),
  openQueryWindowState: vi.fn(),
  setQueryWindowsByNetwork: vi.fn(),
}));

vi.mock("../lib/windowClose", () => ({
  closeChannelWindow: vi.fn(),
  closeQueryWindow: vi.fn(),
}));

vi.mock("../lib/archive", () => ({
  archivedBySlug: () => ({}),
  loadArchive: vi.fn().mockResolvedValue(undefined),
  clearArchive: vi.fn(),
  visibleArchiveForNetwork: () => [],
  setArchiveModalNetwork: vi.fn(),
  archiveModalNetwork: () => null,
}));

import BottomBar from "../BottomBar";
import * as archiveMod from "../lib/archive";
import * as selMod from "../lib/selection";
import * as windowCloseMod from "../lib/windowClose";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BottomBar", () => {
  it("renders one section per network with the network chip", () => {
    const { container } = render(() => <BottomBar />);
    const chips = container.querySelectorAll(".bottom-bar-network-chip");
    expect(chips.length).toBe(2);
    expect(chips[0]?.textContent).toBe("freenode");
    expect(chips[1]?.textContent).toBe("libera");
  });

  it("renders a Server tab for each network", () => {
    render(() => <BottomBar />);
    const serverTabs = screen.getAllByText("Server");
    expect(serverTabs.length).toBe(2);
  });

  // CP13 — Server tab also surfaces the 3 badge classes.
  it("renders all 3 badge classes on the Server tab when counts present", () => {
    render(() => <BottomBar />);
    const serverTab = screen.getAllByText("Server")[0] as HTMLElement;
    const msg = serverTab.querySelector(".bottom-bar-msg-unread");
    const events = serverTab.querySelector(".bottom-bar-events-unread");
    const mention = serverTab.querySelector(".bottom-bar-mention");
    expect(msg?.textContent).toBe("4");
    expect(events?.textContent).toBe("1");
    expect(mention?.textContent).toBe("@3");
  });

  it("renders channel tabs within each network", () => {
    render(() => <BottomBar />);
    expect(screen.getByText("#italia")).toBeInTheDocument();
    expect(screen.getByText("#bnc")).toBeInTheDocument();
    expect(screen.getByText("#solids")).toBeInTheDocument();
  });

  it("renders query window tabs", () => {
    render(() => <BottomBar />);
    expect(screen.getByText("alice")).toBeInTheDocument();
  });

  it("clicking a channel tab calls setSelectedChannel with correct tuple", () => {
    render(() => <BottomBar />);
    fireEvent.click(screen.getByText("#italia"));
    expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#italia",
      kind: "channel",
    });
  });

  it("clicking the Server tab calls setSelectedChannel with kind 'server'", () => {
    render(() => <BottomBar />);
    fireEvent.click(screen.getAllByText("Server")[0] as HTMLElement);
    expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "$server",
      kind: "server",
    });
  });

  it("clicking a query tab calls setSelectedChannel with kind 'query'", () => {
    render(() => <BottomBar />);
    fireEvent.click(screen.getByText("alice"));
    expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "alice",
      kind: "query",
    });
  });

  it("selected channel tab gets the 'selected' class", async () => {
    vi.resetModules();
    vi.doMock("../lib/networks", () => ({
      networks: () => [{ id: 1, slug: "freenode", inserted_at: "", updated_at: "" }],
      channelsBySlug: () => ({
        freenode: [{ name: "#italia", joined: true, source: "autojoin" }],
      }),
    }));
    vi.doMock("../lib/selection", () => ({
      selectedChannel: () => ({
        networkSlug: "freenode",
        channelName: "#italia",
        kind: "channel",
      }),
      setSelectedChannel: vi.fn(),
      unreadCounts: () => ({}),
      messagesUnread: () => ({}),
      eventsUnread: () => ({}),
    }));
    vi.doMock("../lib/mentions", () => ({ mentionCounts: () => ({}) }));
    vi.doMock("../lib/channelKey", () => ({
      channelKey: (slug: string, name: string) => `${slug} ${name}`,
    }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({}),
    }));
    const { default: BottomBarFresh } = await import("../BottomBar");
    const { container } = render(() => <BottomBarFresh />);
    const italiaBtn = container.querySelector(".bottom-bar-tab.selected");
    expect(italiaBtn).toBeTruthy();
    expect(italiaBtn?.textContent).toContain("#italia");
  });

  it("renders unread badge when unreadCounts > 0", () => {
    render(() => <BottomBar />);
    // Scope to the #bnc tab — the Server tab also has a msg-unread badge
    // since CP13 (S8). The test asserts the channel-side badge specifically.
    const bncTab = screen.getByText("#bnc");
    const unread = bncTab.querySelector(".bottom-bar-msg-unread");
    expect(unread?.textContent).toBe("5");
  });

  it("renders mention badge when mentionCounts > 0", () => {
    render(() => <BottomBar />);
    const italiaTab = screen.getByText("#italia");
    const mention = italiaTab.querySelector(".bottom-bar-mention");
    expect(mention?.textContent).toBe("@2");
  });

  it("has role='tablist' on the bottom-bar container", () => {
    const { container } = render(() => <BottomBar />);
    const bar = container.querySelector("div.bottom-bar");
    expect(bar?.getAttribute("role")).toBe("tablist");
  });

  it("parted channels get the 'parted' class on their label", () => {
    render(() => <BottomBar />);
    const bncBtn = screen.getByText("#bnc").closest("button");
    expect(bncBtn?.classList.contains("parted")).toBe(true);
  });

  // iOS-3 — close × per tab (channels + queries; NOT on server tabs).
  it("renders a close × on each channel tab", () => {
    render(() => <BottomBar />);
    const italiaWrap = screen.getByText("#italia").closest(".bottom-bar-tab-wrap");
    const closeBtn = italiaWrap?.querySelector(".bottom-bar-close");
    expect(closeBtn).toBeTruthy();
    expect(closeBtn?.textContent).toBe("×");
    expect(closeBtn?.getAttribute("aria-label")).toBe("Close #italia");
  });

  it("renders a close × on each query (DM) tab", () => {
    render(() => <BottomBar />);
    const aliceWrap = screen.getByText("alice").closest(".bottom-bar-tab-wrap");
    const closeBtn = aliceWrap?.querySelector(".bottom-bar-close");
    expect(closeBtn).toBeTruthy();
    expect(closeBtn?.textContent).toBe("×");
    expect(closeBtn?.getAttribute("aria-label")).toBe("Close DM with alice");
  });

  it("server tabs have NO close × (server window is not closeable)", () => {
    render(() => <BottomBar />);
    const serverTab = screen.getAllByText("Server")[0] as HTMLElement;
    // Server tab is not wrapped in a .bottom-bar-tab-wrap (no close button
    // sibling). Walk up to the parent .bottom-bar-network.
    const wrap = serverTab.closest(".bottom-bar-tab-wrap");
    expect(wrap).toBeNull();
  });

  it("clicking close × on a channel tab calls closeChannelWindow with correct args", () => {
    render(() => <BottomBar />);
    const italiaWrap = screen.getByText("#italia").closest(".bottom-bar-tab-wrap");
    const closeBtn = italiaWrap?.querySelector(".bottom-bar-close") as HTMLElement;
    fireEvent.click(closeBtn);
    expect(windowCloseMod.closeChannelWindow).toHaveBeenCalledWith("freenode", "#italia");
  });

  it("clicking close × on a query tab calls closeQueryWindow with correct args", () => {
    render(() => <BottomBar />);
    const aliceWrap = screen.getByText("alice").closest(".bottom-bar-tab-wrap");
    const closeBtn = aliceWrap?.querySelector(".bottom-bar-close") as HTMLElement;
    fireEvent.click(closeBtn);
    expect(windowCloseMod.closeQueryWindow).toHaveBeenCalledWith(1, "alice");
  });

  // UX-2 (2026-05-17) — mobile archive chip per network. Renders only
  // when `visibleArchiveForNetwork(slug, id)` returns ≥1 entry; tap
  // calls `setArchiveModalNetwork(slug)` which opens `ArchiveModal`.
  describe("UX-2 — archive chip", () => {
    it("does NOT render a chip when archive is empty for every network", () => {
      const { container } = render(() => <BottomBar />);
      expect(container.querySelectorAll(".bottom-bar-archive-chip").length).toBe(0);
    });

    it("auto-loads archive for every network on mount", () => {
      render(() => <BottomBar />);
      expect(archiveMod.loadArchive).toHaveBeenCalledWith("freenode");
      expect(archiveMod.loadArchive).toHaveBeenCalledWith("libera");
    });

    it("renders a chip per network with non-empty visible archive entries", async () => {
      vi.resetModules();
      vi.doMock("../lib/networks", () => ({
        networks: () => [
          { id: 1, slug: "freenode", inserted_at: "", updated_at: "" },
          { id: 2, slug: "libera", inserted_at: "", updated_at: "" },
        ],
        channelsBySlug: () => ({ freenode: [], libera: [] }),
      }));
      vi.doMock("../lib/selection", () => ({
        selectedChannel: () => null,
        setSelectedChannel: vi.fn(),
        unreadCounts: () => ({}),
        messagesUnread: () => ({}),
        eventsUnread: () => ({}),
      }));
      vi.doMock("../lib/mentions", () => ({ mentionCounts: () => ({}) }));
      vi.doMock("../lib/channelKey", () => ({
        channelKey: (slug: string, name: string) => `${slug} ${name}`,
      }));
      vi.doMock("../lib/queryWindows", () => ({
        queryWindowsByNetwork: () => ({}),
      }));
      vi.doMock("../lib/windowClose", () => ({
        closeChannelWindow: vi.fn(),
        closeQueryWindow: vi.fn(),
      }));
      vi.doMock("../lib/archive", () => ({
        archivedBySlug: () => ({}),
        loadArchive: vi.fn().mockResolvedValue(undefined),
        setArchiveModalNetwork: vi.fn(),
        visibleArchiveForNetwork: (slug: string) =>
          slug === "freenode"
            ? [
                { target: "vjt-peer", kind: "query", last_activity: 100, row_count: 4 },
                { target: "#bofh", kind: "channel", last_activity: 200, row_count: 8 },
              ]
            : [],
      }));
      const { default: BottomBarFresh } = await import("../BottomBar");
      const { container } = render(() => <BottomBarFresh />);
      const chips = container.querySelectorAll(".bottom-bar-archive-chip");
      expect(chips.length).toBe(1);
      expect(chips[0]?.textContent).toContain("Archive");
      expect(chips[0]?.textContent).toContain("2");
    });

    it("clicking the chip calls setArchiveModalNetwork with the slug", async () => {
      vi.resetModules();
      vi.doMock("../lib/networks", () => ({
        networks: () => [{ id: 1, slug: "freenode", inserted_at: "", updated_at: "" }],
        channelsBySlug: () => ({ freenode: [] }),
      }));
      vi.doMock("../lib/selection", () => ({
        selectedChannel: () => null,
        setSelectedChannel: vi.fn(),
        unreadCounts: () => ({}),
        messagesUnread: () => ({}),
        eventsUnread: () => ({}),
      }));
      vi.doMock("../lib/mentions", () => ({ mentionCounts: () => ({}) }));
      vi.doMock("../lib/channelKey", () => ({
        channelKey: (slug: string, name: string) => `${slug} ${name}`,
      }));
      vi.doMock("../lib/queryWindows", () => ({
        queryWindowsByNetwork: () => ({}),
      }));
      vi.doMock("../lib/windowClose", () => ({
        closeChannelWindow: vi.fn(),
        closeQueryWindow: vi.fn(),
      }));
      const setArchiveModalNetwork = vi.fn();
      vi.doMock("../lib/archive", () => ({
        archivedBySlug: () => ({}),
        loadArchive: vi.fn().mockResolvedValue(undefined),
        setArchiveModalNetwork,
        visibleArchiveForNetwork: () => [
          { target: "vjt-peer", kind: "query", last_activity: 100, row_count: 4 },
        ],
      }));
      const { default: BottomBarFresh } = await import("../BottomBar");
      const { container } = render(() => <BottomBarFresh />);
      const chip = container.querySelector(".bottom-bar-archive-chip") as HTMLElement;
      expect(chip).toBeTruthy();
      fireEvent.click(chip);
      expect(setArchiveModalNetwork).toHaveBeenCalledWith("freenode");
    });
  });
});
