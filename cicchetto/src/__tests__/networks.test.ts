import { beforeEach, describe, expect, it, vi } from "vitest";

// Boundary: mock REST (`lib/api`) + the socket helpers (`lib/socket`),
// leave Solid's reactive primitives real. The store wires resources
// through createResource — exercising the real reactivity is the
// point of these tests.
//
// Post-D3/A4 the cicchetto store is split across four modules:
//   * `lib/networks` — `/networks`, `/me`, `/networks/:slug/channels`
//     resources (this test file)
//   * `lib/scrollback` — per-channel scrollback verbs
//   * `lib/selection` — selectedChannel + unread counts
//   * `lib/subscribe` — WS join effect
// Per-module test files live alongside.

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
}));

vi.mock("../lib/socket", () => ({
  joinChannel: vi.fn(() => mockChannel),
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
  vi.mocked(api.listChannels).mockResolvedValue([{ name: "#grappa" }, { name: "#cicchetto" }]);
  vi.mocked(api.me).mockResolvedValue({ id: "u1", name: "alice", inserted_at: "x" });
  vi.mocked(api.listMessages).mockResolvedValue([]);
};

describe("networks resources", () => {
  it("populates the networks signal from GET /networks", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    const networks = await import("../lib/networks");
    await vi.waitFor(() => {
      const n = networks.networks();
      expect(n).toBeDefined();
      expect(n?.length).toBe(1);
    });
    expect(networks.networks()?.[0]?.slug).toBe("freenode");
  });

  it("fans out GET /networks/:slug/channels per network into channelsBySlug", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedStubs();
    const api = await import("../lib/api");
    const networks = await import("../lib/networks");
    await vi.waitFor(() => {
      const cbs = networks.channelsBySlug();
      expect(cbs).toBeDefined();
      expect(cbs?.freenode).toBeDefined();
    });
    expect(api.listChannels).toHaveBeenCalledWith("tok", "freenode");
    expect(networks.channelsBySlug()?.freenode?.map((c) => c.name)).toEqual([
      "#grappa",
      "#cicchetto",
    ]);
  });
});
