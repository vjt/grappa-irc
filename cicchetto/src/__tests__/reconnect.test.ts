import { afterEach, describe, expect, it, vi } from "vitest";

// #282 — reconnectConnectedNetworks(): the verb behind the vhost sub-page
// footer "Reconnect to apply" button. The vhost (source-bind address) is
// account-level and resolved fresh PER CONNECT
// (`Grappa.Vhosts.effective_source/2`), so a changed selection only takes
// effect once the upstream socket is re-established. This verb BOUNCES
// every currently-`connected` network — park then reconnect — reusing the
// per-network `PATCH /networks/:slug {connection_state}` path the
// home-page Reconnect uses (the clean SAME-ACCOUNT teardown; NOT the #281
// account-SWITCH client purge, NOT the visitor identity-apply path).

type NetLocal = { slug: string; connection_state: "connected" | "parked" | "failed" };

const patchNetworkMock = vi.fn<
  (t: string, slug: string, body: { connection_state: string }) => Promise<void>
>(() => Promise.resolve());
const tokenMock = vi.fn<() => string | null>(() => "test-token");
const networksMock = vi.fn<() => NetLocal[]>(() => []);

vi.mock("../lib/api", () => ({
  patchNetwork: (t: string, slug: string, body: { connection_state: string }) =>
    patchNetworkMock(t, slug, body),
}));
vi.mock("../lib/auth", () => ({ token: () => tokenMock() }));
vi.mock("../lib/networks", () => ({ networks: () => networksMock() }));

import { reconnectConnectedNetworks } from "../lib/reconnect";

afterEach(() => {
  vi.clearAllMocks();
  tokenMock.mockReturnValue("test-token");
  networksMock.mockReturnValue([]);
});

// Per-network ordered spellings actually PATCHed, in call order.
const spellingsFor = (slug: string): string[] =>
  patchNetworkMock.mock.calls
    .filter((c) => c[1] === slug)
    .map((c) => (c[2] as { connection_state: string }).connection_state);

describe("reconnectConnectedNetworks — bounce every connected network", () => {
  it("parks then reconnects each connected network (park before connect, per network)", async () => {
    networksMock.mockReturnValue([
      { slug: "libera", connection_state: "connected" },
      { slug: "oftc", connection_state: "connected" },
    ]);

    await reconnectConnectedNetworks();

    expect(spellingsFor("libera")).toEqual(["parked", "connected"]);
    expect(spellingsFor("oftc")).toEqual(["parked", "connected"]);
  });

  it("skips networks NOT in the connected state (parked/failed left untouched)", async () => {
    networksMock.mockReturnValue([
      { slug: "libera", connection_state: "connected" },
      { slug: "oftc", connection_state: "parked" },
      { slug: "efnet", connection_state: "failed" },
    ]);

    await reconnectConnectedNetworks();

    const touched = new Set(patchNetworkMock.mock.calls.map((c) => c[1]));
    expect(touched).toEqual(new Set(["libera"]));
  });

  it("no-ops when the bearer is null (never PATCHes)", async () => {
    tokenMock.mockReturnValue(null);
    networksMock.mockReturnValue([{ slug: "libera", connection_state: "connected" }]);

    await reconnectConnectedNetworks();

    expect(patchNetworkMock).not.toHaveBeenCalled();
  });

  it("no-ops when there are no connected networks", async () => {
    networksMock.mockReturnValue([
      { slug: "libera", connection_state: "parked" },
      { slug: "oftc", connection_state: "failed" },
    ]);

    await reconnectConnectedNetworks();

    expect(patchNetworkMock).not.toHaveBeenCalled();
  });

  it("does NOT reconnect a network whose park PATCH failed", async () => {
    networksMock.mockReturnValue([{ slug: "libera", connection_state: "connected" }]);
    // park (first call) rejects → the reconnect half must not fire.
    patchNetworkMock.mockRejectedValueOnce(new Error("park failed"));

    await expect(reconnectConnectedNetworks()).rejects.toThrow("park failed");

    expect(spellingsFor("libera")).toEqual(["parked"]);
  });

  it("propagates a failure so the caller can surface it, but still bounces the healthy networks", async () => {
    networksMock.mockReturnValue([
      { slug: "libera", connection_state: "connected" },
      { slug: "oftc", connection_state: "connected" },
    ]);
    // Fail ONLY libera's park; oftc must still complete its park→connect.
    patchNetworkMock.mockImplementation((_t, slug, body) => {
      if (slug === "libera" && body.connection_state === "parked") {
        return Promise.reject(new Error("park failed"));
      }
      return Promise.resolve();
    });

    await expect(reconnectConnectedNetworks()).rejects.toThrow("park failed");

    expect(spellingsFor("oftc")).toEqual(["parked", "connected"]);
    expect(spellingsFor("libera")).toEqual(["parked"]);
  });
});
