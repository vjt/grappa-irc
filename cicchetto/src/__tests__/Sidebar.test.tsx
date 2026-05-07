import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/networks", () => ({
  networks: () => [{ id: 1, slug: "freenode", inserted_at: "", updated_at: "" }],
  channelsBySlug: () => ({
    freenode: [
      { name: "#italia", joined: true, source: "autojoin" },
      { name: "#azzurra", joined: false, source: "autojoin" },
      { name: "#bnc", joined: true, source: "joined" },
    ],
  }),
}));

vi.mock("../lib/selection", () => ({
  selectedChannel: () => null,
  setSelectedChannel: vi.fn(),
  unreadCounts: () => ({ "freenode #bnc": 3 }),
  messagesUnread: () => ({ "freenode #bnc": 3, "freenode $server": 7 }),
  eventsUnread: () => ({ "freenode $server": 2 }),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({ "freenode #italia": 2, "freenode $server": 1 }),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

vi.mock("../lib/queryWindows", () => ({
  queryWindowsByNetwork: () => ({
    1: [
      { targetNick: "alice", openedAt: "2026-05-04T10:00:00Z" },
      { targetNick: "bob", openedAt: "2026-05-04T11:00:00Z" },
    ],
  }),
  closeQueryWindowState: vi.fn(),
  openQueryWindowState: vi.fn(),
  setQueryWindowsByNetwork: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  postPart: vi.fn().mockResolvedValue(undefined),
  listArchive: vi.fn(),
}));

vi.mock("../lib/archive", () => ({
  archivedBySlug: () => ({
    freenode: [
      { target: "#sniffo", kind: "channel", last_activity: 200, row_count: 576 },
      { target: "vjt-peer", kind: "query", last_activity: 100, row_count: 8 },
    ],
  }),
  loadArchive: vi.fn().mockResolvedValue(undefined),
  clearArchive: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  token: () => "tok",
  socketUserName: () => "alice",
}));

let mockWindowState: Record<string, string> = {};

vi.mock("../lib/windowState", () => ({
  windowStateByChannel: () => mockWindowState,
}));

import * as apiMod from "../lib/api";
import * as archiveMod from "../lib/archive";
// Capture mocked module references at import time, before any resetModules
import * as qwMod from "../lib/queryWindows";
import * as selMod from "../lib/selection";
import Sidebar from "../Sidebar";

beforeEach(() => {
  vi.clearAllMocks();
  mockWindowState = {};
});

describe("Sidebar", () => {
  it("renders all channels grouped by network", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    expect(screen.getByText("#italia")).toBeInTheDocument();
    expect(screen.getByText("#azzurra")).toBeInTheDocument();
    expect(screen.getByText("#bnc")).toBeInTheDocument();
    expect(screen.getByText("freenode")).toBeInTheDocument();
  });

  it("parted channels (joined: false) get the .parted class", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const parted = screen.getByText("#azzurra");
    expect(parted.classList.contains("parted")).toBe(true);
  });

  it("joined channels do NOT get the .parted class", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const joined = screen.getByText("#italia");
    expect(joined.classList.contains("parted")).toBe(false);
  });

  it("renders unread count for channels with messages while away", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    // Scope to the #bnc <li> — the Server <li> also has a msg-unread badge
    // since CP13 (S8). The test asserts the channel-side badge specifically.
    const bncLi = screen.getByText("#bnc").closest("li");
    const unread = bncLi?.querySelector(".sidebar-msg-unread");
    expect(unread?.textContent).toBe("3");
  });

  it("renders mention badge with @-prefix for channels with mentions", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const italiaLi = screen.getByText("#italia").closest("li");
    const mention = italiaLi?.querySelector(".sidebar-mention");
    expect(mention?.textContent).toBe("@2");
  });

  // CP13 — server window also surfaces the 3 badge classes (msg-unread,
  // events-unread, mention) so server-routed numerics + NickServ + MOTD
  // get the same unread treatment as channels.
  it("renders all 3 badge classes on the Server window when counts present", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const serverLi = screen.getByText("Server").closest("li");
    expect(serverLi).not.toBeNull();
    const msg = serverLi?.querySelector(".sidebar-msg-unread");
    const events = serverLi?.querySelector(".sidebar-events-unread");
    const mention = serverLi?.querySelector(".sidebar-mention");
    expect(msg?.textContent).toBe("7");
    expect(events?.textContent).toBe("2");
    expect(mention?.textContent).toBe("@1");
  });

  it("clicking a channel calls setSelectedChannel + onSelect", async () => {
    const sel = await import("../lib/selection");
    const onSelect = vi.fn();
    render(() => <Sidebar onSelect={onSelect} />);
    fireEvent.click(screen.getByText("#italia"));
    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#italia",
      kind: "channel",
    });
    expect(onSelect).toHaveBeenCalled();
  });

  it("renders 'no networks' fallback when networks list is empty", async () => {
    vi.resetModules();
    vi.doMock("../lib/networks", () => ({
      networks: () => [],
      channelsBySlug: () => ({}),
    }));
    vi.doMock("../lib/selection", () => ({
      selectedChannel: () => null,
      setSelectedChannel: vi.fn(),
      unreadCounts: () => ({}),
      messagesUnread: () => ({}),
      eventsUnread: () => ({}),
    }));
    vi.doMock("../lib/mentions", () => ({ mentionCounts: () => ({}) }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({}),
      closeQueryWindowState: vi.fn(),
      openQueryWindowState: vi.fn(),
      setQueryWindowsByNetwork: vi.fn(),
    }));
    const { default: SidebarFresh } = await import("../Sidebar");
    render(() => <SidebarFresh onSelect={vi.fn()} />);
    expect(screen.getByText(/no networks/i)).toBeInTheDocument();
  });

  // C1.2: Query windows appear in sidebar
  it("renders query windows (alice, bob) for the network", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    expect(screen.getByText("alice")).toBeInTheDocument();
    expect(screen.getByText("bob")).toBeInTheDocument();
  });

  // C1.2: Server window is present, not closeable (no X button)
  it("server window has no close button", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const serverEntry = screen.getByText("Server");
    const li = serverEntry.closest("li");
    expect(li?.querySelector(".sidebar-close")).toBeNull();
  });

  // C1.2: Channel windows have a close button
  it("channel windows have a close button", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const channelEntry = screen.getByText("#italia");
    const li = channelEntry.closest("li");
    expect(li?.querySelector(".sidebar-close")).toBeTruthy();
  });

  // C1.2: Query windows have a close button
  it("query windows have a close button", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const queryEntry = screen.getByText("alice");
    const li = queryEntry.closest("li");
    expect(li?.querySelector(".sidebar-close")).toBeTruthy();
  });

  // C1.2: Clicking X on a query window calls closeQueryWindowState
  it("clicking close on query window calls closeQueryWindowState", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const aliceEntry = screen.getByText("alice");
    const li = aliceEntry.closest("li");
    const closeBtn = li?.querySelector(".sidebar-close") as HTMLElement;
    fireEvent.click(closeBtn);
    expect(qwMod.closeQueryWindowState).toHaveBeenCalledWith(1, "alice");
  });

  // C1.2: Clicking X on a channel calls postPart
  it("clicking close on channel calls postPart", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const italiaEntry = screen.getByText("#italia");
    const li = italiaEntry.closest("li");
    const closeBtn = li?.querySelector(".sidebar-close") as HTMLElement;
    fireEvent.click(closeBtn);
    expect(apiMod.postPart).toHaveBeenCalledWith("tok", "freenode", "#italia");
  });

  // CP15 B4 — Archive section per network. Collapsed by default
  // (`<details>` without `open`), lazy-loaded on first expand
  // (`loadArchive(slug)`), entries clickable → setSelectedChannel.
  describe("Archive section", () => {
    it("renders Archive <details> per network, collapsed by default", () => {
      render(() => <Sidebar onSelect={vi.fn()} />);
      const archive = screen.getByText("Archive");
      const details = archive.closest("details") as HTMLDetailsElement | null;
      expect(details).toBeTruthy();
      expect(details?.open).toBe(false);
    });

    it("renders one button per archived entry inside the network section", () => {
      render(() => <Sidebar onSelect={vi.fn()} />);
      // Both entries are rendered eagerly (the renderer reads from
      // `archivedBySlug()` which the test mock pre-populates). Lazy
      // FETCH still happens on expand; the renderer doesn't wait.
      expect(screen.getByText("#sniffo")).toBeInTheDocument();
      expect(screen.getByText("vjt-peer")).toBeInTheDocument();
    });

    it("expanding the Archive <details> calls loadArchive(slug)", () => {
      render(() => <Sidebar onSelect={vi.fn()} />);
      const archive = screen.getByText("Archive");
      const details = archive.closest("details") as HTMLDetailsElement;
      details.open = true;
      // Solid handlers fire on the toggle event, not on the property set.
      details.dispatchEvent(new Event("toggle"));
      expect(archiveMod.loadArchive).toHaveBeenCalledWith("freenode");
    });

    it("clicking an archived channel entry sets selection with kind=channel", () => {
      render(() => <Sidebar onSelect={vi.fn()} />);
      fireEvent.click(screen.getByText("#sniffo"));
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#sniffo",
        kind: "channel",
      });
    });

    it("clicking an archived query entry sets selection with kind=query", () => {
      render(() => <Sidebar onSelect={vi.fn()} />);
      fireEvent.click(screen.getByText("vjt-peer"));
      expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "vjt-peer",
        kind: "query",
      });
    });
  });

  // CP15 B5 — windowState visual cues. Failed/kicked/parked channels +
  // queries get `.sidebar-window-greyed` on the row's button. Pending
  // channels NOT yet in `channelsBySlug` (operator just clicked JOIN
  // and waiting for the upstream echo) render as a synthetic sidebar
  // row so the operator sees immediate feedback. The actual joined
  // list still flows from `channelsBySlug` (heartbeat refetch).
  describe("CP15 B5 — windowState visual cues", () => {
    it("channel rows get .sidebar-window-greyed when state=failed", () => {
      mockWindowState = { "freenode #italia": "failed" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("channel rows get .sidebar-window-greyed when state=kicked", () => {
      mockWindowState = { "freenode #italia": "kicked" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("channel rows get .sidebar-window-greyed when state=parked", () => {
      mockWindowState = { "freenode #italia": "parked" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("channel rows do NOT get .sidebar-window-greyed when state=joined", () => {
      mockWindowState = { "freenode #italia": "joined" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(false);
    });

    it("channel rows do NOT get .sidebar-window-greyed when no state entry", () => {
      mockWindowState = {};
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("#italia").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(false);
    });

    it("query rows get .sidebar-window-greyed when state=failed (DM target gone)", () => {
      // DMs don't transition to failed in the IRC sense, but the state
      // map shape is the same — apply uniformly so future state kinds
      // ride the same render branch without per-kind plumbing.
      mockWindowState = { "freenode alice": "kicked" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const li = screen.getByText("alice").closest("li");
      const btn = li?.querySelector(".sidebar-window-btn");
      expect(btn?.classList.contains("sidebar-window-greyed")).toBe(true);
    });

    it("renders a pending sidebar row for a channel in state=pending NOT yet in channelsBySlug", () => {
      // Operator clicked JOIN — networks.ts setPending fires; the
      // sidebar shows the row immediately (visual feedback). When the
      // server emits `joined`, channelsBySlug refetches via the
      // channels_changed heartbeat and the same row continues life
      // under the channelsBySlug branch (state transitions from
      // pending → joined and the greyed class falls off).
      mockWindowState = { "freenode #new-room": "pending" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      expect(screen.getByText("#new-room")).toBeInTheDocument();
    });

    it("does NOT duplicate a pending row when the channel IS already in channelsBySlug", () => {
      // #italia is in channelsBySlug + state=pending. The row should
      // appear EXACTLY ONCE — channelsBySlug branch wins; the synthetic
      // pending row only fires when channelsBySlug doesn't already
      // carry the channel.
      mockWindowState = { "freenode #italia": "pending" };
      render(() => <Sidebar onSelect={vi.fn()} />);
      const matches = screen.getAllByText("#italia");
      expect(matches.length).toBe(1);
    });
  });
});
