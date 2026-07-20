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

  // #327 — the active-tab auto-scroll must DEFER its scrollIntoView until
  // AFTER layout settles. Selecting a window zeroes its unread/mention
  // badges in the SAME reactive flush (selection.ts perChannelUnread reads
  // selectedChannel), so the `.bottom-bar-msg-unread` / `.bottom-bar-mention`
  // spans unmount and the tab's width changes. A synchronous scrollIntoView
  // reads STALE pre-reflow geometry and undershoots/no-ops with smooth. The
  // fix is the codebase's double-rAF idiom (ScrollbackPane.tsx ~:1569): schedule
  // rAF(rAF(...)) and RE-QUERY `.bottom-bar-tab.selected` inside the deferred
  // callback so it resolves against settled DOM.
  describe("#327 — active-tab auto-scroll defers to settled layout (double rAF)", () => {
    it("does not scrollIntoView synchronously; scrolls the selected tab after two rAF ticks", async () => {
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

      // jsdom does not implement scrollIntoView; record the element it is
      // invoked on so we can prove the deferred callback re-queries the DOM.
      const origScrollIntoView = HTMLElement.prototype.scrollIntoView;
      const scrollSpy = vi.fn();
      let scrolledOn: Element | null = null;
      (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
        function (this: Element) {
          scrolledOn = this;
          scrollSpy();
        };

      try {
        const { default: BottomBarFresh } = await import("../BottomBar");
        const { container } = render(() => <BottomBarFresh />);
        expect(container.querySelectorAll(".bottom-bar-tab.selected").length).toBe(0);

        // Discard any frames queued during the async mount boundary — our
        // own selection-null mount run plus leftover self-rescheduling rAF
        // loops from earlier trees in this file. From here the block is
        // fully synchronous, so jsdom's frame timer cannot inject more: the
        // only rAF that lands is the one OUR effect schedules on the change.
        rafQueue.length = 0;
        scrollSpy.mockClear();
        scrolledOn = null;

        // Select #italia — the effect must NOT scroll synchronously.
        setSel({ networkSlug: "freenode", channelName: "#italia", kind: "channel" });
        expect(scrollSpy).not.toHaveBeenCalled();

        // One frame is not enough — the idiom needs the SECOND rAF (layout
        // settled) before it reads geometry.
        frame();
        expect(scrollSpy).not.toHaveBeenCalled();

        // Second frame: now it scrolls the currently-selected tab. That this
        // resolves the LIVE selection (not a ref captured before the rAF) is
        // discriminated by the sibling test below.
        frame();
        expect(scrollSpy).toHaveBeenCalledTimes(1);
        expect(scrolledOn).not.toBeNull();
        expect((scrolledOn as unknown as HTMLElement).classList.contains("selected")).toBe(true);
        expect((scrolledOn as unknown as HTMLElement).textContent).toContain("#italia");
      } finally {
        (HTMLElement.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView =
          origScrollIntoView;
        vi.unstubAllGlobals();
      }
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

      const origScrollIntoView = HTMLElement.prototype.scrollIntoView;
      // Record the data-window-name of every tab scrollIntoView lands on.
      const scrolledNames: string[] = [];
      (HTMLElement.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
        function (this: Element) {
          scrolledNames.push((this as HTMLElement).getAttribute("data-window-name") ?? "");
        };

      try {
        const { default: BottomBarFresh } = await import("../BottomBar");
        render(() => <BottomBarFresh />);
        rafQueue.length = 0;
        scrolledNames.length = 0;

        // Select #italia, then advance ONE frame so its outer rAF has run and
        // its inner (DOM-reading) callback is scheduled but NOT yet executed.
        setSel({ networkSlug: "freenode", channelName: "#italia", kind: "channel" });
        frame();

        // Mid-flight switch to #other BEFORE that inner callback runs — the
        // `.selected` class moves to #other synchronously. A fix that captured
        // the tab ref at effect-fire time would still scroll #italia; the
        // re-query resolves `.bottom-bar-tab.selected` to the NOW-selected
        // #other.
        setSel({ networkSlug: "freenode", channelName: "#other", kind: "channel" });

        // Drain the #italia chain's inner + the #other chain's outer→inner.
        frame();
        frame();

        expect(scrolledNames.length).toBeGreaterThan(0);
        expect(scrolledNames).not.toContain("#italia");
        expect(scrolledNames.every((n) => n === "#other")).toBe(true);
      } finally {
        (HTMLElement.prototype as unknown as { scrollIntoView?: () => void }).scrollIntoView =
          origScrollIntoView;
        vi.unstubAllGlobals();
      }
    });
  });
});
