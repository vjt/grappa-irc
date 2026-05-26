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
  setJoined: vi.fn(),
  setFailed: vi.fn(),
  setKicked: vi.fn(),
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
});
