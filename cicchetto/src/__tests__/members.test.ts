import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

vi.mock("../lib/api", () => ({
  setOn401Handler: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

// CP15 B5: members.ts no longer exposes loadMembers / listMembers.
// Bootstrap goes through `seedMembers`, fed by the server's
// `members_seeded` WS broadcast (after_join + every 366
// RPL_ENDOFNAMES). Live updates flow via `applyPresenceEvent` from
// per-channel WS messages. The old once-per-channel REST gate
// (`loadedChannels`) went away with the REST fetch path.

describe("members.seedMembers", () => {
  it("seeds membersByChannel from a payload", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedMembers(key, [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);

    expect(members.membersByChannel()[key]).toEqual([
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);
  });

  it("seedMembers overwrites a prior seed", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedMembers(key, [{ nick: "stale", modes: [] }]);
    members.seedMembers(key, [
      { nick: "vjt", modes: [] },
      { nick: "bob", modes: ["@"] },
    ]);

    expect(members.membersByChannel()[key]).toEqual([
      { nick: "vjt", modes: [] },
      { nick: "bob", modes: ["@"] },
    ]);
  });
});

describe("members.applyPresenceEvent", () => {
  it(":join inserts the sender (modes: []) at the end", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [{ nick: "vjt", modes: ["@"] }]);

    members.applyPresenceEvent(key, {
      id: 1,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "join",
      sender: "alice",
      body: null,
      meta: {},
    });

    expect(members.membersByChannel()[key]).toEqual([
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);
  });

  it(":part removes the sender", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);

    members.applyPresenceEvent(key, {
      id: 2,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "part",
      sender: "alice",
      body: null,
      meta: {},
    });

    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });

  it(":quit removes the sender", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);

    members.applyPresenceEvent(key, {
      id: 3,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "quit",
      sender: "alice",
      body: "bye",
      meta: {},
    });

    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });

  it(":nick_change renames the sender, preserving modes", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [{ nick: "alice", modes: ["@"] }]);

    members.applyPresenceEvent(key, {
      id: 4,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "nick_change",
      sender: "alice",
      body: null,
      meta: { new_nick: "alice_" },
    });

    expect(members.membersByChannel()[key]).toEqual([{ nick: "alice_", modes: ["@"] }]);
  });

  it(":kick removes the target", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);

    members.applyPresenceEvent(key, {
      id: 5,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "kick",
      sender: "vjt",
      body: "behave",
      meta: { target: "alice" },
    });

    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });

  it(":mode applies the mode string via modeApply", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [
      { nick: "alice", modes: [] },
      { nick: "bob", modes: [] },
    ]);

    members.applyPresenceEvent(key, {
      id: 6,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "mode",
      sender: "vjt",
      body: null,
      meta: { modes: "+ov", args: ["alice", "bob"] },
    });

    expect(members.membersByChannel()[key]).toEqual([
      { nick: "alice", modes: ["@"] },
      { nick: "bob", modes: ["+"] },
    ]);
  });

  it("non-presence kinds (privmsg/notice/action/topic) are ignored", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [{ nick: "vjt", modes: ["@"] }]);

    members.applyPresenceEvent(key, {
      id: 7,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "privmsg",
      sender: "alice",
      body: "hi",
      meta: {},
    });

    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });
});
