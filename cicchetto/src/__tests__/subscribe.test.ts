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
}));

vi.mock("../lib/socket", () => ({
  joinChannel: vi.fn(() => mockChannel),
}));

vi.mock("../lib/members", () => ({
  applyPresenceEvent: vi.fn(),
  loadMembers: vi.fn(),
  reloadMembers: vi.fn(),
  membersByChannel: vi.fn(() => ({})),
  seedFromTest: vi.fn(),
}));

vi.mock("../lib/mentions", () => ({
  bumpMention: vi.fn(),
  mentionCounts: () => ({}),
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
const setVisibleForTest = (v: boolean) => {
  visibleForTest = v;
};

beforeEach(async () => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
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
    { id: 1, slug: "freenode", inserted_at: "x", updated_at: "y" },
  ]);
  vi.mocked(api.listChannels).mockResolvedValue([
    { name: "#grappa", joined: true, source: "autojoin" },
    { name: "#cicchetto", joined: true, source: "autojoin" },
  ]);
  vi.mocked(api.me).mockResolvedValue({ kind: "user", id: "u1", name: "alice", inserted_at: "x" });
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
  msg: Partial<{ id: number; sender: string; body: string; server_time: number; kind: string }>,
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
      meta: {},
    },
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
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "#grappa");
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "#cicchetto");
    // DM-listener join uses the operator's own nick as the channel
    // segment — server broadcasts inbound PRIVMSGs on this topic.
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "alice");
    // BUG2: server-messages loop joins the $server synthetic channel.
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "$server");
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

  // Live-reading cursor advance: when a NEW msg arrives on the
  // currently-FOCUSED window, the marker should disappear by itself
  // (the user is reading it live; nothing should be unread).
  // Mechanism: subscribe.ts's routeMessage sees isSelected → advances
  // the read cursor to the new msg's server_time.
  //
  // Without this advance, the marker stays pinned at whatever older
  // server_time the user moved-on-from previously, AND new live msgs
  // pile up on top of it inflating the unread count without bound.
  // (Reported user pain: "we'll keep on increasing the number of
  // unread messages as they arrive".)
  // Cursor-advance spec (revised after the unread-marker UX fix):
  //
  //   own-msg on focused window → advance cursor (user demonstrated
  //     participation; the marker SHOULD clear).
  //   peer-msg on focused window → cursor STAYS (the user is reading,
  //     so no badge bump, but the marker should NOT disappear just
  //     because someone else spoke — the user can still scroll back to
  //     read it. Marker clears via leave-arm or own-msg only).
  //
  // This is the symmetric counterpart to the focused/blurred split:
  // marker resets on user *participation* (own-msg, leave, switch),
  // not on passive arrivals.
  it("advances rc cursor when an OWN-SENT msg lands on the SELECTED window", async () => {
    // Own-sent msg = REST POST + WS broadcast roundtrip. The WS echo
    // hits routeMessage with sender === ownNick and isSelected = true.
    // The user typed and submitted — clear the marker.
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
    localStorage.setItem("rc:freenode:#grappa", "100");
    fireMessageEvent("#grappa", {
      id: 8,
      server_time: 300,
      body: "own echo",
      sender: "alice",
    });
    expect(localStorage.getItem("rc:freenode:#grappa")).toBe("300");
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

    it("selected + browser VISIBLE + OWN msg: cursor advances (own participation)", async () => {
      // Sanity guard for the visibility AND own-msg gate combo.
      // Effective-focus + sender == ownNick → cursor advance (marker clear).
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
        id: 51,
        server_time: 600,
        body: "live",
        sender: "alice",
      });

      expect(localStorage.getItem("rc:freenode:#grappa")).toBe("600");
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
      expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "#grappa");

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
        inserted_at: "x",
      });
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
        expect(socket.joinChannel).toHaveBeenCalledWith("bob", "freenode", "bob");
      });
      expect(socket.joinChannel).toHaveBeenCalledWith("bob", "freenode", "#grappa");
      expect(socket.joinChannel).toHaveBeenCalledWith("bob", "freenode", "#cicchetto");
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
      { id: 1, slug: "freenode", inserted_at: "x", updated_at: "y" },
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
      { id: 1, slug: "freenode", inserted_at: "x", updated_at: "y" },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
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
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "#grappa");
    // Query topic uses the targetNick as the channel-name segment —
    // matches the server-side broadcast on Topic.channel(user,
    // network_slug, target) for outbound `/msg vjt body`.
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "vjt");
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
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "vjt");
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "carol");
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
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "vjt");
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
      { id: 1, slug: "freenode", inserted_at: "x", updated_at: "y" },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
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
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "alice");
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

  // Bug A fix: NOTICE/mode/join/part/quit/kick/topic/nick_change on the
  // own-nick topic must NOT append to any scrollback key. These belong
  // in the server-messages window (feature #4, deferred). The dm-listener
  // handler drops them silently until that surface lands.
  it("NOTICE on own-nick topic is dropped — no scrollback append to any key", async () => {
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
    // NOTICE from NickServ arriving on own-nick topic.
    dmHandler({
      kind: "message",
      message: {
        id: 500,
        network: "freenode",
        channel: "alice",
        server_time: 0,
        kind: "notice",
        sender: "NickServ",
        body: "This nick is registered.",
        meta: {},
      },
    });
    // Own-nick bucket must be empty — NOTICE dropped, not stored.
    const ownKey = channelKey("freenode", "alice");
    expect(store.scrollbackByChannel()[ownKey]).toBeUndefined();
    // NickServ "nick" key must also be empty — no re-key either.
    const nickServKey = channelKey("freenode", "NickServ");
    expect(store.scrollbackByChannel()[nickServKey]).toBeUndefined();
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
      { id: 1, slug: "freenode", inserted_at: "x", updated_at: "y" },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([
      { name: "#grappa", joined: true, source: "autojoin" },
    ]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "alice",
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
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "#grappa");
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "alice");
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "$server");
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
    expect(socket.joinChannel).toHaveBeenCalledWith("vjt", "freenode", "vjt");
    // DM-listener must join channel:grappa (the actual IRC nick, from net.nick).
    expect(socket.joinChannel).toHaveBeenCalledWith("vjt", "freenode", "grappa");
    // $server loop joins $server.
    expect(socket.joinChannel).toHaveBeenCalledWith("vjt", "freenode", "$server");
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
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
  };

  it("self-PART event clears selectedChannel", async () => {
    localStorage.setItem("grappa-token", "tok");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
    );
    await seedWithNick("alice");
    const store = await loadStores();
    await vi.waitFor(() => expect(mockChannel.on).toHaveBeenCalled());

    // Pre-select the channel to simulate being focused in #grappa.
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

    expect(store.selectedChannel()).toBeNull();
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

    // Still selected — only own PART clears the window.
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
  // members_seeded WS event — server's 366 RPL_ENDOFNAMES landed; client
  // must re-fetch GET /members to overwrite any empty snapshot the racing
  // initial loadMembers may have produced.
  describe("members_seeded WS event", () => {
    it("fires reloadMembers for the channel when members_seeded payload arrives", async () => {
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

      // Find the channel handler and dispatch a members_seeded payload.
      const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
        p: unknown,
      ) => void;
      handler({
        kind: "members_seeded",
        network: "freenode",
        channel: "#grappa",
      });

      expect(members.reloadMembers).toHaveBeenCalledWith("freenode", "#grappa");
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
      });

      const key = channelKey("freenode", "#grappa");
      expect(store.scrollbackByChannel()[key]).toBeUndefined();
      expect(store.unreadCounts()[key]).toBeUndefined();
    });
  });
});
