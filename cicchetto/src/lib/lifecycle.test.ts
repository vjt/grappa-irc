import { beforeEach, describe, expect, it, vi } from "vitest";

// #126 + #211 phase 6 — canonical lifecycle verb routing (detach / quit).
// This is the wiring gate: which server call(s) each verb fires, per
// subject kind. The SettingsDrawer test owns the per-subject RENDERING
// gate; this owns the per-subject BEHAVIOUR.
//
// Phase 6 — the visitor `disconnect`/`reconnect` lifecycle verbs are
// RETIRED. Per-network park/reconnect moved to the home page (`patchNetwork`
// / the shared `PATCH /networks/:id`); global disconnect is `quit`
// (client-composed park-all via `quitAll`), for BOTH subjects.

const subjectHolder = vi.hoisted(() => ({
  current: null as
    | { kind: "user"; id: string; name: string }
    | { kind: "visitor"; id: string; nick: string; registered?: boolean }
    | null,
}));

vi.mock("./auth", () => ({
  logout: vi.fn().mockResolvedValue(undefined),
  clearLocalAuth: vi.fn(),
  token: () => "test-bearer",
  getSubject: () => subjectHolder.current,
}));

vi.mock("./api", () => ({
  deleteAccount: vi.fn().mockResolvedValue(undefined),
  updateIdentity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./quit", () => ({
  quitAll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./networks", () => ({
  refetchUser: vi.fn(),
}));

import { deleteAccount, detach, quit } from "./lifecycle";

beforeEach(() => {
  vi.clearAllMocks();
  subjectHolder.current = null;
});

describe("detach", () => {
  it("revokes the web session via logout (bouncer stays up)", async () => {
    const auth = await import("./auth");
    const quitMod = await import("./quit");
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };

    await detach();

    expect(auth.logout).toHaveBeenCalled();
    // detach is the ABSENCE of teardown — never parks.
    expect(quitMod.quitAll).not.toHaveBeenCalled();
  });
});

describe("quit", () => {
  it("user → parks all networks then detaches (quitAll)", async () => {
    const quitMod = await import("./quit");
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };

    await quit();

    expect(quitMod.quitAll).toHaveBeenCalled();
  });

  it("registered visitor → ALSO parks all networks then detaches (phase 6 park-all)", async () => {
    const quitMod = await import("./quit");
    subjectHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "vjt",
      registered: true,
    };

    await quit();

    // Phase 6: a registered visitor's global disconnect IS the same
    // client-composed park-all a user's is — persists across reboot.
    expect(quitMod.quitAll).toHaveBeenCalled();
  });

  it("ephemeral visitor → detaches only (logout's anon branch stops + purges server-side)", async () => {
    const quitMod = await import("./quit");
    const auth = await import("./auth");
    subjectHolder.current = {
      kind: "visitor",
      id: "v2",
      nick: "guest",
      registered: false,
    };

    await quit();

    // No park-all: an anon visitor's row is purged by logout server-side.
    expect(quitMod.quitAll).not.toHaveBeenCalled();
    expect(auth.logout).toHaveBeenCalled();
  });
});

describe("deleteAccount (#157)", () => {
  it("wipes server-side then clears the local bearer", async () => {
    const api = await import("./api");
    const auth = await import("./auth");
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };

    await deleteAccount();

    expect(api.deleteAccount).toHaveBeenCalledWith("test-bearer");
    expect(auth.clearLocalAuth).toHaveBeenCalled();
  });

  it("is DISTINCT from quit — never parks / logs out", async () => {
    const auth = await import("./auth");
    const quitMod = await import("./quit");
    subjectHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "vjt",
      registered: true,
    };

    await deleteAccount();

    expect(quitMod.quitAll).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it("does NOT clear the local bearer when the server wipe fails (account still exists)", async () => {
    const api = await import("./api");
    const auth = await import("./auth");
    (api.deleteAccount as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("forbidden"));
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };

    await expect(deleteAccount()).rejects.toThrow("forbidden");
    expect(auth.clearLocalAuth).not.toHaveBeenCalled();
  });
});
