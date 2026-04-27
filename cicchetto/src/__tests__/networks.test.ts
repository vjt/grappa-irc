import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

// Boundary: mock REST (`lib/api`) + the socket helpers (`lib/socket`),
// leave Solid's reactive primitives real. The store wires resources to
// signals through createEffect/on — exercising the real reactivity is
// the point of this test.

// phoenix.js's `Channel.join()` returns a Push whose `.receive(...)`
// returns the same Push for chaining; the production code calls
// `.join().receive("error", ...).receive("timeout", ...)` (S48). The
// mock Push must mirror that chain shape so the production call site
// doesn't crash inside the test.
const mockJoinPush = {
  receive: vi.fn(),
};
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
}));

vi.mock("../lib/socket", () => ({
  joinChannel: vi.fn(() => mockChannel),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  // joined-set is module-level — vi.resetModules drops the module cache
  // so a fresh import gets a fresh Set; nothing to do here.
});

// Tests reach into both `lib/networks` (the networks/user/channels
// resources + selection signals) and `lib/scrollback` (the scrollback
// signal + load/loadMore/send verbs). Pre-A4 split the two were one
// module; importing networks transitively loads scrollback (the
// module-load chain still fires scrollback's createRoot), so bare
// `await import("../lib/networks")` calls keep their meaning.
// Tests that READ scrollback exports go through the merged-store
// helper.
const loadStore = async () => {
  const networks = await import("../lib/networks");
  const scrollback = await import("../lib/scrollback");
  return { ...networks, ...scrollback };
};

const seedStubs = async () => {
  const api = await import("../lib/api");
  vi.mocked(api.listNetworks).mockResolvedValue([
    { id: 1, slug: "freenode", inserted_at: "x", updated_at: "y" },
  ]);
  vi.mocked(api.listChannels).mockResolvedValue([{ name: "#grappa" }, { name: "#cicchetto" }]);
  vi.mocked(api.me).mockResolvedValue({ id: "u1", name: "alice", inserted_at: "x" });
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

describe("networks store", () => {
  it("populates the networks signal from GET /networks", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    const store = await loadStore();
    await vi.waitFor(() => {
      const n = store.networks();
      expect(n).toBeDefined();
      expect(n?.length).toBe(1);
    });
    expect(store.networks()?.[0]?.slug).toBe("freenode");
  });

  it("fans out GET /networks/:slug/channels per network into channelsBySlug", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    const api = await import("../lib/api");
    const store = await loadStore();
    await vi.waitFor(() => {
      const cbs = store.channelsBySlug();
      expect(cbs).toBeDefined();
      expect(cbs?.freenode).toBeDefined();
    });
    expect(api.listChannels).toHaveBeenCalledWith("tok", "freenode");
    expect(store.channelsBySlug()?.freenode?.map((c) => c.name)).toEqual(["#grappa", "#cicchetto"]);
  });

  it("joins the channel-shape topic for every channel and installs an event handler", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    const socket = await import("../lib/socket");
    await import("../lib/networks");
    await vi.waitFor(() => {
      expect(socket.joinChannel).toHaveBeenCalledTimes(2);
    });
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "#grappa");
    expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "#cicchetto");
    expect(mockChannel.on).toHaveBeenCalledWith("event", expect.any(Function));
  });

  it("incoming PRIVMSG event increments unread for non-selected channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    await import("../lib/socket");
    const store = await loadStore();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
      p: unknown,
    ) => void;
    handler({
      kind: "message",
      message: {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "privmsg",
        sender: "bob",
        body: "hi",
        meta: {},
      },
    });
    expect(store.unreadCounts()[channelKey("freenode", "#grappa")]).toBe(1);
  });

  it("does not increment unread when the event arrives on the selected channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    await import("../lib/socket");
    const store = await loadStore();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    store.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa" });
    const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
      p: unknown,
    ) => void;
    handler({
      kind: "message",
      message: {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "privmsg",
        sender: "bob",
        body: "hi",
        meta: {},
      },
    });
    expect(store.unreadCounts()[channelKey("freenode", "#grappa")]).toBeUndefined();
  });

  it("selecting a channel clears its accumulated unread count", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    await import("../lib/socket");
    const store = await loadStore();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    const handler = mockChannel.on.mock.calls.find((c) => c[0] === "event")?.[1] as (
      p: unknown,
    ) => void;
    handler({
      kind: "message",
      message: {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "privmsg",
        sender: "bob",
        body: "hi",
        meta: {},
      },
    });
    expect(store.unreadCounts()[channelKey("freenode", "#grappa")]).toBe(1);
    store.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa" });
    expect(store.unreadCounts()[channelKey("freenode", "#grappa")]).toBeUndefined();
  });

  it("incoming PRIVMSG event also appends to scrollbackByChannel for that channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    await import("../lib/socket");
    const store = await loadStore();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    fireMessageEvent("#grappa", { id: 7, body: "live" });
    const key = channelKey("freenode", "#grappa");
    expect(store.scrollbackByChannel()[key]).toBeDefined();
    expect(store.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([7]);
  });

  it("two events on the same channel append in arrival order", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    await import("../lib/socket");
    const store = await loadStore();
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
    await import("../lib/socket");
    const store = await loadStore();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    fireMessageEvent("#grappa", { id: 42, server_time: 100, body: "from ws" });
    store.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa" });
    await vi.waitFor(() => {
      expect(api.listMessages).toHaveBeenCalled();
    });
    const key = channelKey("freenode", "#grappa");
    await vi.waitFor(() => {
      expect(store.scrollbackByChannel()[key]?.length).toBe(1);
    });
  });

  it("selecting a channel fires loadInitialScrollback exactly once across re-selections", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    const api = await import("../lib/api");
    await import("../lib/socket");
    const store = await loadStore();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    store.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa" });
    await vi.waitFor(() => {
      expect(api.listMessages).toHaveBeenCalledWith("tok", "freenode", "#grappa");
    });
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    store.setSelectedChannel({ networkSlug: "freenode", channelName: "#cicchetto" });
    store.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa" });
    await vi.waitFor(() => {
      expect(api.listMessages).toHaveBeenCalledWith("tok", "freenode", "#cicchetto");
    });
    // Two unique channels = two REST fetches; re-selecting #grappa does
    // NOT trigger a third call.
    expect(api.listMessages).toHaveBeenCalledTimes(2);
  });

  it("loadInitialScrollback merges REST DESC page into ASC scrollback", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      {
        id: 3,
        network: "freenode",
        channel: "#grappa",
        server_time: 300,
        kind: "privmsg",
        sender: "carol",
        body: "newest",
        meta: {},
      },
      {
        id: 2,
        network: "freenode",
        channel: "#grappa",
        server_time: 200,
        kind: "privmsg",
        sender: "bob",
        body: "middle",
        meta: {},
      },
      {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 100,
        kind: "privmsg",
        sender: "alice",
        body: "oldest",
        meta: {},
      },
    ]);
    await import("../lib/socket");
    const store = await loadStore();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    store.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa" });
    const key = channelKey("freenode", "#grappa");
    await vi.waitFor(() => {
      expect(store.scrollbackByChannel()[key]?.length).toBe(3);
    });
    expect(store.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("loadMore fetches with before=oldest server_time and prepends older entries", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValueOnce([
      {
        id: 5,
        network: "freenode",
        channel: "#grappa",
        server_time: 500,
        kind: "privmsg",
        sender: "z",
        body: "now",
        meta: {},
      },
    ]);
    await import("../lib/socket");
    const store = await loadStore();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    store.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa" });
    const key = channelKey("freenode", "#grappa");
    await vi.waitFor(() => {
      expect(store.scrollbackByChannel()[key]?.length).toBe(1);
    });
    vi.mocked(api.listMessages).mockResolvedValueOnce([
      {
        id: 3,
        network: "freenode",
        channel: "#grappa",
        server_time: 300,
        kind: "privmsg",
        sender: "y",
        body: "older",
        meta: {},
      },
    ]);
    await store.loadMore("freenode", "#grappa");
    expect(api.listMessages).toHaveBeenLastCalledWith("tok", "freenode", "#grappa", 500);
    expect(store.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([3, 5]);
  });

  it("sendMessage POSTs to api.sendMessage with token, slug, channel, body", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    const api = await import("../lib/api");
    await import("../lib/socket");
    const store = await loadStore();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    await store.sendMessage("freenode", "#grappa", "hello world");
    expect(api.sendMessage).toHaveBeenCalledWith("tok", "freenode", "#grappa", "hello world");
  });

  it("send round-trip: REST POST + WS broadcast → scrollback shows the row exactly once", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    const api = await import("../lib/api");
    await import("../lib/socket");
    const store = await loadStore();
    await vi.waitFor(() => {
      expect(mockChannel.on).toHaveBeenCalled();
    });
    // Server is mocked to return a row with id 999; the matching WS
    // broadcast carries the same id. Both paths converge in the store.
    await store.sendMessage("freenode", "#grappa", "echo");
    expect(api.sendMessage).toHaveBeenCalled();
    fireMessageEvent("#grappa", { id: 999, server_time: 999, body: "echo", sender: "alice" });
    const key = channelKey("freenode", "#grappa");
    expect(store.scrollbackByChannel()[key]?.length).toBe(1);
    expect(store.scrollbackByChannel()[key]?.[0]?.body).toBe("echo");
  });

  // C7 / A1 (architecture review HIGH): module-singleton state must be
  // cleared on identity transitions. Pre-fix the `joined` and
  // `loadedChannels` Sets persist across token rotations and logout, so a
  // logout-then-login-as-different-user shows empty scrollback for every
  // channel (the join effect skips re-installing the WS handler because
  // `joined.has(key)` is true) AND the new user inherits the previous
  // user's scrollback (`scrollbackByChannel` keyed on slug+channel, not
  // user). Same lifecycle question as C7's S17 server-side mirror — when
  // does channel-join state get cleaned up.
  describe("identity-transition state cleanup", () => {
    it("token rotation A→B clears scrollback + unread + selection and re-joins channels under the new identity", async () => {
      localStorage.setItem("grappa-token", "tokA");
      await seedStubs();
      const auth = await import("../lib/auth");
      const socket = await import("../lib/socket");
      const store = await loadStore();

      await vi.waitFor(() => {
        expect(socket.joinChannel).toHaveBeenCalledTimes(2);
      });
      expect(socket.joinChannel).toHaveBeenCalledWith("alice", "freenode", "#grappa");

      // Populate per-channel state under user A.
      fireMessageEvent("#grappa", { id: 1, body: "as A" });
      const key = channelKey("freenode", "#grappa");
      expect(store.scrollbackByChannel()[key]?.length).toBe(1);
      expect(store.unreadCounts()[key]).toBe(1);
      store.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa" });
      expect(store.selectedChannel()).not.toBeNull();

      // /me now resolves to a different user; clear joinChannel call
      // history so the assertion below counts only post-rotation calls.
      const api = await import("../lib/api");
      vi.mocked(api.me).mockResolvedValue({ id: "u2", name: "bob", inserted_at: "x" });
      vi.mocked(socket.joinChannel).mockClear();

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

    it("logout (token → null) clears scrollback + unread + selection", async () => {
      localStorage.setItem("grappa-token", "tokA");
      await seedStubs();
      const auth = await import("../lib/auth");
      await import("../lib/socket");
      const store = await loadStore();

      await vi.waitFor(() => {
        expect(mockChannel.on).toHaveBeenCalled();
      });

      fireMessageEvent("#grappa", { id: 1, body: "as A" });
      const key = channelKey("freenode", "#grappa");
      expect(store.scrollbackByChannel()[key]?.length).toBe(1);
      expect(store.unreadCounts()[key]).toBe(1);
      store.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa" });

      auth.setToken(null);

      await vi.waitFor(() => {
        expect(store.scrollbackByChannel()[key]).toBeUndefined();
      });
      expect(store.unreadCounts()[key]).toBeUndefined();
      expect(store.selectedChannel()).toBeNull();
    });
  });
});
