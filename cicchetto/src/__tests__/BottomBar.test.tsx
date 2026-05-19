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

  it("UX-5 BC2: query (DM) tab nick is rendered through NickText (.nick-text span + inline color)", () => {
    render(() => <BottomBar />);
    // The DM tab for "alice" mounts the NickText helper, which wraps
    // the nick in a `.nick-text` span carrying the deterministic
    // `var(--nick-color-N)` inline style. This pins consistency with
    // the desktop Sidebar's identical DM-row migration — without this
    // assertion the mobile bottom bar could silently regress to a bare
    // `{qw.targetNick}` interpolation (the pre-BC2 shape).
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
  // Post-UX-3-DEC: tab + close × are flat flex siblings (no wrapper span).
  it("renders a close × on each channel tab", () => {
    render(() => <BottomBar />);
    const italiaTab = screen.getByText("#italia").closest("button");
    expect(italiaTab).not.toBeNull();
    const closeBtn = italiaTab!.nextElementSibling as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    expect(closeBtn!.classList.contains("bottom-bar-close")).toBe(true);
    expect(closeBtn!.textContent).toBe("×");
    expect(closeBtn!.getAttribute("aria-label")).toBe("Close #italia");
  });

  it("renders a close × on each query (DM) tab", () => {
    render(() => <BottomBar />);
    const aliceTab = screen.getByText("alice").closest("button");
    expect(aliceTab).not.toBeNull();
    const closeBtn = aliceTab!.nextElementSibling as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    expect(closeBtn!.classList.contains("bottom-bar-close")).toBe(true);
    expect(closeBtn!.textContent).toBe("×");
    expect(closeBtn!.getAttribute("aria-label")).toBe("Close DM with alice");
  });

  it("server tabs have NO close × (server window is not closeable)", () => {
    render(() => <BottomBar />);
    const serverTab = screen.getAllByText("Server")[0] as HTMLElement;
    const tabBtn = serverTab.closest("button");
    expect(tabBtn).not.toBeNull();
    // The bottom-bar-close MUST NOT exist as the tab's adjacent sibling.
    // Walk the parent's children looking for any sibling .bottom-bar-close
    // referencing Server — there must be zero.
    const network = tabBtn!.parentElement;
    expect(network).not.toBeNull();
    const serverCloses = network!.querySelectorAll(
      ':scope > .bottom-bar-close[aria-label*="Server"]',
    );
    expect(serverCloses.length).toBe(0);
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

  // UX-4 bucket L (2026-05-19): the per-network mobile archive chip
  // moved from BottomBar to the always-visible ShellChrome bar at the
  // top of `.shell-main`. BottomBar no longer renders archive chips
  // and no longer eager-loads `loadArchive` per network — desktop's
  // `<details>` lazy-loads on user expand, and ShellChrome resolves
  // archive on demand from the currently-selected window's network.
  // Coverage moved to ShellChrome.test.tsx.
});
