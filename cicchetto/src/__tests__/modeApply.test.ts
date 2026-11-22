import { describe, expect, it } from "vitest";
import { DEFAULT_ISUPPORT, type IsupportEntry } from "../lib/isupport";
import type { ChannelMembers } from "../lib/memberTypes";
import { applyModeString } from "../lib/modeApply";

const m = (entries: Record<string, string[]>): ChannelMembers =>
  Object.entries(entries).map(([nick, modes]) => ({ nick, modes }));

describe("applyModeString", () => {
  it("+o grants @ to a target nick", () => {
    const before = m({ alice: [] });
    const after = applyModeString(before, "+o", ["alice"], "ascii");
    expect(after).toEqual([{ nick: "alice", modes: ["@"] }]);
  });

  it("+v grants + to a target nick", () => {
    const before = m({ bob: [] });
    const after = applyModeString(before, "+v", ["bob"], "ascii");
    expect(after).toEqual([{ nick: "bob", modes: ["+"] }]);
  });

  it("+h grants % to a target nick (bucket J — halfop)", () => {
    const before = m({ carol: [] });
    const after = applyModeString(before, "+h", ["carol"], "ascii");
    expect(after).toEqual([{ nick: "carol", modes: ["%"] }]);
  });

  it("-h revokes % from a target nick (bucket J — halfop)", () => {
    const before = m({ carol: ["%"] });
    const after = applyModeString(before, "-h", ["carol"], "ascii");
    expect(after).toEqual([{ nick: "carol", modes: [] }]);
  });

  it("+ohv pairs three args by position: alice@, bob%, carol+ (bucket J — halfop)", () => {
    const before = m({ alice: [], bob: [], carol: [] });
    const after = applyModeString(before, "+ohv", ["alice", "bob", "carol"], "ascii");
    expect(after).toEqual([
      { nick: "alice", modes: ["@"] },
      { nick: "bob", modes: ["%"] },
      { nick: "carol", modes: ["+"] },
    ]);
  });

  it("-o revokes @ from a target nick", () => {
    const before = m({ alice: ["@"] });
    const after = applyModeString(before, "-o", ["alice"], "ascii");
    expect(after).toEqual([{ nick: "alice", modes: [] }]);
  });

  it("+ov pairs args by position: alice gets @, bob gets +", () => {
    const before = m({ alice: [], bob: [] });
    const after = applyModeString(before, "+ov", ["alice", "bob"], "ascii");
    expect(after).toEqual([
      { nick: "alice", modes: ["@"] },
      { nick: "bob", modes: ["+"] },
    ]);
  });

  it("preserves unrelated members + their existing modes", () => {
    const before = m({ alice: [], bob: ["+"], carol: ["@"] });
    const after = applyModeString(before, "+o", ["alice"], "ascii");
    expect(after).toEqual([
      { nick: "alice", modes: ["@"] },
      { nick: "bob", modes: ["+"] },
      { nick: "carol", modes: ["@"] },
    ]);
  });

  it("ignores non-(ov) mode chars (e.g. +n channel-modes have no per-user effect)", () => {
    const before = m({ alice: ["@"] });
    const after = applyModeString(before, "+n", [], "ascii");
    expect(after).toEqual(before);
  });

  it("unknown target nick is a no-op (defensive)", () => {
    const before = m({ alice: [] });
    const after = applyModeString(before, "+o", ["nonexistent"], "ascii");
    expect(after).toEqual([{ nick: "alice", modes: [] }]);
  });

  it("toggles the same mode without duplication", () => {
    const before = m({ alice: ["@"] });
    const after = applyModeString(before, "+o", ["alice"], "ascii"); // already op
    expect(after).toEqual([{ nick: "alice", modes: ["@"] }]);
  });

  // Bucket F H3 follow-up — case-insensitive target match (RFC 2812 §2.2).
  // MODE arg arrives in different casing than the JOIN/NAMES populated
  // store row; pre-fix bare `===` silently dropped the mode change.
  it("matches the target nick case-insensitively", () => {
    const before = m({ Alice: [] });
    const after = applyModeString(before, "+o", ["alice"], "ascii");
    expect(after).toEqual([{ nick: "Alice", modes: ["@"] }]);
  });
});

// issue 2692 (arch review 2026-11-21, DUP-A2) — the walker never followed the
// server's #216 move to per-network PREFIX / CHANMODES. The server's
// `EventRouter.walk_modes/5` asks `ISupport.user_prefix/2` and
// `ISupport.takes_param?/3` per letter; this walker hardcodes `{o,h,v}` and
// consumes NO argument for any other letter. Each vector below is mirrored
// by a server test in `event_router_test.exs` ("issue 2692 — …") that pins
// what the server derives from the same bytes.
//
// Two shapes of the defect, and they are not the same kind of bug:
//   (a) expressible on TODAY's signature — a param-taking channel mode ahead
//       of a membership mode shifts every later argument by one. That is a
//       wrong answer inside the existing contract.
//   (b) NOT expressible on today's signature — the walker has no parameter
//       through which the network's PREFIX can reach it. The `@ts-expect-error`
//       on those calls marks that absence; vitest strips types, so the extra
//       argument is ignored at runtime and the assertion is what fails. The
//       directive trips (unused) the day such a parameter exists.
describe("applyModeString follows the network's PREFIX / CHANMODES (issue 2692)", () => {
  // UnrealIRCd-6-shaped 005: `CHANMODES=beI,fkL,lFH,cdimnprstzCDGKMNOPQRSTVZ PREFIX=(qaohv)~&@%+`.
  // Both 005 strings here are recalled, NOT captured off a live server; what
  // the vectors rely on is only `b` type A everywhere, `q`/`a` membership on
  // Unreal, and `q` type A on solanum.
  const UNREAL: IsupportEntry = {
    ...DEFAULT_ISUPPORT,
    chanmodes: {
      a: ["b", "e", "I"],
      b: ["f", "k", "L"],
      c: ["l", "F", "H"],
      d: [..."cdimnprstzCDGKMNOPQRSTVZ"],
    },
    prefix: { q: "~", a: "&", o: "@", h: "%", v: "+" },
    prefixOrder: ["q", "a", "o", "h", "v"],
  };

  // solanum / Libera 005: `CHANMODES=eIbq,k,flj,CFLMPQRSTcgimnprstuz PREFIX=(ov)@+`.
  // `q` is a LIST mode (quiet) here and a MEMBERSHIP mode (founder) on Unreal:
  // no single hardcoded table can be right on both.
  const SOLANUM: IsupportEntry = {
    ...DEFAULT_ISUPPORT,
    chanmodes: {
      a: ["e", "I", "b", "q"],
      b: ["k"],
      c: ["f", "l", "j"],
      d: [..."CFLMPQRSTcgimnprstuz"],
    },
    prefix: { o: "@", v: "+" },
    prefixOrder: ["o", "v"],
  };

  it("(a) +bo <mask> alice ops alice — the ban mask is b's argument, not o's", () => {
    const before = m({ alice: [] });
    const after = applyModeString(before, "+bo", ["*!*@h", "alice"], "ascii");
    expect(after).toEqual([{ nick: "alice", modes: ["@"] }]);
  });

  it("(a) +bov <mask> alice bob grades each nick by its own letter", () => {
    const before = m({ alice: [], bob: [] });
    const after = applyModeString(before, "+bov", ["*!*@h", "alice", "bob"], "ascii");
    expect(after).toEqual([
      { nick: "alice", modes: ["@"] },
      { nick: "bob", modes: ["+"] },
    ]);
  });

  it("(b) +q alice on PREFIX=(qaohv)~&@%+ gives alice the founder sigil", () => {
    const before = m({ alice: [] });
    // @ts-expect-error issue 2692: no parameter carries the network's PREFIX
    const after = applyModeString(before, "+q", ["alice"], "ascii", UNREAL);
    expect(after).toEqual([{ nick: "alice", modes: ["~"] }]);
  });

  it("(b) +a bob on PREFIX=(qaohv)~&@%+ gives bob the admin sigil", () => {
    const before = m({ bob: [] });
    // @ts-expect-error issue 2692: no parameter carries the network's PREFIX
    const after = applyModeString(before, "+a", ["bob"], "ascii", UNREAL);
    expect(after).toEqual([{ nick: "bob", modes: ["&"] }]);
  });

  it("(b) -q founder on PREFIX=(qaohv)~&@%+ takes the founder sigil away", () => {
    const before = m({ founder: ["~"] });
    // @ts-expect-error issue 2692: no parameter carries the network's PREFIX
    const after = applyModeString(before, "-q", ["founder"], "ascii", UNREAL);
    expect(after).toEqual([{ nick: "founder", modes: [] }]);
  });

  it("(b) +qo founder alice on PREFIX=(qaohv) ops alice, not the founder", () => {
    const before = m({ founder: [], alice: [] });
    // @ts-expect-error issue 2692: no parameter carries the network's PREFIX
    const after = applyModeString(before, "+qo", ["founder", "alice"], "ascii", UNREAL);
    expect(after).toEqual([
      { nick: "founder", modes: ["~"] },
      { nick: "alice", modes: ["@"] },
    ]);
  });

  it("(c) +qo <mask> alice on solanum ops alice — q is a quiet list there", () => {
    const before = m({ alice: [] });
    // @ts-expect-error issue 2692: no parameter carries the network's CHANMODES
    const after = applyModeString(before, "+qo", ["*!*@h", "alice"], "ascii", SOLANUM);
    expect(after).toEqual([{ nick: "alice", modes: ["@"] }]);
  });
});
