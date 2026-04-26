import { beforeEach, describe, expect, it, vi } from "vitest";

// Boundary: mock REST (`lib/api`) + the socket helpers (`lib/socket`),
// leave Solid's reactive primitives real. The store wires resources to
// signals through createEffect/on — exercising the real reactivity is
// the point of this test.

const mockChannel = {
  join: vi.fn(),
  on: vi.fn(),
  leave: vi.fn(),
};

vi.mock("../lib/api", () => ({
  listNetworks: vi.fn(),
  listChannels: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("../lib/socket", () => ({
  joinChannel: vi.fn(() => mockChannel),
  joinNetwork: vi.fn(() => mockChannel),
  joinUser: vi.fn(() => mockChannel),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  // joined-set is module-level — vi.resetModules drops the module cache
  // so a fresh import gets a fresh Set; nothing to do here.
});

const seedStubs = async () => {
  const api = await import("../lib/api");
  vi.mocked(api.listNetworks).mockResolvedValue([
    { id: 1, slug: "freenode", inserted_at: "x", updated_at: "y" },
  ]);
  vi.mocked(api.listChannels).mockResolvedValue([{ name: "#grappa" }, { name: "#cicchetto" }]);
  vi.mocked(api.me).mockResolvedValue({ id: "u1", name: "alice", inserted_at: "x" });
};

describe("networks store", () => {
  it("populates the networks signal from GET /networks", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    const store = await import("../lib/networks");
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
    const store = await import("../lib/networks");
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
    const store = await import("../lib/networks");
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
    expect(store.unreadCounts()[store.channelKey("freenode", "#grappa")]).toBe(1);
  });

  it("does not increment unread when the event arrives on the selected channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    await import("../lib/socket");
    const store = await import("../lib/networks");
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
    expect(store.unreadCounts()[store.channelKey("freenode", "#grappa")]).toBeUndefined();
  });

  it("selecting a channel clears its accumulated unread count", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    await import("../lib/socket");
    const store = await import("../lib/networks");
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
    expect(store.unreadCounts()[store.channelKey("freenode", "#grappa")]).toBe(1);
    store.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa" });
    expect(store.unreadCounts()[store.channelKey("freenode", "#grappa")]).toBeUndefined();
  });
});
