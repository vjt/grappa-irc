import { beforeEach, describe, expect, it, vi } from "vitest";

// #126 — canonical lifecycle verb routing (detach / disconnect /
// reconnect / quit). This is the wiring gate: which server call(s) each
// verb fires, per subject kind. The SettingsDrawer test owns the
// per-subject RENDERING gate; this owns the per-subject BEHAVIOUR.

const subjectHolder = vi.hoisted(() => ({
  current: null as
    | { kind: "user"; id: string; name: string }
    | { kind: "visitor"; id: string; nick: string; network_slug: string; registered?: boolean }
    | null,
}));

vi.mock("./auth", () => ({
  logout: vi.fn().mockResolvedValue(undefined),
  token: () => "test-bearer",
  getSubject: () => subjectHolder.current,
}));

vi.mock("./api", () => ({
  disconnectSession: vi.fn().mockResolvedValue(undefined),
  reconnectSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./quit", () => ({
  quitAll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./networks", () => ({
  refetchUser: vi.fn(),
}));

import { detach, disconnect, quit, reconnect } from "./lifecycle";

beforeEach(() => {
  vi.clearAllMocks();
  subjectHolder.current = null;
});

describe("detach", () => {
  it("revokes the web session via logout (bouncer stays up)", async () => {
    const auth = await import("./auth");
    const api = await import("./api");
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };

    await detach();

    expect(auth.logout).toHaveBeenCalled();
    // detach is the ABSENCE of teardown — never drops the upstream.
    expect(api.disconnectSession).not.toHaveBeenCalled();
  });
});

describe("quit", () => {
  it("user → parks all networks then detaches (quitAll)", async () => {
    const quitMod = await import("./quit");
    const api = await import("./api");
    subjectHolder.current = { kind: "user", id: "u1", name: "alice" };

    await quit();

    expect(quitMod.quitAll).toHaveBeenCalled();
    expect(api.disconnectSession).not.toHaveBeenCalled();
  });

  it("registered visitor → drops the upstream (disconnectSession) THEN detaches", async () => {
    const api = await import("./api");
    const auth = await import("./auth");
    subjectHolder.current = {
      kind: "visitor",
      id: "v1",
      nick: "vjt",
      network_slug: "azzurra",
      registered: true,
    };

    await quit();

    expect(api.disconnectSession).toHaveBeenCalledWith("test-bearer");
    expect(auth.logout).toHaveBeenCalled();
  });

  it("ephemeral visitor → detaches only (logout's anon branch stops + purges server-side)", async () => {
    const api = await import("./api");
    const auth = await import("./auth");
    subjectHolder.current = {
      kind: "visitor",
      id: "v2",
      nick: "guest",
      network_slug: "azzurra",
      registered: false,
    };

    await quit();

    // No client-side disconnect: an ephemeral visitor is never offered
    // the disconnect endpoint (it would 403). logout purges it server-side.
    expect(api.disconnectSession).not.toHaveBeenCalled();
    expect(auth.logout).toHaveBeenCalled();
  });
});

describe("disconnect / reconnect (registered visitor)", () => {
  it("disconnect drops the upstream then refetches /me (connected flips)", async () => {
    const api = await import("./api");
    const networks = await import("./networks");

    await disconnect();

    expect(api.disconnectSession).toHaveBeenCalledWith("test-bearer");
    expect(networks.refetchUser).toHaveBeenCalled();
  });

  it("reconnect respawns the upstream then refetches /me", async () => {
    const api = await import("./api");
    const networks = await import("./networks");

    await reconnect();

    expect(api.reconnectSession).toHaveBeenCalledWith("test-bearer");
    expect(networks.refetchUser).toHaveBeenCalled();
  });
});
