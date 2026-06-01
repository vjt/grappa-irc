import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// BottomBar: mobile-only window picker rendered UNDER ComposeBox.
// Horizontally scrollable strip with per-network sections, each containing
// a server tab, channel tabs, and query tabs with unread + mention badges.
//
// UX-6-E (2026-05-21): the per-network header chip and the standalone
// "Server" tab are merged into ONE entry, mirroring desktop Sidebar's
// `.sidebar-network-header` row. The chip itself IS the clickable Server-
// window entry (emoji + slug + badges + disconnect ×).

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
  applySeedEnvelope: vi.fn(),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({ "freenode #italia": 2, "freenode $server": 3 }),
  bumpMention: vi.fn(),
  clearMentionsForKey: vi.fn(),
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
  disconnectNetwork: vi.fn(),
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
import * as selMod from "../lib/selection";
import * as windowCloseMod from "../lib/windowClose";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BottomBar", () => {
  it("renders one network-header per network containing slug + emoji", () => {
    const { container } = render(() => <BottomBar />);
    const headers = container.querySelectorAll(".bottom-bar-network-header");
    expect(headers.length).toBe(2);
    expect(headers[0]?.textContent).toContain("freenode");
    expect(headers[1]?.textContent).toContain("libera");
    // The ⚙️ emoji mirrors the sidebar's `.sidebar-network-emoji` byte.
    expect(headers[0]?.querySelector(".bottom-bar-network-emoji")?.textContent).toBe("⚙️");
  });

  it("does NOT render the legacy chip span or a standalone 'Server' tab (UX-6-E dedup)", () => {
    const { container } = render(() => <BottomBar />);
    // Belt: the pre-UX-6-E passive `.bottom-bar-network-chip` span is gone.
    expect(container.querySelectorAll(".bottom-bar-network-chip").length).toBe(0);
    // Braces: no non-header `.bottom-bar-tab` carries the literal "Server"
    // label. The header IS the server entry; no parallel tab remains.
    const allTabText = Array.from(
      container.querySelectorAll(".bottom-bar-tab:not(.bottom-bar-network-header)"),
    )
      .map((n) => n.textContent ?? "")
      .join("|");
    expect(allTabText).not.toContain("Server");
    // Sanity: there IS at least one non-header tab (a channel) to ensure
    // the previous selector isn't matching zero elements vacuously.
    const standaloneChannel = container.querySelector(
      ".bottom-bar-tab:not(.bottom-bar-network-header)",
    );
    expect(standaloneChannel).not.toBeNull();
  });

  it("the network-header acts as the Server-window entry: click → kind 'server'", () => {
    const { container } = render(() => <BottomBar />);
    const header = container.querySelector(
      '.bottom-bar-network-header[data-network-slug="freenode"]',
    ) as HTMLElement;
    expect(header).not.toBeNull();
    fireEvent.click(header);
    expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "$server",
      kind: "server",
    });
  });

  it("renders all 3 badge classes on the network-header (server entry)", () => {
    const { container } = render(() => <BottomBar />);
    const header = container.querySelector(
      '.bottom-bar-network-header[data-network-slug="freenode"]',
    ) as HTMLElement;
    expect(header).not.toBeNull();
    const msg = header.querySelector(".bottom-bar-msg-unread");
    const events = header.querySelector(".bottom-bar-events-unread");
    const mention = header.querySelector(".bottom-bar-mention");
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

  it("UX-5 BC2: query (DM) tab nick is rendered through NickText (.nick-text span + inline color)", () => {
    render(() => <BottomBar />);
    const aliceTab = screen.getByText("alice").closest("button");
    expect(aliceTab).not.toBeNull();
    const nickText = aliceTab?.querySelector(".nick-text") as HTMLElement | null;
    expect(nickText).not.toBeNull();
    expect(nickText?.textContent).toBe("alice");
    expect(nickText?.style.color).toMatch(/^var\(--nick-color-\d+\)$/);
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

  it("clicking a query tab calls setSelectedChannel with kind 'query'", () => {
    render(() => <BottomBar />);
    fireEvent.click(screen.getByText("alice"));
    expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "alice",
      kind: "query",
    });
  });

  it("selected server window adds 'selected' class to the network-header", async () => {
    vi.resetModules();
    vi.doMock("../lib/networks", () => ({
      networks: () => [{ id: 1, slug: "freenode", inserted_at: "", updated_at: "" }],
      channelsBySlug: () => ({ freenode: [] }),
    }));
    vi.doMock("../lib/selection", () => ({
      selectedChannel: () => ({
        networkSlug: "freenode",
        channelName: "$server",
        kind: "server",
      }),
      setSelectedChannel: vi.fn(),
      unreadCounts: () => ({}),
      messagesUnread: () => ({}),
      eventsUnread: () => ({}),
    }));
    vi.doMock("../lib/mentions", () => ({
      mentionCounts: () => ({}),
      bumpMention: vi.fn(),
      clearMentionsForKey: vi.fn(),
    }));
    vi.doMock("../lib/channelKey", () => ({
      channelKey: (slug: string, name: string) => `${slug} ${name}`,
    }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({}),
    }));
    vi.doMock("../lib/windowClose", () => ({
      closeChannelWindow: vi.fn(),
      closeQueryWindow: vi.fn(),
      disconnectNetwork: vi.fn(),
    }));
    const { default: BottomBarFresh } = await import("../BottomBar");
    const { container } = render(() => <BottomBarFresh />);
    const header = container.querySelector(
      ".bottom-bar-network-header.selected",
    ) as HTMLElement | null;
    expect(header).not.toBeNull();
    expect(header?.getAttribute("data-network-slug")).toBe("freenode");
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
    vi.doMock("../lib/mentions", () => ({
      mentionCounts: () => ({}),
      bumpMention: vi.fn(),
      clearMentionsForKey: vi.fn(),
    }));
    vi.doMock("../lib/channelKey", () => ({
      channelKey: (slug: string, name: string) => `${slug} ${name}`,
    }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({}),
    }));
    vi.doMock("../lib/windowClose", () => ({
      closeChannelWindow: vi.fn(),
      closeQueryWindow: vi.fn(),
      disconnectNetwork: vi.fn(),
    }));
    const { default: BottomBarFresh } = await import("../BottomBar");
    const { container } = render(() => <BottomBarFresh />);
    // Pick the non-header selected tab specifically.
    const italiaBtn = container.querySelector(
      ".bottom-bar-tab.selected:not(.bottom-bar-network-header)",
    );
    expect(italiaBtn).toBeTruthy();
    expect(italiaBtn?.textContent).toContain("#italia");
  });

  it("renders unread badge when unreadCounts > 0", () => {
    render(() => <BottomBar />);
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

  // iOS-3 — close × per tab (channels + queries; NOT on the server header).
  it("renders a close × on each channel tab", () => {
    render(() => <BottomBar />);
    const italiaTab = screen.getByText("#italia").closest("button");
    expect(italiaTab).not.toBeNull();
    const closeBtn = italiaTab!.nextElementSibling as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    expect(closeBtn!.classList.contains("bottom-bar-close")).toBe(true);
    expect(closeBtn?.textContent).toBe("×");
    expect(closeBtn?.getAttribute("aria-label")).toBe("Close #italia");
  });

  it("renders a close × on each query (DM) tab", () => {
    render(() => <BottomBar />);
    const aliceTab = screen.getByText("alice").closest("button");
    expect(aliceTab).not.toBeNull();
    const closeBtn = aliceTab!.nextElementSibling as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    expect(closeBtn!.classList.contains("bottom-bar-close")).toBe(true);
    expect(closeBtn?.textContent).toBe("×");
    expect(closeBtn?.getAttribute("aria-label")).toBe("Close DM with alice");
  });

  it("network-header has a disconnect × sibling (mirrors sidebar UX-4 D)", () => {
    const { container } = render(() => <BottomBar />);
    const header = container.querySelector(
      '.bottom-bar-network-header[data-network-slug="freenode"]',
    ) as HTMLElement;
    expect(header).not.toBeNull();
    const closeBtn = header.nextElementSibling as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    expect(closeBtn!.classList.contains("bottom-bar-close")).toBe(true);
    expect(closeBtn!.getAttribute("aria-label")).toBe("Disconnect freenode");
  });

  it("clicking the network-header close × calls disconnectNetwork", () => {
    const { container } = render(() => <BottomBar />);
    const header = container.querySelector(
      '.bottom-bar-network-header[data-network-slug="freenode"]',
    ) as HTMLElement;
    const closeBtn = header.nextElementSibling as HTMLElement;
    fireEvent.click(closeBtn);
    expect(windowCloseMod.disconnectNetwork).toHaveBeenCalledWith("freenode");
  });

  it("clicking close × on a channel tab calls closeChannelWindow with correct args", () => {
    render(() => <BottomBar />);
    const italiaTab = screen.getByText("#italia").closest("button");
    expect(italiaTab).not.toBeNull();
    const closeBtn = italiaTab!.nextElementSibling as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn!);
    expect(windowCloseMod.closeChannelWindow).toHaveBeenCalledWith("freenode", "#italia");
  });

  it("clicking close × on a query tab calls closeQueryWindow with correct args", () => {
    render(() => <BottomBar />);
    const aliceTab = screen.getByText("alice").closest("button");
    expect(aliceTab).not.toBeNull();
    const closeBtn = aliceTab!.nextElementSibling as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn!);
    expect(windowCloseMod.closeQueryWindow).toHaveBeenCalledWith(1, "alice");
  });
});
