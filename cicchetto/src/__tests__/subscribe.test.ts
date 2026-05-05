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
  membersByChannel: vi.fn(() => ({})),
  seedFromTest: vi.fn(),
}));

vi.mock("../lib/mentions", () => ({
  bumpMention: vi.fn(),
  mentionCounts: () => ({}),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
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
      expect(socket.joinChannel).toHaveBeenCalledTimes(2);
    });
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "#grappa");
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "#cicchetto");
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
        expect(socket.joinChannel).toHaveBeenCalledTimes(2);
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

      await vi.waitFor(() => {
        expect(socket.joinChannel).toHaveBeenCalledTimes(2);
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
