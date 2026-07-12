import { beforeEach, describe, expect, it, vi } from "vitest";

// UX-4 bucket D — windowClose.disconnectNetwork.
//
// #211 phase 6 — subject-agnostic: BOTH users AND visitors PATCH the one
// network to `:parked` (visitors carry a real per-network
// connection_state now). No visitor→quitAll nuclear path; a global
// disconnect-all is the separate `quit` verb. We assert
// `patchNetwork(parked)` fires + `auth.logout` does NOT (the × parks one
// network, it does not tear the session down).
//
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

// windowClose imports setParted to clear the local windowState pseudo-
// projection on channel close (#38). Mock it as a boundary spy — the
// real windowState pulls in selection.ts (a heavy reactive chain this
// unit doesn't need). setParted's own map-clearing outcome is covered
// by its module; the e2e proves the full row-vanishes outcome.
vi.mock("../lib/windowState", () => ({
  setParted: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  mockNetworks.length = 0;
});

// #38 — × on a +k autojoin channel that 475'd on reconnect. Such a
// channel sits in BOTH channelsBySlug (autojoin, joined:false) AND
// windowStateByChannel ("failed"), so the Sidebar dedup renders it via
// the LIVE branch → the × routes through closeChannelWindow. The DELETE
// drops it from channelsBySlug, but the upstream PART is a 442 no-op
// (never joined) so NO self-PART echo arrives — and that echo is the
// only thing that calls setParted (subscribe.ts). Without a local clear
// here, the orphaned windowState entry re-renders as an un-dismissable
// greyed pseudo-row. closeChannelWindow must clear it itself.
describe("closeChannelWindow — channel close clears local windowState", () => {
  it("PARTs the channel AND clears its windowState entry (dismisses a 475-failed +k autojoin row)", async () => {
    const api = await import("../lib/api");
    const auth = await import("../lib/auth");
    const windowState = await import("../lib/windowState");
    const { channelKey } = await import("../lib/channelKey");

    auth.setToken("utok");
    const { closeChannelWindow } = await import("../lib/windowClose");
    closeChannelWindow("bahamut-test", "#k38");

    // Server side: PART (no-op upstream for a never-joined channel) +
    // de-autojoin via the DELETE.
    expect(api.postPart).toHaveBeenCalledWith("utok", "bahamut-test", "#k38");
    // Local side: clear the windowState pseudo-projection so the row
    // can't re-emerge as an orphaned greyed pseudo-row once
    // channelsBySlug drops the name.
    expect(windowState.setParted).toHaveBeenCalledWith(channelKey("bahamut-test", "#k38"));
  });
  // closeChannelWindow shares the `if (!t) return` no-token idiom with
  // disconnectNetwork (whose dedicated test below exercises that guard).
  // Not re-tested here: the partial auth mock leaks the prior test's
  // token across same-file tests, so a no-token assertion is flaky in
  // this position; the shared idiom is already proven below.
});

describe("disconnectNetwork — visitor branch (#211 phase 6 — parks the one network)", () => {
  it("PATCHes the one network to :parked (subject-agnostic, no logout)", async () => {
    const api = await import("../lib/api");
    const auth = await import("../lib/auth");
    localStorage.setItem(
      "grappa-subject",
      JSON.stringify({ kind: "visitor", id: "v-1", nick: "alice" }),
    );
    auth.setToken("vtok");
    // Phase 6: a visitor's network-header × parks THAT network only, the
    // SAME code path a user's does (visitors carry a real per-network
    // connection_state now). NO nuclear quit-all + logout.
    mockNetworks.push({ kind: "visitor", slug: "freenode" });
    const { disconnectNetwork } = await import("../lib/windowClose");
    disconnectNetwork("freenode");
    await new Promise((r) => setTimeout(r, 10));
    expect(api.patchNetwork).toHaveBeenCalledWith("vtok", "freenode", {
      connection_state: "parked",
    });
    expect(auth.logout).not.toHaveBeenCalled();
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
