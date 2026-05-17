import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";

// `api.ts` boundary: REST shape + 401 dead-token detect. The 401
// handler registry is the only mutable module-level state — explicit
// reset between cases via `setOn401Handler(null)`. fetch is stubbed
// with vi.stubGlobal so each test gates its own response shape.

beforeEach(() => {
  vi.restoreAllMocks();
  api.setOn401Handler(null);
});

afterEach(() => {
  api.setOn401Handler(null);
  vi.unstubAllGlobals();
});

function stubFetch(status: number, body: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
  );
}

describe("api 401 handler", () => {
  it("invokes the registered handler exactly once per 401 response", async () => {
    const handler = vi.fn();
    api.setOn401Handler(handler);
    stubFetch(401, { error: "unauthorized" });
    await expect(api.me("dead-token")).rejects.toBeInstanceOf(api.ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the handler on 4xx responses other than 401", async () => {
    const handler = vi.fn();
    api.setOn401Handler(handler);
    stubFetch(404, { errors: { detail: "not_found" } });
    await expect(api.me("any-token")).rejects.toBeInstanceOf(api.ApiError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not invoke the handler on 2xx success", async () => {
    const handler = vi.fn();
    api.setOn401Handler(handler);
    stubFetch(200, { kind: "user", id: "u1", name: "alice", is_admin: false, inserted_at: "x" });
    await expect(api.me("good-token")).resolves.toBeDefined();
    expect(handler).not.toHaveBeenCalled();
  });

  it("clears the handler when set to null", async () => {
    const handler = vi.fn();
    api.setOn401Handler(handler);
    api.setOn401Handler(null);
    stubFetch(401, { error: "unauthorized" });
    await expect(api.me("any-token")).rejects.toBeInstanceOf(api.ApiError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("login 401 (invalid_credentials) also fires the handler — benign no-op when no token is set", async () => {
    // Login is unauthenticated, so a 401 there means "wrong password,"
    // not "expired token." The handler still fires; the auth-side
    // setToken(null) is a no-op against an already-null token. Test
    // pins the by-design behavior so future-Claude doesn't add a
    // path-specific exception.
    const handler = vi.fn();
    api.setOn401Handler(handler);
    stubFetch(401, { error: "invalid_credentials" });
    await expect(api.login({ identifier: "x", password: "wrong" })).rejects.toBeInstanceOf(
      api.ApiError,
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("ApiError still carries the server-side error code on 401", async () => {
    api.setOn401Handler(() => {});
    stubFetch(401, { error: "unauthorized" });
    try {
      await api.me("dead-token");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(api.ApiError);
      const err = e as api.ApiError;
      expect(err.status).toBe(401);
      expect(err.code).toBe("unauthorized");
    }
  });
});

describe("listChannels (post-A5 wire shape)", () => {
  it("decodes {name, joined, source} entries", async () => {
    stubFetch(200, [
      { name: "#italia", joined: true, source: "autojoin" },
      { name: "#bnc", joined: true, source: "joined" },
    ]);

    const result = await api.listChannels("tok", "azzurra");

    expect(result).toEqual([
      { name: "#italia", joined: true, source: "autojoin" },
      { name: "#bnc", joined: true, source: "joined" },
    ]);
  });
});

// Bucket G H3 (codebase-review-2026-05-12): the canonical
// `WireChannelEvent` discriminated union now lives in api.ts (it was
// duplicated as a narrow `ChannelEvent` here + a full `WireEvent`
// local type in subscribe.ts pre-fix). The test exercises the
// exhaustiveness contract: `assertNever` over an exhaustive switch
// is a `tsc` compile-time guarantee, but a runtime "every kind
// narrows correctly" assertion locks in the discriminator field
// shape so a server-side rename (`kind: "join_failed"` →
// `kind: "joinFailed"`) breaks tests at the boundary, not deep in
// the per-arm handler.
describe("WireChannelEvent canonical union (H3)", () => {
  // Construct one example of each arm; the exhaustive switch below
  // exits with throw if a NEW arm is added without an arm here. Same
  // assertNever guarantee as the production handlers in subscribe.ts.
  const samples: Array<{ event: api.WireChannelEvent; expectedKind: string }> = [
    {
      event: {
        kind: "message",
        message: {
          id: 1,
          network: "azzurra",
          channel: "#italia",
          server_time: 1_700_000_000,
          kind: "privmsg",
          sender: "vjt",
          body: "ciao",
          meta: {},
        },
      },
      expectedKind: "message",
    },
    {
      event: {
        kind: "topic_changed",
        network: "azzurra",
        channel: "#italia",
        topic: { text: "ben(e)trovati", set_by: "vjt", set_at: null },
      },
      expectedKind: "topic_changed",
    },
    {
      event: {
        kind: "channel_modes_changed",
        network: "azzurra",
        channel: "#italia",
        modes: { modes: ["n", "t"], params: {} },
      },
      expectedKind: "channel_modes_changed",
    },
    {
      event: {
        kind: "channel_created",
        network: "azzurra",
        channel: "#italia",
        created_at: "2024-09-22T10:00:00Z",
      },
      expectedKind: "channel_created",
    },
    {
      event: {
        kind: "members_seeded",
        network: "azzurra",
        channel: "#italia",
        members: [],
      },
      expectedKind: "members_seeded",
    },
    {
      event: { kind: "joined", network: "azzurra", channel: "#italia", state: "joined" },
      expectedKind: "joined",
    },
    {
      event: {
        kind: "join_failed",
        network: "azzurra",
        channel: "#italia",
        state: "failed",
        reason: "channel is invite-only",
        numeric: 473,
      },
      expectedKind: "join_failed",
    },
    {
      event: {
        kind: "kicked",
        network: "azzurra",
        channel: "#italia",
        state: "kicked",
        by: "op",
        reason: "spam",
      },
      expectedKind: "kicked",
    },
    {
      event: { kind: "read_cursor_set", last_read_message_id: 42 },
      expectedKind: "read_cursor_set",
    },
    // P-0e + P-0f — invite_ack moved from WireChannelEvent to
    // WireUserEvent (operators usually invite peers to channels they
    // are NOT in; per-channel routing silent-dropped). Sample removed.
  ];

  it("each canonical arm narrows on the discriminator", () => {
    for (const { event, expectedKind } of samples) {
      // Exhaustive switch — same shape as subscribe.ts handlers. If a
      // new arm is added to WireChannelEvent without a clause here,
      // tsc fails on the assertNever default with "Argument of type
      // ... is not assignable to parameter of type 'never'".
      switch (event.kind) {
        case "message":
        case "topic_changed":
        case "channel_modes_changed":
        case "channel_created":
        case "members_seeded":
        case "joined":
        case "join_failed":
        case "kicked":
        case "read_cursor_set":
          expect(event.kind).toBe(expectedKind);
          break;
        default:
          api.assertNever(event);
      }
    }
  });

  it("ChannelEvent legacy alias === Extract<WireChannelEvent, {kind:'message'}>", () => {
    // Backwards compatibility: pre-fix consumers depended on
    // `ChannelEvent` being a `{kind:"message", message}` shape. Lock
    // it in so a future PR doesn't accidentally widen the alias.
    const ev: api.ChannelEvent = {
      kind: "message",
      message: {
        id: 1,
        network: "azzurra",
        channel: "#italia",
        server_time: 1,
        kind: "privmsg",
        sender: "vjt",
        body: "x",
        meta: {},
      },
    };
    expect(ev.kind).toBe("message");
  });
});

describe("ApiError info field (T31 admission errors)", () => {
  it("ApiError carries parsed body in info field", async () => {
    stubFetch(400, {
      error: "captcha_required",
      site_key: "k",
      provider: "turnstile",
    });
    try {
      await api.login({ identifier: "alice" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(api.ApiError);
      const err = e as api.ApiError;
      expect(err.code).toBe("captcha_required");
      expect(err.info.site_key).toBe("k");
      expect(err.info.provider).toBe("turnstile");
    }
  });

  it("ApiError extracts Retry-After header into info.retry_after", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "network_unreachable" }), {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": "30",
          },
        }),
      ),
    );
    try {
      await api.login({ identifier: "alice" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(api.ApiError);
      const err = e as api.ApiError;
      expect(err.code).toBe("network_unreachable");
      expect(err.info.retry_after).toBe(30);
    }
  });
});

// Bucket G H2+U4 (codebase-review-2026-05-12): unified `{error,
// field_errors}` envelope for 422 changeset failures. Server-side
// `FallbackController` now emits `%{error: "validation_failed",
// field_errors: %{field => [msg]}}` matching the existing snake_case
// `error: "<token>"` convention; cic side reads it through the same
// `readError` path that already populates `ApiError.info`.
//
// Pre-bucket-G: server emitted `%{errors: %{field => [msg]}}` (no
// `error` discriminator) and `readError` fell through to
// `body.errors.detail` (Phoenix default-error shape). Every 422
// collapsed to `code = res.statusText = "Unprocessable Entity"` and
// the operator lost field-level error info.
describe("ApiError 422 validation envelope (H2+U4)", () => {
  it("422 validation_failed carries field_errors in ApiError.info", async () => {
    stubFetch(422, {
      error: "validation_failed",
      field_errors: {
        nick: ["can't be blank"],
        body: ["should be at least 3 character(s)"],
      },
    });
    try {
      await api.login({ identifier: "alice" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(api.ApiError);
      const err = e as api.ApiError;
      expect(err.status).toBe(422);
      expect(err.code).toBe("validation_failed");
      const fieldErrors = err.info.field_errors as Record<string, string[]>;
      expect(fieldErrors.nick).toEqual(["can't be blank"]);
      expect(fieldErrors.body).toEqual(["should be at least 3 character(s)"]);
    }
  });
});

describe("postTopic / postNick", () => {
  it("postTopic POSTs JSON to /networks/:slug/channels/:chan/topic", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.postTopic("tok", "azzurra", "#italia", "ciao");

    expect(fetchMock).toHaveBeenCalledWith(
      "/networks/azzurra/channels/%23italia/topic",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ body: "ciao" }),
      }),
    );
  });

  it("postNick POSTs JSON to /networks/:slug/nick", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 202 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.postNick("tok", "azzurra", "vjt-away");

    expect(fetchMock).toHaveBeenCalledWith(
      "/networks/azzurra/nick",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ nick: "vjt-away" }),
      }),
    );
  });
});

describe("ownNickForNetwork (cic H3 fix + bucket F H4 type split)", () => {
  // Per-network IRC nick resolver — single source of truth for the
  // "what's my IRC nick on THIS network" question. Replaces the
  // per-callsite `net.nick ?? displayNick(u)` fallback that silently
  // DM-misrouted when the operator's account name happened to match a
  // peer's IRC nick on a network where the configured IRC nick was
  // different (e.g. account "vjt", peer "vjt", own IRC nick "grappa").
  // See lib/api.ts moduledoc for the full rule set.
  //
  // Bucket F H4: the missing-nick branch moved up to `tagNetwork` at
  // the fetch boundary — `Network` (the discriminated union) now
  // makes `nick` REQUIRED on `UserNetwork`. The tests here exercise
  // the post-tag invariants; tagNetwork's own contract has its own
  // describe block below.

  const azzurraUser: api.UserNetwork = {
    kind: "user",
    id: 1,
    slug: "azzurra",
    nick: "grappa",
    connection_state: "connected",
    connection_state_reason: null,
    connection_state_changed_at: null,
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const azzurraVisitor: api.VisitorNetwork = {
    kind: "visitor",
    id: 1,
    slug: "azzurra",
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const ircnetVisitor: api.VisitorNetwork = {
    kind: "visitor",
    id: 2,
    slug: "ircnet",
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  const userMe: api.MeResponse = {
    kind: "user",
    id: "u1",
    name: "vjt",
    is_admin: false,
    inserted_at: "2026-01-01T00:00:00Z",
  };
  const visitorMe: api.MeResponse = {
    kind: "visitor",
    id: "v1",
    nick: "guest42",
    network_slug: "azzurra",
    expires_at: "2026-12-31T00:00:00Z",
  };

  it("user + UserNetwork → returns net.nick (canonical IRC nick)", () => {
    expect(api.ownNickForNetwork(azzurraUser, userMe)).toBe("grappa");
    // Crucially NOT "vjt" (the account name).
  });

  it("user + VisitorNetwork → returns null + logs (kind mismatch contract violation)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(api.ownNickForNetwork(azzurraVisitor, userMe)).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("azzurra");
    expect(errSpy.mock.calls[0]?.[0]).toContain("cic H4");
    errSpy.mockRestore();
  });

  it("visitor + matching network_slug → returns visitor.nick", () => {
    expect(api.ownNickForNetwork(azzurraVisitor, visitorMe)).toBe("guest42");
  });

  it("visitor + non-matching network → returns null (no credential)", () => {
    expect(api.ownNickForNetwork(ircnetVisitor, visitorMe)).toBeNull();
    // Visitors have ONE network only — the one they logged into. Any
    // other Network.t() in their networks() list is a server bug, but
    // we tolerate it as null rather than throwing.
  });

  it("null me → returns null", () => {
    expect(api.ownNickForNetwork(azzurraUser, null)).toBeNull();
  });
});

describe("tagNetwork (bucket F H4)", () => {
  // Boundary tagger — promotes a raw wire RawNetwork to a
  // discriminated UserNetwork | VisitorNetwork based on the subject
  // kind. Server contract violations on user subjects (missing nick
  // OR missing connection_state) are dropped (return null) so the
  // boundary fetcher in lib/networks.ts filters them before the
  // typed store sees them.

  const rawComplete: api.RawNetwork = {
    kind: "user",
    id: 7,
    slug: "azzurra",
    nick: "grappa",
    connection_state: "connected",
    connection_state_reason: null,
    connection_state_changed_at: null,
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  const rawBare: api.RawNetwork = {
    kind: "user",
    id: 8,
    slug: "guest-net",
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };

  it("kind=visitor → returns VisitorNetwork (bare; ignores user-only fields)", () => {
    const out = api.tagNetwork({ ...rawComplete, kind: "visitor" });
    expect(out).not.toBeNull();
    expect(out?.kind).toBe("visitor");
    expect(out).toEqual({
      kind: "visitor",
      id: 7,
      slug: "azzurra",
      inserted_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    });
  });

  it("kind=user + complete raw → returns UserNetwork", () => {
    const out = api.tagNetwork(rawComplete);
    expect(out).not.toBeNull();
    expect(out?.kind).toBe("user");
    if (out?.kind === "user") {
      expect(out.nick).toBe("grappa");
      expect(out.connection_state).toBe("connected");
    }
  });

  it("kind=user + missing nick → returns null + logs", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(api.tagNetwork(rawBare)).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("guest-net");
    expect(errSpy.mock.calls[0]?.[0]).toContain("cic H4");
    errSpy.mockRestore();
  });

  it("kind=user + empty-string nick → returns null + logs", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(api.tagNetwork({ ...rawComplete, nick: "" })).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });

  it("kind=user + missing connection_state → returns null + logs", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const partial: api.RawNetwork = {
      kind: "user",
      id: 9,
      slug: "needsconn",
      nick: "vjt",
      inserted_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    };
    expect(api.tagNetwork(partial)).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
    errSpy.mockRestore();
  });
});

describe("deleteArchiveEntry (UX-1)", () => {
  it("DELETE /networks/:slug/archive/:target with bearer + percent-encoded target", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.deleteArchiveEntry("tok", "freenode", "#sniffo");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch not called");
    const [url, opts] = call as [string, RequestInit];
    expect(url).toBe("/networks/freenode/archive/%23sniffo");
    expect(opts.method).toBe("DELETE");
    expect((opts.headers as Record<string, string>).authorization).toBe("Bearer tok");
  });

  it("query-shaped target works without sigil encoding (peer nick passes through)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await api.deleteArchiveEntry("tok", "freenode", "vjt-peer");

    const call = fetchMock.mock.calls[0];
    if (!call) throw new Error("fetch not called");
    const [url] = call as [string, RequestInit];
    expect(url).toBe("/networks/freenode/archive/vjt-peer");
  });

  it("rejects with ApiError on 4xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: "bad_request" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    await expect(api.deleteArchiveEntry("tok", "freenode", "#bad")).rejects.toBeInstanceOf(
      api.ApiError,
    );
  });
});
