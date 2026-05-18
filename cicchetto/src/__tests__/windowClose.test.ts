import { beforeEach, describe, expect, it, vi } from "vitest";

// UX-4 bucket D — windowClose.disconnectNetwork.
//
// Visitor branch: routes to quitAll → patchNetwork(parked) per network
// + logout. We assert auth.logout was called (the visitor session
// teardown) — the PATCH loop is exercised in compose.test.ts /quit
// coverage. quit.ts imports logout from auth (NOT from api), so the
// mock must replace auth.logout, not api.logout.
//
// User branch: PATCH /networks/:slug {connection_state: "parked"}.
// No selection-redirect here — that lives in selection.ts and is
// covered by selection.test.ts "parked-network → home redirect".

vi.mock(import("../lib/api"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    patchNetwork: vi.fn().mockResolvedValue({}),
    postPart: vi.fn().mockResolvedValue(undefined),
    setOn401Handler: vi.fn(),
    listNetworks: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([]),
    listMessages: vi.fn().mockResolvedValue([]),
    me: vi.fn().mockResolvedValue({
      kind: "user",
      id: "u-test",
      name: "alice",
      is_admin: false,
      inserted_at: "2026-01-01T00:00:00Z",
      read_cursors: {},
    }),
    logout: vi.fn().mockResolvedValue(undefined),
  };
});

// Mock auth.logout directly — quit.ts imports it from ./auth, NOT from
// ./api. Pre-fix mocking api.logout passed the test transitively
// because the real auth.logout calls api.logout internally, but if
// auth.logout ever short-circuits (e.g. visitor skips REST revoke) the
// test would silently false-pass. Per `feedback_no_silent_drops_closed`:
// assert on the actual boundary.
vi.mock(import("../lib/auth"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    logout: vi.fn().mockResolvedValue(undefined),
  };
});

const mockNetworks: { kind: string; slug: string }[] = [];
vi.mock("../lib/networks", () => ({
  networks: () => mockNetworks,
}));

vi.mock("../lib/queryWindows", () => ({
  closeQueryWindowState: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  mockNetworks.length = 0;
});

describe("disconnectNetwork — visitor branch", () => {
  it("calls quitAll path (PATCHes user networks then logs out via auth.logout) for visitor subject", async () => {
    const api = await import("../lib/api");
    const auth = await import("../lib/auth");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "visitor", id: "v-1", nick: "alice", network_slug: "freenode" }),
    );
    auth.setToken("vtok");
    // quit.ts filters to kind=user (visitor networks always 403 server-
    // side). Push a user network the visitor happens to have bound (rare
    // but possible in mixed-identity scenarios) so the PATCH+warn loop
    // has something to chew on; the assertion that auth.logout fires is
    // the visitor-tear-down truth signal regardless.
    mockNetworks.push({ kind: "user", slug: "freenode" });
    const { disconnectNetwork } = await import("../lib/windowClose");
    disconnectNetwork("freenode");
    // quitAll fires patchNetwork(parked) per user network then logout.
    // The disconnect call is fire-and-forget; await microtasks so the
    // promise chain settles.
    await new Promise((r) => setTimeout(r, 10));
    expect(api.patchNetwork).toHaveBeenCalledWith("vtok", "freenode", {
      connection_state: "parked",
    });
    expect(auth.logout).toHaveBeenCalled();
  });

  it("logs out via auth.logout even when no user networks are bound (visitor-only)", async () => {
    const api = await import("../lib/api");
    const auth = await import("../lib/auth");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "visitor", id: "v-2", nick: "bob", network_slug: "freenode" }),
    );
    auth.setToken("vtok2");
    mockNetworks.push({ kind: "visitor", slug: "freenode" });
    const { disconnectNetwork } = await import("../lib/windowClose");
    disconnectNetwork("freenode");
    await new Promise((r) => setTimeout(r, 10));
    // Visitor networks are filtered out; only logout fires.
    expect(api.patchNetwork).not.toHaveBeenCalled();
    expect(auth.logout).toHaveBeenCalled();
  });

  it("no-ops when no token is set (post-logout race)", async () => {
    const api = await import("../lib/api");
    const auth = await import("../lib/auth");
    const { disconnectNetwork } = await import("../lib/windowClose");
    disconnectNetwork("freenode");
    await new Promise((r) => setTimeout(r, 10));
    expect(api.patchNetwork).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it("no-ops + warns when subject is null (poisoned-localStorage race)", async () => {
    const api = await import("../lib/api");
    const auth = await import("../lib/auth");
    auth.setToken("tok-orphan");
    // No grappa-subject key — auth.getSubject() returns null.
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { disconnectNetwork } = await import("../lib/windowClose");
    disconnectNetwork("freenode");
    await new Promise((r) => setTimeout(r, 10));
    expect(api.patchNetwork).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("[/disconnect]"))).toBe(true);
    warnSpy.mockRestore();
  });
});

describe("disconnectNetwork — registered-user branch", () => {
  it("PATCHes the one named network to :parked without logging out", async () => {
    const api = await import("../lib/api");
    const auth = await import("../lib/auth");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u-1", name: "alice" }),
    );
    auth.setToken("utok");
    mockNetworks.push({ kind: "user", slug: "freenode" }, { kind: "user", slug: "azzurra" });
    const { disconnectNetwork } = await import("../lib/windowClose");
    disconnectNetwork("freenode");
    await new Promise((r) => setTimeout(r, 10));
    expect(api.patchNetwork).toHaveBeenCalledTimes(1);
    expect(api.patchNetwork).toHaveBeenCalledWith("utok", "freenode", {
      connection_state: "parked",
    });
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it("logs PATCH rejection but does NOT re-throw (fire-and-forget contract)", async () => {
    const api = await import("../lib/api");
    const auth = await import("../lib/auth");
    vi.mocked(api.patchNetwork).mockRejectedValueOnce(new Error("503 too_many_sessions"));
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "user", id: "u-1", name: "alice" }),
    );
    auth.setToken("utok");
    mockNetworks.push({ kind: "user", slug: "freenode" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { disconnectNetwork } = await import("../lib/windowClose");
    expect(() => disconnectNetwork("freenode")).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("[/disconnect]"))).toBe(true);
    warnSpy.mockRestore();
  });
});
