import { describe, expect, it } from "vitest";
import type { ChannelMembers } from "../lib/memberTypes";
import { applyModeString } from "../lib/modeApply";

const m = (entries: Record<string, string[]>): ChannelMembers =>
  Object.entries(entries).map(([nick, modes]) => ({ nick, modes }));

describe("applyModeString", () => {
  it("+o grants @ to a target nick", () => {
    const before = m({ alice: [] });
    const after = applyModeString(before, "+o", ["alice"]);
    expect(after).toEqual([{ nick: "alice", modes: ["@"] }]);
  });

  it("+v grants + to a target nick", () => {
    const before = m({ bob: [] });
    const after = applyModeString(before, "+v", ["bob"]);
    expect(after).toEqual([{ nick: "bob", modes: ["+"] }]);
  });

  it("-o revokes @ from a target nick", () => {
    const before = m({ alice: ["@"] });
    const after = applyModeString(before, "-o", ["alice"]);
    expect(after).toEqual([{ nick: "alice", modes: [] }]);
  });

  it("+ov pairs args by position: alice gets @, bob gets +", () => {
    const before = m({ alice: [], bob: [] });
    const after = applyModeString(before, "+ov", ["alice", "bob"]);
    expect(after).toEqual([
      { nick: "alice", modes: ["@"] },
      { nick: "bob", modes: ["+"] },
    ]);
  });

  it("preserves unrelated members + their existing modes", () => {
    const before = m({ alice: [], bob: ["+"], carol: ["@"] });
    const after = applyModeString(before, "+o", ["alice"]);
    expect(after).toEqual([
      { nick: "alice", modes: ["@"] },
      { nick: "bob", modes: ["+"] },
      { nick: "carol", modes: ["@"] },
    ]);
  });

  it("ignores non-(ov) mode chars (e.g. +n channel-modes have no per-user effect)", () => {
    const before = m({ alice: ["@"] });
    const after = applyModeString(before, "+n", []);
    expect(after).toEqual(before);
  });

  it("unknown target nick is a no-op (defensive)", () => {
    const before = m({ alice: [] });
    const after = applyModeString(before, "+o", ["nonexistent"]);
    expect(after).toEqual([{ nick: "alice", modes: [] }]);
  });

  it("toggles the same mode without duplication", () => {
    const before = m({ alice: ["@"] });
    const after = applyModeString(before, "+o", ["alice"]); // already op
    expect(after).toEqual([{ nick: "alice", modes: ["@"] }]);
  });
});
