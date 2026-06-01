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

vi.mock("../lib/api", async () => {
  // tagNetwork is NOT mocked — it's a pure boundary function and the
  // tests rely on its real behavior to promote raw wire shapes to the
  // discriminated Network union before the lib/networks resource
  // surfaces them. Mocking it would short-circuit the H4 contract
  // these tests actually want to pin.
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    listNetworks: vi.fn(),
    listChannels: vi.fn(),
    listMessages: vi.fn(),
    sendMessage: vi.fn(),
    me: vi.fn(),
    login: vi.fn(),
    logout: vi.fn(),
    setOn401Handler: vi.fn(),
    tagNetwork: actual.tagNetwork,
  };
});

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
    {
      id: 1,
      slug: "freenode",
      nick: "alice",
      connection_state: "connected",
      connection_state_reason: null,
      connection_state_changed_at: null,
      inserted_at: "x",
      updated_at: "y",
    },
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

  it("exports refetchChannels as a function", async () => {
    const networks = await import("../lib/networks");
    expect(typeof networks.refetchChannels).toBe("function");
  });

  // BUG1-FIX: mutateNetworkNick patches the nick for one network in-place.
  it("mutateNetworkNick updates the nick for a matching network id", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      {
        id: 7,
        slug: "libera",
        nick: "grappa",
        connection_state: "connected",
        connection_state_reason: null,
        connection_state_changed_at: null,
        inserted_at: "x",
        updated_at: "y",
      },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "vjt",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
    const networks = await import("../lib/networks");
    // Wait for the resource to resolve.
    await vi.waitFor(() => {
      const n = networks.networks();
      expect(n?.length).toBe(1);
    });
    // Confirm initial nick from REST. Narrow on kind: post-bucket-F H4
    // Network is a discriminated union and `.nick` is only on UserNetwork.
    const initial = networks.networks()?.[0];
    expect(initial?.kind).toBe("user");
    if (initial?.kind === "user") expect(initial.nick).toBe("grappa");
    // Simulate own_nick_changed broadcast updating the live nick.
    networks.mutateNetworkNick(7, "vjt-grappa");
    const updated = networks.networks()?.[0];
    expect(updated?.kind).toBe("user");
    if (updated?.kind === "user") expect(updated.nick).toBe("vjt-grappa");
  });

  it("mutateNetworkNick is a no-op for unknown network ids", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listNetworks).mockResolvedValue([
      {
        id: 7,
        slug: "libera",
        nick: "grappa",
        connection_state: "connected",
        connection_state_reason: null,
        connection_state_changed_at: null,
        inserted_at: "x",
        updated_at: "y",
      },
    ]);
    vi.mocked(api.listChannels).mockResolvedValue([]);
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u1",
      name: "vjt",
      is_admin: false,
      inserted_at: "x",
    });
    vi.mocked(api.listMessages).mockResolvedValue([]);
    const networks = await import("../lib/networks");
    await vi.waitFor(() => expect(networks.networks()?.length).toBe(1));
    // Wrong id — should be a no-op.
    networks.mutateNetworkNick(999, "should-not-appear");
    const out = networks.networks()?.[0];
    expect(out?.kind).toBe("user");
    if (out?.kind === "user") expect(out.nick).toBe("grappa");
  });

  // bnd-A2: slug→id / slug→Network helpers backed by createMemo Map.
  // Replaces 14× `networks()?.find((n) => n.slug === slug)?.id` literal
  // duplicates across compose.ts. Memo recomputes when networks() updates,
  // so post-/connect new entries are findable without manual invalidation.
  describe("networkBySlug / networkIdBySlug", () => {
    it("networkIdBySlug returns the id for a known slug", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listNetworks).mockResolvedValue([
        {
          id: 1,
          slug: "freenode",
          nick: "vjt",
          connection_state: "connected",
          connection_state_reason: null,
          connection_state_changed_at: null,
          inserted_at: "x",
          updated_at: "y",
        },
        {
          id: 2,
          slug: "libera",
          nick: "vjt",
          connection_state: "connected",
          connection_state_reason: null,
          connection_state_changed_at: null,
          inserted_at: "x",
          updated_at: "y",
        },
      ]);
      vi.mocked(api.listChannels).mockResolvedValue([]);
      vi.mocked(api.me).mockResolvedValue({
        kind: "user",
        id: "u1",
        name: "vjt",
        is_admin: false,
        inserted_at: "x",
      });
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const networks = await import("../lib/networks");
      await vi.waitFor(() => expect(networks.networks()?.length).toBe(2));
      expect(networks.networkIdBySlug("freenode")).toBe(1);
      expect(networks.networkIdBySlug("libera")).toBe(2);
    });

    it("networkIdBySlug returns undefined for an unknown slug", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listNetworks).mockResolvedValue([
        {
          id: 1,
          slug: "freenode",
          nick: "vjt",
          connection_state: "connected",
          connection_state_reason: null,
          connection_state_changed_at: null,
          inserted_at: "x",
          updated_at: "y",
        },
      ]);
      vi.mocked(api.listChannels).mockResolvedValue([]);
      vi.mocked(api.me).mockResolvedValue({
        kind: "user",
        id: "u1",
        name: "vjt",
        is_admin: false,
        inserted_at: "x",
      });
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const networks = await import("../lib/networks");
      await vi.waitFor(() => expect(networks.networks()?.length).toBe(1));
      expect(networks.networkIdBySlug("nonexistent")).toBeUndefined();
    });

    it("networkIdBySlug returns undefined before the resource has resolved", async () => {
      // No token set — resource yields []. Lookup must be undefined,
      // matching the pre-helper `networks()?.find(...)?.id` behavior.
      const networks = await import("../lib/networks");
      expect(networks.networkIdBySlug("anything")).toBeUndefined();
    });

    it("networkBySlug returns the full Network record for a known slug", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listNetworks).mockResolvedValue([
        {
          id: 7,
          slug: "libera",
          nick: "grappa",
          connection_state: "connected",
          connection_state_reason: null,
          connection_state_changed_at: null,
          inserted_at: "x",
          updated_at: "y",
        },
      ]);
      vi.mocked(api.listChannels).mockResolvedValue([]);
      vi.mocked(api.me).mockResolvedValue({
        kind: "user",
        id: "u1",
        name: "vjt",
        is_admin: false,
        inserted_at: "x",
      });
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const networks = await import("../lib/networks");
      await vi.waitFor(() => expect(networks.networks()?.length).toBe(1));
      const n = networks.networkBySlug("libera");
      expect(n).toBeDefined();
      expect(n?.id).toBe(7);
      expect(n?.kind).toBe("user");
      if (n?.kind === "user") expect(n.nick).toBe("grappa");
    });

    it("networkBySlug returns undefined for an unknown slug", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listNetworks).mockResolvedValue([
        {
          id: 1,
          slug: "freenode",
          nick: "vjt",
          connection_state: "connected",
          connection_state_reason: null,
          connection_state_changed_at: null,
          inserted_at: "x",
          updated_at: "y",
        },
      ]);
      vi.mocked(api.listChannels).mockResolvedValue([]);
      vi.mocked(api.me).mockResolvedValue({
        kind: "user",
        id: "u1",
        name: "vjt",
        is_admin: false,
        inserted_at: "x",
      });
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const networks = await import("../lib/networks");
      await vi.waitFor(() => expect(networks.networks()?.length).toBe(1));
      expect(networks.networkBySlug("nope")).toBeUndefined();
    });

    it("lookups reflect mutations to the networks resource", async () => {
      // Reactivity: the memo backs the lookup, so a mutateNetworkNick
      // call (in-place patch of the networks list) leaves slug→id stable
      // but the returned record's nick reflects the update.
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listNetworks).mockResolvedValue([
        {
          id: 7,
          slug: "libera",
          nick: "grappa",
          connection_state: "connected",
          connection_state_reason: null,
          connection_state_changed_at: null,
          inserted_at: "x",
          updated_at: "y",
        },
      ]);
      vi.mocked(api.listChannels).mockResolvedValue([]);
      vi.mocked(api.me).mockResolvedValue({
        kind: "user",
        id: "u1",
        name: "vjt",
        is_admin: false,
        inserted_at: "x",
      });
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const networks = await import("../lib/networks");
      await vi.waitFor(() => expect(networks.networks()?.length).toBe(1));
      const before = networks.networkBySlug("libera");
      if (before?.kind === "user") expect(before.nick).toBe("grappa");
      networks.mutateNetworkNick(7, "vjt-grappa");
      const after = networks.networkBySlug("libera");
      if (after?.kind === "user") expect(after.nick).toBe("vjt-grappa");
      // Slug→id stays intact across the mutation.
      expect(networks.networkIdBySlug("libera")).toBe(7);
    });
  });

  // Bucket C (2026-06-01) — /me carries an `unread_counts` envelope
  // alongside `read_cursors`. The networks resource's /me arm primes
  // selection.ts's `serverSeedCounts` so cold-load sidebar badges
  // render the right messages/events split for cursored channels the
  // user hasn't focused yet in this session.
  describe("/me unread_counts envelope", () => {
    it("hydrates selection.serverSeedCounts from m.unread_counts at login", async () => {
      const { channelKey } = await import("../lib/channelKey");
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listNetworks).mockResolvedValue([
        {
          id: 1,
          slug: "freenode",
          nick: "vjt",
          connection_state: "connected",
          connection_state_reason: null,
          connection_state_changed_at: null,
          inserted_at: "x",
          updated_at: "y",
        },
      ]);
      vi.mocked(api.listChannels).mockResolvedValue([]);
      vi.mocked(api.me).mockResolvedValue({
        kind: "user",
        id: "u1",
        name: "vjt",
        is_admin: false,
        inserted_at: "x",
        read_cursors: { freenode: { "#grappa": 42 } },
        unread_counts: {
          freenode: {
            "#grappa": { messages: 5, events: 2 },
          },
        },
      });
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const networks = await import("../lib/networks");
      const selection = await import("../lib/selection");
      await vi.waitFor(() => expect(networks.user()).toBeDefined());

      const key = channelKey("freenode", "#grappa");
      expect(selection.messagesUnread()[key]).toBe(5);
      expect(selection.eventsUnread()[key]).toBe(2);
      expect(selection.unreadCounts()[key]).toBe(7);
    });

    it("omits the seed entirely when /me has no unread_counts field (older server)", async () => {
      const { channelKey } = await import("../lib/channelKey");
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listNetworks).mockResolvedValue([]);
      vi.mocked(api.listChannels).mockResolvedValue([]);
      vi.mocked(api.me).mockResolvedValue({
        kind: "user",
        id: "u1",
        name: "vjt",
        is_admin: false,
        inserted_at: "x",
        // No unread_counts — applySeedEnvelope({}) clears the map.
      });
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const networks = await import("../lib/networks");
      const selection = await import("../lib/selection");
      await vi.waitFor(() => expect(networks.user()).toBeDefined());

      // No keys hydrated when server omits the field.
      expect(selection.messagesUnread()[channelKey("freenode", "#grappa")]).toBeUndefined();
      expect(selection.eventsUnread()[channelKey("freenode", "#grappa")]).toBeUndefined();
    });
  });
});
