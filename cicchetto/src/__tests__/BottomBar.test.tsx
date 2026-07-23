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

// #243 — controllable re-tap predicate (see Sidebar.test.tsx for the
// rationale; mobile mirrors the desktop wiring exactly).
const isActiveSelectionMock = vi.hoisted(() => vi.fn<(next: unknown) => boolean>());

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
  isActiveSelection: (next: unknown) => isActiveSelectionMock(next),
  unreadCounts: () => ({ "freenode #bnc": 5 }),
  messagesUnread: () => ({ "freenode #bnc": 5, "freenode $server": 4 }),
  eventsUnread: () => ({ "freenode $server": 1 }),
  applySeedEnvelope: vi.fn(),
}));

// #243 — the scroll-to-bottom command bridge, spied for the re-tap wiring.
vi.mock("../lib/scrollToBottomCommand", () => ({
  requestScrollToBottom: vi.fn(),
  scrollToBottomRequest: () => 0,
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({ "freenode #italia": 2, "freenode $server": 3 }),
  setServerMention: vi.fn(),
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
  // #195 — the channel/network × now route through the confirm-gated verbs;
  // query stays a direct (non-destructive) close.
  closeQueryWindow: vi.fn(),
  confirmLeaveChannel: vi.fn(),
  confirmDisconnectNetwork: vi.fn(),
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
import * as scrollCmd from "../lib/scrollToBottomCommand";
import * as selMod from "../lib/selection";
import * as windowCloseMod from "../lib/windowClose";

beforeEach(() => {
  vi.clearAllMocks();
  // #243 — default "not the active window" so existing click tests never
  // trip the scroll-to-bottom branch.
  isActiveSelectionMock.mockReturnValue(false);
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

  // #243 — re-tapping the ALREADY-active bottom-bar entry is an irssi-parity
  // "jump to latest": it fires the scroll-to-bottom command. A tap that
  // SWITCHES windows must not. Mirrors the desktop Sidebar wiring exactly.
  describe("#243 — re-tap active tab scrolls scrollback to bottom", () => {
    it("re-tapping the active channel tab fires requestScrollToBottom with the tapped tuple", () => {
      isActiveSelectionMock.mockReturnValue(true);
      render(() => <BottomBar />);
      fireEvent.click(screen.getByText("#italia"));
      expect(isActiveSelectionMock).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#italia",
        kind: "channel",
      });
      expect(scrollCmd.requestScrollToBottom).toHaveBeenCalledTimes(1);
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#italia",
        kind: "channel",
      });
    });

    it("tapping a DIFFERENT (non-active) channel tab does NOT fire requestScrollToBottom", () => {
      isActiveSelectionMock.mockReturnValue(false);
      render(() => <BottomBar />);
      fireEvent.click(screen.getByText("#bnc"));
      expect(scrollCmd.requestScrollToBottom).not.toHaveBeenCalled();
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#bnc",
        kind: "channel",
      });
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
      isActiveSelection: () => false,
      unreadCounts: () => ({}),
      messagesUnread: () => ({}),
      eventsUnread: () => ({}),
    }));
    vi.doMock("../lib/mentions", () => ({
      mentionCounts: () => ({}),
      setServerMention: vi.fn(),
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
      isActiveSelection: () => false,
      unreadCounts: () => ({}),
      messagesUnread: () => ({}),
      eventsUnread: () => ({}),
    }));
    vi.doMock("../lib/mentions", () => ({
      mentionCounts: () => ({}),
      setServerMention: vi.fn(),
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

  // #195 — the #172 hold-to-close gesture is GONE. A plain click on the
  // channel/network × now opens the explicit confirm modal (the raw close
  // verb runs only on Yes, not from BottomBar). A tap == a click on touch, so
  // this covers both mouse and touch. The confirm-gated verbs are mocked; the
  // modal render + Yes/Cancel is covered by ConfirmModal + the e2e.
  it("clicking the network-header close × opens the disconnect confirm (#195)", () => {
    const { container } = render(() => <BottomBar />);
    const header = container.querySelector(
      '.bottom-bar-network-header[data-network-slug="freenode"]',
    ) as HTMLElement;
    const closeBtn = header.nextElementSibling as HTMLElement;
    fireEvent.click(closeBtn);
    expect(windowCloseMod.confirmDisconnectNetwork).toHaveBeenCalledWith("freenode");
  });

  it("clicking a channel close × opens the leave confirm (#195)", () => {
    render(() => <BottomBar />);
    const italiaTab = screen.getByText("#italia").closest("button");
    expect(italiaTab).not.toBeNull();
    const closeBtn = italiaTab!.nextElementSibling as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn!);
    expect(windowCloseMod.confirmLeaveChannel).toHaveBeenCalledWith("freenode", "#italia");
  });

  // Query close stays a direct, non-destructive close — no confirm modal
  // (a DM window is trivially reopened; only channel PART / network park gate).
  it("clicking a query close × closes it directly, no confirm (#195)", () => {
    render(() => <BottomBar />);
    const aliceTab = screen.getByText("alice").closest("button");
    expect(aliceTab).not.toBeNull();
    const closeBtn = aliceTab!.nextElementSibling as HTMLElement | null;
    expect(closeBtn).not.toBeNull();
    fireEvent.click(closeBtn!);
    expect(windowCloseMod.closeQueryWindow).toHaveBeenCalledWith(1, "alice");
  });

  // #327 — the active-tab auto-scroll must (1) DEFER its geometry read until
  // AFTER layout settles and (2) account for the STICKY network header that
  // pins to the scroller's leading edge (#260 — position:sticky;left:0;
  // z-index:1). The original defer (5d44b7f8) fixed the stale-badge-reflow
  // read; the reopen (2026-07-20) is that scrollIntoView({inline:"nearest"})
  // lands the tab flush to that same edge — i.e. UNDER the pinned header —
  // leaving it occluded. scrollIntoView has no notion of the sticky offset.
  // The fix computes scrollLeft manually inside the double-rAF idiom
  // (ScrollbackPane.tsx ~:1569): the visible region EXCLUDING the header is
  // [scrollerLeft + headerWidth, scrollerRight]; nudge scrollLeft only far
  // enough to bring the selected tab's near edge to that boundary, re-querying
  // `.bottom-bar-tab.selected` INSIDE the deferred callback so it resolves
  // against the settled DOM.
  describe("#327 — active-tab auto-scroll: deferred + sticky-header-aware", () => {
    // jsdom does no layout, so we inject geometry via getBoundingClientRect
    // stubs and prove the effect computes the correct scrollLeft nudge.
    const rectOf = (o: Partial<DOMRect>): DOMRect =>
      ({
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        toJSON: () => ({}),
        ...o,
      }) as DOMRect;

    it("does not scroll synchronously; after two rAF ticks it scrolls the selected tab clear of the sticky header", async () => {
      vi.resetModules();
      const { createSignal } = await import("solid-js");
      const [sel, setSel] = createSignal<{
        networkSlug: string;
        channelName: string;
        kind: string;
      } | null>(null);

      vi.doMock("../lib/networks", () => ({
        networks: () => [{ id: 1, slug: "freenode", inserted_at: "", updated_at: "" }],
        channelsBySlug: () => ({
          freenode: [{ name: "#italia", joined: true, source: "autojoin" }],
        }),
      }));
      vi.doMock("../lib/selection", () => ({
        selectedChannel: sel,
        setSelectedChannel: setSel,
        isActiveSelection: () => false,
        unreadCounts: () => ({}),
        messagesUnread: () => ({}),
        eventsUnread: () => ({}),
      }));
      vi.doMock("../lib/mentions", () => ({
        mentionCounts: () => ({}),
        setServerMention: vi.fn(),
      }));
      vi.doMock("../lib/channelKey", () => ({
        channelKey: (slug: string, name: string) => `${slug} ${name}`,
      }));
      vi.doMock("../lib/queryWindows", () => ({
        queryWindowsByNetwork: () => ({}),
      }));
      vi.doMock("../lib/windowClose", () => ({
        closeQueryWindow: vi.fn(),
        confirmLeaveChannel: vi.fn(),
        confirmDisconnectNetwork: vi.fn(),
      }));
      vi.doMock("../lib/scrollToBottomCommand", () => ({
        requestScrollToBottom: vi.fn(),
        scrollToBottomRequest: () => 0,
      }));

      // Deterministic rAF: capture callbacks, drain them on demand. One
      // drain = one animation frame. jsdom has no real rAF timing.
      const rafQueue: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });
      const frame = () => {
        for (const cb of rafQueue.splice(0)) cb(0);
      };

      const { default: BottomBarFresh } = await import("../BottomBar");
      const { container } = render(() => <BottomBarFresh />);

      const scroller = container.querySelector(".bottom-bar") as HTMLElement;
      const scrollToSpy = vi.fn();
      // jsdom implements neither scrollTo nor layout — inject both.
      (scroller as unknown as { scrollTo: () => void }).scrollTo = scrollToSpy;
      Object.defineProperty(scroller, "scrollLeft", {
        value: 100,
        writable: true,
        configurable: true,
      });
      scroller.getBoundingClientRect = () => rectOf({ left: 0, right: 300, width: 300 });

      // The tab + header render regardless of selection; inject a geometry
      // where the tab sits UNDER the 60px-wide sticky header (tab.left 10 <
      // visibleLeft 60) so the effect MUST scroll it clear.
      const tab = container.querySelector(
        '.bottom-bar-tab[data-window-name="#italia"]',
      ) as HTMLElement;
      tab.getBoundingClientRect = () => rectOf({ left: 10, right: 90, width: 80 });
      const header = container.querySelector(".bottom-bar-network-header") as HTMLElement;
      header.getBoundingClientRect = () => rectOf({ left: 0, right: 60, width: 60 });

      // Discard any frames queued during the async mount boundary; from here
      // the block is synchronous so the only rAF that lands is OUR effect's.
      rafQueue.length = 0;
      scrollToSpy.mockClear();

      // Select #italia — the effect must NOT scroll synchronously.
      setSel({ networkSlug: "freenode", channelName: "#italia", kind: "channel" });
      expect(scrollToSpy).not.toHaveBeenCalled();

      // One frame is not enough — the idiom needs the SECOND rAF (layout
      // settled) before it reads geometry.
      frame();
      expect(scrollToSpy).not.toHaveBeenCalled();

      // Second frame: now it scrolls the selected tab clear of the header.
      // delta = tab.left(10) - (scroller.left(0) + headerWidth(60)) = -50;
      // scrollLeft(100) + delta = 50.
      frame();
      expect(scrollToSpy).toHaveBeenCalledTimes(1);
      expect(scrollToSpy).toHaveBeenCalledWith({ left: 50, behavior: "smooth" });

      vi.unstubAllGlobals();
    });

    it("re-queries the LIVE selection inside the deferred callback — a mid-flight switch scrolls the new tab, never the stale one", async () => {
      vi.resetModules();
      const { createSignal } = await import("solid-js");
      const [sel, setSel] = createSignal<{
        networkSlug: string;
        channelName: string;
        kind: string;
      } | null>(null);

      vi.doMock("../lib/networks", () => ({
        networks: () => [{ id: 1, slug: "freenode", inserted_at: "", updated_at: "" }],
        channelsBySlug: () => ({
          freenode: [
            { name: "#italia", joined: true, source: "autojoin" },
            { name: "#other", joined: true, source: "autojoin" },
          ],
        }),
      }));
      vi.doMock("../lib/selection", () => ({
        selectedChannel: sel,
        setSelectedChannel: setSel,
        isActiveSelection: () => false,
        unreadCounts: () => ({}),
        messagesUnread: () => ({}),
        eventsUnread: () => ({}),
      }));
      vi.doMock("../lib/mentions", () => ({
        mentionCounts: () => ({}),
        setServerMention: vi.fn(),
      }));
      vi.doMock("../lib/channelKey", () => ({
        channelKey: (slug: string, name: string) => `${slug} ${name}`,
      }));
      vi.doMock("../lib/queryWindows", () => ({
        queryWindowsByNetwork: () => ({}),
      }));
      vi.doMock("../lib/windowClose", () => ({
        closeQueryWindow: vi.fn(),
        confirmLeaveChannel: vi.fn(),
        confirmDisconnectNetwork: vi.fn(),
      }));
      vi.doMock("../lib/scrollToBottomCommand", () => ({
        requestScrollToBottom: vi.fn(),
        scrollToBottomRequest: () => 0,
      }));

      const rafQueue: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });
      const frame = () => {
        for (const cb of rafQueue.splice(0)) cb(0);
      };

      const { default: BottomBarFresh } = await import("../BottomBar");
      const { container } = render(() => <BottomBarFresh />);

      const scroller = container.querySelector(".bottom-bar") as HTMLElement;
      const scrollToCalls: Array<{ left: number }> = [];
      (scroller as unknown as { scrollTo: (o: { left: number }) => void }).scrollTo = (o) => {
        scrollToCalls.push(o);
      };
      Object.defineProperty(scroller, "scrollLeft", {
        value: 0,
        writable: true,
        configurable: true,
      });
      scroller.getBoundingClientRect = () => rectOf({ left: 0, right: 300, width: 300 });

      const header = container.querySelector(".bottom-bar-network-header") as HTMLElement;
      header.getBoundingClientRect = () => rectOf({ left: 0, right: 60, width: 60 });

      // #italia occluded under the header → would compute left = 0 + (10 - 60) = -50.
      const italia = container.querySelector(
        '.bottom-bar-tab[data-window-name="#italia"]',
      ) as HTMLElement;
      italia.getBoundingClientRect = () => rectOf({ left: 10, right: 90, width: 80 });
      // #other off the RIGHT edge → computes left = 0 + (400 - 300) = +100.
      const other = container.querySelector(
        '.bottom-bar-tab[data-window-name="#other"]',
      ) as HTMLElement;
      other.getBoundingClientRect = () => rectOf({ left: 320, right: 400, width: 80 });

      rafQueue.length = 0;
      scrollToCalls.length = 0;

      // Select #italia, then advance ONE frame so its outer rAF has run and
      // its inner (DOM-reading) callback is scheduled but NOT yet executed.
      setSel({ networkSlug: "freenode", channelName: "#italia", kind: "channel" });
      frame();

      // Mid-flight switch to #other BEFORE that inner callback runs — the
      // `.selected` class moves to #other synchronously. A fix that captured
      // the tab ref at effect-fire time would still scroll #italia (left -50);
      // the re-query resolves `.bottom-bar-tab.selected` to the NOW-selected
      // #other (left 100).
      setSel({ networkSlug: "freenode", channelName: "#other", kind: "channel" });

      // Drain the #italia chain's inner + the #other chain's outer→inner.
      frame();
      frame();

      expect(scrollToCalls.length).toBeGreaterThan(0);
      // Every scroll targets #other's geometry (left 100), never #italia's (-50).
      expect(scrollToCalls.every((c) => c.left === 100)).toBe(true);
      expect(scrollToCalls.some((c) => c.left === -50)).toBe(false);

      vi.unstubAllGlobals();
    });

    it("selecting the network/server header does NOT spuriously scroll — the header is its OWN sticky occluder", async () => {
      vi.resetModules();
      const { createSignal } = await import("solid-js");
      const [sel, setSel] = createSignal<{
        networkSlug: string;
        channelName: string;
        kind: string;
      } | null>(null);

      vi.doMock("../lib/networks", () => ({
        networks: () => [{ id: 1, slug: "freenode", inserted_at: "", updated_at: "" }],
        channelsBySlug: () => ({ freenode: [] }),
      }));
      vi.doMock("../lib/selection", () => ({
        selectedChannel: sel,
        setSelectedChannel: setSel,
        isActiveSelection: () => false,
        unreadCounts: () => ({}),
        messagesUnread: () => ({}),
        eventsUnread: () => ({}),
      }));
      vi.doMock("../lib/mentions", () => ({
        mentionCounts: () => ({}),
        setServerMention: vi.fn(),
      }));
      vi.doMock("../lib/channelKey", () => ({
        channelKey: (slug: string, name: string) => `${slug} ${name}`,
      }));
      vi.doMock("../lib/queryWindows", () => ({
        queryWindowsByNetwork: () => ({}),
      }));
      vi.doMock("../lib/windowClose", () => ({
        closeQueryWindow: vi.fn(),
        confirmLeaveChannel: vi.fn(),
        confirmDisconnectNetwork: vi.fn(),
      }));
      vi.doMock("../lib/scrollToBottomCommand", () => ({
        requestScrollToBottom: vi.fn(),
        scrollToBottomRequest: () => 0,
      }));

      const rafQueue: FrameRequestCallback[] = [];
      vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
        rafQueue.push(cb);
        return rafQueue.length;
      });
      const frame = () => {
        for (const cb of rafQueue.splice(0)) cb(0);
      };

      const { default: BottomBarFresh } = await import("../BottomBar");
      const { container } = render(() => <BottomBarFresh />);

      const scroller = container.querySelector(".bottom-bar") as HTMLElement;
      const scrollToSpy = vi.fn();
      (scroller as unknown as { scrollTo: () => void }).scrollTo = scrollToSpy;
      // Scrolled well to the right so a bogus header-width subtraction WOULD
      // move the strip (guards against a false pass at scrollLeft 0 → clamp).
      Object.defineProperty(scroller, "scrollLeft", {
        value: 200,
        writable: true,
        configurable: true,
      });
      scroller.getBoundingClientRect = () => rectOf({ left: 0, right: 300, width: 300 });

      // The header is the sticky element pinned at the leading edge (left 0,
      // width 60). Selecting it must NOT scroll: header === selected, so the
      // fix zeroes headerWidth → delta 0. Pre-fix this subtracted 60 against
      // itself → delta -60 → a spurious leftward jerk.
      const header = container.querySelector(".bottom-bar-network-header") as HTMLElement;
      header.getBoundingClientRect = () => rectOf({ left: 0, right: 60, width: 60 });

      rafQueue.length = 0;
      scrollToSpy.mockClear();

      setSel({ networkSlug: "freenode", channelName: "$server", kind: "server" });
      frame();
      frame();

      expect(scrollToSpy).not.toHaveBeenCalled();

      vi.unstubAllGlobals();
    });
  });
});
