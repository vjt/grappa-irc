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
    stubFetch(200, { id: "u1", name: "alice", inserted_at: "x" });
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
    await expect(api.login({ name: "x", password: "wrong" })).rejects.toBeInstanceOf(api.ApiError);
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
