import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

vi.mock("../lib/api", () => ({
  listMembers: vi.fn(),
  setOn401Handler: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("members.loadMembers (snapshot)", () => {
  it("fetches /members + populates membersByChannel", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMembers).mockResolvedValue([
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: ["+"] },
      { nick: "bob", modes: [] },
    ]);

    const members = await import("../lib/members");
    await members.loadMembers("freenode", "#grappa");

    const key = channelKey("freenode", "#grappa");
    expect(members.membersByChannel()[key]).toEqual([
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: ["+"] },
      { nick: "bob", modes: [] },
    ]);
  });

  it("guards double-loads on the same channel within an identity", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMembers).mockResolvedValue([{ nick: "vjt", modes: [] }]);

    const members = await import("../lib/members");
    await members.loadMembers("freenode", "#grappa");
    await members.loadMembers("freenode", "#grappa");

    expect(api.listMembers).toHaveBeenCalledTimes(1);
  });
});

describe("members.seedMembers (members_seeded race fix)", () => {
  it("seeds membersByChannel from a payload — no fetch", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
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
    expect(api.listMembers).not.toHaveBeenCalled();
  });

  it("seedMembers marks the channel as loaded — subsequent loadMembers is a no-op", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMembers).mockResolvedValue([{ nick: "stale", modes: [] }]);
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedMembers(key, [{ nick: "vjt", modes: ["@"] }]);
    await members.loadMembers("freenode", "#grappa");

    expect(api.listMembers).not.toHaveBeenCalled();
    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });

  it("seedMembers overwrites a prior loadMembers result", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMembers).mockResolvedValue([]);

    const members = await import("../lib/members");
    await members.loadMembers("freenode", "#grappa");
    const key = channelKey("freenode", "#grappa");
    expect(members.membersByChannel()[key]).toEqual([]);

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
    localStorage.setItem("grappa-token", "tok");
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
    localStorage.setItem("grappa-token", "tok");
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
    localStorage.setItem("grappa-token", "tok");
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
    localStorage.setItem("grappa-token", "tok");
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
    localStorage.setItem("grappa-token", "tok");
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
    localStorage.setItem("grappa-token", "tok");
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
    localStorage.setItem("grappa-token", "tok");
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
