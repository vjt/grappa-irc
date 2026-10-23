import { createRoot, createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountSlot } from "../lib/e2e/identity";

// issue 2430, X1-crypto — the production wiring a pairing screen hands the
// session. The boundaries are faked: grappa's /me, the browser's stores, the
// networks resource (a Solid resource: state / error / value) and masterOf.

const h = vi.hoisted(() => ({
  token: vi.fn<() => string | null>(),
  me: vi.fn(),
  browserE2e: vi.fn(),
  masterOf: vi.fn(),
  list: null as null | (() => unknown),
  state: null as null | (() => string),
  error: null as null | (() => unknown),
  bySlug: vi.fn(),
}));

vi.mock("../lib/auth", () => ({ token: h.token }));
vi.mock("../lib/api", () => ({ me: h.me }));
vi.mock("../lib/e2e/browser", () => ({ browserE2e: h.browserE2e }));
vi.mock("../lib/e2e/identity", async (orig) => ({
  ...(await orig<typeof import("../lib/e2e/identity")>()),
  masterOf: h.masterOf,
}));
vi.mock("../lib/networks", () => ({
  networkBySlug: h.bySlug,
  // defineProperties, not Object.assign: assign would read the getters once.
  networks: Object.defineProperties(() => h.list?.(), {
    state: { get: () => h.state?.() },
    error: { get: () => h.error?.() },
  }),
}));

const { pairingDeps, holdsMasterHere } = await import("../lib/e2e/pairingDeps");

const E2E = { olm: "olm", accounts: "accounts" };
const NETS = [
  { slug: "azzurra", id: 1, nick: "vjt", extra: "dropped" },
  { slug: "libera", id: 7, nick: "vjt", extra: "dropped" },
];

let setState: (s: string) => void;
let setError: (e: unknown) => void;

beforeEach(() => {
  vi.clearAllMocks();
  const [state, ss] = createRoot(() => createSignal("ready"));
  const [error, se] = createRoot(() => createSignal<unknown>(undefined));
  setState = ss;
  setError = se;
  h.state = state;
  h.error = error;
  h.list = () => NETS;
  h.token.mockReturnValue("tok");
  h.me.mockResolvedValue({ kind: "user", id: "u-1", name: "vjt" });
  h.browserE2e.mockResolvedValue(E2E);
  h.masterOf.mockResolvedValue("MASTERKEY");
  h.bySlug.mockImplementation((slug: string) => NETS.find((n) => n.slug === slug));
});

describe("pairingDeps", () => {
  it("hands over the stores, the bearer, the account and the networks as {slug, id}", async () => {
    const deps = await pairingDeps("tok");
    expect(h.me).toHaveBeenCalledWith("tok", "shared");
    expect(deps.e2e).toBe(E2E);
    expect(deps.bearer).toBe("tok");
    expect(deps.subject).toEqual({ kind: "user", id: "u-1" });
    expect(deps.networks()).toEqual([
      { slug: "azzurra", id: 1 },
      { slug: "libera", id: 7 },
    ]);
  });

  it("waits for the networks to load before it resolves", async () => {
    setState("pending");
    let resolved = false;
    const result = pairingDeps("tok").then((d) => {
      resolved = true;
      return d;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    setState("ready");
    const deps = await result;
    expect(resolved).toBe(true);
    expect(deps.networks()).toHaveLength(2);
  });

  it("rejects when the networks failed to load", async () => {
    setState("pending");
    const result = pairingDeps("tok");
    const failure = new Error("networks down");
    setError(failure);
    setState("errored");
    await expect(result).rejects.toBe(failure);
  });
});

describe("holdsMasterHere", () => {
  it("asks masterOf about the slot of this account on that network", async () => {
    expect(await holdsMasterHere("libera")).toBe(true);
    expect(h.masterOf).toHaveBeenCalledWith(
      E2E.accounts,
      accountSlot({ kind: "user", id: "u-1" }, 7),
    );
  });

  it("is false when this browser holds no master for the slot", async () => {
    h.masterOf.mockResolvedValue(null);
    expect(await holdsMasterHere("azzurra")).toBe(false);
  });

  it("is false with no bearer, asking nothing", async () => {
    h.token.mockReturnValue(null);
    expect(await holdsMasterHere("azzurra")).toBe(false);
    expect(h.masterOf).not.toHaveBeenCalled();
  });

  it("is false on a network this account does not have, asking nothing", async () => {
    expect(await holdsMasterHere("nope")).toBe(false);
    expect(h.masterOf).not.toHaveBeenCalled();
  });
});
