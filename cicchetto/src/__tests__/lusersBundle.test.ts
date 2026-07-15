import { beforeEach, describe, expect, it, vi } from "vitest";

// #248 — LUSERS solicited-request gate.
//
// Bahamut auto-emits the 7-numeric LUSERS sequence at registration
// (connect-welcome). grappa NEVER self-issues LUSERS, so it forwards
// that unsolicited burst as the SAME `lusers_bundle` wire event an
// operator-issued /lusers produces. Pre-#248 the dispatch stored every
// bundle → the LusersCard auto-surfaced on connect, floating over the
// top of the message view; new users read the covered buffer as "my
// sent messages aren't showing".
//
// The store now gates the surface on a per-network solicited flag:
//   - markLusersRequested(slug) — operator issued /lusers.
//   - applyLusersBundle(slug, snap) — incoming bundle; surfaces ONLY
//     when a request is pending (consume-once), else dropped silently.
// The connect-welcome burst is never preceded by a request → dropped.
//
// Each test re-imports the module (resetModules) for a fresh store, and
// drives identity rotation via auth.setToken(...) like the sibling
// identity-scoped store tests (awayStatus.test.ts).

const SNAPSHOT = {
  total_users: 1234,
  invisible: 56,
  servers: 3,
  operators: 7,
  unknown_connections: 2,
  channels_formed: 89,
  local_clients: 100,
  local_servers: 1,
  current_local: 100,
  max_local: 200,
  current_global: 1234,
  max_global: 5000,
};

const OTHER_SNAPSHOT = { ...SNAPSHOT, total_users: 9999 };

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("lusersBundle store — solicited-request gate (#248)", () => {
  it("drops an UNSOLICITED bundle — connect-welcome auto-emit does not surface the card", async () => {
    const lb = await import("../lib/lusersBundle");

    // No markLusersRequested first — this is the Bahamut connect-welcome
    // burst grappa forwards on registration.
    lb.applyLusersBundle("azzurra", SNAPSHOT);

    expect(lb.lusersBundleByNetwork().azzurra).toBeUndefined();
  });

  it("surfaces a SOLICITED bundle — operator /lusers marks the request first", async () => {
    const lb = await import("../lib/lusersBundle");

    lb.markLusersRequested("azzurra");
    lb.applyLusersBundle("azzurra", SNAPSHOT);

    expect(lb.lusersBundleByNetwork().azzurra).toEqual(SNAPSHOT);
  });

  it("consume-once — a second (unsolicited) bundle does NOT replace the surfaced snapshot", async () => {
    const lb = await import("../lib/lusersBundle");

    lb.markLusersRequested("azzurra");
    lb.applyLusersBundle("azzurra", SNAPSHOT);
    expect(lb.lusersBundleByNetwork().azzurra).toEqual(SNAPSHOT);

    // e.g. a later connect-welcome reconnect burst — no fresh request.
    lb.applyLusersBundle("azzurra", OTHER_SNAPSHOT);

    expect(lb.lusersBundleByNetwork().azzurra).toEqual(SNAPSHOT);
  });

  it("per-network — a request for one network does not surface another network's bundle", async () => {
    const lb = await import("../lib/lusersBundle");

    lb.markLusersRequested("azzurra");

    // Unsolicited bundle for a DIFFERENT network → dropped.
    lb.applyLusersBundle("libera", SNAPSHOT);
    expect(lb.lusersBundleByNetwork().libera).toBeUndefined();

    // The pending azzurra request is untouched → its bundle surfaces.
    lb.applyLusersBundle("azzurra", SNAPSHOT);
    expect(lb.lusersBundleByNetwork().azzurra).toEqual(SNAPSHOT);
  });

  it("dismissLusersCard removes a surfaced snapshot", async () => {
    const lb = await import("../lib/lusersBundle");

    lb.markLusersRequested("azzurra");
    lb.applyLusersBundle("azzurra", SNAPSHOT);
    expect(lb.lusersBundleByNetwork().azzurra).toEqual(SNAPSHOT);

    lb.dismissLusersCard("azzurra");
    expect(lb.lusersBundleByNetwork().azzurra).toBeUndefined();
  });

  it("identity rotation clears a pending request — a bundle after rotation is dropped", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const lb = await import("../lib/lusersBundle");

    lb.markLusersRequested("azzurra");

    auth.setToken("tokB");
    await vi.waitFor(() => {
      // The rotation reset must clear pending requests too, else a
      // bundle that arrives after re-login spuriously surfaces.
      lb.applyLusersBundle("azzurra", SNAPSHOT);
      expect(lb.lusersBundleByNetwork().azzurra).toBeUndefined();
    });
  });

  it("identity rotation clears a surfaced snapshot", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const lb = await import("../lib/lusersBundle");

    lb.markLusersRequested("azzurra");
    lb.applyLusersBundle("azzurra", SNAPSHOT);
    expect(lb.lusersBundleByNetwork().azzurra).toEqual(SNAPSHOT);

    auth.setToken("tokB");
    await vi.waitFor(() => {
      expect(lb.lusersBundleByNetwork().azzurra).toBeUndefined();
    });
  });
});
