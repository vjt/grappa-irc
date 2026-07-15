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
  user: vi.fn(() => ({ kind: "user", id: "u1", name: "vjt", is_admin: false, inserted_at: "x" })),
  refetchChannels: vi.fn(),
  refetchNetworks: vi.fn(),
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
  setInvited: vi.fn(),
  setJoined: vi.fn(),
  setFailed: vi.fn(),
  setKicked: vi.fn(),
}));

vi.mock("../lib/awayStatus", () => ({
  setAwayState: vi.fn(),
}));

vi.mock("../lib/reconnectingStatus", () => ({
  setReconnecting: vi.fn(),
}));

vi.mock("../lib/home", () => ({
  patchHomeNetwork: vi.fn(),
}));

vi.mock("../lib/mentionsWindow", () => ({
  setMentionsBundle: vi.fn(),
  clearMentionsBundle: vi.fn(),
}));

vi.mock("../lib/selection", () => ({
  selectedChannel: vi.fn(() => null),
  setSelectedChannel: vi.fn(),
  applySeedEnvelope: vi.fn(),
}));

vi.mock("../lib/bundleHash", () => ({
  setServerBundleHash: vi.fn(),
}));

vi.mock("../lib/peerAway", () => ({
  setPeerAway: vi.fn(),
}));

vi.mock("../lib/lusersBundle", () => ({
  applyLusersBundle: vi.fn(),
  markLusersRequested: vi.fn(),
}));

vi.mock("../lib/serverReplyModal", () => ({
  setServerReply: vi.fn(),
}));

vi.mock("../lib/whowasCard", () => ({
  setWhowasBundle: vi.fn(),
}));

vi.mock("../lib/inviteAck", () => ({
  appendInviteAck: vi.fn(),
}));

vi.mock("../lib/whoisCard", () => ({
  setWhoisBundle: vi.fn(),
}));

vi.mock("../lib/archive", () => ({
  loadArchive: vi.fn(),
}));

vi.mock("../lib/scrollback", () => ({
  purgeScrollback: vi.fn(),
}));

vi.mock("../lib/reconnectBackfill", () => ({
  clearSeen: vi.fn(),
}));

vi.mock("../lib/channelDirectory", () => ({
  onDirectoryProgress: vi.fn(),
  onDirectoryComplete: vi.fn(),
  onDirectoryFailed: vi.fn(),
}));

vi.mock("../lib/isupport", () => ({
  seedIsupport: vi.fn(),
}));

vi.mock("../lib/umodes", () => ({
  seedUmodes: vi.fn(),
}));

// #100 — builds a valid connection_state_changed payload (the narrower
// requires the full set of top-level + nested `network` fields).
function connectionStateChanged(slug: string, to: "connected" | "parked" | "failed") {
  return {
    kind: "connection_state_changed",
    user_id: "u1",
    network_id: 1,
    network_slug: slug,
    from: "connected",
    to,
    reason: to === "connected" ? null : "test reason",
    at: "2026-07-10T00:00:00Z",
    network: {
      slug,
      nick: "vjt-grappa",
      connection_state: to,
      connection_state_reason: to === "connected" ? null : "test reason",
      connection_state_changed_at: "2026-07-10T00:00:00Z",
    },
  };
}

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
    expect(socket.joinUser).toHaveBeenCalledWith("vjt", expect.any(Function));
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
    // S43 — the server emits `network_id` on each entry (redundant with
    // the map key); the narrower now validates it, so realistic mocks
    // carry it. `parseWindowsMap` still derives the key from the map key.
    channelMock.fireEvent({
      kind: "query_windows_list",
      windows: {
        "1": [{ network_id: 1, target_nick: "alice", opened_at: "2026-05-04T10:00:00Z" }],
        "2": [
          { network_id: 2, target_nick: "bob", opened_at: "2026-05-04T11:00:00Z" },
          { network_id: 2, target_nick: "carol", opened_at: "2026-05-04T12:00:00Z" },
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

  // S43 — a malformed entry (here: missing the required `network_id`)
  // drops the WHOLE event at the narrower rather than admitting a
  // half-typed window map via a bare cast.
  it("query_windows_list event drops on a malformed entry (no network_id)", async () => {
    const qw = await import("../lib/queryWindows");
    channelMock.fireEvent({
      kind: "query_windows_list",
      windows: { "1": [{ target_nick: "alice", opened_at: "2026-05-04T10:00:00Z" }] },
    });
    expect(qw.setQueryWindowsByNetwork).not.toHaveBeenCalled();
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

  // #216 — isupport_changed seeds the per-network capability store.
  describe("isupport_changed event (#216)", () => {
    it("calls seedIsupport with the narrowed capability table", async () => {
      const isupport = await import("../lib/isupport");
      channelMock.fireEvent({
        kind: "isupport_changed",
        network_id: 7,
        chanmodes_a: ["b", "e", "I"],
        chanmodes_b: ["k"],
        chanmodes_c: ["l"],
        chanmodes_d: ["n", "t", "s"],
        prefix: { q: "~", o: "@", v: "+" },
      });
      expect(isupport.seedIsupport).toHaveBeenCalledWith(7, {
        chanmodes: { a: ["b", "e", "I"], b: ["k"], c: ["l"], d: ["n", "t", "s"] },
        prefix: { q: "~", o: "@", v: "+" },
      });
    });

    it("drops isupport_changed with a non-number network_id (narrower rejects)", async () => {
      const isupport = await import("../lib/isupport");
      vi.mocked(isupport.seedIsupport).mockClear();
      channelMock.fireEvent({
        kind: "isupport_changed",
        network_id: "seven",
        chanmodes_a: [],
        chanmodes_b: [],
        chanmodes_c: [],
        chanmodes_d: [],
        prefix: {},
      });
      expect(isupport.seedIsupport).not.toHaveBeenCalled();
    });

    it("drops isupport_changed with a malformed chanmodes class (narrower rejects)", async () => {
      const isupport = await import("../lib/isupport");
      vi.mocked(isupport.seedIsupport).mockClear();
      channelMock.fireEvent({
        kind: "isupport_changed",
        network_id: 7,
        chanmodes_a: [],
        chanmodes_b: [],
        chanmodes_c: [],
        chanmodes_d: [1, 2, 3],
        prefix: {},
      });
      expect(isupport.seedIsupport).not.toHaveBeenCalled();
    });
  });

  // #229 — umode_changed seeds the per-network umode store.
  describe("umode_changed event (#229)", () => {
    it("calls seedUmodes with the narrowed letter list", async () => {
      const umodes = await import("../lib/umodes");
      channelMock.fireEvent({
        kind: "umode_changed",
        network_id: 7,
        modes: ["S", "i", "w"],
      });
      expect(umodes.seedUmodes).toHaveBeenCalledWith(7, ["S", "i", "w"]);
    });

    it("accepts an empty umode list (all modes cleared)", async () => {
      const umodes = await import("../lib/umodes");
      vi.mocked(umodes.seedUmodes).mockClear();
      channelMock.fireEvent({ kind: "umode_changed", network_id: 7, modes: [] });
      expect(umodes.seedUmodes).toHaveBeenCalledWith(7, []);
    });

    it("drops umode_changed with a non-number network_id (narrower rejects)", async () => {
      const umodes = await import("../lib/umodes");
      vi.mocked(umodes.seedUmodes).mockClear();
      channelMock.fireEvent({ kind: "umode_changed", network_id: "seven", modes: ["i"] });
      expect(umodes.seedUmodes).not.toHaveBeenCalled();
    });

    it("drops umode_changed whose modes contain a non-string (narrower rejects)", async () => {
      const umodes = await import("../lib/umodes");
      vi.mocked(umodes.seedUmodes).mockClear();
      channelMock.fireEvent({ kind: "umode_changed", network_id: 7, modes: ["i", 42] });
      expect(umodes.seedUmodes).not.toHaveBeenCalled();
    });

    it("drops umode_changed with a non-array modes (narrower rejects)", async () => {
      const umodes = await import("../lib/umodes");
      vi.mocked(umodes.seedUmodes).mockClear();
      channelMock.fireEvent({ kind: "umode_changed", network_id: 7, modes: "iwS" });
      expect(umodes.seedUmodes).not.toHaveBeenCalled();
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

  // #78 — inbound INVITE to a not-joined channel. Server's apply_effects
  // emits `kind: "window_invited"` on Topic.user/1 (same chicken-and-egg
  // user-topic origination as window_pending). userTopic.ts dispatcher
  // mirrors into `setInvited(channelKey(...))`, and subscribe.ts's
  // pre-subscribe loop joins the per-channel topic so the INVITE row
  // lands in the channel buffer.
  describe("window_invited event (#78)", () => {
    it("calls setInvited with channelKey(network, channel) on window_invited", async () => {
      const ws = await import("../lib/windowState");
      const { channelKey } = await import("../lib/channelKey");
      channelMock.fireEvent({
        kind: "window_invited",
        network: "freenode",
        channel: "#random",
        state: "invited",
      });
      expect(ws.setInvited).toHaveBeenCalledWith(channelKey("freenode", "#random"));
    });

    it("drops a window_invited payload missing `channel` (no setInvited call)", async () => {
      const ws = await import("../lib/windowState");
      channelMock.fireEvent({
        kind: "window_invited",
        network: "freenode",
        state: "invited",
      });
      expect(ws.setInvited).not.toHaveBeenCalled();
    });
  });

  // F1 (visitor-parity-and-nickserv 2026-05-15) — typed window-state
  // terminal events on user-topic. Server-side
  // `Session.Server.broadcast_window_state/2` moved the broadcast off
  // the per-channel topic to close the subscribe-then-broadcast race
  // documented at `cp15-b6-pending-to-failed-invite-only.spec.ts` flake.
  // userTopic.ts dispatcher routes to the same `setJoined/setFailed/
  // setKicked` setters subscribe.ts uses for the cold-WS-reconnect
  // snapshot path; both paths are last-write-wins idempotent.
  describe("F1 window-state terminal events on user-topic", () => {
    it("calls setJoined with channelKey on `joined` payload", async () => {
      const ws = await import("../lib/windowState");
      const { channelKey } = await import("../lib/channelKey");
      channelMock.fireEvent({
        kind: "joined",
        network: "freenode",
        channel: "#italia",
        state: "joined",
      });
      expect(ws.setJoined).toHaveBeenCalledWith(channelKey("freenode", "#italia"));
    });

    it("calls setFailed with channelKey + reason + numeric on `join_failed` payload", async () => {
      const ws = await import("../lib/windowState");
      const { channelKey } = await import("../lib/channelKey");
      channelMock.fireEvent({
        kind: "join_failed",
        network: "freenode",
        channel: "#secret",
        state: "failed",
        reason: "Cannot join channel (+i)",
        numeric: 473,
      });
      expect(ws.setFailed).toHaveBeenCalledWith(
        channelKey("freenode", "#secret"),
        "Cannot join channel (+i)",
        473,
      );
    });

    it("calls setFailed with null reason when payload reason is null", async () => {
      const ws = await import("../lib/windowState");
      const { channelKey } = await import("../lib/channelKey");
      channelMock.fireEvent({
        kind: "join_failed",
        network: "freenode",
        channel: "#secret",
        state: "failed",
        reason: null,
        numeric: 471,
      });
      expect(ws.setFailed).toHaveBeenCalledWith(channelKey("freenode", "#secret"), null, 471);
    });

    it("calls setKicked with channelKey + by + reason on `kicked` payload", async () => {
      const ws = await import("../lib/windowState");
      const { channelKey } = await import("../lib/channelKey");
      channelMock.fireEvent({
        kind: "kicked",
        network: "freenode",
        channel: "#italia",
        state: "kicked",
        by: "alice",
        reason: "behave",
      });
      expect(ws.setKicked).toHaveBeenCalledWith(
        channelKey("freenode", "#italia"),
        "alice",
        "behave",
      );
    });

    it("calls setKicked with null reason when payload reason is null", async () => {
      const ws = await import("../lib/windowState");
      const { channelKey } = await import("../lib/channelKey");
      channelMock.fireEvent({
        kind: "kicked",
        network: "freenode",
        channel: "#italia",
        state: "kicked",
        by: "alice",
        reason: null,
      });
      expect(ws.setKicked).toHaveBeenCalledWith(channelKey("freenode", "#italia"), "alice", null);
    });

    it("drops `joined` payload missing channel (narrowUserEvent rejects)", async () => {
      const ws = await import("../lib/windowState");
      channelMock.fireEvent({
        kind: "joined",
        network: "freenode",
        state: "joined",
      });
      expect(ws.setJoined).not.toHaveBeenCalled();
    });

    // #200/#125 invariant, re-asserted for #244: the WS window-state
    // terminal events NEVER originate selection. #244 makes the DirectoryPane
    // TAP foreground the joined channel — but focus originates from the user's
    // tap gesture, NOT from the join COMPLETING. If these WS arms called
    // setSelectedChannel, an automatic re-join (reconnect auto-rejoin, cross-
    // device broadcast) would steal focus — the exact regression #244 must
    // avoid. This guards the boundary.
    it("`joined` payload does NOT originate selection (auto-rejoin no-steal, #200/#244)", async () => {
      const sel = await import("../lib/selection");
      channelMock.fireEvent({
        kind: "joined",
        network: "freenode",
        channel: "#italia",
        state: "joined",
      });
      expect(sel.setSelectedChannel).not.toHaveBeenCalled();
    });

    it("`window_pending` payload does NOT originate selection (auto-rejoin no-steal, #200/#244)", async () => {
      const sel = await import("../lib/selection");
      channelMock.fireEvent({
        kind: "window_pending",
        network: "freenode",
        channel: "#italia",
        state: "pending",
      });
      expect(sel.setSelectedChannel).not.toHaveBeenCalled();
    });

    it("drops `join_failed` payload with non-number numeric (narrowUserEvent rejects)", async () => {
      const ws = await import("../lib/windowState");
      channelMock.fireEvent({
        kind: "join_failed",
        network: "freenode",
        channel: "#secret",
        state: "failed",
        reason: "x",
        numeric: "473",
      });
      expect(ws.setFailed).not.toHaveBeenCalled();
    });

    it("drops `kicked` payload with wrong state literal (narrowUserEvent rejects)", async () => {
      const ws = await import("../lib/windowState");
      channelMock.fireEvent({
        kind: "kicked",
        network: "freenode",
        channel: "#italia",
        state: "joined",
        by: "alice",
        reason: null,
      });
      expect(ws.setKicked).not.toHaveBeenCalled();
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

  // #188 — clear-on-away lifecycle. Going /away AGAIN clears the prior
  // mentions bundle so the next return-from-away consults a fresh panel.
  // The bundle is SET on RETURN (mentions_bundle) and CLEARED on GOING
  // away (away_confirmed state === "away"); state === "present" must NOT
  // clear (that IS the return path).
  describe("clear-on-away lifecycle (#188)", () => {
    it("clears the network's mentions bundle when state flips to away", async () => {
      const mw = await import("../lib/mentionsWindow");
      channelMock.fireEvent({
        kind: "away_confirmed",
        network: "azzurra",
        state: "away",
      });
      expect(mw.clearMentionsBundle).toHaveBeenCalledWith("azzurra");
    });

    it("does NOT clear the mentions bundle when state is present (return path)", async () => {
      const mw = await import("../lib/mentionsWindow");
      channelMock.fireEvent({
        kind: "away_confirmed",
        network: "azzurra",
        state: "present",
      });
      expect(mw.clearMentionsBundle).not.toHaveBeenCalled();
    });
  });

  // #100 — connection_progress dispatch: the transient reconnect badge
  // signal flips reconnectingByNetwork via setReconnecting. "connecting"
  // → true (badge shows); "connected" → false (badge clears).
  describe("connection_progress arm (#100)", () => {
    it("sets reconnecting=true on state connecting", async () => {
      const rs = await import("../lib/reconnectingStatus");
      channelMock.fireEvent({
        kind: "connection_progress",
        network: "bahamut-test",
        state: "connecting",
      });
      expect(rs.setReconnecting).toHaveBeenCalledWith("bahamut-test", true);
    });

    it("sets reconnecting=false on state connected", async () => {
      const rs = await import("../lib/reconnectingStatus");
      channelMock.fireEvent({
        kind: "connection_progress",
        network: "bahamut-test",
        state: "connected",
      });
      expect(rs.setReconnecting).toHaveBeenCalledWith("bahamut-test", false);
    });

    it("drops payload with an unknown state (no setReconnecting call)", async () => {
      const rs = await import("../lib/reconnectingStatus");
      channelMock.fireEvent({
        kind: "connection_progress",
        network: "bahamut-test",
        state: "parked",
      });
      expect(rs.setReconnecting).not.toHaveBeenCalled();
    });

    it("drops payload missing network (no setReconnecting call)", async () => {
      const rs = await import("../lib/reconnectingStatus");
      channelMock.fireEvent({ kind: "connection_progress", state: "connecting" });
      expect(rs.setReconnecting).not.toHaveBeenCalled();
    });

    // #100 — a reconnect that ends terminally (k-line → :failed) or is
    // operator-parked (:parked) never emits connection_progress "connected",
    // so the badge would stay stuck. The connection_state_changed arm clears
    // it on those settled non-connecting states.
    it("clears reconnecting when connection_state_changed → failed", async () => {
      const rs = await import("../lib/reconnectingStatus");
      channelMock.fireEvent(connectionStateChanged("bahamut-test", "failed"));
      expect(rs.setReconnecting).toHaveBeenCalledWith("bahamut-test", false);
    });

    it("clears reconnecting when connection_state_changed → parked", async () => {
      const rs = await import("../lib/reconnectingStatus");
      channelMock.fireEvent(connectionStateChanged("bahamut-test", "parked"));
      expect(rs.setReconnecting).toHaveBeenCalledWith("bahamut-test", false);
    });

    it("does NOT clear reconnecting when connection_state_changed → connected", async () => {
      const rs = await import("../lib/reconnectingStatus");
      channelMock.fireEvent(connectionStateChanged("bahamut-test", "connected"));
      expect(rs.setReconnecting).not.toHaveBeenCalled();
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
    it("calls applyLusersBundle with (network, snapshot) — snapshot omits kind + network", async () => {
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
      expect(lb.applyLusersBundle).toHaveBeenCalledWith("azzurra", {
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
      expect(lb.applyLusersBundle).toHaveBeenCalledWith(
        "azzurra",
        expect.objectContaining({ total_users: 42, invisible: null, max_global: null }),
      );
    });

    it("drops payload missing `network` (no applyLusersBundle call)", async () => {
      const lb = await import("../lib/lusersBundle");
      channelMock.fireEvent({
        kind: "lusers_bundle",
        total_users: 42,
      });
      expect(lb.applyLusersBundle).not.toHaveBeenCalled();
    });
  });

  describe("server_reply arm (#127)", () => {
    it("calls setServerReply with (network, reply) — reply keeps source + lines, drops kind", async () => {
      const srm = await import("../lib/serverReplyModal");
      channelMock.fireEvent({
        kind: "server_reply",
        network: "azzurra",
        source: "motd",
        lines: ["- Welcome -", "line two"],
      });
      expect(srm.setServerReply).toHaveBeenCalledWith("azzurra", {
        network: "azzurra",
        source: "motd",
        lines: ["- Welcome -", "line two"],
      });
    });

    it("accepts an empty line list (422 no-MOTD)", async () => {
      const srm = await import("../lib/serverReplyModal");
      channelMock.fireEvent({
        kind: "server_reply",
        network: "azzurra",
        source: "info",
        lines: [],
      });
      expect(srm.setServerReply).toHaveBeenCalledWith("azzurra", {
        network: "azzurra",
        source: "info",
        lines: [],
      });
    });

    it("drops a payload with an unknown source (no setServerReply call)", async () => {
      const srm = await import("../lib/serverReplyModal");
      channelMock.fireEvent({
        kind: "server_reply",
        network: "azzurra",
        source: "stats",
        lines: ["x"],
      });
      expect(srm.setServerReply).not.toHaveBeenCalled();
    });

    it("drops a payload whose lines contain a non-string (no setServerReply call)", async () => {
      const srm = await import("../lib/serverReplyModal");
      channelMock.fireEvent({
        kind: "server_reply",
        network: "azzurra",
        source: "motd",
        lines: ["ok", 42],
      });
      expect(srm.setServerReply).not.toHaveBeenCalled();
    });
  });

  describe("whowas_bundle arm (P-0c)", () => {
    it("calls setWhowasBundle with the bundle (kind stripped) on success path", async () => {
      const wc = await import("../lib/whowasCard");
      channelMock.fireEvent({
        kind: "whowas_bundle",
        network: "azzurra",
        target: "alice",
        user: "alice_u",
        host: "alice.host",
        realname: "Alice Liddell",
        server: "irc.test.org",
        logoff_time: "Mon May 13 12:34:56 2026",
        not_found: false,
      });
      expect(wc.setWhowasBundle).toHaveBeenCalledWith("azzurra", {
        network: "azzurra",
        target: "alice",
        user: "alice_u",
        host: "alice.host",
        realname: "Alice Liddell",
        server: "irc.test.org",
        logoff_time: "Mon May 13 12:34:56 2026",
        not_found: false,
      });
    });

    it("accepts not_found: true with all historical fields nil (406 case)", async () => {
      const wc = await import("../lib/whowasCard");
      channelMock.fireEvent({
        kind: "whowas_bundle",
        network: "azzurra",
        target: "ghost",
        user: null,
        host: null,
        realname: null,
        server: null,
        logoff_time: null,
        not_found: true,
      });
      expect(wc.setWhowasBundle).toHaveBeenCalledWith(
        "azzurra",
        expect.objectContaining({ target: "ghost", not_found: true, user: null }),
      );
    });

    it("drops payload missing `not_found` boolean (no setWhowasBundle call)", async () => {
      const wc = await import("../lib/whowasCard");
      channelMock.fireEvent({
        kind: "whowas_bundle",
        network: "azzurra",
        target: "alice",
        user: null,
        host: null,
        realname: null,
        server: null,
        logoff_time: null,
      });
      expect(wc.setWhowasBundle).not.toHaveBeenCalled();
    });

    it("drops payload with non-string user (type mismatch)", async () => {
      const wc = await import("../lib/whowasCard");
      channelMock.fireEvent({
        kind: "whowas_bundle",
        network: "azzurra",
        target: "alice",
        user: 42,
        host: null,
        realname: null,
        server: null,
        logoff_time: null,
        not_found: false,
      });
      expect(wc.setWhowasBundle).not.toHaveBeenCalled();
    });
  });

  describe("invite_ack arm (P-0e + P-0f)", () => {
    it("calls appendInviteAck with (network, channel, peer)", async () => {
      const ia = await import("../lib/inviteAck");
      channelMock.fireEvent({
        kind: "invite_ack",
        network: "azzurra",
        channel: "#it-opers",
        peer: "grappa",
      });
      expect(ia.appendInviteAck).toHaveBeenCalledWith("azzurra", "#it-opers", "grappa");
    });

    it("drops payload missing `peer` (no appendInviteAck call)", async () => {
      const ia = await import("../lib/inviteAck");
      channelMock.fireEvent({
        kind: "invite_ack",
        network: "azzurra",
        channel: "#it-opers",
      });
      expect(ia.appendInviteAck).not.toHaveBeenCalled();
    });

    it("drops payload with non-string channel (no appendInviteAck call)", async () => {
      const ia = await import("../lib/inviteAck");
      channelMock.fireEvent({
        kind: "invite_ack",
        network: "azzurra",
        channel: 42,
        peer: "grappa",
      });
      expect(ia.appendInviteAck).not.toHaveBeenCalled();
    });
  });

  // no-silent-drops B6.10 HIGH-11 — per-element narrowers for bundle
  // arrays. Pre-fix the dispatcher only checked `Array.isArray()` for
  // `mentions_bundle.messages` and `whois_bundle.channels`. A single
  // malformed element would crash a downstream renderer that read a
  // missing field. Now per-element narrowing drops the whole bundle
  // on any element-shape failure.
  describe("mentions_bundle per-element narrowing (HIGH-11)", () => {
    const goodMessage = {
      server_time: 1_700_000_000,
      channel: "#italia",
      sender: "alice",
      body: "ping vjt",
      kind: "privmsg",
    };

    it("accepts a well-formed messages array", async () => {
      const mw = await import("../lib/mentionsWindow");
      channelMock.fireEvent({
        kind: "mentions_bundle",
        network: "azzurra",
        away_started_at: "2026-05-14T08:00:00Z",
        away_ended_at: "2026-05-14T09:00:00Z",
        away_reason: null,
        messages: [goodMessage],
      });
      expect(mw.setMentionsBundle).toHaveBeenCalledWith(
        "azzurra",
        expect.objectContaining({
          messages: [goodMessage],
        }),
      );
    });

    it("accepts an empty messages array", async () => {
      const mw = await import("../lib/mentionsWindow");
      channelMock.fireEvent({
        kind: "mentions_bundle",
        network: "azzurra",
        away_started_at: "2026-05-14T08:00:00Z",
        away_ended_at: "2026-05-14T09:00:00Z",
        away_reason: null,
        messages: [],
      });
      expect(mw.setMentionsBundle).toHaveBeenCalledWith(
        "azzurra",
        expect.objectContaining({ messages: [] }),
      );
    });

    it("drops bundle when one message has wrong-typed `body`", async () => {
      const mw = await import("../lib/mentionsWindow");
      channelMock.fireEvent({
        kind: "mentions_bundle",
        network: "azzurra",
        away_started_at: "2026-05-14T08:00:00Z",
        away_ended_at: "2026-05-14T09:00:00Z",
        away_reason: null,
        messages: [goodMessage, { ...goodMessage, body: 42 }],
      });
      expect(mw.setMentionsBundle).not.toHaveBeenCalled();
    });

    it("drops bundle when one message is missing `sender`", async () => {
      const mw = await import("../lib/mentionsWindow");
      const broken = { ...goodMessage } as Partial<typeof goodMessage>;
      delete broken.sender;
      channelMock.fireEvent({
        kind: "mentions_bundle",
        network: "azzurra",
        away_started_at: "2026-05-14T08:00:00Z",
        away_ended_at: "2026-05-14T09:00:00Z",
        away_reason: null,
        messages: [broken],
      });
      expect(mw.setMentionsBundle).not.toHaveBeenCalled();
    });

    it("drops bundle when a message element is null", async () => {
      const mw = await import("../lib/mentionsWindow");
      channelMock.fireEvent({
        kind: "mentions_bundle",
        network: "azzurra",
        away_started_at: "2026-05-14T08:00:00Z",
        away_ended_at: "2026-05-14T09:00:00Z",
        away_reason: null,
        messages: [null],
      });
      expect(mw.setMentionsBundle).not.toHaveBeenCalled();
    });

    it("accepts body: null (away-period notice rows)", async () => {
      const mw = await import("../lib/mentionsWindow");
      channelMock.fireEvent({
        kind: "mentions_bundle",
        network: "azzurra",
        away_started_at: "2026-05-14T08:00:00Z",
        away_ended_at: "2026-05-14T09:00:00Z",
        away_reason: null,
        messages: [{ ...goodMessage, body: null }],
      });
      expect(mw.setMentionsBundle).toHaveBeenCalled();
    });
  });

  describe("whois_bundle per-element channels narrowing (HIGH-11)", () => {
    const baseBundle = {
      kind: "whois_bundle",
      network: "azzurra",
      target: "alice",
      user: "alice_u",
      host: "alice.host",
      realname: "Alice",
      server: "irc.test",
      server_info: "test",
      is_operator: false,
      idle_seconds: 0,
      signon: 0,
      using_ssl: false,
      is_registered: false,
      is_admin: false,
      is_services_admin: false,
      is_helper: false,
      is_chanop: false,
      is_agent: false,
      is_java: false,
      umodes: null,
      away_message: null,
      actually_host: null,
      actually_ip: null,
      // #221 — solanum WHOIS-leg fields are REQUIRED by narrowUserEvent
      // (account/certfp nullable-string, secure boolean, secure_cipher
      // nullable-string). A realistic whois_bundle always carries them; a
      // mock missing them is dropped by the narrower (this predated the
      // fields being required — pre-existing test breakage fixed alongside
      // #221's secure_cipher add).
      account: null,
      secure: false,
      secure_cipher: null,
      certfp: null,
    };

    it("accepts well-formed channels array", async () => {
      const wc = await import("../lib/whoisCard");
      channelMock.fireEvent({ ...baseBundle, channels: ["@#italia", "+#grappa"] });
      expect(wc.setWhoisBundle).toHaveBeenCalledWith(
        "azzurra",
        expect.objectContaining({ channels: ["@#italia", "+#grappa"] }),
      );
    });

    it("accepts channels: null (no /whois channel list)", async () => {
      const wc = await import("../lib/whoisCard");
      channelMock.fireEvent({ ...baseBundle, channels: null });
      expect(wc.setWhoisBundle).toHaveBeenCalledWith(
        "azzurra",
        expect.objectContaining({ channels: null }),
      );
    });

    it("drops bundle when channels has a non-string element", async () => {
      const wc = await import("../lib/whoisCard");
      channelMock.fireEvent({ ...baseBundle, channels: ["#italia", 42] });
      expect(wc.setWhoisBundle).not.toHaveBeenCalled();
    });

    it("drops bundle when channels has a null element", async () => {
      const wc = await import("../lib/whoisCard");
      channelMock.fireEvent({ ...baseBundle, channels: ["#italia", null] });
      expect(wc.setWhoisBundle).not.toHaveBeenCalled();
    });

    it("accepts empty channels array", async () => {
      const wc = await import("../lib/whoisCard");
      channelMock.fireEvent({ ...baseBundle, channels: [] });
      expect(wc.setWhoisBundle).toHaveBeenCalledWith(
        "azzurra",
        expect.objectContaining({ channels: [] }),
      );
    });

    it("#221 — narrows account/secure/secure_cipher/certfp through to the bundle", async () => {
      const wc = await import("../lib/whoisCard");
      channelMock.fireEvent({
        ...baseBundle,
        channels: null,
        account: "AliceAccount",
        secure: true,
        secure_cipher: "TLSv1.3, TLS_AES_256_GCM_SHA384",
        certfp: "deadbeefcafef00d",
      });
      expect(wc.setWhoisBundle).toHaveBeenCalledWith(
        "azzurra",
        expect.objectContaining({
          account: "AliceAccount",
          secure: true,
          secure_cipher: "TLSv1.3, TLS_AES_256_GCM_SHA384",
          certfp: "deadbeefcafef00d",
        }),
      );
    });

    it("#221 — drops bundle when secure_cipher is a non-string non-null value", async () => {
      const wc = await import("../lib/whoisCard");
      channelMock.fireEvent({ ...baseBundle, channels: null, secure_cipher: 42 });
      expect(wc.setWhoisBundle).not.toHaveBeenCalled();
    });
  });

  describe("archive_purged arm (UX-7-B 2026-05-22)", () => {
    it("purges scrollback + clears the resume cursor + reloads the archive list", async () => {
      const archive = await import("../lib/archive");
      const sb = await import("../lib/scrollback");
      const rb = await import("../lib/reconnectBackfill");
      const { channelKey } = await import("../lib/channelKey");

      channelMock.fireEvent({
        kind: "archive_purged",
        network_slug: "bahamut-test",
        target: "#bofh",
      });

      const key = channelKey("bahamut-test", "#bofh");
      expect(sb.purgeScrollback).toHaveBeenCalledWith(key);
      expect(rb.clearSeen).toHaveBeenCalledWith(key);
      expect(archive.loadArchive).toHaveBeenCalledWith("bahamut-test");
    });

    it("works for query-shaped targets too (peer-nick DM purge)", async () => {
      const sb = await import("../lib/scrollback");
      const { channelKey } = await import("../lib/channelKey");

      channelMock.fireEvent({
        kind: "archive_purged",
        network_slug: "azzurra",
        target: "alice",
      });

      expect(sb.purgeScrollback).toHaveBeenCalledWith(channelKey("azzurra", "alice"));
    });

    it("drops archive_purged payload missing `target` (narrowing rejects)", async () => {
      const sb = await import("../lib/scrollback");

      channelMock.fireEvent({
        kind: "archive_purged",
        network_slug: "bahamut-test",
      });

      expect(sb.purgeScrollback).not.toHaveBeenCalled();
    });

    it("drops archive_purged payload missing `network_slug` (narrowing rejects)", async () => {
      const sb = await import("../lib/scrollback");

      channelMock.fireEvent({
        kind: "archive_purged",
        target: "#bofh",
      });

      expect(sb.purgeScrollback).not.toHaveBeenCalled();
    });

    it("archive_changed (refresh-only sibling) does NOT trigger purgeScrollback", async () => {
      const sb = await import("../lib/scrollback");
      const archive = await import("../lib/archive");

      channelMock.fireEvent({
        kind: "archive_changed",
        network_slug: "bahamut-test",
      });

      expect(sb.purgeScrollback).not.toHaveBeenCalled();
      expect(archive.loadArchive).toHaveBeenCalledWith("bahamut-test");
    });
  });

  // #84 — channel directory `/list` refresh progress pings. Server emits
  // three tiny payloads on the user-topic during a refresh run. Each arm
  // calls the matching channelDirectory store hook which re-GETs the
  // current directory view for that network.
  describe("directory progress pings (#84)", () => {
    it("dispatches directory_progress to onDirectoryProgress(network)", async () => {
      const cd = await import("../lib/channelDirectory");
      channelMock.fireEvent({ kind: "directory_progress", network: "libera", count: 42 });
      expect(cd.onDirectoryProgress).toHaveBeenCalledWith("libera");
    });

    it("dispatches directory_complete to onDirectoryComplete(network)", async () => {
      const cd = await import("../lib/channelDirectory");
      channelMock.fireEvent({ kind: "directory_complete", network: "libera", total: 100 });
      expect(cd.onDirectoryComplete).toHaveBeenCalledWith("libera");
    });

    it("dispatches directory_failed to onDirectoryFailed(network)", async () => {
      const cd = await import("../lib/channelDirectory");
      channelMock.fireEvent({ kind: "directory_failed", network: "libera", reason: "timeout" });
      expect(cd.onDirectoryFailed).toHaveBeenCalledWith("libera");
    });

    it("drops directory_progress with non-number count (narrowing rejects)", async () => {
      const cd = await import("../lib/channelDirectory");
      channelMock.fireEvent({ kind: "directory_progress", network: "libera", count: "x" });
      expect(cd.onDirectoryProgress).not.toHaveBeenCalled();
    });

    it("drops directory_complete missing network (narrowing rejects)", async () => {
      const cd = await import("../lib/channelDirectory");
      channelMock.fireEvent({ kind: "directory_complete", total: 1 });
      expect(cd.onDirectoryComplete).not.toHaveBeenCalled();
    });

    it("drops directory_failed with non-string reason (narrowing rejects)", async () => {
      const cd = await import("../lib/channelDirectory");
      channelMock.fireEvent({ kind: "directory_failed", network: "libera", reason: 99 });
      expect(cd.onDirectoryFailed).not.toHaveBeenCalled();
    });
  });
});

// Pure narrowUserEvent tests — no mock setup needed; narrowUserEvent is a
// stateless predicate exported for unit-testing (matches wireNarrow.ts
// siblings: narrowChannelEvent et al.).
describe("narrowUserEvent — directory pings", () => {
  it("narrows directory_progress", async () => {
    const { narrowUserEvent } = await import("../lib/userTopic");
    expect(narrowUserEvent({ kind: "directory_progress", network: "libera", count: 42 })).toEqual({
      kind: "directory_progress",
      network: "libera",
      count: 42,
    });
  });

  it("narrows directory_complete", async () => {
    const { narrowUserEvent } = await import("../lib/userTopic");
    expect(narrowUserEvent({ kind: "directory_complete", network: "libera", total: 100 })).toEqual({
      kind: "directory_complete",
      network: "libera",
      total: 100,
    });
  });

  it("narrows directory_failed", async () => {
    const { narrowUserEvent } = await import("../lib/userTopic");
    expect(
      narrowUserEvent({ kind: "directory_failed", network: "libera", reason: "timeout" }),
    ).toEqual({ kind: "directory_failed", network: "libera", reason: "timeout" });
  });

  it("rejects directory_progress with non-number count", async () => {
    const { narrowUserEvent } = await import("../lib/userTopic");
    expect(
      narrowUserEvent({ kind: "directory_progress", network: "libera", count: "x" }),
    ).toBeNull();
  });

  it("rejects directory_complete missing network", async () => {
    const { narrowUserEvent } = await import("../lib/userTopic");
    expect(narrowUserEvent({ kind: "directory_complete", total: 1 })).toBeNull();
  });
});

// #140 — names_reply narrowing. Reuses the shared narrowMembers helper
// (same as the channel-topic members_seeded arm); a malformed member
// element drops the whole payload rather than rendering a half-typed row.
describe("narrowUserEvent — names_reply (#140)", () => {
  it("narrows a well-formed roster", async () => {
    const { narrowUserEvent } = await import("../lib/userTopic");
    expect(
      narrowUserEvent({
        kind: "names_reply",
        network: "azzurra",
        channel: "#bofh",
        members: [
          { nick: "alice", modes: ["@"] },
          { nick: "carol", modes: [] },
        ],
      }),
    ).toEqual({
      kind: "names_reply",
      network: "azzurra",
      channel: "#bofh",
      members: [
        { nick: "alice", modes: ["@"] },
        { nick: "carol", modes: [] },
      ],
    });
  });

  it("narrows an empty roster (366 with zero names)", async () => {
    const { narrowUserEvent } = await import("../lib/userTopic");
    expect(
      narrowUserEvent({ kind: "names_reply", network: "azzurra", channel: "#ghost", members: [] }),
    ).toEqual({ kind: "names_reply", network: "azzurra", channel: "#ghost", members: [] });
  });

  it("rejects a names_reply missing channel", async () => {
    const { narrowUserEvent } = await import("../lib/userTopic");
    expect(narrowUserEvent({ kind: "names_reply", network: "azzurra", members: [] })).toBeNull();
  });

  it("rejects a names_reply whose members array has a malformed element", async () => {
    const { narrowUserEvent } = await import("../lib/userTopic");
    expect(
      narrowUserEvent({
        kind: "names_reply",
        network: "azzurra",
        channel: "#bofh",
        members: [
          { nick: "alice", modes: ["@"] },
          { nick: 42, modes: [] },
        ],
      }),
    ).toBeNull();
  });
});
