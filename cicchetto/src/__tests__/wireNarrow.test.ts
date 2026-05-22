import { describe, expect, it } from "vitest";
import {
  narrowAdminEvent,
  narrowAdminSnapshot,
  narrowChannelEvent,
  narrowWindowStateEvent,
} from "../lib/wireNarrow";

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

// ── REV-G H24 (2026-05-22) — admin-channel narrowers ──────────────
describe("narrowAdminEvent (REV-G H24)", () => {
  describe("invalid top-level shape", () => {
    it("returns null on null", () => {
      expect(narrowAdminEvent(null)).toBeNull();
    });
    it("returns null on non-object", () => {
      expect(narrowAdminEvent("event")).toBeNull();
      expect(narrowAdminEvent(42)).toBeNull();
      expect(narrowAdminEvent(undefined)).toBeNull();
    });
    it("returns null on missing kind", () => {
      expect(narrowAdminEvent({ at: "2026-05-22T12:00:00Z" })).toBeNull();
    });
    it("returns null on unknown kind", () => {
      expect(narrowAdminEvent({ kind: "totally_new", at: "2026-05-22T12:00:00Z" })).toBeNull();
    });
    it("returns null on missing at", () => {
      expect(narrowAdminEvent({ kind: "reaper_swept", count: 0 })).toBeNull();
    });
  });

  describe("kind: circuit_open", () => {
    const valid = {
      kind: "circuit_open",
      network_id: 1,
      network_slug: "azzurra",
      threshold: 3,
      cooldown_ms: 30_000,
      at: "2026-05-22T12:00:00Z",
    };
    it("accepts valid shape verbatim", () => {
      expect(narrowAdminEvent(valid)).toEqual(valid);
    });
    it("accepts null network_slug", () => {
      expect(narrowAdminEvent({ ...valid, network_slug: null })).toEqual({
        ...valid,
        network_slug: null,
      });
    });
    it("rejects non-number threshold", () => {
      expect(narrowAdminEvent({ ...valid, threshold: "3" })).toBeNull();
    });
    it("rejects missing cooldown_ms", () => {
      const { cooldown_ms: _cm, ...rest } = valid;
      expect(narrowAdminEvent(rest)).toBeNull();
    });
  });

  describe("kind: circuit_close", () => {
    const valid = {
      kind: "circuit_close",
      network_id: 1,
      network_slug: "azzurra",
      reason: "success" as const,
      at: "2026-05-22T12:00:00Z",
    };
    it("accepts success", () => {
      expect(narrowAdminEvent(valid)).toEqual(valid);
    });
    it("accepts cooldown_expired", () => {
      expect(narrowAdminEvent({ ...valid, reason: "cooldown_expired" })).toEqual({
        ...valid,
        reason: "cooldown_expired",
      });
    });
    it("rejects unknown reason", () => {
      expect(narrowAdminEvent({ ...valid, reason: "manual" })).toBeNull();
    });
  });

  describe("kind: capacity_reject", () => {
    const valid = {
      kind: "capacity_reject",
      flow: "login_fresh" as const,
      error: "max_concurrent_visitor_sessions",
      network_id: 1,
      network_slug: "azzurra",
      client_id: "abc",
      at: "2026-05-22T12:00:00Z",
    };
    it("accepts valid", () => {
      expect(narrowAdminEvent(valid)).toEqual(valid);
    });
    it("accepts null client_id", () => {
      expect(narrowAdminEvent({ ...valid, client_id: null })).toEqual({
        ...valid,
        client_id: null,
      });
    });
    it("rejects unknown flow", () => {
      expect(narrowAdminEvent({ ...valid, flow: "made_up" })).toBeNull();
    });
  });

  describe("kind: visitor_deleted / visitor_reaped", () => {
    it("accepts visitor_deleted", () => {
      const ev = {
        kind: "visitor_deleted",
        visitor_id: "uuid-1",
        visitor_nick: "alice",
        network_slug: "azzurra",
        actor_user_id: "uuid-op",
        actor_user_name: "admin",
        at: "2026-05-22T12:00:00Z",
      };
      expect(narrowAdminEvent(ev)).toEqual(ev);
    });
    it("accepts visitor_reaped without actor fields", () => {
      const ev = {
        kind: "visitor_reaped",
        visitor_id: "uuid-1",
        visitor_nick: null,
        network_slug: null,
        at: "2026-05-22T12:00:00Z",
      };
      expect(narrowAdminEvent(ev)).toEqual(ev);
    });
  });

  describe("kind: reaper_swept / uploads_swept", () => {
    it("accepts reaper_swept", () => {
      const ev = { kind: "reaper_swept", count: 5, at: "2026-05-22T12:00:00Z" };
      expect(narrowAdminEvent(ev)).toEqual(ev);
    });
    it("rejects non-number count", () => {
      expect(
        narrowAdminEvent({ kind: "reaper_swept", count: "5", at: "2026-05-22T12:00:00Z" }),
      ).toBeNull();
    });
    it("accepts uploads_swept", () => {
      const ev = { kind: "uploads_swept", count: 7, at: "2026-05-22T12:00:00Z" };
      expect(narrowAdminEvent(ev)).toEqual(ev);
    });
  });

  describe("kind: upload_reaped", () => {
    const valid = {
      kind: "upload_reaped",
      upload_id: "uuid-up",
      slug: "abcdefghijklmnopqrstuvwxyz",
      subject_kind: "user" as const,
      subject_id: "uuid-user",
      at: "2026-05-22T12:00:00Z",
    };
    it("accepts user subject_kind", () => {
      expect(narrowAdminEvent(valid)).toEqual(valid);
    });
    it("accepts visitor subject_kind", () => {
      expect(narrowAdminEvent({ ...valid, subject_kind: "visitor" })).toEqual({
        ...valid,
        subject_kind: "visitor",
      });
    });
    it("rejects unknown subject_kind", () => {
      expect(narrowAdminEvent({ ...valid, subject_kind: "anonymous" })).toBeNull();
    });
  });

  describe("kind: session_disconnected / session_terminated", () => {
    const base = {
      subject_kind: "user" as const,
      subject_id: "uuid-user",
      network_id: 1,
      network_slug: "azzurra",
      actor_user_id: "uuid-op",
      actor_user_name: "admin",
      at: "2026-05-22T12:00:00Z",
    };
    it("accepts disconnected", () => {
      const ev = { kind: "session_disconnected", ...base };
      expect(narrowAdminEvent(ev)).toEqual(ev);
    });
    it("accepts terminated with null actor", () => {
      const ev = {
        kind: "session_terminated",
        ...base,
        actor_user_id: null,
        actor_user_name: null,
      };
      expect(narrowAdminEvent(ev)).toEqual(ev);
    });
    it("rejects missing subject_id", () => {
      const { subject_id: _sid, ...rest } = base;
      expect(narrowAdminEvent({ kind: "session_disconnected", ...rest })).toBeNull();
    });
  });

  describe("kind: network_caps_updated", () => {
    const valid = {
      kind: "network_caps_updated",
      network_id: 1,
      network_slug: "azzurra",
      max_concurrent_visitor_sessions: 100,
      max_concurrent_user_sessions: 50,
      max_per_client: 5,
      actor_user_id: "uuid-op",
      actor_user_name: "admin",
      at: "2026-05-22T12:00:00Z",
    };
    it("accepts valid", () => {
      expect(narrowAdminEvent(valid)).toEqual(valid);
    });
    it("accepts null caps", () => {
      const ev = {
        ...valid,
        max_concurrent_visitor_sessions: null,
        max_concurrent_user_sessions: null,
        max_per_client: null,
      };
      expect(narrowAdminEvent(ev)).toEqual(ev);
    });
    it("rejects non-null non-number cap", () => {
      expect(narrowAdminEvent({ ...valid, max_per_client: "5" })).toBeNull();
    });
    it("rejects null network_slug (required non-null on this arm)", () => {
      expect(narrowAdminEvent({ ...valid, network_slug: null })).toBeNull();
    });
  });

  describe("kind: circuit_reset", () => {
    const valid = {
      kind: "circuit_reset",
      network_id: 1,
      network_slug: "azzurra",
      actor_user_id: "uuid-op",
      actor_user_name: "admin",
      at: "2026-05-22T12:00:00Z",
    };
    it("accepts valid", () => {
      expect(narrowAdminEvent(valid)).toEqual(valid);
    });
    it("accepts null slug + null actor", () => {
      expect(
        narrowAdminEvent({
          ...valid,
          network_slug: null,
          actor_user_id: null,
          actor_user_name: null,
        }),
      ).toEqual({
        ...valid,
        network_slug: null,
        actor_user_id: null,
        actor_user_name: null,
      });
    });
    it("rejects non-number network_id", () => {
      expect(narrowAdminEvent({ ...valid, network_id: "1" })).toBeNull();
    });
  });

  describe("kind: cap_counts_changed", () => {
    const valid = {
      kind: "cap_counts_changed",
      network_id: 1,
      network_slug: "azzurra",
      visitors: 12,
      users: 8,
      max_concurrent_visitor_sessions: 100,
      max_concurrent_user_sessions: 50,
      at: "2026-05-22T12:00:00Z",
    };
    it("accepts valid", () => {
      expect(narrowAdminEvent(valid)).toEqual(valid);
    });
    it("rejects negative-not-checked but non-number visitors", () => {
      expect(narrowAdminEvent({ ...valid, visitors: "12" })).toBeNull();
    });
  });
});

describe("narrowAdminSnapshot (REV-G H24)", () => {
  it("returns null on non-object", () => {
    expect(narrowAdminSnapshot(null)).toBeNull();
    expect(narrowAdminSnapshot("snapshot")).toBeNull();
    expect(narrowAdminSnapshot(undefined)).toBeNull();
  });
  it("returns null on missing events array", () => {
    expect(narrowAdminSnapshot({})).toBeNull();
    expect(narrowAdminSnapshot({ events: "not-array" })).toBeNull();
  });
  it("accepts empty events array", () => {
    expect(narrowAdminSnapshot({ events: [] })).toEqual({ events: [] });
  });
  it("accepts snapshot with valid events verbatim", () => {
    const ev = { kind: "reaper_swept", count: 3, at: "2026-05-22T12:00:00Z" };
    expect(narrowAdminSnapshot({ events: [ev] })).toEqual({ events: [ev] });
  });
  it("rejects entire snapshot when ONE element is malformed (atomic)", () => {
    const good = { kind: "reaper_swept", count: 3, at: "2026-05-22T12:00:00Z" };
    const bad = { kind: "reaper_swept", count: "3", at: "2026-05-22T12:00:00Z" };
    expect(narrowAdminSnapshot({ events: [good, bad] })).toBeNull();
  });
});

