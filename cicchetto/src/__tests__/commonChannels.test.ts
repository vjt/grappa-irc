import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";
import { warmGraph } from "./helpers/warmGraph";

vi.mock("../lib/api", () => ({
  listCommonChannels: vi.fn(),
}));

// #781 — see helpers/warmGraph.ts. The per-test `await import` pays
// vite's transform for this graph on the FIRST import only; warming it
// in `beforeAll` moves that cost onto the 10s `hookTimeout` instead of
// the 5s per-test budget. `lib/api` is NOT warmed: the factory above
// means the real file is never transformed at all.
beforeAll(() => warmGraph(() => import("../lib/commonChannels")));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

// Issue 2449 — the live derivation over the client's own member lists,
// plus the REST snapshot store it falls back to for unseeded channels.
// Window state is driven through the real `setJoined` (server-owned
// projection); member lists through the real `seedMembers` /
// `applyPresenceEvent` (the `members_seeded` bootstrap + presence
// deltas). The api module is mocked: only `listCommonChannels` is a
// value import here.

const setup = async () => {
  const members = await import("../lib/members");
  const ws = await import("../lib/windowState");
  const cc = await import("../lib/commonChannels");
  const api = await import("../lib/api");
  return { members, ws, cc, api };
};

const joinAndSeed = (
  ws: Awaited<ReturnType<typeof setup>>["ws"],
  members: Awaited<ReturnType<typeof setup>>["members"],
  channel: string,
  nicks: string[],
): void => {
  ws.setJoined(channelKey("azzurra", channel));
  members.seedMembers(
    channelKey("azzurra", channel),
    nicks.map((nick) => ({ nick, modes: [] as string[] })),
  );
};

describe("commonChannels.deriveCommonChannels", () => {
  it("returns only the joined channels whose member list holds the peer", async () => {
    const { members, ws, cc } = await setup();
    joinAndSeed(ws, members, "#test", ["alice", "bob"]);
    joinAndSeed(ws, members, "#other", ["carol"]);
    ws.setJoined(channelKey("azzurra", "#third"));
    members.seedMembers(channelKey("azzurra", "#third"), [{ nick: "alice", modes: [] }]);

    expect(cc.deriveCommonChannels("azzurra", "alice", ["#test", "#third"])).toEqual([
      "#test",
      "#third",
    ]);
    expect(cc.deriveCommonChannels("azzurra", "carol", ["#other"])).toEqual(["#other"]);
    expect(cc.deriveCommonChannels("azzurra", "dave", [])).toEqual([]);
  });

  it("matches the peer case-insensitively under the network casemapping", async () => {
    const { members, ws, cc } = await setup();
    joinAndSeed(ws, members, "#test", ["Alice"]);

    expect(cc.deriveCommonChannels("azzurra", "alice", ["#test"])).toEqual(["#test"]);
    expect(cc.deriveCommonChannels("azzurra", "ALICE", ["#test"])).toEqual(["#test"]);
  });

  it("ignores channels that are not joined", async () => {
    const { members, cc } = await setup();
    // #test is seeded but never joined — the derivation only counts
    // joined windows, mirroring the tab-complete candidate set.
    members.seedMembers(channelKey("azzurra", "#test"), [{ nick: "alice", modes: [] }]);
    expect(cc.deriveCommonChannels("azzurra", "alice", ["#test"])).toEqual([]);
  });

  it("falls back to the snapshot for channels with no member list", async () => {
    const { ws, cc } = await setup();
    // #other is joined but never seeded: the client has no list, so
    // the snapshot's word stands. #gone is joined, unseeded, and NOT
    // in the snapshot — unknowable locally, so it stays out.
    ws.setJoined(channelKey("azzurra", "#other"));
    ws.setJoined(channelKey("azzurra", "#gone"));

    expect(cc.deriveCommonChannels("azzurra", "alice", ["#other"])).toEqual(["#other"]);
    expect(cc.deriveCommonChannels("azzurra", "alice", [])).toEqual([]);
  });

  it("follows live presence events (join/part/quit/nick)", async () => {
    const { members, ws, cc } = await setup();
    joinAndSeed(ws, members, "#test", ["alice"]);
    const key = channelKey("azzurra", "#test");

    expect(cc.deriveCommonChannels("azzurra", "alice", ["#test"])).toEqual(["#test"]);

    members.applyPresenceEvent(
      key,
      {
        id: 2,
        network: "azzurra",
        channel: "#test",
        server_time: 0,
        kind: "part",
        sender: "alice",
        body: null,
        meta: {},
      },
      "ascii",
    );
    expect(cc.deriveCommonChannels("azzurra", "alice", ["#test"])).toEqual([]);

    members.applyPresenceEvent(
      key,
      {
        id: 3,
        network: "azzurra",
        channel: "#test",
        server_time: 0,
        kind: "join",
        sender: "alice",
        body: null,
        meta: {},
      },
      "ascii",
    );
    expect(cc.deriveCommonChannels("azzurra", "alice", ["#test"])).toEqual(["#test"]);

    members.applyPresenceEvent(
      key,
      {
        id: 4,
        network: "azzurra",
        channel: "#test",
        server_time: 0,
        kind: "nick_change",
        sender: "alice",
        body: null,
        meta: { new_nick: "alicia" },
      },
      "ascii",
    );
    expect(cc.deriveCommonChannels("azzurra", "alice", ["#test"])).toEqual([]);
    expect(cc.deriveCommonChannels("azzurra", "alicia", ["#test"])).toEqual(["#test"]);

    members.applyPresenceEvent(
      key,
      {
        id: 5,
        network: "azzurra",
        channel: "#test",
        server_time: 0,
        kind: "quit",
        sender: "alicia",
        body: null,
        meta: {},
      },
      "ascii",
    );
    expect(cc.deriveCommonChannels("azzurra", "alicia", ["#test"])).toEqual([]);
  });
});

describe("commonChannels.fetchCommonChannels", () => {
  it("stores the snapshot on success", async () => {
    const { cc, api } = await setup();
    vi.mocked(api.listCommonChannels).mockResolvedValue(["#test", "#other"]);

    await cc.fetchCommonChannels("tok", "azzurra", "alice");

    expect(api.listCommonChannels).toHaveBeenCalledWith("tok", "azzurra", "alice");
    // Stored under the folded peer key — a differently-cased lookup
    // reads the same entry.
    const { atKey } = await import("../lib/byKey");
    const { normalizeNick } = await import("../lib/nickEquals");
    const { casemappingForSlug } = await import("../lib/casemapping");
    const entry = atKey(
      cc.commonChannelsBySlug().azzurra,
      normalizeNick("ALICE", casemappingForSlug("azzurra")),
    );
    expect(entry).toEqual(["#test", "#other"]);
  });

  it("stores null on fetch failure (banner hides, never asserts empty)", async () => {
    const { cc, api } = await setup();
    vi.mocked(api.listCommonChannels).mockRejectedValue(new Error("boom"));

    await cc.fetchCommonChannels("tok", "azzurra", "alice");

    const { atKey } = await import("../lib/byKey");
    const { normalizeNick } = await import("../lib/nickEquals");
    const { casemappingForSlug } = await import("../lib/casemapping");
    const entry = atKey(
      cc.commonChannelsBySlug().azzurra,
      normalizeNick("alice", casemappingForSlug("azzurra")),
    );
    expect(entry).toBeNull();
  });

  it("clearCommonChannels drops the entry", async () => {
    const { cc, api } = await setup();
    vi.mocked(api.listCommonChannels).mockResolvedValue(["#test"]);

    await cc.fetchCommonChannels("tok", "azzurra", "alice");
    cc.clearCommonChannels("azzurra", "alice");

    const { atKey } = await import("../lib/byKey");
    const { normalizeNick } = await import("../lib/nickEquals");
    const { casemappingForSlug } = await import("../lib/casemapping");
    const entry = atKey(
      cc.commonChannelsBySlug().azzurra,
      normalizeNick("alice", casemappingForSlug("azzurra")),
    );
    expect(entry).toBeUndefined();
  });
});
