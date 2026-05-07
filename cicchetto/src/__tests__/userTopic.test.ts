import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type EventHandler = (payload: { kind: string; [k: string]: unknown }) => void;

const channelMock = vi.hoisted(() => {
  const handlers: EventHandler[] = [];
  return {
    handlers,
    on: vi.fn((event: string, fn: EventHandler) => {
      if (event === "event") handlers.push(fn);
    }),
    fireEvent: (payload: { kind: string; [k: string]: unknown }) => {
      for (const h of handlers) h(payload);
    },
    reset: () => {
      handlers.length = 0;
    },
  };
});

vi.mock("../lib/socket", () => ({
  joinUser: vi.fn(() => ({ on: channelMock.on })),
  joinChannel: vi.fn(),
}));

vi.mock("../lib/networks", () => ({
  user: vi.fn(() => ({ kind: "user", id: "u1", name: "vjt", inserted_at: "x" })),
  refetchChannels: vi.fn(),
  networks: vi.fn(() => []),
  mutateNetworkNick: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  token: vi.fn(() => "t1"),
  socketUserName: vi.fn(() => "vjt"),
}));

vi.mock("../lib/queryWindows", () => ({
  setQueryWindowsByNetwork: vi.fn(),
  queryWindowsByNetwork: vi.fn(() => ({})),
  closeQueryWindowState: vi.fn(),
  openQueryWindowState: vi.fn(),
}));

describe("userTopic", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    channelMock.reset();
    // Re-import to trigger the createRoot side-effect anew per test.
    vi.resetModules();
    await import("../lib/userTopic");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("joins the user topic when user resolves", async () => {
    const socket = await import("../lib/socket");
    expect(socket.joinUser).toHaveBeenCalledWith("vjt");
  });

  it("calls refetchChannels on channels_changed event", async () => {
    const networks = await import("../lib/networks");
    channelMock.fireEvent({ kind: "channels_changed" });
    expect(networks.refetchChannels).toHaveBeenCalled();
  });

  it("does NOT call refetchChannels on unrelated event payloads", async () => {
    const networks = await import("../lib/networks");
    channelMock.fireEvent({ kind: "message", body: "hi" });
    expect(networks.refetchChannels).not.toHaveBeenCalled();
  });

  // C1.3: query_windows_list event populates queryWindowsByNetwork state.
  //
  // The server sends string keys (JSON objects always have string keys),
  // e.g. {"1": [{target_nick: "alice", opened_at: "..."}]}. cicchetto
  // must coerce string keys to integers and snake_case field names to
  // camelCase before calling setQueryWindowsByNetwork.
  it("query_windows_list event calls setQueryWindowsByNetwork with parsed state", async () => {
    const qw = await import("../lib/queryWindows");
    channelMock.fireEvent({
      kind: "query_windows_list",
      windows: {
        "1": [{ target_nick: "alice", opened_at: "2026-05-04T10:00:00Z" }],
        "2": [
          { target_nick: "bob", opened_at: "2026-05-04T11:00:00Z" },
          { target_nick: "carol", opened_at: "2026-05-04T12:00:00Z" },
        ],
      },
    });
    expect(qw.setQueryWindowsByNetwork).toHaveBeenCalledWith({
      1: [{ targetNick: "alice", openedAt: "2026-05-04T10:00:00Z" }],
      2: [
        { targetNick: "bob", openedAt: "2026-05-04T11:00:00Z" },
        { targetNick: "carol", openedAt: "2026-05-04T12:00:00Z" },
      ],
    });
  });

  it("query_windows_list event with empty windows calls setQueryWindowsByNetwork({})", async () => {
    const qw = await import("../lib/queryWindows");
    channelMock.fireEvent({ kind: "query_windows_list", windows: {} });
    expect(qw.setQueryWindowsByNetwork).toHaveBeenCalledWith({});
  });

  it("unrelated events do NOT call setQueryWindowsByNetwork", async () => {
    const qw = await import("../lib/queryWindows");
    channelMock.fireEvent({ kind: "channels_changed" });
    expect(qw.setQueryWindowsByNetwork).not.toHaveBeenCalled();
  });

  // BUG1-FIX: own_nick_changed event updates network nick in memory.
  describe("own_nick_changed event (BUG1-FIX)", () => {
    it("calls mutateNetworkNick with the new nick on own_nick_changed", async () => {
      const networks = await import("../lib/networks");
      channelMock.fireEvent({
        kind: "own_nick_changed",
        network_id: 42,
        nick: "vjt-grappa",
      });
      expect(networks.mutateNetworkNick).toHaveBeenCalledWith(42, "vjt-grappa");
    });

    it("does NOT call mutateNetworkNick for unrelated events", async () => {
      const networks = await import("../lib/networks");
      channelMock.fireEvent({ kind: "channels_changed" });
      expect(networks.mutateNetworkNick).not.toHaveBeenCalled();
    });

    it("handles repeated own_nick_changed events (nick rotation)", async () => {
      const networks = await import("../lib/networks");
      channelMock.fireEvent({ kind: "own_nick_changed", network_id: 1, nick: "grappa-1" });
      channelMock.fireEvent({ kind: "own_nick_changed", network_id: 1, nick: "grappa-2" });
      expect(networks.mutateNetworkNick).toHaveBeenCalledTimes(2);
      expect(networks.mutateNetworkNick).toHaveBeenNthCalledWith(1, 1, "grappa-1");
      expect(networks.mutateNetworkNick).toHaveBeenNthCalledWith(2, 1, "grappa-2");
    });
  });
});
