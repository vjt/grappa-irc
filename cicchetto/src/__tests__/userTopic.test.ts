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

vi.mock("../lib/windowState", () => ({
  setPending: vi.fn(),
}));

vi.mock("../lib/awayStatus", () => ({
  setAwayState: vi.fn(),
}));

vi.mock("../lib/mentionsWindow", () => ({
  setMentionsBundle: vi.fn(),
}));

vi.mock("../lib/selection", () => ({
  selectedChannel: vi.fn(() => null),
  setSelectedChannel: vi.fn(),
}));

vi.mock("../lib/bundleHash", () => ({
  setServerBundleHash: vi.fn(),
}));

vi.mock("../lib/peerAway", () => ({
  setPeerAway: vi.fn(),
}));

vi.mock("../lib/lusersBundle", () => ({
  setLusersBundle: vi.fn(),
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
    // CP16 B5: payloads are narrowed via WireUserEvent discriminated
    // union; assertNever fires loudly on an unknown kind. Pick another
    // valid arm (away_confirmed) to verify the dispatch is exclusive —
    // it must not collateral-trigger refetchChannels.
    channelMock.fireEvent({
      kind: "away_confirmed",
      network: "azzurra",
      state: "away",
    });
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

  // CP17: server-driven `:pending` window-state origination. Server's
  // `record_in_flight_join/2` emits `kind: "window_pending"` on
  // `Topic.user/1` (NOT per-channel — chicken-and-egg: cic only joins
  // per-channel after seeing :pending in windowStateByChannel). The
  // user-topic dispatcher mirrors into `setPending(channelKey(...))`,
  // which is what the pre-CP17 compose.ts:210 workaround used to do
  // optimistically. Closes the CLAUDE.md "cic NEVER originates state"
  // hard-invariant violation.
  describe("window_pending event (CP17)", () => {
    it("calls setPending with channelKey(network, channel) on window_pending", async () => {
      const ws = await import("../lib/windowState");
      const { channelKey } = await import("../lib/channelKey");
      channelMock.fireEvent({
        kind: "window_pending",
        network: "freenode",
        channel: "#italia",
        state: "pending",
      });
      expect(ws.setPending).toHaveBeenCalledWith(channelKey("freenode", "#italia"));
    });

    it("does NOT call setPending for unrelated events", async () => {
      const ws = await import("../lib/windowState");
      channelMock.fireEvent({ kind: "channels_changed" });
      expect(ws.setPending).not.toHaveBeenCalled();
    });
  });

  // Codebase audit cic M1 — runtime narrowing of WireUserEvent. The
  // pre-fix `as WireUserEvent` cast trusted the server unconditionally:
  // a malformed payload (kind valid but required field missing or
  // wrong-typed) would let the dispatch arm read `undefined` from the
  // payload and either crash or silently corrupt state. Post-fix the
  // dispatcher gates on a runtime predicate that re-validates the
  // shape per arm before narrowing — malformed payloads are dropped.
  describe("WireUserEvent runtime narrowing (cic M1)", () => {
    it("drops away_confirmed payload missing `network` (no setAwayState call)", async () => {
      const away = await import("../lib/awayStatus");
      // Server bug or proxy mangling: `kind` valid but `network` missing.
      // Pre-fix: setAwayState(undefined, ...) — boom. Post-fix: dropped.
      channelMock.fireEvent({
        kind: "away_confirmed",
        state: "away",
      });
      expect(away.setAwayState).not.toHaveBeenCalled();
    });

    it("drops own_nick_changed payload missing `network_id` (no mutateNetworkNick call)", async () => {
      const networks = await import("../lib/networks");
      channelMock.fireEvent({
        kind: "own_nick_changed",
        nick: "vjt-grappa",
      });
      expect(networks.mutateNetworkNick).not.toHaveBeenCalled();
    });

    it("drops window_pending payload missing `channel` (no setPending call)", async () => {
      const ws = await import("../lib/windowState");
      channelMock.fireEvent({
        kind: "window_pending",
        network: "freenode",
        state: "pending",
      });
      expect(ws.setPending).not.toHaveBeenCalled();
    });
  });

  // CP23 S4 B5 — bundle_hash dispatch.
  describe("bundle_hash arm", () => {
    it("calls setServerBundleHash with the pushed hash", async () => {
      const bh = await import("../lib/bundleHash");
      channelMock.fireEvent({ kind: "bundle_hash", hash: "RvD22cM9" });
      expect(bh.setServerBundleHash).toHaveBeenCalledWith("RvD22cM9");
    });

    it("drops bundle_hash with empty hash (no setServerBundleHash call)", async () => {
      const bh = await import("../lib/bundleHash");
      channelMock.fireEvent({ kind: "bundle_hash", hash: "" });
      expect(bh.setServerBundleHash).not.toHaveBeenCalled();
    });

    it("drops bundle_hash with missing hash (no setServerBundleHash call)", async () => {
      const bh = await import("../lib/bundleHash");
      channelMock.fireEvent({ kind: "bundle_hash" });
      expect(bh.setServerBundleHash).not.toHaveBeenCalled();
    });
  });

  // P-0b — peer_away dispatch.
  describe("peer_away arm", () => {
    it("calls setPeerAway with (network, peer, message)", async () => {
      const pa = await import("../lib/peerAway");
      channelMock.fireEvent({
        kind: "peer_away",
        network: "azzurra",
        peer: "alice",
        message: "Gone fishing",
      });
      expect(pa.setPeerAway).toHaveBeenCalledWith("azzurra", "alice", "Gone fishing");
    });

    it("drops peer_away missing `peer` (no setPeerAway call)", async () => {
      const pa = await import("../lib/peerAway");
      channelMock.fireEvent({
        kind: "peer_away",
        network: "azzurra",
        message: "Gone fishing",
      });
      expect(pa.setPeerAway).not.toHaveBeenCalled();
    });

    it("drops peer_away with non-string `message` (no setPeerAway call)", async () => {
      const pa = await import("../lib/peerAway");
      channelMock.fireEvent({
        kind: "peer_away",
        network: "azzurra",
        peer: "alice",
        message: 42,
      });
      expect(pa.setPeerAway).not.toHaveBeenCalled();
    });
  });

  describe("lusers_bundle arm (P-0d)", () => {
    it("calls setLusersBundle with (network, snapshot) — snapshot omits kind + network", async () => {
      const lb = await import("../lib/lusersBundle");
      channelMock.fireEvent({
        kind: "lusers_bundle",
        network: "azzurra",
        total_users: 1234,
        invisible: 56,
        servers: 3,
        operators: 7,
        unknown_connections: 2,
        channels_formed: 89,
        local_clients: 100,
        local_servers: 1,
        current_local: 100,
        max_local: 200,
        current_global: 1234,
        max_global: 5000,
      });
      expect(lb.setLusersBundle).toHaveBeenCalledWith("azzurra", {
        total_users: 1234,
        invisible: 56,
        servers: 3,
        operators: 7,
        unknown_connections: 2,
        channels_formed: 89,
        local_clients: 100,
        local_servers: 1,
        current_local: 100,
        max_local: 200,
        current_global: 1234,
        max_global: 5000,
      });
    });

    it("accepts null fields (graceful degradation for partial bundles)", async () => {
      const lb = await import("../lib/lusersBundle");
      channelMock.fireEvent({
        kind: "lusers_bundle",
        network: "azzurra",
        total_users: 42,
        invisible: null,
        servers: null,
        operators: null,
        unknown_connections: null,
        channels_formed: null,
        local_clients: null,
        local_servers: null,
        current_local: null,
        max_local: null,
        current_global: null,
        max_global: null,
      });
      expect(lb.setLusersBundle).toHaveBeenCalledWith(
        "azzurra",
        expect.objectContaining({ total_users: 42, invisible: null, max_global: null }),
      );
    });

    it("drops payload missing `network` (no setLusersBundle call)", async () => {
      const lb = await import("../lib/lusersBundle");
      channelMock.fireEvent({
        kind: "lusers_bundle",
        total_users: 42,
      });
      expect(lb.setLusersBundle).not.toHaveBeenCalled();
    });
  });
});
