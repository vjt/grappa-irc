import { beforeEach, describe, expect, it, vi } from "vitest";

// `auth.ts` reads `localStorage` at module load to seed its signal — so
// every test that asserts a different starting state has to (1) seed
// localStorage, (2) reset the module registry, (3) re-import. Without
// `vi.resetModules()` the second test would observe the first test's
// signal value because the module instance is cached across imports.

vi.mock("../lib/api", () => ({
  login: vi.fn(),
  me: vi.fn(),
  logout: vi.fn(),
  setOn401Handler: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("auth signal store", () => {
  it("initializes token from localStorage on module load", async () => {
    localStorage.setItem("grappa-token", "abc");
    const auth = await import("../lib/auth");
    expect(auth.token()).toBe("abc");
    expect(auth.isAuthenticated()).toBe(true);
  });

  it("starts with null token when localStorage is empty", async () => {
    const auth = await import("../lib/auth");
    expect(auth.token()).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it("setToken writes to localStorage and updates the signal", async () => {
    const auth = await import("../lib/auth");
    auth.setToken("xyz");
    expect(localStorage.getItem("grappa-token")).toBe("xyz");
    expect(auth.token()).toBe("xyz");
    expect(auth.isAuthenticated()).toBe(true);
  });

  it("setToken(null) removes from localStorage and clears the signal", async () => {
    localStorage.setItem("grappa-token", "abc");
    const auth = await import("../lib/auth");
    auth.setToken(null);
    expect(localStorage.getItem("grappa-token")).toBeNull();
    expect(auth.token()).toBeNull();
    expect(auth.isAuthenticated()).toBe(false);
  });

  it("login() calls api.login and stores returned token", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.login).mockResolvedValue({
      token: "tok-123",
      subject: { kind: "user", id: "u1", name: "alice" },
    });
    const auth = await import("../lib/auth");
    await auth.login("alice", "secret");
    expect(api.login).toHaveBeenCalledWith({ identifier: "alice", password: "secret" });
    expect(auth.token()).toBe("tok-123");
    expect(localStorage.getItem("grappa-token")).toBe("tok-123");
  });

  it("logout() calls api.logout with current token and clears state", async () => {
    localStorage.setItem("grappa-token", "tok-abc");
    const api = await import("../lib/api");
    vi.mocked(api.logout).mockResolvedValue(undefined);
    const auth = await import("../lib/auth");
    await auth.logout();
    expect(api.logout).toHaveBeenCalledWith("tok-abc");
    expect(auth.token()).toBeNull();
    expect(localStorage.getItem("grappa-token")).toBeNull();
  });

  // C3 — localStorage is mutated by the user (devtools), browser
  // extensions, and any successful XSS. `getSubject()` MUST narrow on
  // `unknown` and reject malformed payloads, otherwise a tampered
  // {"kind":"user"} (missing id/name) types as Subject and downstream
  // consumers reading `subject.name` get `undefined` typed as `string`.
  describe("getSubject() validation", () => {
    it("returns null when no key present", async () => {
      const auth = await import("../lib/auth");
      expect(auth.getSubject()).toBeNull();
    });

    it("returns valid user subject", async () => {
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "user", id: "u1", name: "alice" }),
      );
      const auth = await import("../lib/auth");
      const s = auth.getSubject();
      expect(s).toEqual({ kind: "user", id: "u1", name: "alice" });
    });

    it("returns valid visitor subject", async () => {
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({
          kind: "visitor",
          id: "v1",
          nick: "vjt",
          network_slug: "azzurra",
        }),
      );
      const auth = await import("../lib/auth");
      const s = auth.getSubject();
      expect(s).toEqual({
        kind: "visitor",
        id: "v1",
        nick: "vjt",
        network_slug: "azzurra",
      });
    });

    it("returns null + clears key on tampered user (missing fields)", async () => {
      localStorage.setItem("grappa-subject", JSON.stringify({ kind: "user" }));
      const auth = await import("../lib/auth");
      expect(auth.getSubject()).toBeNull();
      expect(localStorage.getItem("grappa-subject")).toBeNull();
    });

    it("returns null + clears key on tampered visitor (missing network_slug)", async () => {
      localStorage.setItem(
        "grappa-subject",
        JSON.stringify({ kind: "visitor", id: "v1", nick: "vjt" }),
      );
      const auth = await import("../lib/auth");
      expect(auth.getSubject()).toBeNull();
      expect(localStorage.getItem("grappa-subject")).toBeNull();
    });

    it("returns null + clears key on unknown kind", async () => {
      localStorage.setItem("grappa-subject", JSON.stringify({ kind: "robot", id: "r1" }));
      const auth = await import("../lib/auth");
      expect(auth.getSubject()).toBeNull();
      expect(localStorage.getItem("grappa-subject")).toBeNull();
    });

    it("returns null + clears key on non-JSON gibberish", async () => {
      localStorage.setItem("grappa-subject", "not-json{{");
      const auth = await import("../lib/auth");
      expect(auth.getSubject()).toBeNull();
      expect(localStorage.getItem("grappa-subject")).toBeNull();
    });

    it("returns null + clears key on non-object payload (string)", async () => {
      localStorage.setItem("grappa-subject", JSON.stringify("hello"));
      const auth = await import("../lib/auth");
      expect(auth.getSubject()).toBeNull();
      expect(localStorage.getItem("grappa-subject")).toBeNull();
    });
  });

  // M-cic-6 — `setOn401Handler` used to fire as a module-load side
  // effect of `auth.ts`. Any test that imported `auth.ts` (directly or
  // transitively, e.g. via `Login.tsx`) wired the global api module's
  // 401 handler before Vitest's mock-reset window opened, leaking
  // state across files. Move to an explicit `bootstrapAuth()` called
  // once from `main.tsx`; importing the module no longer mutates
  // the api module.
  describe("bootstrapAuth() — explicit 401 handler wiring", () => {
    it("does NOT register a 401 handler at module load", async () => {
      let registrations = 0;
      vi.doMock("../lib/api", () => ({
        login: vi.fn(),
        me: vi.fn(),
        logout: vi.fn(),
        setOn401Handler: vi.fn().mockImplementation(() => {
          registrations++;
        }),
      }));
      await import("../lib/auth");
      expect(registrations).toBe(0);
      vi.doUnmock("../lib/api");
    });

    it("registers a 401 handler that clears the token when bootstrapAuth is called", async () => {
      let captured: (() => void) | null = null;
      vi.doMock("../lib/api", () => ({
        login: vi.fn(),
        me: vi.fn(),
        logout: vi.fn(),
        setOn401Handler: vi.fn().mockImplementation((fn: () => void) => {
          captured = fn;
        }),
      }));
      localStorage.setItem("grappa-token", "tok-stale");
      const auth = await import("../lib/auth");
      expect(auth.token()).toBe("tok-stale");
      // Pre-bootstrap: no handler captured yet.
      expect(captured).toBeNull();
      auth.bootstrapAuth();
      expect(captured).not.toBeNull();
      if (captured !== null) (captured as () => void)();
      expect(auth.token()).toBeNull();
      expect(localStorage.getItem("grappa-token")).toBeNull();
      vi.doUnmock("../lib/api");
    });
  });
});
