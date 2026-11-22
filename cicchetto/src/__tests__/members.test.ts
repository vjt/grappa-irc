import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";
import { DEFAULT_ISUPPORT, sigilRank } from "../lib/isupport";

vi.mock("../lib/api", () => ({
  setOn401Handler: vi.fn(),
  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2):
  // selection.ts now imports isContentKind from api.ts for the badge
  // memo derivation. Any test importing selection (directly or
  // transitively) needs the classifier in its api mock.
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
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

    members.applyPresenceEvent(
      key,
      {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "join",
        sender: "alice",
        body: null,
        meta: {},
      },
      "ascii",
    );

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

    members.applyPresenceEvent(
      key,
      {
        id: 2,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "part",
        sender: "alice",
        body: null,
        meta: {},
      },
      "ascii",
    );

    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });

  it(":quit removes the sender", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);

    members.applyPresenceEvent(
      key,
      {
        id: 3,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "quit",
        sender: "alice",
        body: "bye",
        meta: {},
      },
      "ascii",
    );

    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });

  it(":nick_change renames the sender, preserving modes", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [{ nick: "alice", modes: ["@"] }]);

    members.applyPresenceEvent(
      key,
      {
        id: 4,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "nick_change",
        sender: "alice",
        body: null,
        meta: { new_nick: "alice_" },
      },
      "ascii",
    );

    expect(members.membersByChannel()[key]).toEqual([{ nick: "alice_", modes: ["@"] }]);
  });

  it(":kick removes the target", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [
      { nick: "vjt", modes: ["@"] },
      { nick: "alice", modes: [] },
    ]);

    members.applyPresenceEvent(
      key,
      {
        id: 5,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "kick",
        sender: "vjt",
        body: "behave",
        meta: { target: "alice" },
      },
      "ascii",
    );

    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });

  it(":mode applies meta.member_modes — the modes the server derived", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [
      { nick: "alice", modes: [] },
      { nick: "bob", modes: [] },
    ]);

    members.applyPresenceEvent(
      key,
      {
        id: 6,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "mode",
        sender: "vjt",
        body: null,
        meta: { modes: "+ov", args: ["alice", "bob"], member_modes: { alice: ["@"], bob: ["+"] } },
      },
      "ascii",
    );

    expect(members.membersByChannel()[key]).toEqual([
      { nick: "alice", modes: ["@"] },
      { nick: "bob", modes: ["+"] },
    ]);
  });

  it("non-presence kinds (privmsg/notice/action/topic) are ignored", async () => {
    const members = await import("../lib/members");
    const key = channelKey("freenode", "#grappa");

    members.seedFromTest(key, [{ nick: "vjt", modes: ["@"] }]);

    members.applyPresenceEvent(
      key,
      {
        id: 7,
        network: "freenode",
        channel: "#grappa",
        server_time: 0,
        kind: "privmsg",
        sender: "alice",
        body: "hi",
        meta: {},
      },
      "ascii",
    );

    expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
  });

  // Bucket F H3 — case-insensitive nick comparison (RFC 2812 §2.2).
  // Pre-fix members.ts used bare `===` so server emitting `Alice` on
  // JOIN then `alice` on QUIT (or any casing variant) would not match
  // the JOIN row, leaving the lower-cased copy stuck in the store
  // forever as a phantom member. Post-fix all four presence dispatches
  // (join dedup, part/quit filter, kick filter, nick_change replace)
  // route through `nickEquals` from `lib/nickEquals.ts`.
  describe("case-insensitive nick comparison (H3)", () => {
    it(":part removes the JOIN'd row when the QUIT casing differs", async () => {
      const members = await import("../lib/members");
      const key = channelKey("freenode", "#grappa");

      // JOIN with original casing.
      members.seedFromTest(key, [{ nick: "Alice", modes: [] }]);

      members.applyPresenceEvent(
        key,
        {
          id: 100,
          network: "freenode",
          channel: "#grappa",
          server_time: 0,
          kind: "part",
          sender: "alice", // lower-case PART
          body: null,
          meta: {},
        },
        "ascii",
      );

      // Pre-fix: ["Alice"] (phantom). Post-fix: [].
      expect(members.membersByChannel()[key]).toEqual([]);
    });

    it(":quit removes the JOIN'd row when the QUIT casing differs", async () => {
      const members = await import("../lib/members");
      const key = channelKey("freenode", "#grappa");

      members.seedFromTest(key, [{ nick: "Bob", modes: ["@"] }]);

      members.applyPresenceEvent(
        key,
        {
          id: 101,
          network: "freenode",
          channel: "#grappa",
          server_time: 0,
          kind: "quit",
          sender: "BOB",
          body: "bye",
          meta: {},
        },
        "ascii",
      );

      expect(members.membersByChannel()[key]).toEqual([]);
    });

    it(":kick removes the target when the casing differs", async () => {
      const members = await import("../lib/members");
      const key = channelKey("freenode", "#grappa");

      members.seedFromTest(key, [
        { nick: "vjt", modes: ["@"] },
        { nick: "Alice", modes: [] },
      ]);

      members.applyPresenceEvent(
        key,
        {
          id: 102,
          network: "freenode",
          channel: "#grappa",
          server_time: 0,
          kind: "kick",
          sender: "vjt",
          body: "behave",
          meta: { target: "alice" }, // lower-case
        },
        "ascii",
      );

      expect(members.membersByChannel()[key]).toEqual([{ nick: "vjt", modes: ["@"] }]);
    });

    it(":nick_change renames the row when the sender casing differs", async () => {
      const members = await import("../lib/members");
      const key = channelKey("freenode", "#grappa");

      members.seedFromTest(key, [{ nick: "Alice", modes: ["+"] }]);

      members.applyPresenceEvent(
        key,
        {
          id: 103,
          network: "freenode",
          channel: "#grappa",
          server_time: 0,
          kind: "nick_change",
          sender: "alice",
          body: null,
          meta: { new_nick: "Alyssa" },
        },
        "ascii",
      );

      expect(members.membersByChannel()[key]).toEqual([{ nick: "Alyssa", modes: ["+"] }]);
    });

    it(":join dedup matches the existing row across casing variants", async () => {
      const members = await import("../lib/members");
      const key = channelKey("freenode", "#grappa");

      // Snapshot from RPL_NAMES has the original casing.
      members.seedFromTest(key, [{ nick: "Alice", modes: [] }]);

      // A racy JOIN echo arrives lower-cased — the dedup must catch it
      // (otherwise we get two rows for the same person).
      members.applyPresenceEvent(
        key,
        {
          id: 104,
          network: "freenode",
          channel: "#grappa",
          server_time: 0,
          kind: "join",
          sender: "alice",
          body: null,
          meta: {},
        },
        "ascii",
      );

      expect(members.membersByChannel()[key]).toEqual([{ nick: "Alice", modes: [] }]);
    });
  });
});

const BAHAMUT = sigilRank(DEFAULT_ISUPPORT);

describe("members.sortMembers (bucket J)", () => {
  it("orders by tier: op > halfop > voice > plain", async () => {
    const { sortMembers } = await import("../lib/members");
    const input = [
      { nick: "plain", modes: [] },
      { nick: "voice", modes: ["+"] },
      { nick: "op", modes: ["@"] },
      { nick: "halfop", modes: ["%"] },
    ];
    const sorted = sortMembers(input, BAHAMUT);
    expect(sorted.map((m) => m.nick)).toEqual(["op", "halfop", "voice", "plain"]);
  });

  it("alpha-sorts case-insensitive within each tier", async () => {
    const { sortMembers } = await import("../lib/members");
    const input = [
      { nick: "carol", modes: [] },
      { nick: "Alice", modes: [] },
      { nick: "bob", modes: [] },
    ];
    const sorted = sortMembers(input, BAHAMUT);
    expect(sorted.map((m) => m.nick)).toEqual(["Alice", "bob", "carol"]);
  });

  it("op tier preserves alpha order across mixed cases", async () => {
    const { sortMembers } = await import("../lib/members");
    const input = [
      { nick: "Zoe", modes: ["@"] },
      { nick: "alice", modes: ["@"] },
      { nick: "Bob", modes: ["@"] },
    ];
    const sorted = sortMembers(input, BAHAMUT);
    expect(sorted.map((m) => m.nick)).toEqual(["alice", "Bob", "Zoe"]);
  });

  it("full mixed list: tier rank then alpha", async () => {
    const { sortMembers } = await import("../lib/members");
    const input = [
      { nick: "zane", modes: [] },
      { nick: "voicedB", modes: ["+"] },
      { nick: "opA", modes: ["@"] },
      { nick: "halfopZ", modes: ["%"] },
      { nick: "alpha", modes: [] },
      { nick: "voicedA", modes: ["+"] },
      { nick: "opZ", modes: ["@"] },
      { nick: "halfopA", modes: ["%"] },
    ];
    const sorted = sortMembers(input, BAHAMUT);
    expect(sorted.map((m) => m.nick)).toEqual([
      "opA",
      "opZ",
      "halfopA",
      "halfopZ",
      "voicedA",
      "voicedB",
      "alpha",
      "zane",
    ]);
  });

  it("returns a NEW array (does not mutate input)", async () => {
    const { sortMembers } = await import("../lib/members");
    const input = [
      { nick: "b", modes: [] },
      { nick: "a", modes: ["@"] },
    ];
    const sorted = sortMembers(input, BAHAMUT);
    expect(sorted).not.toBe(input);
    expect(input.map((m) => m.nick)).toEqual(["b", "a"]);
  });

  it("empty input returns empty array", async () => {
    const { sortMembers } = await import("../lib/members");
    expect(sortMembers([], BAHAMUT)).toEqual([]);
  });

  it("a member with multiple modes ([@, +]) ranks by highest tier (op)", async () => {
    // Real-world: a user can hold both @ and + simultaneously. sigil/tier
    // priority is op-wins (see memberSigil.ts) — same precedence here.
    const { sortMembers } = await import("../lib/members");
    const input = [
      { nick: "plain", modes: [] },
      { nick: "opvoiced", modes: ["@", "+"] },
      { nick: "voiced", modes: ["+"] },
    ];
    const sorted = sortMembers(input, BAHAMUT);
    expect(sorted.map((m) => m.nick)).toEqual(["opvoiced", "voiced", "plain"]);
  });
});

describe("members.sortMembers rank comes from the network's PREFIX (issue 1999)", () => {
  const RICH = ["~", "&", "@", "%", "+"];

  it("founder and admin sort ABOVE op", async () => {
    // The issue's third acceptance criterion. `tierRank` knew `@ % +` only,
    // so `~` and `&` fell through to the plain tier and a channel's founder
    // was rendered at the BOTTOM of the pane, below every lurker.
    const { sortMembers } = await import("../lib/members");
    const input = [
      { nick: "plain", modes: [] },
      { nick: "op", modes: ["@"] },
      { nick: "founder", modes: ["~"] },
      { nick: "voice", modes: ["+"] },
      { nick: "admin", modes: ["&"] },
      { nick: "halfop", modes: ["%"] },
    ];

    expect(sortMembers(input, RICH).map((m) => m.nick)).toEqual([
      "founder",
      "admin",
      "op",
      "halfop",
      "voice",
      "plain",
    ]);
  });

  it("rank is the RUN's, so the same roster orders differently per network", async () => {
    // Two networks, one roster, two truths — which is the whole reason rank
    // cannot be a module constant. On a network that never advertised `~`
    // the founder is not a grade at all and sorts alphabetically as plain.
    const { sortMembers } = await import("../lib/members");
    const input = [
      { nick: "zed", modes: ["@"] },
      { nick: "founder", modes: ["~"] },
    ];

    expect(sortMembers(input, RICH).map((m) => m.nick)).toEqual(["founder", "zed"]);
    expect(sortMembers(input, ["@", "+"]).map((m) => m.nick)).toEqual(["zed", "founder"]);
  });

  it("alpha tie-break still applies within a rich tier", async () => {
    const { sortMembers } = await import("../lib/members");
    const input = [
      { nick: "Zoe", modes: ["~"] },
      { nick: "alice", modes: ["~"] },
      { nick: "Bob", modes: ["~"] },
    ];

    expect(sortMembers(input, RICH).map((m) => m.nick)).toEqual(["alice", "Bob", "Zoe"]);
  });

  it("an empty rank run flattens to pure alpha rather than throwing", async () => {
    const { sortMembers } = await import("../lib/members");
    const input = [
      { nick: "b", modes: ["@"] },
      { nick: "a", modes: [] },
    ];

    expect(sortMembers(input, []).map((m) => m.nick)).toEqual(["a", "b"]);
  });
});

// issue 2692 — the server writes what a MODE did to the roster onto the row
// (`meta.member_modes`, nick → ABSOLUTE modes) and this store applies it. cic
// no longer walks `modes`/`args`: its walker had a hardcoded (ohv) table and
// no CHANMODES, so it graded the wrong member on `+bo <mask> alice` and never
// applied `+q`/`+a`. These rows are fed the way subscribe.ts feeds them.
describe("members.applyPresenceEvent — :mode applies meta.member_modes (issue 2692)", () => {
  const key = channelKey("azzurra", "#grappa");
  const modeRow = (meta: Record<string, unknown>) => ({
    id: 2692,
    network: "azzurra",
    channel: "#grappa",
    server_time: 0,
    kind: "mode" as const,
    sender: "op",
    body: null,
    meta,
  });

  it("+bov <mask> alice bob grades alice op and bob voice — from the key, not the letters", async () => {
    const members = await import("../lib/members");
    members.seedFromTest(key, [
      { nick: "alice", modes: [] },
      { nick: "bob", modes: [] },
    ]);

    members.applyPresenceEvent(
      key,
      modeRow({
        modes: "+bov",
        args: ["*!*@h", "alice", "bob"],
        structural: true,
        member_modes: { alice: ["@"], bob: ["+"] },
      }),
      "ascii",
    );

    expect(members.membersByChannel()[key]).toEqual([
      { nick: "alice", modes: ["@"] },
      { nick: "bob", modes: ["+"] },
    ]);
  });

  it("a founder sigil the network advertises lands as the server stated it", async () => {
    const members = await import("../lib/members");
    members.seedFromTest(key, [
      { nick: "founder", modes: [] },
      { nick: "alice", modes: [] },
    ]);

    members.applyPresenceEvent(
      key,
      modeRow({
        modes: "+qo",
        args: ["founder", "alice"],
        member_modes: { founder: ["~"], alice: ["@"] },
      }),
      "ascii",
    );

    expect(members.membersByChannel()[key]).toEqual([
      { nick: "founder", modes: ["~"] },
      { nick: "alice", modes: ["@"] },
    ]);
  });

  it("the value REPLACES the member's modes — a removal states what is left", async () => {
    const members = await import("../lib/members");
    members.seedFromTest(key, [{ nick: "alice", modes: ["@", "+"] }]);

    members.applyPresenceEvent(
      key,
      modeRow({ modes: "-o", args: ["alice"], member_modes: { alice: ["+"] } }),
      "ascii",
    );

    expect(members.membersByChannel()[key]).toEqual([{ nick: "alice", modes: ["+"] }]);
  });

  it("matches the nick case-insensitively and keeps the entry's other fields", async () => {
    const members = await import("../lib/members");
    members.seedFromTest(key, [
      { nick: "alice", modes: [], gender: "female" },
      { nick: "bob", modes: ["+"] },
    ]);

    members.applyPresenceEvent(
      key,
      modeRow({ modes: "+o", args: ["ALICE"], member_modes: { ALICE: ["@"] } }),
      "ascii",
    );

    expect(members.membersByChannel()[key]).toEqual([
      { nick: "alice", modes: ["@"], gender: "female" },
      { nick: "bob", modes: ["+"] },
    ]);
  });

  it("a nick the roster does not hold adds nobody", async () => {
    const members = await import("../lib/members");
    members.seedFromTest(key, [{ nick: "alice", modes: [] }]);

    members.applyPresenceEvent(
      key,
      modeRow({ modes: "+o", args: ["ghost"], member_modes: { ghost: ["@"] } }),
      "ascii",
    );

    expect(members.membersByChannel()[key]).toEqual([{ nick: "alice", modes: [] }]);
  });

  // `meta` is validated nowhere upstream (the schema types it as a record of
  // anything), so the narrowing in `memberModesOf` is the only guard on the
  // value. A value that is not a string array is dropped, not applied: a
  // string would spread into characters, a number would throw inside the
  // signal updater. The well-formed sibling in the SAME row still applies,
  // which is what tells "dropped the bad entries" from "ignored the row".
  it("a member_modes value that is not a string array is dropped; its well-formed sibling applies", async () => {
    const members = await import("../lib/members");
    members.seedFromTest(key, [
      { nick: "alice", modes: [] },
      { nick: "bob", modes: ["+"] },
      { nick: "carol", modes: ["%"] },
      { nick: "dave", modes: [] },
    ]);

    members.applyPresenceEvent(
      key,
      modeRow({
        modes: "+oooo",
        args: ["alice", "bob", "carol", "dave"],
        member_modes: { alice: "@", bob: 7, carol: ["@", 3], dave: ["@"] },
      }),
      "ascii",
    );

    expect(members.membersByChannel()[key]).toEqual([
      { nick: "alice", modes: [] },
      { nick: "bob", modes: ["+"] },
      { nick: "carol", modes: ["%"] },
      { nick: "dave", modes: ["@"] },
    ]);
  });

  // No fallback walker: a row without the key (a channel-only mode, or a row
  // from a server predating protocol 66) changes nothing. Walking the letters
  // here would bring back exactly the second parser this issue deletes.
  it("a :mode row WITHOUT member_modes leaves the roster alone, whatever its letters say", async () => {
    const members = await import("../lib/members");
    members.seedFromTest(key, [{ nick: "alice", modes: [] }]);

    members.applyPresenceEvent(key, modeRow({ modes: "+o", args: ["alice"] }), "ascii");

    expect(members.membersByChannel()[key]).toEqual([{ nick: "alice", modes: [] }]);
  });
});
