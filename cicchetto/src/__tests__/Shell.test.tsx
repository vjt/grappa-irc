import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const selectionState = vi.hoisted(() => {
  const state: {
    current: { networkSlug: string; channelName: string; kind: string } | null;
  } = {
    current: null,
  };
  return {
    selSig: () => state.current,
    setSelSig: (v: { networkSlug: string; channelName: string; kind: string } | null) => {
      state.current = v;
    },
    setSelectedChannelMock: vi.fn(
      (v: { networkSlug: string; channelName: string; kind: string } | null) => {
        state.current = v;
      },
    ),
  };
});

// Mutable isMobile ref so individual tests can flip to mobile mode.
const mobileState = vi.hoisted(() => ({ value: false }));

vi.mock("@solidjs/router", () => ({
  useNavigate: () => vi.fn(),
}));

vi.mock("../lib/networks", () => ({
  networks: () => [{ id: 1, slug: "freenode", inserted_at: "", updated_at: "" }],
  channelsBySlug: () => ({
    freenode: [
      { name: "#a", joined: true, source: "autojoin" },
      { name: "#b", joined: true, source: "autojoin" },
    ],
  }),
  user: () => ({ id: "u1", name: "vjt", inserted_at: "x" }),
}));

vi.mock("../lib/selection", () => ({
  selectedChannel: () => selectionState.selSig(),
  setSelectedChannel: selectionState.setSelectedChannelMock,
  unreadCounts: () => ({}),
  messagesUnread: () => ({}),
  eventsUnread: () => ({}),
}));

vi.mock("../lib/scrollback", () => ({
  scrollbackByChannel: () => ({}),
  appendToScrollback: vi.fn(),
  loadInitialScrollback: vi.fn(),
  loadMore: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("../lib/members", () => ({
  membersByChannel: () => ({}),
  loadMembers: vi.fn(),
  applyPresenceEvent: vi.fn(),
  seedFromTest: vi.fn(),
}));

vi.mock("../lib/channelTopic", () => ({
  topicByChannel: () => ({}),
  modesByChannel: () => ({}),
  compactModeString: (modes: string[]) => (modes.length > 0 ? `+${modes.join("")}` : ""),
  seedTopic: vi.fn(),
  seedModes: vi.fn(),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({}),
  bumpMention: vi.fn(),
}));

vi.mock("../lib/compose", () => ({
  getDraft: () => "",
  setDraft: vi.fn(),
  submit: vi.fn(),
  recallPrev: vi.fn(),
  recallNext: vi.fn(),
  tabComplete: vi.fn(),
}));

vi.mock("../lib/theme", () => ({
  getTheme: vi.fn(() => "auto"),
  setTheme: vi.fn(),
  isMobile: () => mobileState.value,
}));

vi.mock("../lib/auth", () => ({
  logout: vi.fn().mockResolvedValue(undefined),
  token: () => null,
}));

vi.mock("../lib/queryWindows", () => ({
  queryWindowsByNetwork: () => ({}),
  closeQueryWindowState: vi.fn(),
  openQueryWindowState: vi.fn(),
  setQueryWindowsByNetwork: vi.fn(),
}));

vi.mock("../lib/mentionsWindow", () => ({
  mentionsBundleBySlug: () => ({
    freenode: {
      network_slug: "freenode",
      away_started_at: "2026-05-05T10:00:00.000Z",
      away_ended_at: "2026-05-05T10:30:00.000Z",
      away_reason: "lunch",
      messages: [
        {
          server_time: 1_746_442_200_000,
          channel: "#grappa",
          sender_nick: "alice",
          body: "hey vjt",
          kind: "privmsg",
        },
      ],
    },
  }),
}));

const setReadCursorMock = vi.fn();
vi.mock("../lib/readCursor", () => ({
  getReadCursor: vi.fn(() => null),
  setReadCursor: (...args: unknown[]) => setReadCursorMock(...args),
}));

vi.mock("../lib/api", () => ({
  postPart: vi.fn().mockResolvedValue(undefined),
  displayNick: (me: { kind: "user" | "visitor"; name?: string; nick?: string }) =>
    me.kind === "user" ? (me.name ?? "") : (me.nick ?? ""),
}));

vi.mock("../lib/channelKey", () => ({
  channelKey: (slug: string, name: string) => `${slug} ${name}`,
}));

import Shell from "../Shell";

beforeEach(() => {
  vi.clearAllMocks();
  selectionState.setSelSig(null);
  mobileState.value = false;
});

describe("Shell — three-pane integration", () => {
  it("renders sidebar + main + members aside", () => {
    const { container } = render(() => <Shell />);
    expect(container.querySelector(".shell-sidebar")).toBeTruthy();
    expect(container.querySelector(".shell-main")).toBeTruthy();
    expect(container.querySelector(".shell-members")).toBeTruthy();
  });

  it("renders 'select a channel' fallback when nothing is selected", () => {
    render(() => <Shell />);
    expect(screen.getByText(/select a channel/i)).toBeInTheDocument();
  });

  it("renders TopicBar + ScrollbackPane + ComposeBox once a channel is selected", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
    render(() => <Shell />);
    await waitFor(() => {
      expect(screen.getByLabelText(/open channel sidebar/i)).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/message #a/i)).toBeInTheDocument();
  });

  it("does NOT render TopicBar when the synthetic :server window is selected (channel-only per spec #20)", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: ":server", kind: "server" });
    const { container } = render(() => <Shell />);
    // ScrollbackPane still renders (server window has its own scrollback);
    // ComposeBox still renders (server-message read-only handled separately).
    // TopicBar must NOT — feature #20: channel-window-only.
    await waitFor(() => {
      expect(container.querySelector(".scrollback-pane")).toBeInTheDocument();
    });
    expect(container.querySelector(".topic-bar")).not.toBeInTheDocument();
  });

  it("does NOT render TopicBar when a query window is selected (channel-only per spec #20)", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "alice", kind: "query" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(container.querySelector(".scrollback-pane")).toBeInTheDocument();
    });
    expect(container.querySelector(".topic-bar")).not.toBeInTheDocument();
  });

  it("Alt+1 selects the first flat channel via keybindings", async () => {
    render(() => <Shell />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", altKey: true }));
    await waitFor(() => {
      expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#a",
        kind: "channel",
      });
    });
  });

  it("Alt+2 selects the second flat channel via keybindings", async () => {
    render(() => <Shell />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", altKey: true }));
    await waitFor(() => {
      expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#b",
        kind: "channel",
      });
    });
  });

  it("Esc closes any open drawer", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(screen.getByLabelText(/open channel sidebar/i)).toBeInTheDocument();
    });
    // Open sidebar via topic-bar hamburger
    fireEvent.click(screen.getByLabelText(/open channel sidebar/i));
    expect(container.querySelector(".shell-sidebar")?.classList.contains("open")).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await waitFor(() => {
      expect(container.querySelector(".shell-sidebar")?.classList.contains("open")).toBe(false);
    });
  });

  it("clicking ⚙ opens SettingsDrawer (.open class)", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(screen.getByLabelText(/open settings/i)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByLabelText(/open settings/i));
    expect(container.querySelector(".settings-drawer")?.classList.contains("open")).toBe(true);
  });

  it("empty-state renders the ☰ open-sidebar button (mobile escape hatch)", () => {
    render(() => <Shell />);
    // selectionState set to null in beforeEach — empty state.
    expect(screen.getByLabelText(/open channel sidebar/i)).toBeInTheDocument();
  });

  it("empty-state renders the ⚙ settings button", () => {
    render(() => <Shell />);
    expect(screen.getByLabelText(/open settings/i)).toBeInTheDocument();
  });

  it("clicking empty-state ☰ opens the sidebar drawer", () => {
    const { container } = render(() => <Shell />);
    const sidebar = container.querySelector(".shell-sidebar");
    expect(sidebar?.classList.contains("open")).toBe(false);
    fireEvent.click(screen.getByLabelText(/open channel sidebar/i));
    expect(sidebar?.classList.contains("open")).toBe(true);
  });

  it("clicking empty-state ⚙ opens the settings drawer", () => {
    const { container } = render(() => <Shell />);
    fireEvent.click(screen.getByLabelText(/open settings/i));
    const settings = container.querySelector(".settings-drawer");
    expect(settings?.classList.contains("open")).toBe(true);
  });
  it("renders MentionsWindow (not ScrollbackPane) when kind === 'mentions'", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "", kind: "mentions" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(container.querySelector(".mentions-window")).toBeInTheDocument();
    });
    expect(container.querySelector(".scrollback-pane")).not.toBeInTheDocument();
    expect(container.querySelector(".compose-box")).not.toBeInTheDocument();
    expect(container.querySelector(".topic-bar")).not.toBeInTheDocument();
  });

  it("C8.2: clicking a mentions row switches focus to channel and sets read cursor", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "", kind: "mentions" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(container.querySelector(".mentions-window")).toBeInTheDocument();
    });
    const row = container.querySelector(".mentions-row");
    expect(row).toBeDefined();
    if (row) fireEvent.click(row);
    // Should navigate to the channel the mention came from.
    expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    // Should set read cursor to serverTime - 1 so ScrollbackPane scrolls
    // to the unread marker positioned just before the clicked message.
    expect(setReadCursorMock).toHaveBeenCalledWith("freenode", "#grappa", 1_746_442_199_999);
  });
});

describe("Shell — mobile layout (isMobile = true)", () => {
  // C6.1: on mobile, shell-sidebar is NOT rendered in the DOM.
  // Channels live in the BottomBar; the left drawer goes away entirely.
  it("shell-sidebar is absent from the DOM on mobile", () => {
    mobileState.value = true;
    const { container } = render(() => <Shell />);
    expect(container.querySelector(".shell-sidebar")).toBeNull();
  });

  // C6.1: on mobile, a .bottom-bar element IS rendered (BottomBar).
  it("bottom-bar IS rendered on mobile", () => {
    mobileState.value = true;
    const { container } = render(() => <Shell />);
    expect(container.querySelector(".bottom-bar")).toBeTruthy();
  });

  // C6.3: on mobile, there is exactly ONE .topic-bar-hamburger (the members one).
  // The channel-sidebar hamburger is removed on mobile.
  it("exactly one .topic-bar-hamburger rendered on mobile (members only)", async () => {
    mobileState.value = true;
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(container.querySelectorAll(".topic-bar-hamburger").length).toBe(1);
    });
  });

  // C6.3: on mobile, the single hamburger opens the members drawer.
  it("single hamburger on mobile opens members drawer", async () => {
    mobileState.value = true;
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a", kind: "channel" });
    const { container } = render(() => <Shell />);
    await waitFor(() => {
      expect(container.querySelector(".topic-bar-hamburger")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".topic-bar-hamburger") as HTMLElement);
    expect(container.querySelector(".shell-members")?.classList.contains("open")).toBe(true);
  });
});
