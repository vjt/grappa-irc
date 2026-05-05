import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const selectionState = vi.hoisted(() => {
  const state: { current: { networkSlug: string; channelName: string } | null } = {
    current: null,
  };
  return {
    selSig: () => state.current,
    setSelSig: (v: { networkSlug: string; channelName: string } | null) => {
      state.current = v;
    },
    setSelectedChannelMock: vi.fn((v: { networkSlug: string; channelName: string } | null) => {
      state.current = v;
    }),
  };
});

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
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a" });
    render(() => <Shell />);
    await waitFor(() => {
      expect(screen.getByLabelText(/open channel sidebar/i)).toBeInTheDocument();
    });
    expect(screen.getByPlaceholderText(/message #a/i)).toBeInTheDocument();
  });

  it("Alt+1 selects the first flat channel via keybindings", async () => {
    render(() => <Shell />);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", altKey: true }));
    await waitFor(() => {
      expect(selectionState.setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "freenode",
        channelName: "#a",
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
      });
    });
  });

  it("Esc closes any open drawer", async () => {
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a" });
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
    selectionState.setSelSig({ networkSlug: "freenode", channelName: "#a" });
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
});
