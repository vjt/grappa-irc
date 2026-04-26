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
      user: { id: "u1", name: "alice" },
    });
    const auth = await import("../lib/auth");
    await auth.login("alice", "secret");
    expect(api.login).toHaveBeenCalledWith({ name: "alice", password: "secret" });
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
});
