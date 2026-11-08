import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

const mockListCommonChannels = vi.fn(
  (_token: string, _slug: string, _nick: string): Promise<string[]> => Promise.resolve([]),
);
vi.mock("../lib/api", () => ({
  listCommonChannels: (...args: [string, string, string]) => mockListCommonChannels(...args),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

// Issue 2449 — common channels with the query peer (M2 hybrid: local
// derivation from membersByChannel + REST fetch as the readiness gate).
//
// The store modules are imported FRESH per test (vi.resetModules +
// dynamic import, the members.test.ts shape): identityScopedStore
// singletons persist across tests in one file otherwise, and a joined
// channel / fetched snapshot from one test would leak into the next.

const msg = (
  kind: ScrollbackMessage["kind"],
  sender: string,
  meta: Record<string, unknown> = {},
): ScrollbackMessage => ({
  id: 1,
  network: "freenode",
  channel: "#grappa",
  server_time: 0,
  kind,
  sender,
  body: null,
  meta,
});

describe("commonChannels.deriveCommonChannels", () => {
  it("returns joined channels whose seeded list holds the peer", async () => {
    const members = await import("../lib/members");
    const windowState = await import("../lib/windowState");
    const { deriveCommonChannels } = await import("../lib/commonChannels");

    windowState.setJoined(channelKey("freenode", "#grappa"));
    windowState.setJoined(channelKey("freenode", "#sbiffo"));
    members.seedFromTest(channelKey("freenode", "#grappa"), [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);
    members.seedFromTest(channelKey("freenode", "#sbiffo"), [{ nick: "bob", modes: [] }]);

    expect(deriveCommonChannels("freenode", "alice")).toEqual(["#grappa"]);
    expect(deriveCommonChannels("freenode", "bob")).toEqual(["#sbiffo"]);
    expect(deriveCommonChannels("freenode", "vjt")).toEqual(["#grappa"]);
  });

  it("excludes a joined channel whose list does not hold the peer", async () => {
    const members = await import("../lib/members");
    const windowState = await import("../lib/windowState");
    const { deriveCommonChannels } = await import("../lib/commonChannels");

    windowState.setJoined(channelKey("freenode", "#grappa"));
    members.seedFromTest(channelKey("freenode", "#grappa"), [{ nick: "bob", modes: [] }]);

    expect(deriveCommonChannels("freenode", "alice")).toEqual([]);
  });

  it("excludes a non-joined channel even when the peer is a member there", async () => {
    const members = await import("../lib/members");
    const { deriveCommonChannels } = await import("../lib/commonChannels");

    // #sbiffo seeded but never setJoined — e.g. a window the operator
    // parted, or an autojoin channel not joined yet.
    members.seedFromTest(channelKey("freenode", "#sbiffo"), [{ nick: "alice", modes: [] }]);

    expect(deriveCommonChannels("freenode", "alice")).toEqual([]);
  });

  it("skips a joined channel with no seeded member list (cold start)", async () => {
    const windowState = await import("../lib/windowState");
    const { deriveCommonChannels } = await import("../lib/commonChannels");

    windowState.setJoined(channelKey("freenode", "#grappa"));

    // Joined but pre-NAMES: the server has not seeded the list yet, so
    // locally "peer absent" and "list not loaded yet" are the same
    // empty read. The derivation must not count it — the REST fetch
    // is what answers for unseeded channels (see commonChannelsForPeer).
    expect(deriveCommonChannels("freenode", "alice")).toEqual([]);
  });

  it("matches case-insensitively under the network casemapping", async () => {
    const members = await import("../lib/members");
    const windowState = await import("../lib/windowState");
    const { deriveCommonChannels } = await import("../lib/commonChannels");

    windowState.setJoined(channelKey("freenode", "#grappa"));
    members.seedFromTest(channelKey("freenode", "#grappa"), [{ nick: "ALICE", modes: [] }]);

    expect(deriveCommonChannels("freenode", "alice")).toEqual(["#grappa"]);
  });

  it("sorts the answer like the server does", async () => {
    const members = await import("../lib/members");
    const windowState = await import("../lib/windowState");
    const { deriveCommonChannels } = await import("../lib/commonChannels");

    windowState.setJoined(channelKey("freenode", "#zeta"));
    windowState.setJoined(channelKey("freenode", "#alpha"));
    members.seedFromTest(channelKey("freenode", "#zeta"), [{ nick: "alice", modes: [] }]);
    members.seedFromTest(channelKey("freenode", "#alpha"), [{ nick: "alice", modes: [] }]);

    expect(deriveCommonChannels("freenode", "alice")).toEqual(["#alpha", "#zeta"]);
  });

  it("updates live on all five presence kinds via applyPresenceEvent", async () => {
    const members = await import("../lib/members");
    const windowState = await import("../lib/windowState");
    const { deriveCommonChannels } = await import("../lib/commonChannels");
    const key = channelKey("freenode", "#grappa");

    windowState.setJoined(key);
    members.seedFromTest(key, [{ nick: "vjt", modes: ["@"] }]);

    members.applyPresenceEvent(key, msg("join", "alice"), "ascii");
    expect(deriveCommonChannels("freenode", "alice")).toEqual(["#grappa"]);

    members.applyPresenceEvent(key, msg("nick_change", "alice", { new_nick: "bea" }), "ascii");
    expect(deriveCommonChannels("freenode", "alice")).toEqual([]);
    expect(deriveCommonChannels("freenode", "bea")).toEqual(["#grappa"]);

    members.applyPresenceEvent(key, msg("part", "bea"), "ascii");
    expect(deriveCommonChannels("freenode", "bea")).toEqual([]);

    members.applyPresenceEvent(key, msg("join", "carol"), "ascii");
    members.applyPresenceEvent(key, msg("quit", "carol"), "ascii");
    expect(deriveCommonChannels("freenode", "carol")).toEqual([]);

    members.applyPresenceEvent(key, msg("join", "dave"), "ascii");
    members.applyPresenceEvent(key, msg("kick", "vjt", { target: "dave" }), "ascii");
    expect(deriveCommonChannels("freenode", "dave")).toEqual([]);
  });

  it("goes stale when a presence event never reaches the store (pause gap)", async () => {
    const members = await import("../lib/members");
    const windowState = await import("../lib/windowState");
    const { deriveCommonChannels } = await import("../lib/commonChannels");
    const key = channelKey("freenode", "#grappa");

    windowState.setJoined(key);
    members.seedFromTest(key, [{ nick: "alice", modes: [] }]);

    // #1680/#1769: on a paused channel the server stops pushing peer
    // join/part/quit and applyPresenceEvent is skipped — so a QUIT the
    // store never sees leaves the peer listed. This pins the gap the
    // REST fetch closes; the derivation alone cannot detect it.
    expect(deriveCommonChannels("freenode", "alice")).toEqual(["#grappa"]);
  });
});

describe("commonChannels.commonChannelsForPeer", () => {
  it("is not loaded before the fetch lands", async () => {
    const windowState = await import("../lib/windowState");
    const { commonChannelsForPeer } = await import("../lib/commonChannels");

    windowState.setJoined(channelKey("freenode", "#grappa"));
    expect(commonChannelsForPeer("freenode", "alice")).toEqual({
      channels: [],
      loaded: false,
    });
  });

  it("fills in unseeded joined channels from the fetched snapshot", async () => {
    const windowState = await import("../lib/windowState");
    const cc = await import("../lib/commonChannels");

    windowState.setJoined(channelKey("freenode", "#grappa"));
    // #grappa joined but never seeded; the fetch says the peer is there.
    cc.setCommonChannels("freenode", "alice", ["#grappa"]);

    expect(cc.commonChannelsForPeer("freenode", "alice")).toEqual({
      channels: ["#grappa"],
      loaded: true,
    });
  });

  it("trusts the seeded local list over a stale fetched entry", async () => {
    const members = await import("../lib/members");
    const windowState = await import("../lib/windowState");
    const cc = await import("../lib/commonChannels");
    const key = channelKey("freenode", "#grappa");

    windowState.setJoined(key);
    members.seedFromTest(key, [{ nick: "bob", modes: [] }]);
    // The fetch was taken before the peer left; the seeded list is live.
    cc.setCommonChannels("freenode", "alice", ["#grappa"]);

    expect(cc.commonChannelsForPeer("freenode", "alice")).toEqual({
      channels: [],
      loaded: true,
    });
  });

  it("clearCommonChannels unloads the peer again", async () => {
    const cc = await import("../lib/commonChannels");

    cc.setCommonChannels("freenode", "alice", ["#grappa"]);
    expect(cc.commonChannelsForPeer("freenode", "alice").loaded).toBe(true);
    cc.clearCommonChannels("freenode", "alice");
    expect(cc.commonChannelsForPeer("freenode", "alice")).toEqual({
      channels: [],
      loaded: false,
    });
  });
});

describe("commonChannels.fetchCommonChannels", () => {
  it("fetches once and stores the sorted snapshot", async () => {
    const cc = await import("../lib/commonChannels");

    mockListCommonChannels.mockResolvedValue(["#zeta", "#alpha"]);
    await cc.fetchCommonChannels("tok", "freenode", "alice");

    expect(mockListCommonChannels).toHaveBeenCalledTimes(1);
    expect(mockListCommonChannels).toHaveBeenCalledWith("tok", "freenode", "alice");
    expect(cc.commonChannelsForPeer("freenode", "alice")).toEqual({
      channels: ["#alpha", "#zeta"],
      loaded: true,
    });
  });

  it("dedupes concurrent fetches for the same peer", async () => {
    const cc = await import("../lib/commonChannels");

    mockListCommonChannels.mockResolvedValue(["#grappa"]);
    await Promise.all([
      cc.fetchCommonChannels("tok", "freenode", "alice"),
      cc.fetchCommonChannels("tok", "freenode", "alice"),
    ]);

    expect(mockListCommonChannels).toHaveBeenCalledTimes(1);
  });

  it("a failed fetch leaves the peer unloaded, never a false zero", async () => {
    const cc = await import("../lib/commonChannels");

    mockListCommonChannels.mockRejectedValue(new Error("boom"));
    await cc.fetchCommonChannels("tok", "freenode", "alice");

    expect(cc.commonChannelsForPeer("freenode", "alice")).toEqual({
      channels: [],
      loaded: false,
    });
  });
});
