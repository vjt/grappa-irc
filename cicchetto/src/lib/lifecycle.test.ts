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

// Spread the REAL auth module so the pure `isPersistentIdentity` predicate
// (which quit() now routes on) runs for real against the stubbed
// getSubject — the whole point is to exercise the actual persistence
// classification, not a re-implemented copy. Only the side-effecting
// exports are stubbed.
vi.mock("./auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth")>()),
  logout: vi.fn().mockResolvedValue(undefined),
  clearLocalAuth: vi.fn(),
  token: () => "test-bearer",
  getSubject: () => subjectHolder.current,
}));

vi.mock("./api", () => ({
  deleteAccount: vi.fn().mockResolvedValue(undefined),
  updateNetworkIdentity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./quit", () => ({
  quitAll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./networks", () => ({
  refetchUser: vi.fn(),
}));

import { acceptConfirm, confirmRequest, dismissConfirm } from "./confirmDialog";
import { canDetach, confirmDetach, confirmQuit, deleteAccount, detach, quit } from "./lifecycle";

beforeEach(() => {
  vi.clearAllMocks();
  subjectHolder.current = null;
  dismissConfirm();
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

  it("visitor with registered === undefined (pre-field / not-registered) → logout only", async () => {
    const quitMod = await import("./quit");
    const auth = await import("./auth");
    // `registered` is optional (backward compat: a subject persisted
    // before the field landed reads as not-registered). Only an EXPLICIT
    // `registered === true` is a persistent identity — undefined is not.
    subjectHolder.current = { kind: "visitor", id: "v3", nick: "legacy" };

    await quit();

    expect(quitMod.quitAll).not.toHaveBeenCalled();
    expect(auth.logout).toHaveBeenCalled();
  });

  it("null subject (not yet loaded) → logout only, never parks", async () => {
    const quitMod = await import("./quit");
    const auth = await import("./auth");
    // The loading null-subject is not a persistent identity; it falls
    // through to the ephemeral (logout-only) path, never park-all.
    subjectHolder.current = null;

    await quit();

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

// #986 — the rail-actions confirm gate. `detach` / `quit` are no longer a
// bare button + a two-tap arm in the settings drawer: they are rail entries
// behind the shared #195 confirm modal, and the modal BODY must state the
// consequence that actually applies to the subject in front of it. The
// defect this closes is one shared sentence for three different events, so
// the load-bearing assertion is that the three bodies genuinely DIFFER —
// a "the modal opens" test would pass with the old six words intact.
describe("canDetach (#986)", () => {
  it("offers detach to a registered user", () => {
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };
    expect(canDetach()).toBe(true);
  });

  it("offers detach to a registered visitor (same persistence answer)", () => {
    subjectHolder.current = { kind: "visitor", id: "v1", nick: "vjt", registered: true };
    expect(canDetach()).toBe(true);
  });

  it("withholds detach from an ephemeral visitor — no bouncer to leave running", () => {
    subjectHolder.current = { kind: "visitor", id: "v2", nick: "anon", registered: false };
    expect(canDetach()).toBe(false);
  });

  it("withholds detach from the not-yet-loaded null subject", () => {
    subjectHolder.current = null;
    expect(canDetach()).toBe(false);
  });
});

describe("confirmQuit copy (#986)", () => {
  const bodyFor = (subject: typeof subjectHolder.current): string => {
    subjectHolder.current = subject;
    confirmQuit(vi.fn());
    const req = confirmRequest();
    if (req === null) throw new Error("confirmQuit did not raise a confirm request");
    return req.body;
  };

  const USER = { kind: "user", id: "u1", name: "alice" } as const;
  const REGISTERED = { kind: "visitor", id: "v1", nick: "vjt", registered: true } as const;
  const EPHEMERAL = { kind: "visitor", id: "v2", nick: "anon", registered: false } as const;

  it("gives the three subject shapes three DIFFERENT bodies", () => {
    const user = bodyFor(USER);
    const registeredVisitor = bodyFor(REGISTERED);
    const ephemeral = bodyFor(EPHEMERAL);

    expect(new Set([user, registeredVisitor, ephemeral]).size).toBe(3);
  });

  it("promises survival to both persistent identities and destruction to the anon one", () => {
    // The MEANING, not the wording: only the ephemeral copy may say the
    // session is deleted, and neither persistent copy may.
    expect(bodyFor(EPHEMERAL)).toMatch(/delete|permanently/i);
    expect(bodyFor(USER)).toMatch(/survive/i);
    expect(bodyFor(USER)).not.toMatch(/delete/i);
    expect(bodyFor(REGISTERED)).toMatch(/survive/i);
    expect(bodyFor(REGISTERED)).not.toMatch(/delete/i);
  });

  it("takes the ephemeral copy for the not-yet-loaded null subject (the arm quit() routes it to)", () => {
    expect(bodyFor(null)).toBe(bodyFor(EPHEMERAL));
  });

  it("adds NO typed re-entry gate — the modal explains and asks", () => {
    subjectHolder.current = USER;
    confirmQuit(vi.fn());
    // #986 ruling: the type-your-name gate is exclusive to delete account.
    // The confirm request carries no input contract at all — just a body,
    // an affirmative label, and (unused here) the #816 third door.
    expect(confirmRequest()?.alternative).toBeNull();
  });
});

describe("confirmDetach / confirmQuit wiring (#986)", () => {
  it("fires detach + the caller's landing only on the affirmative", async () => {
    const auth = await import("./auth");
    const onDone = vi.fn();
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };

    confirmDetach(onDone);
    expect(auth.logout).not.toHaveBeenCalled();

    acceptConfirm();
    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(auth.logout).toHaveBeenCalled();
  });

  it("dismissing the quit modal tears NOTHING down", async () => {
    const auth = await import("./auth");
    const quitMod = await import("./quit");
    const onDone = vi.fn();
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };

    confirmQuit(onDone);
    dismissConfirm();

    expect(quitMod.quitAll).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
  });

  it("confirming quit runs the subject's real teardown (user → park-all)", async () => {
    const quitMod = await import("./quit");
    const onDone = vi.fn();
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };

    confirmQuit(onDone);
    acceptConfirm();

    await vi.waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(quitMod.quitAll).toHaveBeenCalled();
  });
});
