import { describe, expect, it } from "vitest";
import { narrowChannelEvent, narrowWindowStateEvent } from "../lib/wireNarrow";

// Bucket G H4+U3 — runtime narrower for per-channel WS events.
// Mirror of `narrowUserEvent` (cic M1) on the per-channel boundary.
// Each arm asserted: valid shape passes verbatim; any malformed shape
// returns null. The narrower is the WS-edge boundary; downstream
// consumers (subscribe.ts) trust the typed result and never re-validate.

describe("narrowChannelEvent (bucket G H4+U3)", () => {
  describe("invalid top-level shape", () => {
    it("returns null on null", () => {
      expect(narrowChannelEvent(null)).toBeNull();
    });
    it("returns null on non-object", () => {
      expect(narrowChannelEvent("event")).toBeNull();
      expect(narrowChannelEvent(42)).toBeNull();
      expect(narrowChannelEvent(undefined)).toBeNull();
    });
    it("returns null on missing kind", () => {
      expect(narrowChannelEvent({})).toBeNull();
      expect(narrowChannelEvent({ message: {} })).toBeNull();
    });
    it("returns null on unknown kind", () => {
      expect(narrowChannelEvent({ kind: "totally_new_thing" })).toBeNull();
    });
    it("returns null on non-string kind", () => {
      expect(narrowChannelEvent({ kind: 123 })).toBeNull();
    });
  });

  describe("kind: message", () => {
    const validMessage = {
      id: 42,
      network: "azzurra",
      channel: "#italia",
      server_time: 1_700_000_000,
      kind: "privmsg",
      sender: "vjt",
      body: "ciao",
      meta: {},
    };

    it("narrows a complete message envelope", () => {
      const out = narrowChannelEvent({ kind: "message", message: validMessage });
      expect(out).not.toBeNull();
      expect(out?.kind).toBe("message");
      if (out?.kind === "message") {
        expect(out.message.id).toBe(42);
        expect(out.message.kind).toBe("privmsg");
      }
    });

    it("accepts null body (e.g. JOIN/PART)", () => {
      const joinMsg = { ...validMessage, kind: "join", body: null };
      const out = narrowChannelEvent({ kind: "message", message: joinMsg });
      expect(out).not.toBeNull();
    });

    it("rejects unknown message.kind", () => {
      const bad = { ...validMessage, kind: "newfangled" };
      expect(narrowChannelEvent({ kind: "message", message: bad })).toBeNull();
    });

    it("rejects message with missing required field", () => {
      const { sender: _omit, ...bad } = validMessage;
      expect(narrowChannelEvent({ kind: "message", message: bad })).toBeNull();
    });

    it("rejects message with wrong-typed field", () => {
      const bad = { ...validMessage, server_time: "1700000000" };
      expect(narrowChannelEvent({ kind: "message", message: bad })).toBeNull();
    });

    it("rejects message with null meta", () => {
      const bad = { ...validMessage, meta: null };
      expect(narrowChannelEvent({ kind: "message", message: bad })).toBeNull();
    });

    // B6.11 HIGH-7 (no-silent-drops 2026-05-14): :server_event was
    // missing from VALID_MESSAGE_KINDS — first integration smoke
    // surfaced it (B2 INVITE CTA test failed with the row silently
    // dropped at the WS edge). Pin all 11 kinds explicitly so a
    // future enum addition that forgets to update the runtime
    // allowlist fails this test, not a Playwright run.
    it("accepts all 11 MessageKind values (kind allowlist exhaustiveness)", () => {
      const kinds = [
        "privmsg",
        "notice",
        "action",
        "join",
        "part",
        "quit",
        "nick_change",
        "mode",
        "topic",
        "kick",
        "server_event",
      ];
      for (const k of kinds) {
        const msg = { ...validMessage, kind: k, body: null };
        const out = narrowChannelEvent({ kind: "message", message: msg });
        expect(out, `kind=${k} should be accepted by VALID_MESSAGE_KINDS`).not.toBeNull();
      }
    });
  });

  describe("kind: topic_changed", () => {
    it("narrows a complete envelope", () => {
      const out = narrowChannelEvent({
        kind: "topic_changed",
        network: "azzurra",
        channel: "#italia",
        topic: { text: "ben(e)trovati", set_by: "vjt", set_at: "2026-05-12T18:00:00Z" },
      });
      expect(out?.kind).toBe("topic_changed");
    });

    it("accepts null fields in TopicEntry", () => {
      const out = narrowChannelEvent({
        kind: "topic_changed",
        network: "azzurra",
        channel: "#italia",
        topic: { text: null, set_by: null, set_at: null },
      });
      expect(out?.kind).toBe("topic_changed");
    });

    it("rejects missing topic", () => {
      expect(
        narrowChannelEvent({
          kind: "topic_changed",
          network: "azzurra",
          channel: "#italia",
        }),
      ).toBeNull();
    });

    it("rejects wrong-typed text", () => {
      expect(
        narrowChannelEvent({
          kind: "topic_changed",
          network: "azzurra",
          channel: "#italia",
          topic: { text: 42, set_by: null, set_at: null },
        }),
      ).toBeNull();
    });
  });

  describe("kind: channel_modes_changed", () => {
    it("narrows a complete envelope", () => {
      const out = narrowChannelEvent({
        kind: "channel_modes_changed",
        network: "azzurra",
        channel: "#italia",
        modes: { modes: ["n", "t"], params: { k: "secret" } },
      });
      expect(out?.kind).toBe("channel_modes_changed");
    });

    it("rejects modes array containing non-string", () => {
      expect(
        narrowChannelEvent({
          kind: "channel_modes_changed",
          network: "azzurra",
          channel: "#italia",
          modes: { modes: ["n", 42], params: {} },
        }),
      ).toBeNull();
    });

    it("rejects missing params object", () => {
      expect(
        narrowChannelEvent({
          kind: "channel_modes_changed",
          network: "azzurra",
          channel: "#italia",
          modes: { modes: [] },
        }),
      ).toBeNull();
    });
  });

  // UX-5 BJ (2026-05-19) — JoinBanner was killed but the narrower keeps
  // recognizing `channel_created` as a recognized-but-ignored arm so the
  // per-JOIN server emission doesn't log via the default-null path. See
  // `subscribe.ts` channel handler for the no-op routing.
  describe("kind: channel_created", () => {
    it("narrows a complete envelope", () => {
      const out = narrowChannelEvent({
        kind: "channel_created",
        network: "azzurra",
        channel: "#italia",
        created_at: "2024-09-22T10:00:00Z",
      });
      expect(out).toEqual({
        kind: "channel_created",
        network: "azzurra",
        channel: "#italia",
        created_at: "2024-09-22T10:00:00Z",
      });
    });

    it("rejects missing network", () => {
      expect(
        narrowChannelEvent({
          kind: "channel_created",
          channel: "#italia",
          created_at: "2024-09-22T10:00:00Z",
        }),
      ).toBeNull();
    });

    it("rejects missing channel", () => {
      expect(
        narrowChannelEvent({
          kind: "channel_created",
          network: "azzurra",
          created_at: "2024-09-22T10:00:00Z",
        }),
      ).toBeNull();
    });

    it("rejects non-string created_at", () => {
      expect(
        narrowChannelEvent({
          kind: "channel_created",
          network: "azzurra",
          channel: "#italia",
          created_at: 1727000000,
        }),
      ).toBeNull();
    });
  });

  describe("kind: members_seeded", () => {
    it("narrows empty members list", () => {
      const out = narrowChannelEvent({
        kind: "members_seeded",
        network: "azzurra",
        channel: "#italia",
        members: [],
      });
      expect(out?.kind).toBe("members_seeded");
    });

    it("narrows populated members list", () => {
      const out = narrowChannelEvent({
        kind: "members_seeded",
        network: "azzurra",
        channel: "#italia",
        members: [
          { nick: "vjt", modes: ["@"] },
          { nick: "ll", modes: [] },
        ],
      });
      expect(out?.kind).toBe("members_seeded");
      if (out?.kind === "members_seeded") expect(out.members).toHaveLength(2);
    });

    it("rejects non-array members", () => {
      expect(
        narrowChannelEvent({
          kind: "members_seeded",
          network: "azzurra",
          channel: "#italia",
          members: "vjt",
        }),
      ).toBeNull();
    });

    it("rejects member missing nick", () => {
      expect(
        narrowChannelEvent({
          kind: "members_seeded",
          network: "azzurra",
          channel: "#italia",
          members: [{ modes: [] }],
        }),
      ).toBeNull();
    });

    it("rejects member with non-string mode entry", () => {
      expect(
        narrowChannelEvent({
          kind: "members_seeded",
          network: "azzurra",
          channel: "#italia",
          members: [{ nick: "vjt", modes: ["@", 42] }],
        }),
      ).toBeNull();
    });
  });

  describe("kind: joined", () => {
    it("narrows the canonical envelope", () => {
      const out = narrowChannelEvent({
        kind: "joined",
        network: "azzurra",
        channel: "#italia",
        state: "joined",
      });
      expect(out?.kind).toBe("joined");
    });

    it("rejects state other than 'joined'", () => {
      expect(
        narrowChannelEvent({
          kind: "joined",
          network: "azzurra",
          channel: "#italia",
          state: "pending",
        }),
      ).toBeNull();
    });
  });

  describe("kind: join_failed", () => {
    it("narrows a complete envelope", () => {
      const out = narrowChannelEvent({
        kind: "join_failed",
        network: "azzurra",
        channel: "#italia",
        state: "failed",
        reason: "channel is invite-only",
        numeric: 473,
      });
      expect(out?.kind).toBe("join_failed");
    });

    it("accepts null reason", () => {
      const out = narrowChannelEvent({
        kind: "join_failed",
        network: "azzurra",
        channel: "#italia",
        state: "failed",
        reason: null,
        numeric: 473,
      });
      expect(out?.kind).toBe("join_failed");
    });

    it("rejects non-numeric numeric", () => {
      expect(
        narrowChannelEvent({
          kind: "join_failed",
          network: "azzurra",
          channel: "#italia",
          state: "failed",
          reason: null,
          numeric: "473",
        }),
      ).toBeNull();
    });
  });

  describe("kind: kicked", () => {
    it("narrows a complete envelope", () => {
      const out = narrowChannelEvent({
        kind: "kicked",
        network: "azzurra",
        channel: "#italia",
        state: "kicked",
        by: "op",
        reason: "spam",
      });
      expect(out?.kind).toBe("kicked");
    });

    it("accepts null by + null reason", () => {
      const out = narrowChannelEvent({
        kind: "kicked",
        network: "azzurra",
        channel: "#italia",
        state: "kicked",
        by: null,
        reason: null,
      });
      expect(out?.kind).toBe("kicked");
    });

    it("rejects state other than 'kicked'", () => {
      expect(
        narrowChannelEvent({
          kind: "kicked",
          network: "azzurra",
          channel: "#italia",
          state: "left",
          by: null,
          reason: null,
        }),
      ).toBeNull();
    });
  });

  describe("kind: invite_ack (P-0e + P-0f)", () => {
    // P-0f flipped invite_ack from per-channel to user-topic. The
    // channel-event narrower now drops any stray invite_ack payload
    // (defensive — server should never emit on the channel topic
    // post-P-0f). User-topic narrowing is covered in userTopic.test.ts.
    it("drops invite_ack on the channel-event surface (now lives on user-topic)", () => {
      expect(
        narrowChannelEvent({
          kind: "invite_ack",
          network: "azzurra",
          channel: "#italia",
          peer: "alice",
        }),
      ).toBeNull();
    });
  });
});

// REV-A H1 (codebase-review-2026-05-22) — shared narrower for
// joined/join_failed/kicked. Pre-REV-A the byte-identical shape
// narrowing lived inline in BOTH narrowChannelEvent (above) AND
// narrowUserEvent (userTopic.ts). The extraction here pins the
// single-source contract; the existing narrowChannelEvent arm tests
// above implicitly exercise this code path. These tests give the
// helper direct coverage so a future caller (e.g. a per-arm test
// for narrowUserEvent's user-topic dual-broadcast routing) can
// reuse the assertions.
describe("narrowWindowStateEvent (REV-A H1)", () => {
  it("narrows a valid joined arm", () => {
    expect(
      narrowWindowStateEvent({
        kind: "joined",
        network: "azzurra",
        channel: "#italia",
        state: "joined",
      }),
    ).toEqual({ kind: "joined", network: "azzurra", channel: "#italia", state: "joined" });
  });

  it("narrows a valid join_failed arm", () => {
    expect(
      narrowWindowStateEvent({
        kind: "join_failed",
        network: "azzurra",
        channel: "#sekrit",
        state: "failed",
        reason: "channel key required",
        numeric: 475,
      }),
    ).toEqual({
      kind: "join_failed",
      network: "azzurra",
      channel: "#sekrit",
      state: "failed",
      reason: "channel key required",
      numeric: 475,
    });
  });

  it("narrows a valid kicked arm with null reason", () => {
    expect(
      narrowWindowStateEvent({
        kind: "kicked",
        network: "azzurra",
        channel: "#italia",
        state: "kicked",
        by: "moderator",
        reason: null,
      }),
    ).toEqual({
      kind: "kicked",
      network: "azzurra",
      channel: "#italia",
      state: "kicked",
      by: "moderator",
      reason: null,
    });
  });

  it("returns null on unknown kind", () => {
    expect(narrowWindowStateEvent({ kind: "totally_new" })).toBeNull();
  });

  it("returns null on shape mismatch (joined with non-string network)", () => {
    expect(
      narrowWindowStateEvent({ kind: "joined", network: 1, channel: "#x", state: "joined" }),
    ).toBeNull();
  });

  it("returns null on shape mismatch (join_failed with non-number numeric)", () => {
    expect(
      narrowWindowStateEvent({
        kind: "join_failed",
        network: "azzurra",
        channel: "#x",
        state: "failed",
        reason: null,
        numeric: "475",
      }),
    ).toBeNull();
  });

  it("returns null on null/non-object input", () => {
    expect(narrowWindowStateEvent(null)).toBeNull();
    expect(narrowWindowStateEvent("kicked")).toBeNull();
    expect(narrowWindowStateEvent(undefined)).toBeNull();
  });
});
