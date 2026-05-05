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
  messagesUnread: () => ({ "freenode #bnc": 3 }),
  eventsUnread: () => ({}),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({ "freenode #italia": 2 }),
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
}));

vi.mock("../lib/auth", () => ({
  token: () => "tok",
  socketUserName: () => "alice",
}));

import * as apiMod from "../lib/api";
// Capture mocked module references at import time, before any resetModules
import * as qwMod from "../lib/queryWindows";
import Sidebar from "../Sidebar";

beforeEach(() => {
  vi.clearAllMocks();
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
    const unread = document.querySelector(".sidebar-msg-unread");
    expect(unread?.textContent).toBe("3");
  });

  it("renders mention badge with @-prefix for channels with mentions", () => {
    render(() => <Sidebar onSelect={vi.fn()} />);
    const mention = document.querySelector(".sidebar-mention");
    expect(mention?.textContent).toBe("@2");
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
});
