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
    stubFetch(200, { kind: "user", id: "u1", name: "alice", inserted_at: "x" });
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

describe("ownNickForNetwork (cic H3 fix)", () => {
  // Per-network IRC nick resolver — single source of truth for the
  // "what's my IRC nick on THIS network" question. Replaces the
  // per-callsite `net.nick ?? displayNick(u)` fallback that silently
  // DM-misrouted when the operator's account name happened to match a
  // peer's IRC nick on a network where the configured IRC nick was
  // different (e.g. account "vjt", peer "vjt", own IRC nick "grappa").
  // See lib/api.ts moduledoc for the full rule set.

  const azzurra: api.Network = {
    id: 1,
    slug: "azzurra",
    nick: "grappa",
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const ircnet: api.Network = {
    id: 2,
    slug: "ircnet",
    inserted_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    // nick intentionally absent → server-contract violation branch
  };

  const userMe: api.MeResponse = {
    kind: "user",
    id: "u1",
    name: "vjt",
    inserted_at: "2026-01-01T00:00:00Z",
  };
  const visitorMe: api.MeResponse = {
    kind: "visitor",
    id: "v1",
    nick: "guest42",
    network_slug: "azzurra",
    expires_at: "2026-12-31T00:00:00Z",
  };

  it("user + populated net.nick → returns net.nick (canonical IRC nick)", () => {
    expect(api.ownNickForNetwork(azzurra, userMe)).toBe("grappa");
    // Crucially NOT "vjt" (the account name) — the pre-fix fallback
    // would have returned "vjt" if net.nick were missing, silently
    // mismatching the IRC nick the server broadcasts on.
  });

  it("user + missing net.nick → returns null + logs to console.error", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(api.ownNickForNetwork(ircnet, userMe)).toBeNull();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("ircnet");
    expect(errSpy.mock.calls[0]?.[0]).toContain("cic H3");
    errSpy.mockRestore();
    // The pre-fix behavior was to fall back to displayNick(me) === me.name,
    // returning "vjt" — this test pins that we now refuse and surface the
    // server contract drift loudly instead of DM-misrouting silently.
  });

  it("user + empty-string net.nick → returns null (treated as missing)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(api.ownNickForNetwork({ ...azzurra, nick: "" }, userMe)).toBeNull();
    errSpy.mockRestore();
  });

  it("visitor + matching network_slug → returns visitor.nick", () => {
    expect(api.ownNickForNetwork(azzurra, visitorMe)).toBe("guest42");
  });

  it("visitor + non-matching network → returns null (no credential)", () => {
    expect(api.ownNickForNetwork(ircnet, visitorMe)).toBeNull();
    // Visitors have ONE network only — the one they logged into. Any
    // other Network.t() in their networks() list is a server bug, but
    // we tolerate it as null rather than throwing.
  });

  it("null me → returns null", () => {
    expect(api.ownNickForNetwork(azzurra, null)).toBeNull();
  });
});
