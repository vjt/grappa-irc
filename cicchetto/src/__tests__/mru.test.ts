import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

// UX-4 bucket E — MRU store unit tests.
//
// Boundary: mock `api` so re-importing the chain (auth → networks →
// mru) doesn't pull network. mru.ts subscribes to `networks()` for the
// slug-prune effect; a resolved-empty networks list keeps the prune
// reactive without crashing the createResource chain. `me` is mocked
// because networks.ts gates its fetch on user().

vi.mock(import("../lib/api"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listNetworks: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue({}),
    listMessages: vi.fn(),
    sendMessage: vi.fn(),
    me: vi.fn().mockResolvedValue({
      kind: "user",
      id: "u-test",
      name: "alice",
      is_admin: false,
      inserted_at: "2026-01-01T00:00:00Z",
      read_cursors: {},
    }),
    login: vi.fn(),
    logout: vi.fn(),
    setOn401Handler: vi.fn(),
  };
});

vi.mock("../lib/readCursor", () => ({
  setReadCursor: vi.fn().mockResolvedValue(undefined),
  applyMeEnvelope: vi.fn(),
  applyJoinReply: vi.fn(),
  applyReadCursorSet: vi.fn(),
  getReadCursor: vi.fn(() => null),
  clearReadCursors: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("mru store", () => {
  it("recordFocus appends to front for a single key", async () => {
    localStorage.setItem("grappa-token", "tok");
    const mru = await import("../lib/mru");
    const k = channelKey("freenode", "#grappa");
    mru.recordFocus(k);
    expect(mru.mru()).toEqual([k]);
  });

  it("recordFocus dedup-pushes — re-focus moves to front", async () => {
    localStorage.setItem("grappa-token", "tok");
    const mru = await import("../lib/mru");
    const a = channelKey("freenode", "#grappa");
    const b = channelKey("freenode", "#cicchetto");
    const c = channelKey("freenode", "#italia");
    mru.recordFocus(a);
    mru.recordFocus(b);
    mru.recordFocus(c);
    expect(mru.mru()).toEqual([c, b, a]);
    mru.recordFocus(a);
    expect(mru.mru()).toEqual([a, c, b]);
  });

  it("recordFocus evicts oldest at MRU_MAX = 32", async () => {
    localStorage.setItem("grappa-token", "tok");
    const mru = await import("../lib/mru");
    const keys = Array.from({ length: 40 }, (_, i) => channelKey("net", `#chan${i}`));
    for (const k of keys) mru.recordFocus(k);
    const list = mru.mru();
    expect(list.length).toBe(32);
    // Most recent first; the oldest 8 should be gone.
    expect(list[0]).toBe(keys[39]);
    expect(list[31]).toBe(keys[8]);
    expect(list).not.toContain(keys[0]);
  });

  it("evictFromMru drops a specific key", async () => {
    localStorage.setItem("grappa-token", "tok");
    const mru = await import("../lib/mru");
    const a = channelKey("freenode", "#a");
    const b = channelKey("freenode", "#b");
    const c = channelKey("freenode", "#c");
    mru.recordFocus(a);
    mru.recordFocus(b);
    mru.recordFocus(c);
    mru.evictFromMru(b);
    expect(mru.mru()).toEqual([c, a]);
  });

  it("evictFromMru on absent key is a no-op", async () => {
    localStorage.setItem("grappa-token", "tok");
    const mru = await import("../lib/mru");
    const a = channelKey("freenode", "#a");
    mru.recordFocus(a);
    const before = mru.mru();
    mru.evictFromMru(channelKey("freenode", "#missing"));
    expect(mru.mru()).toBe(before);
  });

  it("token rotation clears MRU", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const mru = await import("../lib/mru");
    const k = channelKey("freenode", "#grappa");
    mru.recordFocus(k);
    expect(mru.mru()).toEqual([k]);
    auth.setToken("tokB");
    await vi.waitFor(() => {
      expect(mru.mru()).toEqual([]);
    });
  });

  it("logout clears MRU", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const mru = await import("../lib/mru");
    const k = channelKey("freenode", "#grappa");
    mru.recordFocus(k);
    auth.setToken(null);
    await vi.waitFor(() => {
      expect(mru.mru()).toEqual([]);
    });
  });

  describe("pickLiveMru", () => {
    it("returns the most-recent entry passing the isLive predicate", async () => {
      localStorage.setItem("grappa-token", "tok");
      const mru = await import("../lib/mru");
      const a = channelKey("freenode", "#a");
      const b = channelKey("freenode", "#b");
      const c = channelKey("freenode", "#c");
      mru.recordFocus(a);
      mru.recordFocus(b);
      mru.recordFocus(c);
      expect(mru.pickLiveMru(null, () => true)).toBe(c);
    });

    it("skips entries matching the exclude key", async () => {
      localStorage.setItem("grappa-token", "tok");
      const mru = await import("../lib/mru");
      const a = channelKey("freenode", "#a");
      const b = channelKey("freenode", "#b");
      mru.recordFocus(a);
      mru.recordFocus(b);
      expect(mru.pickLiveMru(b, () => true)).toBe(a);
    });

    it("skips entries failing the isLive predicate", async () => {
      localStorage.setItem("grappa-token", "tok");
      const mru = await import("../lib/mru");
      const a = channelKey("freenode", "#a");
      const b = channelKey("freenode", "#dead");
      const c = channelKey("freenode", "#c");
      mru.recordFocus(a);
      mru.recordFocus(b);
      mru.recordFocus(c);
      const isLive = (k: string) => k !== b;
      expect(mru.pickLiveMru(null, isLive)).toBe(c);
      // After removing c via predicate: b is excluded → a wins.
      const isLive2 = (k: string) => k !== c && k !== b;
      expect(mru.pickLiveMru(null, isLive2)).toBe(a);
    });

    it("returns null when no entry qualifies", async () => {
      localStorage.setItem("grappa-token", "tok");
      const mru = await import("../lib/mru");
      const a = channelKey("freenode", "#a");
      mru.recordFocus(a);
      expect(mru.pickLiveMru(a, () => true)).toBeNull();
      expect(mru.pickLiveMru(null, () => false)).toBeNull();
    });

    it("returns null on an empty MRU", async () => {
      localStorage.setItem("grappa-token", "tok");
      const mru = await import("../lib/mru");
      expect(mru.pickLiveMru(null, () => true)).toBeNull();
    });
  });

  describe("slug-prune on networks() change", () => {
    it("prunes entries whose slug is no longer in networks()", async () => {
      // Initial fetch: two networks. Refetch: one is gone (DELETE
      // /networks). MRU entries under the deleted slug must drop.
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listNetworks)
        .mockResolvedValueOnce([
          {
            kind: "user",
            id: 1,
            slug: "freenode",
            nick: "alice",
            connection_state: "connected",
            connection_state_reason: null,
            connection_state_changed_at: null,
            inserted_at: "",
            updated_at: "",
          },
          {
            kind: "user",
            id: 2,
            slug: "azzurra",
            nick: "alice",
            connection_state: "connected",
            connection_state_reason: null,
            connection_state_changed_at: null,
            inserted_at: "",
            updated_at: "",
          },
        ])
        .mockResolvedValueOnce([
          {
            kind: "user",
            id: 1,
            slug: "freenode",
            nick: "alice",
            connection_state: "connected",
            connection_state_reason: null,
            connection_state_changed_at: null,
            inserted_at: "",
            updated_at: "",
          },
        ]);
      const auth = await import("../lib/auth");
      const networks = await import("../lib/networks");
      const mru = await import("../lib/mru");
      auth.setToken("tokPrune");
      await vi.waitFor(() => {
        expect(networks.networks()?.length).toBe(2);
      });
      const liveKey = channelKey("freenode", "#a");
      const deadKey = channelKey("azzurra", "#b");
      mru.recordFocus(liveKey);
      mru.recordFocus(deadKey);
      expect(mru.mru()).toEqual([deadKey, liveKey]);

      networks.refetchNetworks();
      await vi.waitFor(() => {
        expect(networks.networks()?.length).toBe(1);
      });
      await vi.waitFor(() => {
        expect(mru.mru()).toEqual([liveKey]);
      });
    });
  });
});
