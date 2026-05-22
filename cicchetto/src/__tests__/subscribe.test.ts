import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

// Boundary: mock REST (`lib/api`) + the socket helpers (`lib/socket`).
// `subscribe.ts` is a side-effect module — the createRoot installs
// the join effect on import, fanning out joinChannel + ch.on("event")
// per channel once `user()` + `channelsBySlug()` resolve.
//
// The "join + handler" path is the cross-cutting integration surface:
// asserts that the WS handler routes through `scrollback.appendToScrollback`
// and `selection.bumpUnread` correctly, plus the identity-transition
// re-join under a new bearer.

const mockJoinPush = { receive: vi.fn() };
mockJoinPush.receive.mockReturnValue(mockJoinPush);

const mockChannel = {
  join: vi.fn(() => mockJoinPush),
  on: vi.fn(),
  leave: vi.fn(),
};

vi.mock("../lib/api", () => ({
  listNetworks: vi.fn(),
  listChannels: vi.fn(),
  listMessages: vi.fn(),
  sendMessage: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setOn401Handler: vi.fn(),
  displayNick: (me: { kind: "user" | "visitor"; name?: string; nick?: string }) =>
    me.kind === "user" ? (me.name ?? "") : (me.nick ?? ""),
  // Mirror of production `ownNickForNetwork` — single source for
  // per-network IRC nick (cic H3 fix). Tests stub `Network` fixtures
  // with `nick: <stub>` so the user branch returns it; without
  // explicit `nick`, returns null (matching prod's contract-violation
  // branch). Visitor branch returns me.nick when network_slug matches.
  ownNickForNetwork: (
    net: { slug: string; nick?: string },
    me: { kind: "user" | "visitor"; nick?: string; network_slug?: string } | null | undefined,
  ) => {
    if (me == null) return null;
    if (me.kind === "visitor") return me.network_slug === net.slug ? (me.nick ?? null) : null;
    return net.nick && net.nick !== "" ? net.nick : null;
  },
  // Bucket F H4: lib/networks resource calls tagNetwork — passthrough
  // mock that mirrors production behavior so tests don't need to add
  // per-call branching.
  //
  // Test-flexibility relaxation: production tagNetwork drops a row
  // when `connection_state` is missing on the user branch — but the
  // HIGH-24 (no-silent-drops B6.9a 2026-05-14): tagNetwork now reads
  // the discriminator off `raw.kind` instead of taking a subjectKind
  // arg. The mock mirrors the production single-arg signature; legacy
  // fixtures that omit `kind` default to "user" to match the most
  // common test path.
  tagNetwork: (
    raw: {
      kind?: "user" | "visitor";
      id: number;
      slug: string;
      nick?: string;
      connection_state?: string;
    } & Record<string, unknown>,
  ) => {
    const kind = raw.kind ?? "user";
    if (kind === "visitor") {
      return {
        kind: "visitor",
        id: raw.id,
        slug: raw.slug,
        inserted_at: raw.inserted_at,
        updated_at: raw.updated_at,
      };
    }
    if (raw.nick === undefined || raw.nick === "") return null;
    return {
      kind: "user",
      ...raw,
      connection_state: raw.connection_state ?? "connected",
      connection_state_reason: raw.connection_state_reason ?? null,
      connection_state_changed_at: raw.connection_state_changed_at ?? null,
    };
  },
}));

vi.mock("../lib/socket", () => ({
  joinChannel: vi.fn(() => mockChannel),
}));

vi.mock("../lib/members", () => ({
  applyPresenceEvent: vi.fn(),
  seedMembers: vi.fn(),
  membersByChannel: vi.fn(() => ({})),
  seedFromTest: vi.fn(),
}));

vi.mock("../lib/windowState", () => ({
  setPending: vi.fn(),
  setJoined: vi.fn(),
  setFailed: vi.fn(),
  setKicked: vi.fn(),
  setParted: vi.fn(),
  windowStateByChannel: vi.fn(() => ({})),
  windowFailureByChannel: vi.fn(() => ({})),
  windowKickedMetaByChannel: vi.fn(() => ({})),
}));

vi.mock("../lib/mentions", () => ({
  bumpMention: vi.fn(),
  mentionCounts: () => ({}),
  clearMentionsForKey: vi.fn(),
}));

vi.mock("../lib/beep", () => ({
  playBeep: vi.fn(),
}));

vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: vi.fn(),
  closeQueryWindowState: vi.fn(),
  queryWindowsByNetwork: vi.fn(() => ({})),
  setQueryWindowsByNetwork: vi.fn(),
}));

// documentVisibility — controllable via setVisibleForTest(). Defaults to
// true so existing tests (written when isSelected was the only gate)
// continue to assert "selected + visible" semantics. New tests flip the
// signal to false to exercise the "selected but blurred" branch.
let visibleForTest = true;
vi.mock("../lib/documentVisibility", () => ({
  isDocumentVisible: () => visibleForTest,
}));

vi.mock("../lib/inviteAck", () => ({
  appendInviteAck: vi.fn(),
}));
const setVisibleForTest = (v: boolean) => {
  visibleForTest = v;
};

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  // Reset H2 per-topic registry so cross-test handler counts don't
  // leak (each test that opts in via usePerTopicChannels gets a fresh
  // pool; tests that don't opt in fall back to the singleton mockChannel).
  perTopicChannels.length = 0;
  // Restore default joinChannel mock — vi.clearAllMocks wipes
  // mock.calls but NOT the mockImplementation set by
  // `usePerTopicChannels`. Without this restoration the per-topic
  // factory leaks into subsequent tests, breaking every test that
  // probes the singleton `mockChannel.on`.
  const socket = await import("../lib/socket");
  vi.mocked(socket.joinChannel).mockImplementation(
    () => mockChannel as unknown as ReturnType<typeof socket.joinChannel>,
  );
  // Default visibility back to true between tests so leftover state from a
  // hidden-tab test doesn't bleed into the next.
  setVisibleForTest(true);
  // Reset queryWindowsByNetwork mock implementation — vi.clearAllMocks
  // wipes call history but NOT implementation overrides set via
  // mockReturnValue in prior tests. Without this, the C4.1 "existing
  // query window" test's seeded {1: [bob]} leaks into the next test
  // and the new query-window subscribe effect (DM live-WS gap fix)
  // produces an extra unexpected join.
  const qw = await import("../lib/queryWindows");
  vi.mocked(qw.queryWindowsByNetwork).mockImplementation(() => ({}));
});

const seedStubs = async () => {
  const api = await import("../lib/api");
  vi.mocked(api.listNetworks).mockResolvedValue([
    { id: 1, slug: "freenode", nick: "alice", inserted_at: "x", updated_at: "y" },
  ]);
  vi.mocked(api.listChannels).mockResolvedValue([
    { name: "#grappa", joined: true, source: "autojoin" },
    { name: "#cicchetto", joined: true, source: "autojoin" },
  ]);
  vi.mocked(api.me).mockResolvedValue({
    kind: "user",
    id: "u1",
    name: "alice",
    is_admin: false,
    inserted_at: "x",
  });
  vi.mocked(api.listMessages).mockResolvedValue([]);
  vi.mocked(api.sendMessage).mockResolvedValue({
    id: 999,
    network: "freenode",
    channel: "#grappa",
    server_time: 999,
    kind: "privmsg",
    sender: "alice",
    body: "echo",
    meta: {},
  });
};

const fireMessageEvent = (
  channel: string,
  msg: Partial<{
    id: number;
    sender: string;
    body: string;
    server_time: number;
    kind: string;
    meta: Record<string, unknown>;
  }>,
) => {
  const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
    p: unknown,
  ) => void;
  handler({
    kind: "message",
    message: {
      id: msg.id ?? 1,
      network: "freenode",
      channel,
      server_time: msg.server_time ?? 0,
      kind: msg.kind ?? "privmsg",
      sender: msg.sender ?? "bob",
      body: msg.body ?? "hi",
      meta: msg.meta ?? {},
    },
  });
};

// Codebase review 2026-05-08 cic H2 helper. Fires an event payload by
// invoking EVERY currently-registered "event" handler (not just the
// first one as `fireMessageEvent` does). Used to detect the duplicate-
// handler-installation regression: if rotation didn't tear down the
// prior topic's Channel, both the old + new `phx.on("event", ...)`
// closures fire when the socket dispatches an event, doubling
// per-event side effects (presence delta, unread bump, mention bump).
//
// Walks the per-Channel mocks created by `makeChannelMock` (when used)
// or falls back to the legacy singleton `mockChannel.on.mock.calls`.
// Only counts handlers on Channels that haven't been `.leave()`d.
const fireMessageToAllHandlers = (
  channel: string,
  msg: Partial<{ id: number; sender: string; body: string; server_time: number; kind: string }>,
) => {
  const payload = {
    kind: "message" as const,
    message: {
      id: msg.id ?? 1,
      network: "freenode",
      channel,
      server_time: msg.server_time ?? 0,
      kind: msg.kind ?? "privmsg",
      sender: msg.sender ?? "bob",
      body: msg.body ?? "hi",
      meta: {},
    },
  };
  if (perTopicChannels.length > 0) {
    for (const c of perTopicChannels) {
      if (c.left) continue;
      for (const call of c.on.mock.calls) {
        if (call[0] !== "event") continue;
        (call[1] as (p: unknown) => void)(payload);
      }
    }
    return;
  }
  for (const call of mockChannel.on.mock.calls) {
    if (call[0] !== "event") continue;
    (call[1] as (p: unknown) => void)(payload);
  }
};

// Per-topic Channel mock factory for H2 test. Each call to
// `joinChannel(...)` produces a fresh mock that tracks its OWN handler
// list and a `.leave()` flag — modelling phoenix.js's actual behaviour
// (`socket.channel(topic)` always returns a new Channel; `.leave()`
// removes it from `socket.channels[]`). Pushed into `perTopicChannels`
// so `fireMessageToAllHandlers` can walk the LIVE set only.
type PerTopicMock = ReturnType<typeof makeChannelMock>;
const perTopicChannels: PerTopicMock[] = [];

function makeChannelMock() {
  const join = vi.fn(() => mockJoinPush);
  const on = vi.fn();
  const obj = {
    join,
    on,
    leave: vi.fn(),
    left: false,
  };
  obj.leave.mockImplementation(() => {
    obj.left = true;
  });
  return obj;
}

const usePerTopicChannels = async () => {
  const socket = await import("../lib/socket");
  vi.mocked(socket.joinChannel).mockImplementation(() => {
    const m = makeChannelMock();
    perTopicChannels.push(m);
    return m as unknown as ReturnType<typeof socket.joinChannel>;
  });
};

const loadStores = async () => {
  const networks = await import("../lib/networks");
  const scrollback = await import("../lib/scrollback");
  const selection = await import("../lib/selection");
  await import("../lib/subscribe");
  return { ...networks, ...scrollback, ...selection };
};

describe("subscribe — WS join effect", () => {
  it("joins the channel-shape topic for every channel and installs an event handler", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const socket = await import("../lib/socket");
    await loadStores();
    await vi.waitFor(() => {
      // 2 real channels + 1 DM-listener (own-nick topic) + 1 $server = 4 joins.
      expect(socket.joinChannel).toHaveBeenCalledTimes(4);
    });
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "#grappa",
      expect.any(Function),
    );
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "#cicchetto",
      expect.any(Function),
    );
    // DM-listener join uses the operator's own nick as the channel
    // segment — server broadcasts inbound PRIVMSGs on this topic.
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "alice",
      expect.any(Function),
    );
    // BUG2: server-messages loop joins the $server synthetic channel.
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "$server",
      expect.any(Function),
    );
    expect(mockChannel.on).toHaveBeenCalledWith("event", expect.any(Function));
  });

  it("incoming PRIVMSG event increments unread for non-selected channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    fireMessageEvent("#grappa", { id: 1, body: "hi" });
    expect(store.unreadCounts()[channelKey("freenode", "#grappa")]).toBe(1);
  });

  // BUG6: badge showed "2" for 1 PRIVMSG and "+2" per subsequent message.
  // Root cause: bumpMessageUnread must fire EXACTLY ONCE per incoming PRIVMSG.
  // This test asserts the split counters directly — the displayed badge is
  // messagesUnread (not the aggregate unreadCounts).
  it("BUG6: one PRIVMSG bumps messagesUnread by 1, not 2", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    const key = channelKey("freenode", "#grappa");
    fireMessageEvent("#grappa", { id: 10, body: "msg1" });
    expect(store.messagesUnread()[key]).toBe(1);
    expect(store.eventsUnread()[key]).toBeUndefined();

    fireMessageEvent("#grappa", { id: 11, body: "msg2" });
    expect(store.messagesUnread()[key]).toBe(2);
    expect(store.eventsUnread()[key]).toBeUndefined();
  });

  it("BUG6: one JOIN event bumps eventsUnread by 1, not messagesUnread", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    const key = channelKey("freenode", "#grappa");
    fireMessageEvent("#grappa", { id: 20, kind: "join", sender: "carol" });
    expect(store.eventsUnread()[key]).toBe(1);
    expect(store.messagesUnread()[key]).toBeUndefined();
  });

  // Server-numeric-derived NOTICE: routes to a window that the operator's
  // own action targeted (e.g. /msg nonexistent_nick → server replies 401
  // ERR_NOSUCHNICK, persisted as kind:"notice" with meta.numeric=401 in
  // the target's query window). The operator owns the action — same
  // semantic class as own-presence events (BUG5b). Must NOT bump unread.
  // Wire shape: `meta.numeric` is the server-side discriminator
  // (Session.Server.handle_numeric_with_routing → Wire.message_payload).
  it("server-numeric notice does NOT bump unread on the routed window", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    const key = channelKey("freenode", "#grappa");
    fireMessageEvent("#grappa", {
      id: 30,
      kind: "notice",
      sender: "raccooncity.azzurra.chat",
      body: "No such nick/channel",
      meta: { numeric: 401, severity: "error" },
    });
    expect(store.unreadCounts()[key]).toBeUndefined();
    expect(store.messagesUnread()[key]).toBeUndefined();
    expect(store.eventsUnread()[key]).toBeUndefined();
  });

  // Plain NOTICE without meta.numeric (peer-originated, e.g. NickServ
  // greeting on identify, or another user's /notice) STILL bumps unread —
  // it's a real unsolicited message, not feedback from operator action.
  it("plain notice (no meta.numeric) bumps messagesUnread", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    const key = channelKey("freenode", "#grappa");
    fireMessageEvent("#grappa", {
      id: 31,
      kind: "notice",
      sender: "NickServ",
      body: "You are now identified",
      meta: {},
    });
    expect(store.messagesUnread()[key]).toBe(1);
  });

  it("does not increment unread when the event arrives on the selected channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    store.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    fireMessageEvent("#grappa", { id: 1, body: "hi" });
    expect(store.unreadCounts()[channelKey("freenode", "#grappa")]).toBeUndefined();
  });

  // CP29 R-4 cursor-advance spec — server-owned, FORWARD-ONLY:
  //
  //   On every focused window LEAVE (selection.ts on(selectedChannel)
  //     focus-leave arm + browser-blur arm) → POST cursor advance to the
  //     server with the last visible message id. The server's typed WS
  //     `read_cursor_set` broadcast then folds the new id into the
  //     signal map on every device subscribed to the per-channel topic.
  //
  //   subscribe.ts NO LONGER advances the cursor on per-message events.
  //   The pre-CP29 own-msg-on-focused-window arm was a localStorage-era
  //   trick the new model doesn't need — selection focus-leave covers
  //   the "user has demonstrably moved on" semantic uniformly. This
  //   test asserts the LACK of that legacy behavior so a future
  //   regression that re-introduces a per-message advance fails loudly.
  it("does NOT advance the cursor when an OWN-SENT msg lands on the SELECTED window (subscribe.ts no longer originates advances)", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    store.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    const sentinel = "100";
    localStorage.setItem("rc:freenode:#grappa", sentinel);
    fireMessageEvent("#grappa", {
      id: 8,
      server_time: 300,
      body: "own echo",
      sender: "alice",
    });
    // Cursor untouched — subscribe.ts no longer writes localStorage at
    // all. The (rc: legacy key) test fixture confirms a regression that
    // re-adds a write would fail this assertion.
    expect(localStorage.getItem("rc:freenode:#grappa")).toBe(sentinel);
  });

  it("does NOT advance rc cursor when a PEER msg lands on the SELECTED window", async () => {
    // Marker-preservation spec: a peer's msg arriving on the focused
    // window must NOT clobber the read-cursor. The user is reading
    // (effective focus = true), so no badge bump — but the existing
    // marker stays put. Without this, the marker would silently
    // disappear every time a peer talked, defeating the "where was I?"
    // boundary the marker provides.
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    store.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    const sentinel = "100";
    localStorage.setItem("rc:freenode:#grappa", sentinel);
    fireMessageEvent("#grappa", {
      id: 7,
      server_time: 200,
      body: "peer talked",
      sender: "bob",
    });
    // Cursor untouched — the marker (if any) survives this peer msg.
    expect(localStorage.getItem("rc:freenode:#grappa")).toBe(sentinel);
    // Still no badge bump — user IS reading.
    const key = channelKey("freenode", "#grappa");
    expect(store.unreadCounts()[key]).toBeUndefined();
    expect(store.messagesUnread()[key]).toBeUndefined();
  });

  it("does NOT advance rc cursor when msg arrives on a NON-selected window", async () => {
    // Anti-spec guard: only the focused window's cursor moves on live
    // ingest. A msg arriving on #cicchetto while user is on #grappa
    // must leave rc:#cicchetto alone — its marker should appear when
    // the user later switches to #cicchetto.
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    store.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    localStorage.setItem("rc:freenode:#cicchetto", "100");
    fireMessageEvent("#cicchetto", {
      id: 9,
      server_time: 500,
      body: "background msg",
      sender: "bob",
    });
    expect(localStorage.getItem("rc:freenode:#cicchetto")).toBe("100");
  });

  // Effective-focus gating (browser visibility tier — unread-marker bug fix).
  //
  // Spec: "effective-focused" := isCichettoSelected AND isDocumentVisible().
  // Only effective-focused windows trigger the live-reading cursor advance
  // and skip the unread bump. A cicchetto-selected-but-browser-blurred
  // window must accumulate unread (the user is not actively reading).
  describe("isDocumentVisible gate (effective focus)", () => {
    it("selected + browser HIDDEN: incoming msg bumps unread, does NOT advance cursor", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const store = await loadStores();
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });
      // User has #grappa visually selected but Cmd-Tabbed away from the browser.
      store.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      setVisibleForTest(false);
      const sentinel = "100";
      localStorage.setItem("rc:freenode:#grappa", sentinel);

      fireMessageEvent("#grappa", {
        id: 50,
        server_time: 500,
        body: "msg while away",
        sender: "bob",
      });

      const key = channelKey("freenode", "#grappa");
      // Cursor untouched — we're not actually reading; the marker must
      // surface when the user returns to this window.
      expect(localStorage.getItem("rc:freenode:#grappa")).toBe(sentinel);
      // Unread accumulators bump (the user missed this msg).
      expect(store.unreadCounts()[key]).toBe(1);
      expect(store.messagesUnread()[key]).toBe(1);
    });

    it("selected + browser VISIBLE + OWN msg: cursor stays (CP29 R-4: subscribe.ts no longer advances)", async () => {
      // CP29 R-4 spec change: subscribe.ts no longer originates cursor
      // advances. The pre-flip own-msg-on-focused-window arm was a
      // localStorage-era trick; with the server-owned id-based cursor
      // the advance happens uniformly on focus-leave (selection.ts).
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const store = await loadStores();
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });
      store.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      setVisibleForTest(true);
      const sentinel = "100";
      localStorage.setItem("rc:freenode:#grappa", sentinel);

      fireMessageEvent("#grappa", {
        id: 51,
        server_time: 600,
        body: "live",
        sender: "alice",
      });

      // Cursor untouched — only selection.ts focus-leave / browser-blur
      // arms call `setReadCursor`.
      expect(localStorage.getItem("rc:freenode:#grappa")).toBe(sentinel);
    });

    it("selected + browser VISIBLE + PEER msg: cursor STAYS (marker preserved)", async () => {
      // The new spec: peer-msg on focused window does NOT clobber the
      // cursor. User is reading (no badge bump), but the marker boundary
      // is left intact — only own-msg or window leave clears it.
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const store = await loadStores();
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });
      store.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      setVisibleForTest(true);
      localStorage.setItem("rc:freenode:#grappa", "100");

      fireMessageEvent("#grappa", {
        id: 52,
        server_time: 700,
        body: "peer talks",
        sender: "bob",
      });

      // Cursor untouched.
      expect(localStorage.getItem("rc:freenode:#grappa")).toBe("100");
      // No badge bump — user IS reading.
      const key = channelKey("freenode", "#grappa");
      expect(store.unreadCounts()[key]).toBeUndefined();
    });
  });

  it("incoming PRIVMSG event appends to scrollbackByChannel for that channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    fireMessageEvent("#grappa", { id: 7, body: "live" });
    const key = channelKey("freenode", "#grappa");
    expect(store.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([7]);
  });

  it("two events on the same channel append in arrival order", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    fireMessageEvent("#grappa", { id: 1, server_time: 100, body: "first" });
    fireMessageEvent("#grappa", { id: 2, server_time: 200, body: "second" });
    const key = channelKey("freenode", "#grappa");
    expect(store.scrollbackByChannel()[key]?.map((m) => m.body)).toEqual(["first", "second"]);
  });

  it("duplicate id from REST + WS overlap is deduped (single entry kept)", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      {
        id: 42,
        network: "freenode",
        channel: "#grappa",
        server_time: 100,
        kind: "privmsg",
        sender: "bob",
        body: "from rest",
        meta: {},
      },
    ]);
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    fireMessageEvent("#grappa", { id: 42, server_time: 100, body: "from ws" });
    store.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    await vi.waitFor(() => {
      expect(api.listMessages).toHaveBeenCalled();
    });
    const key = channelKey("freenode", "#grappa");
    await vi.waitFor(() => {
      expect(store.scrollbackByChannel()[key]?.length).toBe(1);
    });
  });

  it("send round-trip: REST POST + WS broadcast → scrollback shows the row exactly once", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const api = await import("../lib/api");
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    await store.sendMessage("freenode", "#grappa", "echo");
    expect(api.sendMessage).toHaveBeenCalled();
    fireMessageEvent("#grappa", { id: 999, server_time: 999, body: "echo", sender: "alice" });
    const key = channelKey("freenode", "#grappa");
    expect(store.scrollbackByChannel()[key]?.length).toBe(1);
    expect(store.scrollbackByChannel()[key]?.[0]?.body).toBe("echo");
  });

  // C7 / A1: identity-transition cleanup contract — module-singleton
  // state must be cleared on token rotation/logout. Pre-A1 fix the
  // joined Set persisted, silently dropping new-identity messages.
  describe("identity-transition state cleanup", () => {
    it("token rotation A→B clears scrollback + unread + selection and re-joins channels under the new identity", async () => {
      localStorage.setItem("grappa-token", "tokA");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const auth = await import("../lib/auth");
      const socket = await import("../lib/socket");
      const store = await loadStores();

      await vi.waitFor(() => {
        // 2 channels + 1 DM-listener + 1 $server = 4.
        expect(socket.joinChannel).toHaveBeenCalledTimes(4);
      });
      expect(socket.joinChannel).toHaveBeenCalledWith(
        "alice",
        "freenode",
        "#grappa",
        expect.any(Function),
      );

      fireMessageEvent("#grappa", { id: 1, body: "as A" });
      const key = channelKey("freenode", "#grappa");
      expect(store.scrollbackByChannel()[key]?.length).toBe(1);
      expect(store.unreadCounts()[key]).toBe(1);
      store.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      expect(store.selectedChannel()).not.toBeNull();

      const api = await import("../lib/api");
      vi.mocked(api.me).mockResolvedValue({
        kind: "user",
        id: "u2",
        name: "bob",
        is_admin: false,
        inserted_at: "x",
      });
      // Bob's credential row carries its own per-network IRC nick. The
      // pre-cic-H3 code path silently accepted the leftover stub from
      // alice's seed via the displayNick(u) fallback; post-fix the
      // credential nick must reflect bob's identity for the DM-listener
      // join to use bob's nick on bob's network.
      vi.mocked(api.listNetworks).mockResolvedValue([
        { id: 1, slug: "freenode", nick: "bob", inserted_at: "x", updated_at: "y" },
      ]);
      vi.mocked(socket.joinChannel).mockClear();

      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u2", name: "bob" }),
      );
      auth.setToken("tokB");

      await vi.waitFor(() => {
        expect(store.scrollbackByChannel()[key]).toBeUndefined();
      });
      expect(store.unreadCounts()[key]).toBeUndefined();
      expect(store.selectedChannel()).toBeNull();

      // Wait for the DM-listener join under bob's own nick — it lags the
      // channel joins because user() re-fetches asynchronously. Once it
      // fires, the channel joins are guaranteed to have happened too.
      await vi.waitFor(() => {
        expect(socket.joinChannel).toHaveBeenCalledWith(
          "bob",
          "freenode",
          "bob",
          expect.any(Function),
        );
      });
      expect(socket.joinChannel).toHaveBeenCalledWith(
        "bob",
        "freenode",
        "#grappa",
        expect.any(Function),
      );
      expect(socket.joinChannel).toHaveBeenCalledWith(
        "bob",
        "freenode",
        "#cicchetto",
        expect.any(Function),
      );
    });

    // Codebase review 2026-05-08 cic H2 (HIGH).
    // Pre-fix: subscribe.ts kept channel handles in a `Set<ChannelKey>`.
    // On token rotation `joined.clear()` ran but the previously joined
    // Phoenix Channel objects survived in `socket.channels[]` (phoenix.js
    // pushes every `socket.channel(topic)` call onto the array; nothing
    // removes them). Re-running the join effect under the new identity
    // installed a fresh `phx.on("event", handler)` on a NEW Channel for
    // the same topic — the OLD Channel + its handler were never
    // `.leave()`d. Both Channels received the next event from the socket
    // dispatcher; presence/unread/mention counters doubled. N rotations =
    // N+1 handlers per channel.
    //
    // Fix: track Channel objects in `Map<ChannelKey, Channel>` and call
    // `phx.leave()` on each before clearing on rotation. Phoenix.js's
    // Channel.leave triggers `phx_close`, removing the Channel from
    // `socket.channels[]` and disabling its handlers.
    it("H2: token rotation tears down prior Channels (no duplicate event handlers)", async () => {
      localStorage.setItem("grappa-token", "tokA");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const auth = await import("../lib/auth");
      const socket = await import("../lib/socket");
      // Use per-topic Channel mocks so .leave() actually retires a
      // handler from the active set. The default singleton mockChannel
      // is not enough — it's a single object whose `.on` accumulates
      // across all `joinChannel(...)` calls.
      await usePerTopicChannels();
      const store = await loadStores();

      // Seed initial joins under tokA.
      await vi.waitFor(() => {
        expect(socket.joinChannel).toHaveBeenCalledTimes(4);
      });

      const api = await import("../lib/api");
      vi.mocked(api.me).mockResolvedValue({
        kind: "user",
        id: "u2",
        name: "bob",
        is_admin: false,
        inserted_at: "x",
      });
      // Bob's per-network IRC nick (cic H3 follow-on for the rotation
      // path — see the prior rotation test for the rationale).
      vi.mocked(api.listNetworks).mockResolvedValue([
        { id: 1, slug: "freenode", nick: "bob", inserted_at: "x", updated_at: "y" },
      ]);
      vi.mocked(socket.joinChannel).mockClear();
      // Re-install per-topic factory after mockClear (mockClear wipes
      // mockImplementation too).
      await usePerTopicChannels();

      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u2", name: "bob" }),
      );
      auth.setToken("tokB");

      // Wait for the new identity to fan out joins.
      await vi.waitFor(() => {
        expect(socket.joinChannel).toHaveBeenCalledWith(
          "bob",
          "freenode",
          "#grappa",
          expect.any(Function),
        );
      });

      // Critical assertion: when the socket dispatches a single event
      // payload to the #grappa topic, exactly ONE handler fires —
      // not the post-rotation "alice handler + bob handler" duplicate.
      // Pre-fix: 2 (one per identity, both still subscribed). Fix:
      // alice handler is `.leave()`d on rotation; only bob handler
      // remains.
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");

      const beforeUnread = selection.unreadCounts()[key] ?? 0;
      // Select something else so an inbound event will bump unread.
      store.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#cicchetto",
        kind: "channel",
      });

      fireMessageToAllHandlers("#grappa", { id: 100, body: "first-after-rotation" });

      // Single message dispatched to ALL registered "event" handlers
      // for the channel. With the fix, exactly one handler runs —
      // unread bump is +1. Pre-fix: 2 handlers run, unread bump is +2
      // (the alice-era handler + the bob-era handler).
      const afterUnread = selection.unreadCounts()[key] ?? 0;
      expect(afterUnread - beforeUnread).toBe(1);
    });

    it("PRIVMSG mentioning operator nick on non-selected channel bumps mention badge (P4-1 Task 29)", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const mentions = await import("../lib/mentions");
      const store = await loadStores();
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });

      // Selection on OTHER channel; mention arrives on #grappa.
      store.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#cicchetto",
        kind: "channel",
      });

      fireMessageEvent("#grappa", { id: 100, kind: "privmsg", body: "hey alice come look" });

      const key = channelKey("freenode", "#grappa");
      expect(mentions.bumpMention).toHaveBeenCalledWith(key);
    });

    it("PRIVMSG mentioning nick on the SELECTED channel does NOT bump mention badge", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const mentions = await import("../lib/mentions");
      const store = await loadStores();
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });

      store.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      fireMessageEvent("#grappa", { id: 101, kind: "privmsg", body: "hey alice" });

      expect(mentions.bumpMention).not.toHaveBeenCalled();
    });

    it("PRIVMSG without nick mention does NOT bump mention badge", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const mentions = await import("../lib/mentions");
      const store = await loadStores();
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });

      store.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#cicchetto",
        kind: "channel",
      });
      fireMessageEvent("#grappa", { id: 102, kind: "privmsg", body: "no mention here" });

      expect(mentions.bumpMention).not.toHaveBeenCalled();
    });

    it("dispatches presence events to members.applyPresenceEvent (P4-1 Q4)", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const members = await import("../lib/members");
      await loadStores();
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });

      fireMessageEvent("#grappa", { id: 10, kind: "join", sender: "newcomer" });
      fireMessageEvent("#grappa", { id: 11, kind: "part", sender: "newcomer" });
      fireMessageEvent("#grappa", { id: 12, kind: "quit", sender: "alice" });
      fireMessageEvent("#grappa", { id: 13, kind: "nick_change", sender: "alice" });
      fireMessageEvent("#grappa", { id: 14, kind: "mode", sender: "op" });
      fireMessageEvent("#grappa", { id: 15, kind: "kick", sender: "op" });
      fireMessageEvent("#grappa", { id: 16, kind: "privmsg", sender: "alice" });

      // applyPresenceEvent is called for ALL events; the filtering by
      // kind happens inside members.ts itself (privmsg is a no-op there).
      // Subscribe.ts dispatches every event; members.ts decides what
      // matters. Assert the call count includes the privmsg too.
      expect(members.applyPresenceEvent).toHaveBeenCalledTimes(7);
      const key = channelKey("freenode", "#grappa");
      expect(members.applyPresenceEvent).toHaveBeenCalledWith(
        key,
        expect.objectContaining({ id: 10, kind: "join" }),
      );
      expect(members.applyPresenceEvent).toHaveBeenCalledWith(
        key,
        expect.objectContaining({ id: 14, kind: "mode" }),
      );
    });

    it("logout (token → null) clears scrollback + unread + selection", async () => {
      localStorage.setItem("grappa-token", "tokA");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const auth = await import("../lib/auth");
      const store = await loadStores();

      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });

      fireMessageEvent("#grappa", { id: 1, body: "as A" });
      const key = channelKey("freenode", "#grappa");
      expect(store.scrollbackByChannel()[key]?.length).toBe(1);
      expect(store.unreadCounts()[key]).toBe(1);
      store.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });

      auth.setToken(null);

      await vi.waitFor(() => {
        expect(store.scrollbackByChannel()[key]).toBeUndefined();
      });
      expect(store.unreadCounts()[key]).toBeUndefined();
      expect(store.selectedChannel()).toBeNull();
    });
  });
});

// C4.1 — DM auto-open on incoming PRIVMSG.
//
// When an incoming PRIVMSG arrives on the own-nick channel (the server
// routes DMs to scrollback keyed by the recipient's nick), and no query
// window exists for the sender, subscribe.ts should call
// openQueryWindowState — but NOT setSelectedChannel (focus-rule: auto-
// open is focus-neutral, per spec #1).
describe("subscribe — C4.1 DM auto-open on incoming PRIVMSG", () => {
  // Helper: fire the event handler installed for the Nth channel in join order.
  const fireAtHandlerIndex = (idx: number, payload: unknown) => {
    const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
    const handler = eventCalls[idx]?.[1] as (p: unknown) => void;
    handler(payload);
  };

  // stubs: channels include "alice" (own nick) as the DM channel.
  const seedDmStubs = async () => {
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      { id: 1, slug: "freenode", nick: "alice", inserted_at: "x", updated_at: "y" },
    ]);
    // Production: own-nick is NEVER in the channels list. The
    // DM-listener loop subscribes to the own-nick topic per network
    // independently. With the new design, faking own-nick as a channel
    // would dedupe the DM-listener subscription away. Keep channels
    // realistic — one real IRC channel only.
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
  };

  it("incoming PRIVMSG to own nick from new sender opens query window; selection unchanged", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedDmStubs();
    const qw = await import("../lib/queryWindows");
    const store = await loadStores();
    await vi.waitFor(() => {
      // 1 channel (#grappa) + 1 DM-listener (alice topic) + 1 $server = 3 joins.
      expect(mockChannel.on).toHaveBeenCalledTimes(3);
    });
    // DM-listener handler is index 1 (channels-loop runs first, then
    // dm-listener loop; $server loop may run before or after — we look for
    // the handler by finding the call that fires on the alice DM topic).
    fireAtHandlerIndex(1, {
      kind: "message",
      message: {
        id: 200,
        network: "freenode",
        channel: "alice",
        server_time: 0,
        kind: "privmsg",
        sender: "bob",
        body: "hey",
        meta: {},
      },
    });
    // Query window should be opened for "bob" on network 1.
    expect(qw.openQueryWindowState).toHaveBeenCalledWith(1, "bob", expect.any(String));
    // Focus must NOT change.
    expect(store.selectedChannel()).toBeNull();
  });

  it("incoming PRIVMSG to own nick from sender with existing query window — no duplicate open; selection unchanged", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedDmStubs();
    const qw = await import("../lib/queryWindows");
    // Seed "bob" as already-open query window — adds a third
    // joinChannel call from the query-window subscribe effect. Layout:
    // 1 channel (#grappa) + 1 query window (bob) + 1 DM-listener
    // (alice topic) + 1 $server = 4 handler installs.
    vi.mocked(qw.queryWindowsByNetwork).mockReturnValue({
      1: [{ targetNick: "bob", openedAt: "2026-05-04T10:00:00Z" }],
    });
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalledTimes(4);
    });
    // DM-listener handler is index 2 (channels-loop, then query-window
    // loop, then dm-listener loop; $server may be at index 3).
    fireAtHandlerIndex(2, {
      kind: "message",
      message: {
        id: 201,
        network: "freenode",
        channel: "alice",
        server_time: 0,
        kind: "privmsg",
        sender: "bob",
        body: "hey again",
        meta: {},
      },
    });
    // openQueryWindowState still called (idempotent inside it), but
    // selection must NOT change.
    expect(store.selectedChannel()).toBeNull();
    // We do NOT assert openQueryWindowState NOT called — the production
    // code calls it; idempotency is enforced inside queryWindows.ts
    // (already tested in queryWindows.test.ts). The key invariant here
    // is focus-neutrality.
  });

  it("incoming PRIVMSG to a channel (not own nick) does NOT open query window", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedDmStubs();
    const qw = await import("../lib/queryWindows");
    await loadStores();
    await vi.waitFor(() => {
      // 1 channel + 1 DM-listener + 1 $server = 3.
      expect(mockChannel.on).toHaveBeenCalledTimes(3);
    });
    // Fire on #grappa channel (index 0) — regular channel PRIVMSG.
    fireAtHandlerIndex(0, {
      kind: "message",
      message: {
        id: 202,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "privmsg",
        sender: "bob",
        body: "hello channel",
        meta: {},
      },
    });
    expect(qw.openQueryWindowState).not.toHaveBeenCalled();
  });
});

// DM live-WS gap fix — query-window subscribe path.
//
// Bug: prior to this fix, subscribe.ts only joined topics for real
// IRC channels (channelsBySlug). DM topics — `grappa:user:<u>/network:
// <slug>/channel:<targetNick>` — were never joined, so outbound `/msg
// <nick>` echoes and incoming replies didn't appear in the query pane
// without a page reload. The fix: a second createEffect iterates over
// queryWindowsByNetwork() and joins one topic per (networkId, target-
// Nick), funneled through the SAME installHandler as the channel loop.
describe("subscribe — query-window WS subscribe (DM live-WS gap)", () => {
  // Standard channel + network stubs; query windows are seeded per-test.
  const seedQueryStubs = async () => {
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      { id: 1, slug: "freenode", nick: "alice", inserted_at: "x", updated_at: "y" },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
  };

  it("joins the channel-shape topic for every open query window targeting <targetNick>", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedQueryStubs();
    const qw = await import("../lib/queryWindows");
    vi.mocked(qw.queryWindowsByNetwork).mockReturnValue({
      1: [{ targetNick: "vjt", openedAt: "2026-05-05T10:00:00Z" }],
    });
    const socket = await import("../lib/socket");
    await loadStores();
    // 1 channel (#grappa) + 1 query window (vjt) + 1 DM-listener
    // (alice topic) + 1 $server = 4 join calls.
    await vi.waitFor(() => {
      expect(socket.joinChannel).toHaveBeenCalledTimes(4);
    });
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "#grappa",
      expect.any(Function),
    );
    // Query topic uses the targetNick as the channel-name segment —
    // matches the server-side broadcast on Topic.channel(user,
    // network_slug, target) for outbound `/msg vjt body`.
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "vjt",
      expect.any(Function),
    );
  });

  it("multiple query windows on the same network → each joined exactly once", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedQueryStubs();
    const qw = await import("../lib/queryWindows");
    vi.mocked(qw.queryWindowsByNetwork).mockReturnValue({
      1: [
        { targetNick: "vjt", openedAt: "2026-05-05T10:00:00Z" },
        { targetNick: "carol", openedAt: "2026-05-05T11:00:00Z" },
      ],
    });
    const socket = await import("../lib/socket");
    await loadStores();
    await vi.waitFor(() => {
      // 1 channel + 2 query windows + 1 DM-listener + 1 $server = 5.
      expect(socket.joinChannel).toHaveBeenCalledTimes(5);
    });
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "vjt",
      expect.any(Function),
    );
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "carol",
      expect.any(Function),
    );
  });

  it("incoming PRIVMSG on a query topic appends to the query window's scrollback", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedQueryStubs();
    const qw = await import("../lib/queryWindows");
    vi.mocked(qw.queryWindowsByNetwork).mockReturnValue({
      1: [{ targetNick: "vjt", openedAt: "2026-05-05T10:00:00Z" }],
    });
    const store = await loadStores();
    await vi.waitFor(() => {
      // 1 channel + 1 query window + 1 DM-listener + 1 $server = 4.
      expect(mockChannel.on).toHaveBeenCalledTimes(4);
    });
    // Handler index 1 is the query-window join (channels first, then
    // query windows, then DM-listener). Fire an inbound reply from vjt
    // — the topic param is "vjt" (the targetNick), so the message
    // lands at channelKey("freenode", "vjt").
    const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
    const queryHandler = eventCalls[1]?.[1] as (p: unknown) => void;
    queryHandler({
      kind: "message",
      message: {
        id: 300,
        network: "freenode",
        channel: "vjt",
        server_time: 0,
        kind: "privmsg",
        sender: "vjt",
        body: "hi back",
        meta: {},
      },
    });
    const key = channelKey("freenode", "vjt");
    expect(store.scrollbackByChannel()[key]?.map((m) => m.body)).toEqual(["hi back"]);
  });

  it("opening a NEW query window mid-session triggers a fresh join (effect reactive on queryWindowsByNetwork)", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedQueryStubs();
    // Drive reactivity through a real Solid signal underlying the
    // mock — the effect tracks function calls, so swapping the mock
    // implementation between a tracked-getter and asserting the
    // re-run mirrors the production "openQueryWindowState() pushes
    // a new entry" path. Direct mockReturnValue swaps don't notify
    // Solid because there's no signal between the mock and the effect.
    const { createSignal } = await import("solid-js");
    const [windows, setWindows] = createSignal<
      Record<number, Array<{ targetNick: string; openedAt: string }>>
    >({});
    const qw = await import("../lib/queryWindows");
    vi.mocked(qw.queryWindowsByNetwork).mockImplementation(() => windows());
    const socket = await import("../lib/socket");
    await loadStores();
    // Initially: 1 channel + 1 DM-listener (alice topic) + 1 $server, no query
    // windows → 3 joins.
    await vi.waitFor(() => {
      expect(socket.joinChannel).toHaveBeenCalledTimes(3);
    });
    // Simulate openQueryWindowState pushing "vjt" into the windows
    // signal — the production path is qw.openQueryWindowState calling
    // setQueryWindowsByNetwork, which is exactly this shape.
    setWindows({ 1: [{ targetNick: "vjt", openedAt: "2026-05-05T10:00:00Z" }] });
    await vi.waitFor(() => {
      // +1 join for the new query window (vjt).
      expect(socket.joinChannel).toHaveBeenCalledTimes(4);
    });
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "vjt",
      expect.any(Function),
    );
  });

  it("query-window join is deduped — re-render of the same window list does not re-join", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedQueryStubs();
    const { createSignal } = await import("solid-js");
    const [windows, setWindows] = createSignal<
      Record<number, Array<{ targetNick: string; openedAt: string }>>
    >({ 1: [{ targetNick: "vjt", openedAt: "2026-05-05T10:00:00Z" }] });
    const qw = await import("../lib/queryWindows");
    vi.mocked(qw.queryWindowsByNetwork).mockImplementation(() => windows());
    const socket = await import("../lib/socket");
    await loadStores();
    await vi.waitFor(() => {
      // 1 channel + 1 query window + 1 DM-listener + 1 $server = 4.
      expect(socket.joinChannel).toHaveBeenCalledTimes(4);
    });
    // Re-emit the same list (new array reference, same targetNicks) —
    // the `joined` Set must dedupe and skip the second join.
    setWindows({ 1: [{ targetNick: "vjt", openedAt: "2026-05-05T10:00:00Z" }] });
    await new Promise((r) => setTimeout(r, 10));
    expect(socket.joinChannel).toHaveBeenCalledTimes(4);
  });
});

// DM-listener — per-network own-nick topic subscription.
//
// The server persists inbound DMs (`PRIVMSG <ownNick> :body` from a
// remote sender) at `channel = ownNick`, then broadcasts on the
// own-nick topic. Without a dedicated subscription, the message is
// silently dropped (channels list never includes own-nick; query-
// windows list only catches OUTBOUND echoes). The DM-listener loop
// closes that gap by always subscribing to the own-nick topic per
// network and re-keying the append to `channelKey(slug, sender)` so
// the message appears in the conversation partner's pane.
describe("subscribe — DM-listener (own-nick topic, inbound DM re-key)", () => {
  const seedDmListenerStubs = async () => {
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      { id: 1, slug: "freenode", nick: "alice", inserted_at: "x", updated_at: "y" },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
  };

  it("subscribes to the own-nick topic per network", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedDmListenerStubs();
    const socket = await import("../lib/socket");
    await loadStores();
    await vi.waitFor(() => {
      // 1 channel + 1 DM-listener + 1 $server = 3.
      expect(socket.joinChannel).toHaveBeenCalledTimes(3);
    });
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "alice",
      expect.any(Function),
    );
  });

  it("inbound PRIVMSG on own-nick topic re-keys to sender's window scrollback", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedDmListenerStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      // 1 channel + 1 DM-listener + 1 $server = 3.
      expect(mockChannel.on).toHaveBeenCalledTimes(3);
    });
    // Handler index 1 is the DM-listener (channels first, then dm-
    // listener, then $server). Fire an inbound DM from vjt.
    const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
    const dmHandler = eventCalls[1]?.[1] as (p: unknown) => void;
    dmHandler({
      kind: "message",
      message: {
        id: 400,
        network: "freenode",
        channel: "alice",
        server_time: 0,
        kind: "privmsg",
        sender: "vjt",
        body: "hi alice",
        meta: {},
      },
    });
    // Message lands in vjt's window (NOT alice's own-nick bucket).
    const vjtKey = channelKey("freenode", "vjt");
    expect(store.scrollbackByChannel()[vjtKey]?.map((m) => m.body)).toEqual(["hi alice"]);
    // Own-nick bucket stays empty for the PRIVMSG case.
    const ownKey = channelKey("freenode", "alice");
    expect(store.scrollbackByChannel()[ownKey]).toBeUndefined();
  });

  it("inbound PRIVMSG on own-nick topic auto-opens the sender's query window", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedDmListenerStubs();
    const qw = await import("../lib/queryWindows");
    await loadStores();
    await vi.waitFor(() => {
      // 1 channel + 1 DM-listener + 1 $server = 3.
      expect(mockChannel.on).toHaveBeenCalledTimes(3);
    });
    const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
    const dmHandler = eventCalls[1]?.[1] as (p: unknown) => void;
    dmHandler({
      kind: "message",
      message: {
        id: 401,
        network: "freenode",
        channel: "alice",
        server_time: 0,
        kind: "privmsg",
        sender: "vjt",
        body: "hello",
        meta: {},
      },
    });
    expect(qw.openQueryWindowState).toHaveBeenCalledWith(1, "vjt", expect.any(String));
  });

  // CP23 cluster `code-reload`: peer-to-peer NOTICEs on the own-nick
  // topic auto-open the sender's query window — same UX as PRIVMSG.
  // The CTCP-VERSION-query visibility row is the canonical case (server
  // emits a notice with body "CTCP VERSION query → grappa <vsn>" so the
  // operator sees CTCP traffic in cic instead of silently consuming it).
  // Pre-CP23 this test asserted the opposite ("Bug A fix: NOTICE dropped")
  // — that was overcorrecting for service notices from NickServ etc.,
  // which our server actually routes to "$server", not the own-nick
  // topic. So the own-nick-topic NOTICE branch is exclusively
  // peer-to-peer DMs and should auto-open same as PRIVMSG.
  it("inbound NOTICE on own-nick topic auto-opens sender's window + appends", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedDmListenerStubs();
    const qw = await import("../lib/queryWindows");
    const store = await loadStores();
    await vi.waitFor(() => {
      // 1 channel + 1 DM-listener + 1 $server = 3.
      expect(mockChannel.on).toHaveBeenCalledTimes(3);
    });
    const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
    const dmHandler = eventCalls[1]?.[1] as (p: unknown) => void;
    // Inbound NOTICE from a peer (CTCP-VERSION-query visibility row
    // shape — sender = peer, NOT the operator's own nick).
    dmHandler({
      kind: "message",
      message: {
        id: 500,
        network: "freenode",
        channel: "alice",
        server_time: 0,
        kind: "notice",
        sender: "vjt",
        body: "CTCP VERSION query → grappa 0.1.0",
        meta: {},
      },
    });
    // Sender's query window auto-opened.
    expect(qw.openQueryWindowState).toHaveBeenCalledWith(1, "vjt", expect.any(String));
    // Body landed in sender's bucket (NOT alice's own-nick bucket).
    const vjtKey = channelKey("freenode", "vjt");
    expect(store.scrollbackByChannel()[vjtKey]?.map((m) => m.body)).toEqual([
      "CTCP VERSION query → grappa 0.1.0",
    ]);
    const ownKey = channelKey("freenode", "alice");
    expect(store.scrollbackByChannel()[ownKey]).toBeUndefined();
  });

  // Self-echo guard: own outbound NOTICEs (server fans out to the
  // own-nick topic too) MUST NOT auto-open a window with our own nick
  // as the target — that would be a self-DM phantom window. The
  // sender !== ownNick guard in installDmListenerHandler enforces this.
  it("own outbound NOTICE on own-nick topic is dropped — no auto-open", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedDmListenerStubs();
    const qw = await import("../lib/queryWindows");
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalledTimes(3);
    });
    const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
    const dmHandler = eventCalls[1]?.[1] as (p: unknown) => void;
    // sender = ownNick "alice" — this is our own outbound NOTICE
    // echoing back via fan-out. Drop silently.
    dmHandler({
      kind: "message",
      message: {
        id: 501,
        network: "freenode",
        channel: "alice",
        server_time: 0,
        kind: "notice",
        sender: "alice",
        body: "self-emitted notice echo",
        meta: {},
      },
    });
    expect(qw.openQueryWindowState).not.toHaveBeenCalled();
    const ownKey = channelKey("freenode", "alice");
    expect(store.scrollbackByChannel()[ownKey]).toBeUndefined();
  });

  it("non-PRIVMSG/action kinds (mode, join, part, quit, kick, nick_change) on own-nick topic are dropped", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedDmListenerStubs();
    const store = await loadStores();
    await vi.waitFor(() => {
      // 1 channel + 1 DM-listener + 1 $server = 3.
      expect(mockChannel.on).toHaveBeenCalledTimes(3);
    });
    const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
    const dmHandler = eventCalls[1]?.[1] as (p: unknown) => void;
    const ownKey = channelKey("freenode", "alice");
    for (const kind of ["mode", "join", "part", "quit", "kick", "nick_change", "topic"] as const) {
      dmHandler({
        kind: "message",
        message: {
          id: 501,
          network: "freenode",
          channel: "alice",
          server_time: 0,
          kind,
          sender: "server",
          body: "",
          meta: {},
        },
      });
    }
    // No event must have produced an append to any scrollback key.
    expect(store.scrollbackByChannel()[ownKey]).toBeUndefined();
  });

  // Bug B (self-msg path): PRIVMSG with sender = ownNick (self-msg via
  // `/msg alice body`) must append to the own-nick window key AND call
  // openQueryWindowState(networkId, ownNick).
  it("self-msg PRIVMSG (sender = ownNick) appends to own-nick window and opens own-nick query window", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedDmListenerStubs();
    const qw = await import("../lib/queryWindows");
    const store = await loadStores();
    await vi.waitFor(() => {
      // 1 channel + 1 DM-listener + 1 $server = 3.
      expect(mockChannel.on).toHaveBeenCalledTimes(3);
    });
    const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
    const dmHandler = eventCalls[1]?.[1] as (p: unknown) => void;
    // Operator sent `/msg alice hello yourself` — server echoes on own-nick topic.
    dmHandler({
      kind: "message",
      message: {
        id: 502,
        network: "freenode",
        channel: "alice",
        server_time: 0,
        kind: "privmsg",
        sender: "alice",
        body: "hello yourself",
        meta: {},
      },
    });
    // Must open the own-nick query window.
    expect(qw.openQueryWindowState).toHaveBeenCalledWith(1, "alice", expect.any(String));
    // Must append to own-nick key (channelKey("freenode", "alice")).
    const ownKey = channelKey("freenode", "alice");
    expect(store.scrollbackByChannel()[ownKey]?.map((m) => m.body)).toEqual(["hello yourself"]);
  });
});

// query-windows-loop own-nick dedup rule.
//
// If a query window for targetNick = ownNick exists in queryWindowsByNetwork
// (e.g. from a self-msg that auto-opened the own-nick window), the query-
// windows-loop must NOT install an extra installChannelHandler on the own-
// nick topic. The dm-listener loop is the SOLE handler for that topic.
// Installing a channel-handler would pollute the own-nick window with ALL
// traffic on that topic (NOTICEs from NickServ, PRIVMSGs from others, etc.)
// because installChannelHandler routes everything to its fixed key.
describe("subscribe — query-window loop skips own-nick topic (Bug A root cause)", () => {
  const seedOwnNickQueryStubs = async () => {
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      { id: 1, slug: "freenode", nick: "alice", inserted_at: "x", updated_at: "y" },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
  };

  it("own-nick query window does NOT cause an extra join beyond the dm-listener join", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedOwnNickQueryStubs();
    const qw = await import("../lib/queryWindows");
    // Simulate a query window for the own nick (opened via self-msg).
    vi.mocked(qw.queryWindowsByNetwork).mockReturnValue({
      1: [{ targetNick: "alice", openedAt: "2026-05-05T12:00:00Z" }],
    });
    const socket = await import("../lib/socket");
    await loadStores();
    // 1 channel + 1 DM-listener (alice) + 1 $server = 3 joins.
    // The own-nick query window must NOT add a 4th join — the dm-listener
    // already owns the alice topic.
    await vi.waitFor(() => {
      expect(socket.joinChannel).toHaveBeenCalledTimes(3);
    });
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "#grappa",
      expect.any(Function),
    );
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "alice",
      expect.any(Function),
    );
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "alice",
      "freenode",
      "$server",
      expect.any(Function),
    );
    // Exactly 3 calls — no extra join for the own-nick query window.
    expect(socket.joinChannel).toHaveBeenCalledTimes(3);
  });

  it("own-nick query window present — NOTICE on own-nick topic still dropped (no channel-handler pollution)", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedOwnNickQueryStubs();
    const qw = await import("../lib/queryWindows");
    vi.mocked(qw.queryWindowsByNetwork).mockReturnValue({
      1: [{ targetNick: "alice", openedAt: "2026-05-05T12:00:00Z" }],
    });
    const store = await loadStores();
    // 1 channel + 1 DM-listener + 1 $server = 3 handlers.
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalledTimes(3);
    });
    // Fire NOTICE on the DM-listener handler (index 1).
    const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
    const dmHandler = eventCalls[1]?.[1] as (p: unknown) => void;
    dmHandler({
      kind: "message",
      message: {
        id: 600,
        network: "freenode",
        channel: "alice",
        server_time: 0,
        kind: "notice",
        sender: "NickServ",
        body: "Password accepted.",
        meta: {},
      },
    });
    const ownKey = channelKey("freenode", "alice");
    // NOTICE must not pollute the own-nick window even when a query
    // window for alice exists.
    expect(store.scrollbackByChannel()[ownKey]).toBeUndefined();
  });
});

// DM live-WS gap — nick-clash regression.
//
// Bug: when operator's cicchetto user.name ("vjt") coincides with a query
// window targetNick ("vjt") but the IRC nick on the network is different
// ("grappa"), the query-windows-loop incorrectly skipped the join for the
// "vjt" topic (comparing targetNick against displayNick(user()) = user.name
// instead of net.nick). The DM-listener then captured the "vjt" topic with
// the wrong re-keying handler, routing messages to channelKey("freenode",
// "grappa") instead of channelKey("freenode", "vjt").
//
// Fix: use net.nick (per-network IRC nick from the credential, now included
// in GET /networks response) for the own-nick comparison in both loops.
describe("subscribe — nick-clash regression (user.name === targetNick, IRC nick differs)", () => {
  const seedNickClashStubs = async () => {
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      // net.nick = "grappa" (IRC nick) !== user.name = "vjt" (operator account).
      { id: 1, slug: "freenode", nick: "grappa", inserted_at: "x", updated_at: "y" },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    // user.name ("vjt") clashes with targetNick ("vjt") but NOT with IRC nick ("grappa").
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "vjt",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
  };

  it("joins channel:vjt via query-windows-loop even when user.name === targetNick", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem("grappa-subject", JSON.stringify({ kind: "user", id: "u1", name: "vjt" }));
    await seedNickClashStubs();
    const qw = await import("../lib/queryWindows");
    vi.mocked(qw.queryWindowsByNetwork).mockReturnValue({
      1: [{ targetNick: "vjt", openedAt: "2026-05-05T10:00:00Z" }],
    });
    const socket = await import("../lib/socket");
    await loadStores();
    // 1 channel (#grappa) + 1 query window (vjt) + 1 DM-listener (grappa IRC nick) + 1 $server = 4 joins.
    await vi.waitFor(() => {
      expect(socket.joinChannel).toHaveBeenCalledTimes(4);
    });
    // query-windows-loop must join channel:vjt (targetNick != IRC nick "grappa").
    expect(socket.joinChannel).toHaveBeenCalledWith("vjt", "freenode", "vjt", expect.any(Function));
    // DM-listener must join channel:grappa (the actual IRC nick, from net.nick).
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "vjt",
      "freenode",
      "grappa",
      expect.any(Function),
    );
    // $server loop joins $server.
    expect(socket.joinChannel).toHaveBeenCalledWith(
      "vjt",
      "freenode",
      "$server",
      expect.any(Function),
    );
  });

  it("outbound DM echo (sender=grappa, channel=vjt) lands in channelKey freenode/vjt", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem("grappa-subject", JSON.stringify({ kind: "user", id: "u1", name: "vjt" }));
    await seedNickClashStubs();
    const qw = await import("../lib/queryWindows");
    vi.mocked(qw.queryWindowsByNetwork).mockReturnValue({
      1: [{ targetNick: "vjt", openedAt: "2026-05-05T10:00:00Z" }],
    });
    const store = await loadStores();
    // 1 channel + 1 query window + 1 DM-listener + 1 $server = 4 handlers.
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalledTimes(4);
    });
    // Handler index 1 is the query-windows-loop join for "vjt".
    // Fire an outbound DM echo: server broadcasts on channel:vjt with sender=grappa.
    const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
    const queryHandler = eventCalls[1]?.[1] as (p: unknown) => void;
    queryHandler({
      kind: "message",
      message: {
        id: 700,
        network: "freenode",
        channel: "vjt",
        server_time: 0,
        kind: "privmsg",
        sender: "grappa",
        body: "E2E-CASE2-out-payload",
        meta: {},
      },
    });
    // Message must land in vjt's query window, NOT in any grappa key.
    const vjtKey = channelKey("freenode", "vjt");
    expect(store.scrollbackByChannel()[vjtKey]?.map((m) => m.body)).toEqual([
      "E2E-CASE2-out-payload",
    ]);
    // grappa key must be untouched — no re-keying happened.
    const grappaKey = channelKey("freenode", "grappa");
    expect(store.scrollbackByChannel()[grappaKey]).toBeUndefined();
  });
});

// BUG4: self-JOIN auto-focus.
//
// When the server echoes a JOIN event with sender === ownNick, the channel
// handler must call setSelectedChannel for the new channel so the user
// lands in it immediately — mirroring irssi's auto-focus on /join.
// Without this, typing /join #foo sends the user to #foo server-side but
// leaves the cicchetto UI stuck in whatever window was previously selected.
describe("subscribe — BUG4: self-JOIN auto-focus", () => {
  const seedWithNick = async (ircNick: string) => {
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      { id: 1, slug: "freenode", nick: ircNick, inserted_at: "x", updated_at: "y" },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
  };

  it("self-JOIN event auto-focuses the new channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedWithNick("alice");
    const store = await loadStores();
    await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled());

    // Fire a join event from own nick on #grappa.
    const eventHandler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
      p: unknown,
    ) => void;
    eventHandler({
      kind: "message",
      message: {
        id: 99,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "join",
        sender: "alice",
        body: null,
        meta: {},
      },
    });

    expect(store.selectedChannel()).toEqual({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
  });

  it("other-user JOIN event does NOT change selectedChannel", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedWithNick("alice");
    const store = await loadStores();
    await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled());

    const eventHandler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
      p: unknown,
    ) => void;
    eventHandler({
      kind: "message",
      message: {
        id: 100,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "join",
        sender: "bob",
        body: null,
        meta: {},
      },
    });

    // selectedChannel must remain null (no window was focused before).
    expect(store.selectedChannel()).toBeNull();
  });
});

// BUG5a: self-PART window dismiss.
//
// When the server echoes a PART event with sender === ownNick, the channel
// handler must call setSelectedChannel(null) to clear the focused window.
// Without this, the sidebar removes the channel from the list (via
// channels_changed) but the ScrollbackPane keeps showing the old channel's
// content with a blank header — a stuck ghost window.
describe("subscribe — BUG5a: self-PART window dismiss", () => {
  const seedWithNick = async (ircNick: string) => {
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      { id: 1, slug: "freenode", nick: ircNick, inserted_at: "x", updated_at: "y" },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
  };

  it("self-PART of focused channel leaves selection for close-watcher to redirect (no eager null)", async () => {
    // UX-7-C 2026-05-22: the self-PART handler previously called
    // `setSelectedChannel(null)` eagerly. That short-circuited the
    // UX-4-E close-watcher (selection.ts:317 — `if (!sel) return;`
    // bails on null), so MRU / server-fallback / home picker never
    // ran. It also nuked selection when the operator partied a
    // DIFFERENT channel than the focused one (see the next test).
    //
    // The window-dismiss intent is now wholly owned by the close-
    // watcher: own-PART → channels_changed → channelsBySlug drops
    // the channel → close-watcher fires its MRU/server/home chain.
    // This handler keeps only the `setParted(key)` projection (the
    // windowState absence semantic) — see the "own-PART fires
    // setParted" test below.
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedWithNick("alice");
    const store = await loadStores();
    await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled());

    // Pre-select the focused channel.
    store.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa", kind: "channel" });
    expect(store.selectedChannel()).not.toBeNull();

    const eventHandler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
      p: unknown,
    ) => void;
    eventHandler({
      kind: "message",
      message: {
        id: 101,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "part",
        sender: "alice",
        body: "Leaving",
        meta: {},
      },
    });

    // The handler MUST NOT eagerly null the selection. Close-watcher
    // (selection.ts) picks the next window when channelsBySlug drops
    // the channel — that path is exercised by the UX-4-Z e2e and
    // selection-redirect tests over there.
    expect(store.selectedChannel()).toEqual({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
  });

  it("self-PART of an UNFOCUSED channel leaves selection untouched (UX-7-C regression guard)", async () => {
    // UX-7-C 2026-05-22 — exact bug: operator focused on
    // `#ux4z-key-test` (a :failed pseudo-row), then types
    // `/part #bofh` (DIFFERENT channel). Pre-fix the handler
    // unconditionally setSelectedChannel(null) on every own-PART,
    // nuking the unrelated selection and dumping the operator on the
    // "select a channel below" placeholder.
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedWithNick("alice");
    const store = await loadStores();
    await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled());

    // Focus is on a DIFFERENT channel than the one being parted.
    store.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#elsewhere",
      kind: "channel",
    });

    const eventHandler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
      p: unknown,
    ) => void;
    eventHandler({
      kind: "message",
      message: {
        id: 101,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "part",
        sender: "alice",
        body: "Leaving",
        meta: {},
      },
    });

    expect(store.selectedChannel()).toEqual({
      networkSlug: "freenode",
      channelName: "#elsewhere",
      kind: "channel",
    });
  });

  it("other-user PART does NOT clear selectedChannel", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedWithNick("alice");
    const store = await loadStores();
    await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled());

    store.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa", kind: "channel" });

    const eventHandler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
      p: unknown,
    ) => void;
    eventHandler({
      kind: "message",
      message: {
        id: 102,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "part",
        sender: "bob",
        body: "cya",
        meta: {},
      },
    });

    // Selection untouched. Post-UX-7-C neither own-PART nor peer-PART
    // clears selection in subscribe.ts — the close-watcher in
    // selection.ts owns selection-redirect on close events.
    expect(store.selectedChannel()).toEqual({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
  });
});

// BUG5b: own-action events must not bump unread counters.
//
// A self-JOIN or self-PART event arriving while the channel is not selected
// must NOT increment any unread counter. Only other users' presence events
// (and PRIVMSGs from others) should bump unread. Own-sent messages and
// own-action events are already visible to the operator — they drove the
// action, so bumping unread is misleading.
describe("subscribe — BUG5b: own-action events do not bump unread", () => {
  const seedWithNick = async (ircNick: string) => {
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      { id: 1, slug: "freenode", nick: ircNick, inserted_at: "x", updated_at: "y" },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
  };

  it("self-JOIN does NOT bump unread counter for the channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedWithNick("alice");
    const store = await loadStores();
    await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled());

    const eventHandler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
      p: unknown,
    ) => void;
    eventHandler({
      kind: "message",
      message: {
        id: 103,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "join",
        sender: "alice",
        body: null,
        meta: {},
      },
    });

    const key = channelKey("freenode", "#grappa");
    expect(store.unreadCounts()[key]).toBeUndefined();
  });

  it("self-PART does NOT bump unread counter for the channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedWithNick("alice");
    const store = await loadStores();
    await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled());

    const eventHandler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
      p: unknown,
    ) => void;
    eventHandler({
      kind: "message",
      message: {
        id: 104,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "part",
        sender: "alice",
        body: "leaving",
        meta: {},
      },
    });

    const key = channelKey("freenode", "#grappa");
    expect(store.unreadCounts()[key]).toBeUndefined();
  });

  it("other-user JOIN DOES bump eventsUnread", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedWithNick("alice");
    const store = await loadStores();
    await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled());

    const eventHandler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
      p: unknown,
    ) => void;
    eventHandler({
      kind: "message",
      message: {
        id: 105,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "join",
        sender: "carol",
        body: null,
        meta: {},
      },
    });

    const key = channelKey("freenode", "#grappa");
    expect(store.unreadCounts()[key]).toBe(1);
  });

  // CP29 R-6 — coverage for the remaining presence kinds beyond join+part
  // (the cluster-original BUG5b shipped only join/part). Each iteration
  // asserts the badge gate at subscribe.ts:191 (now factored into
  // `isOwnPresenceEvent`) drops the bump for own-nick presence verbs and
  // forwards the bump for peer-nick versions of the same verb. Parameterised
  // table — adding a new presence kind here is a one-line edit, mirroring
  // the new `PRESENCE_KINDS` set in lib/ownPresenceEvent.ts.
  const PRESENCE_BUMP_CASES: Array<{ kind: "quit" | "nick_change" | "mode" | "kick" }> = [
    { kind: "quit" },
    { kind: "nick_change" },
    { kind: "mode" },
    { kind: "kick" },
  ];

  for (const { kind } of PRESENCE_BUMP_CASES) {
    it(`self-${kind} does NOT bump unread counter for the channel`, async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedWithNick("alice");
      const store = await loadStores();
      await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled());

      const eventHandler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
        p: unknown,
      ) => void;
      eventHandler({
        kind: "message",
        message: {
          id: 200,
          network: "freenode",
          channel: "#grappa",
          server_time: 0,
          kind,
          sender: "alice",
          body: null,
          meta: {},
        },
      });

      const key = channelKey("freenode", "#grappa");
      expect(store.unreadCounts()[key]).toBeUndefined();
    });

    it(`other-user ${kind} DOES bump eventsUnread`, async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedWithNick("alice");
      const store = await loadStores();
      await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled());

      const eventHandler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
        p: unknown,
      ) => void;
      eventHandler({
        kind: "message",
        message: {
          id: 201,
          network: "freenode",
          channel: "#grappa",
          server_time: 0,
          kind,
          sender: "carol",
          body: null,
          meta: {},
        },
      });

      const key = channelKey("freenode", "#grappa");
      expect(store.unreadCounts()[key]).toBe(1);
    });
  }

  // members_seeded WS event — server pushes the full sorted snapshot on
  // after_join AND on every 366 RPL_ENDOFNAMES. CP15 B5 dropped the
  // GET /members REST fetch path entirely; this is the sole bootstrap
  // surface for the members list.
  describe("members_seeded WS event", () => {
    it("seeds members directly from members_seeded payload", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      await loadStores();
      const members = await import("../lib/members");
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });

      const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
        p: unknown,
      ) => void;
      handler({
        kind: "members_seeded",
        network: "freenode",
        channel: "#grappa",
        members: [
          { nick: "vjt", modes: ["@"] },
          { nick: "alice", modes: [] },
        ],
      });

      const key = channelKey("freenode", "#grappa");
      expect(members.seedMembers).toHaveBeenCalledWith(key, [
        { nick: "vjt", modes: ["@"] },
        { nick: "alice", modes: [] },
      ]);
    });

    it("does NOT route members_seeded as a message (no scrollback append, no unread bump)", async () => {
      // Sanity: members_seeded is a control event. It must not flow through
      // routeMessage and accidentally bump unread or append a row.
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const store = await loadStores();
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });
      const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
        p: unknown,
      ) => void;
      handler({
        kind: "members_seeded",
        network: "freenode",
        channel: "#grappa",
        members: [],
      });

      const key = channelKey("freenode", "#grappa");
      expect(store.scrollbackByChannel()[key]).toBeUndefined();
      expect(store.unreadCounts()[key]).toBeUndefined();
    });
  });

  // CP15 B5 — typed window-state events: server-side apply_effects arms
  // broadcast `kind: "joined" | "join_failed" | "kicked"` on the per-
  // channel topic. `:parted` is intentionally NOT broadcast — its
  // projection is "key removed from windowStateByChannel" (the archive
  // section in Sidebar derives from it). Cic's subscribe.ts dispatches
  // each kind to the matching windowState setter; the snapshot push
  // uses byte-identical payloads so the same handler arms cover both
  // cold-WS-resubscribe (`push_window_state_if_known`) and event-time
  // broadcast paths.
  describe("window-state WS events", () => {
    it("'joined' event fires setJoined for the (slug, channel) key", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      await loadStores();
      const ws = await import("../lib/windowState");
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });
      const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
        p: unknown,
      ) => void;
      handler({
        kind: "joined",
        network: "freenode",
        channel: "#grappa",
        state: "joined",
      });
      expect(ws.setJoined).toHaveBeenCalledWith(channelKey("freenode", "#grappa"));
    });

    it("'join_failed' event fires setFailed with reason + numeric", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      await loadStores();
      const ws = await import("../lib/windowState");
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });
      const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
        p: unknown,
      ) => void;
      handler({
        kind: "join_failed",
        network: "freenode",
        channel: "#grappa",
        state: "failed",
        reason: "Cannot join channel (+i)",
        numeric: 473,
      });
      expect(ws.setFailed).toHaveBeenCalledWith(
        channelKey("freenode", "#grappa"),
        "Cannot join channel (+i)",
        473,
      );
    });

    it("'join_failed' event with null reason still fires setFailed", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      await loadStores();
      const ws = await import("../lib/windowState");
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });
      const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
        p: unknown,
      ) => void;
      handler({
        kind: "join_failed",
        network: "freenode",
        channel: "#grappa",
        state: "failed",
        reason: null,
        numeric: 471,
      });
      expect(ws.setFailed).toHaveBeenCalledWith(channelKey("freenode", "#grappa"), null, 471);
    });

    it("'kicked' event fires setKicked with by + reason", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      await loadStores();
      const ws = await import("../lib/windowState");
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });
      const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
        p: unknown,
      ) => void;
      handler({
        kind: "kicked",
        network: "freenode",
        channel: "#grappa",
        state: "kicked",
        by: "op",
        reason: "behave",
      });
      expect(ws.setKicked).toHaveBeenCalledWith(channelKey("freenode", "#grappa"), "op", "behave");
    });

    it("own-PART message fires setParted (absence is the projection)", async () => {
      // Server intentionally does NOT broadcast `kind: "parted"` — the
      // signal is the absence of the window_states entry. Cic derives
      // it from the existing :part presence message: when the operator
      // PARTs (sender === ownNick && kind === "part"), drop the
      // windowState entry. Same install site as BUG5a self-PART
      // dismiss; setParted is the projection mirror.
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      await loadStores();
      const ws = await import("../lib/windowState");
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });
      // Own-nick PART on #grappa.
      fireMessageEvent("#grappa", { id: 50, kind: "part", sender: "alice" });
      expect(ws.setParted).toHaveBeenCalledWith(channelKey("freenode", "#grappa"));
    });

    it("peer PART does NOT fire setParted (only own-PART projects to absence)", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      await loadStores();
      const ws = await import("../lib/windowState");
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });
      fireMessageEvent("#grappa", { id: 51, kind: "part", sender: "bob" });
      expect(ws.setParted).not.toHaveBeenCalled();
    });

    it("window-state events do NOT route as messages (no scrollback append, no unread)", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const store = await loadStores();
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });
      const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
        p: unknown,
      ) => void;
      handler({
        kind: "joined",
        network: "freenode",
        channel: "#grappa",
        state: "joined",
      });
      handler({
        kind: "join_failed",
        network: "freenode",
        channel: "#grappa",
        state: "failed",
        reason: "Cannot join channel (+i)",
        numeric: 473,
      });
      handler({
        kind: "kicked",
        network: "freenode",
        channel: "#grappa",
        state: "kicked",
        by: "op",
        reason: "behave",
      });
      const key = channelKey("freenode", "#grappa");
      expect(store.scrollbackByChannel()[key]).toBeUndefined();
      expect(store.unreadCounts()[key]).toBeUndefined();
    });
  });

  // P-0e + P-0f — invite-ack moved from per-channel topic to user-topic
  // (see userTopic.test.ts for the dispatch-arm coverage). The
  // per-channel handler post-P-0f drops any stray invite_ack payload
  // because `narrowChannelEvent` no longer recognizes the kind.
  describe("invite_ack WS event (per-channel surface — defensive drop post-P-0f)", () => {
    it("does NOT route invite_ack from the channel topic — narrower drops it", async () => {
      localStorage.setItem("grappa-token", "tok");
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      await seedStubs();
      const store = await loadStores();
      const inviteAck = await import("../lib/inviteAck");
      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });
      const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
        p: unknown,
      ) => void;
      handler({
        kind: "invite_ack",
        network: "freenode",
        channel: "#grappa",
        peer: "bob",
      });

      // No append — the channel-topic handler drops invite_ack post-P-0f.
      expect(inviteAck.appendInviteAck).not.toHaveBeenCalled();
      // No scrollback / unread side effects either.
      const key = channelKey("freenode", "#grappa");
      expect(store.scrollbackByChannel()[key]).toBeUndefined();
      expect(store.unreadCounts()[key]).toBeUndefined();
    });
  });
});

// CP15 B5 fix - pending-channel pre-subscribe race avoidance.
//
// The server's `record_in_flight_join/2` writes
// `window_states[ch] = :pending` and broadcasts `kind: "window_pending"`
// on the user-topic. cic's userTopic.ts dispatcher routes that into
// `setPending(channelKey(...))`, which adds a "pending" entry to
// `windowStateByChannel`. The subscribe.ts pending-loop must
// immediately joinChannel + installChannelHandler so the per-channel
// topic is subscribed BEFORE the upstream JOIN echo broadcasts.
// Otherwise Phoenix PubSub drops the broadcast (no replay to late
// subscribers) and the JOIN events never surface in the UI - the
// symptom vjt reported in production after B5 ship.
//
// CP17: origination moved from cic (compose.ts:210) to the server.
// The pre-subscribe loop is unchanged: it tracks the
// windowStateByChannel signal and re-runs on any mutation regardless
// of whether the mutation came from compose.ts (pre-CP17) or
// userTopic.ts (post-CP17). This test asserts that contract — the
// subscribe behavior is decoupled from the mutation origin.
//
// Coverage: assert that adding a pending entry to windowStateByChannel
// triggers a joinChannel call for the (slug, channel) pair.
describe("subscribe - pending-channel pre-subscribe loop (CP15 B5 fix)", () => {
  it("joins the per-channel topic when windowState transitions to pending", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const socket = await import("../lib/socket");
    const ws = await import("../lib/windowState");
    await loadStores();

    await vi.waitFor(() => {
      // Initial channels-loop joins: 2 real + 1 dm-listener + 1 $server.
      expect(socket.joinChannel).toHaveBeenCalledTimes(4);
    });

    // CP17: server's userTopic.ts dispatcher fires setPending in
    // response to a `kind: "window_pending"` event from
    // `record_in_flight_join/2`. The mock for windowState was a
    // vi.fn() returning {} above so we need to swap its implementation
    // to return a fresh map with the pending entry.
    vi.mocked(ws.windowStateByChannel).mockImplementation(() => ({
      [channelKey("freenode", "#new-room")]: "pending",
    }));
    // Force the pending-loop createEffect to re-run by writing into the
    // signal it tracks. Since we mocked the module, we need a real
    // re-render trigger - easiest is to dispatch a setPending call,
    // which the mock records but doesn't actually mutate (mock returns
    // a static map). Instead, use a different reactive trigger - the
    // pending-loop tracks token() too, but token() is stable here.
    //
    // Solid effects re-run when ANY tracked signal changes. The mock
    // function we override doesn't emit a Solid notification - the
    // signal is in mock-land, not real solid. So this test asserts
    // STATIC subscribe-on-pending-state-presence: load the module with
    // pending state already in place + verify the topic is joined.
    //
    // Re-import path: reset modules + re-mock with pending state, then
    // re-import subscribe.
    vi.resetModules();
    vi.doMock("../lib/api", () => ({
      listNetworks: vi
        .fn()
        .mockResolvedValue([
          { id: 1, slug: "freenode", nick: "alice", inserted_at: "x", updated_at: "y" },
        ]),
      listChannels: vi.fn().mockResolvedValue([]),
      listMessages: vi.fn().mockResolvedValue([]),
      sendMessage: vi.fn(),
      me: vi.fn().mockResolvedValue({
        kind: "user",
        id: "u1",
        name: "alice",
        is_admin: false,
        inserted_at: "x",
      }),
      login: vi.fn(),
      logout: vi.fn(),
      setOn401Handler: vi.fn(),
      displayNick: (me: { kind: string; name?: string }) => me.name ?? "",
      ownNickForNetwork: (
        net: { slug: string; nick?: string },
        me: { kind: "user" | "visitor"; nick?: string; network_slug?: string } | null | undefined,
      ) => {
        if (me == null) return null;
        if (me.kind === "visitor") return me.network_slug === net.slug ? (me.nick ?? null) : null;
        return net.nick && net.nick !== "" ? net.nick : null;
      },
      tagNetwork: (
        raw: {
          kind?: "user" | "visitor";
          id: number;
          slug: string;
          nick?: string;
          connection_state?: string;
        } & Record<string, unknown>,
      ) => {
        const kind = raw.kind ?? "user";
        if (kind === "visitor") {
          return {
            kind: "visitor",
            id: raw.id,
            slug: raw.slug,
            inserted_at: raw.inserted_at,
            updated_at: raw.updated_at,
          };
        }
        if (raw.nick === undefined || raw.nick === "") return null;
        return {
          kind: "user",
          ...raw,
          connection_state: raw.connection_state ?? "connected",
          connection_state_reason: raw.connection_state_reason ?? null,
          connection_state_changed_at: raw.connection_state_changed_at ?? null,
        };
      },
    }));
    vi.doMock("../lib/socket", () => ({
      joinChannel: vi.fn(() => mockChannel),
    }));
    vi.doMock("../lib/members", () => ({
      applyPresenceEvent: vi.fn(),
      seedMembers: vi.fn(),
      membersByChannel: vi.fn(() => ({})),
      seedFromTest: vi.fn(),
    }));
    vi.doMock("../lib/windowState", () => ({
      setPending: vi.fn(),
      setJoined: vi.fn(),
      setFailed: vi.fn(),
      setKicked: vi.fn(),
      setParted: vi.fn(),
      windowStateByChannel: () => ({
        [channelKey("freenode", "#new-room")]: "pending",
      }),
      windowFailureByChannel: () => ({}),
      windowKickedMetaByChannel: () => ({}),
    }));
    vi.doMock("../lib/mentions", () => ({
      bumpMention: vi.fn(),
      mentionCounts: () => ({}),
      clearMentionsForKey: vi.fn(),
    }));
    vi.doMock("../lib/queryWindows", () => ({
      openQueryWindowState: vi.fn(),
      closeQueryWindowState: vi.fn(),
      queryWindowsByNetwork: vi.fn(() => ({})),
      setQueryWindowsByNetwork: vi.fn(),
    }));
    vi.doMock("../lib/documentVisibility", () => ({
      isDocumentVisible: () => true,
    }));

    const socketFresh = await import("../lib/socket");
    await import("../lib/networks");
    await import("../lib/scrollback");
    await import("../lib/selection");
    await import("../lib/subscribe");

    await vi.waitFor(() => {
      expect(socketFresh.joinChannel).toHaveBeenCalledWith(
        "alice",
        "freenode",
        "#new-room",
        expect.any(Function),
      );
    });
  });
});

// UX-6-L (2026-05-20) — foreground push → in-app beep.
//
// `lib/beep.ts` is the audio surface. `subscribe.ts` calls
// `playBeep()` at two sites: channel mention path (after
// `bumpMention`'s gate) and DM-listener PRIVMSG/ACTION arrivals
// (call-site BEFORE `routeMessage` so DM-routing logic doesn't
// need to know about audio). Both sites are gated on
// `!isEffectivelyFocused` so a selected+visible window doesn't beep.
//
// Negative cases mirror the existing mention-bump gates so a
// regression in either path surfaces here first.
describe("subscribe — UX-6-L foreground beep wiring", () => {
  it("PRIVMSG mentioning own nick on non-selected channel calls playBeep", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const beep = await import("../lib/beep");
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });

    store.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#cicchetto",
      kind: "channel",
    });

    fireMessageEvent("#grappa", { id: 300, kind: "privmsg", body: "alice ping" });

    expect(beep.playBeep).toHaveBeenCalledTimes(1);
  });

  it("PRIVMSG without nick mention does NOT call playBeep", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const beep = await import("../lib/beep");
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });

    store.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#cicchetto",
      kind: "channel",
    });

    fireMessageEvent("#grappa", { id: 301, kind: "privmsg", body: "no mention here" });

    expect(beep.playBeep).not.toHaveBeenCalled();
  });

  it("mention on the SELECTED+VISIBLE channel does NOT call playBeep", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const beep = await import("../lib/beep");
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });

    store.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });

    fireMessageEvent("#grappa", { id: 302, kind: "privmsg", body: "alice are you here" });

    expect(beep.playBeep).not.toHaveBeenCalled();
  });

  it("presence event (join) does NOT call playBeep", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const beep = await import("../lib/beep");
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });

    store.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#cicchetto",
      kind: "channel",
    });

    fireMessageEvent("#grappa", { id: 303, kind: "join", sender: "carol", body: "" });

    expect(beep.playBeep).not.toHaveBeenCalled();
  });

  it("own outbound PRIVMSG echo does NOT call playBeep (sender === ownNick gate)", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedStubs();
    const beep = await import("../lib/beep");
    const store = await loadStores();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });

    store.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#cicchetto",
      kind: "channel",
    });

    // Own PRIVMSG echo arriving on a non-selected channel. body
    // contains own nick — mentionsUser would normally match — but
    // own-echo + own-presence guards must keep playBeep silent.
    fireMessageEvent("#grappa", {
      id: 304,
      kind: "privmsg",
      sender: "alice",
      body: "alice typed this",
    });

    expect(beep.playBeep).not.toHaveBeenCalled();
  });

  it("inbound DM via DM-listener calls playBeep (operator-targeted by definition)", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      { id: 1, slug: "freenode", nick: "alice", inserted_at: "x", updated_at: "y" },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
    const beep = await import("../lib/beep");
    const socket = await import("../lib/socket");
    await loadStores();
    // Wait for the DM-listener subscription to land. The own-nick
    // topic is the unambiguous identifier; index-into-mock-calls is
    // fragile across other tests that leak module-state into
    // windowStateByChannel / queryWindowsByNetwork (pending-channel
    // loop adds a "#new-room" subscription as a 4th join).
    await vi.waitFor(() => {
      const topics = vi.mocked(socket.joinChannel).mock.calls.map((c) => `${c[1]}/${c[2]}`);
      expect(topics).toContain("freenode/alice");
    });

    // Find the DM-listener handler by matching its joinChannel call
    // (own-nick topic = "freenode/alice"). The handler installed via
    // phx.on("event", ...) for that channel is the DM-listener.
    // Index-into-on.calls is order-dependent across the channels-loop /
    // dm-listener-loop / $server-loop, so anchor on the joinChannel
    // call order instead.
    const joinCalls = vi.mocked(socket.joinChannel).mock.calls;
    const dmJoinIdx = joinCalls.findIndex((c) => c[1] === "freenode" && c[2] === "alice");
    const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
    const dmHandler = eventCalls[dmJoinIdx]?.[1] as (p: unknown) => void;
    dmHandler({
      kind: "message",
      message: {
        id: 305,
        network: "freenode",
        channel: "alice",
        server_time: 0,
        kind: "privmsg",
        sender: "bob",
        body: "hey",
        meta: {},
      },
    });

    expect(beep.playBeep).toHaveBeenCalledTimes(1);
  });

  it("self-msg echo on DM-listener (sender === ownNick) does NOT call playBeep", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      { id: 1, slug: "freenode", nick: "alice", inserted_at: "x", updated_at: "y" },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
    const beep = await import("../lib/beep");
    const socket = await import("../lib/socket");
    await loadStores();
    await vi.waitFor(() => {
      const topics = vi.mocked(socket.joinChannel).mock.calls.map((c) => `${c[1]}/${c[2]}`);
      expect(topics).toContain("freenode/alice");
    });

    const joinCalls = vi.mocked(socket.joinChannel).mock.calls;
    const dmJoinIdx = joinCalls.findIndex((c) => c[1] === "freenode" && c[2] === "alice");
    const eventCalls = mockChannel.on.mock.calls.filter((c) => c[0] === "event");
    const dmHandler = eventCalls[dmJoinIdx]?.[1] as (p: unknown) => void;
    // Operator typed `/msg alice ...` — server echoes the self-msg on
    // the own-nick topic. Sender === ownNick: must not beep (own action).
    dmHandler({
      kind: "message",
      message: {
        id: 306,
        network: "freenode",
        channel: "alice",
        server_time: 0,
        kind: "privmsg",
        sender: "alice",
        body: "talking to myself",
        meta: {},
      },
    });

    expect(beep.playBeep).not.toHaveBeenCalled();
  });
});
