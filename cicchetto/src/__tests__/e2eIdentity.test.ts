// issue 2430 — the identity sync: what cic asks grappa, in what order, and
// what it keeps; above all, that an identity grappa holds is never replaced
// unless the user asks for it (vjt 6344779758). REST is mocked at the api
// module (the boundary) and answered by the fake grappa v2
// (`helpers/e2eGrappa.ts`), which refuses what grappa refuses; the account
// store is the real one over in-memory twins of IndexedDB and Web Locks, and
// the keys are real vodozemac keys.
import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStore } from "../lib/e2e/accountStore";
import type { E2eState } from "../lib/e2e/engine";
import { Grappa, routeApi } from "./helpers/e2eGrappa";
import { type MemoryVault, memoryLock, memoryVault } from "./helpers/e2eVault";
import { olm } from "./helpers/olm";

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return {
    ApiError: real.ApiError,
    registerE2eDevice: vi.fn(),
    listE2eDevices: vi.fn(),
    removeE2eDevice: vi.fn(),
    getE2eList: vi.fn(),
    putE2eList: vi.fn(),
    getE2eDeviceKeys: vi.fn(),
    uploadE2eDeviceKeys: vi.fn(),
    listE2eDeviceInbox: vi.fn(),
    ackE2eDeviceInbox: vi.fn(),
    sendE2e: vi.fn(),
    clearE2eKeys: vi.fn(),
  };
});

const [bearer, setBearer] = createSignal<string | null>(null);
const [me, setMe] = createSignal<{ kind: string; id: string } | null>(null);
const [list, setList] = createSignal<{ id: number; slug: string }[] | undefined>(undefined);
vi.mock("../lib/auth", () => ({ token: () => bearer() }));
vi.mock("../lib/networks", () => ({ user: () => me(), networks: () => list() }));
vi.mock("../lib/e2e/olm", () => ({ loadOlm: async () => olm() }));

// The browser store is IndexedDB + Web Locks, which jsdom has neither of,
// and the page holds a Web Lock while it lives (`e2e/browser.ts`).
(await import("./helpers/e2eVault")).installPageLocks();
vi.mock("../lib/e2e/accountStore", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/e2e/accountStore")>();
  const { memoryLock, memoryVault } = await import("./helpers/e2eVault");
  const vault = memoryVault();
  return { ...real, indexedDbVault: () => vault, webLock: memoryLock() };
});

const api = await import("../lib/api");
const { accountStore, open, seal } = await import("../lib/e2e/accountStore");
const { Engine, newState } = await import("../lib/e2e/engine");
const { idBlock } = await import("../lib/e2e/keyBundle");
const { certSigText, decodePayload, did, encodePayload, listSigText, OTK_SIG_PREFIX } =
  await import("../lib/e2e/wire");
const { accountSlot, mountIdentitySync, replaceIdentity, syncIdentity } = await import(
  "../lib/e2e/identity"
);

/** The subject: the fake grappa's bearer is its nick. */
const NICK = "alice";
const SLUG = "azzurra";
const SLOT = "user:0b5e:1";

let grappa: Grappa;

beforeEach(() => {
  grappa = new Grappa();
  routeApi(api, () => grappa);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

/** A browser: its own IndexedDB and Web Locks, and the account store over them. */
function browser(): { vault: MemoryVault; store: AccountStore } {
  const vault = memoryVault();
  return { vault, store: accountStore(olm(), vault, memoryLock()) };
}

const sync = (store: AccountStore) => syncIdentity(store, NICK, SLOT, SLUG);

/** What the slot holds, read under its lock. */
const stored = (store: AccountStore) =>
  store.withAccount(SLOT, async ({ account, master, own, state }) => ({
    E: account.ed25519_key(),
    M: master?.ed25519_key() ?? null,
    own,
    state: structuredClone(state),
    unpublished: account.one_time_keys().length,
  }));

/** The id block grappa registered for device key `E`, as `GET …/devices` lists it, minus its did. */
function idBlockOf(E: string) {
  return { ed25519: E, curve25519: expect.any(String), sig: expect.any(String) };
}

const DOORS = [
  ["GET list", api.getE2eList],
  ["POST devices", api.registerE2eDevice],
  ["PUT list", api.putE2eList],
  ["GET keys", api.getE2eDeviceKeys],
  ["POST keys", api.uploadE2eDeviceKeys],
  ["DELETE keys", api.clearE2eKeys],
  ["GET devices", api.listE2eDevices],
  ["DELETE device", api.removeE2eDevice],
] as const;

/** The E2E doors cic called, in order. */
const calls = (): string[] =>
  DOORS.flatMap(([name, door]) =>
    vi.mocked(door).mock.invocationCallOrder.map((order) => ({ order, name })),
  )
    .sort((a, b) => a.order - b.order)
    .map(({ name }) => name);

const uploads = () => vi.mocked(api.uploadE2eDeviceKeys).mock.calls.map((call) => call[3]);

/**
 * The one-time keys the slot's sealed record holds unpublished, read off the
 * vault without its lock: what a crash at this moment would leave.
 */
async function sealedKeys(vault: MemoryVault): Promise<string[] | undefined> {
  const sealed = vault.records.get(SLOT);
  if (sealed === undefined) return undefined;
  const record = JSON.parse(await open(await vault.wrappingKey(), SLOT, sealed)) as {
    account: string;
  };
  const account = olm().Account.from_pickle(record.account);
  const keys = account.one_time_keys();
  account.free();
  return keys;
}

/** A state with something in every field: what a device that chatted a while holds. */
function lived(): E2eState {
  const msg = {
    id: "1",
    plaintext: '{"t":"text","body":"hi","lv":1}',
    priority: "text" as const,
    sends: 1,
    tag: "t1",
    expiresAt: null,
  };
  return {
    v: 2,
    masters: {
      "M-bob": {
        nick: "bob",
        verified: true,
        ver: 3,
        devices: ["E-bob"],
        revoked: ["E-old"],
        revokedCurves: ["K-old"],
      },
    },
    devices: {
      "E-bob": {
        ed25519: "E-bob",
        curve25519: "K-bob",
        master: "M-bob",
        did: "AaZaARRDyBk",
        proven: true,
        certVer: 2,
      },
    },
    pins: { bob: "M-bob" },
    sessions: { "K-bob": ["a-session-pickle"] },
    seen: ["a-session-id"],
    outq: { bob: [{ nick: "bob", master: "M-bob", only: null, done: [], msg, at: 1 }] },
    keyreqSentAt: { bob: 1 },
    keysAwaited: { bob: true },
    rekeyAt: { bob: 1 },
    rekeying: { "E-bob": true },
    listreqAt: { bob: { at: 1, lv: [4] } },
    listreqHeld: { bob: "bob" },
    listAnsweredAt: { "bob AaZaARRDyBk": 1 },
    sent: [
      {
        ref: "r1",
        msgid: "q83vEjRWeJA",
        nick: "bob",
        master: "M-bob",
        devices: { AaZaARRDyBk: { ed25519: "E-bob", sessionId: "s1" } },
        msg,
        at: 1,
      },
    ],
    nextRef: 2,
    inbox: 9,
    sas: {
      "M-bob": {
        tx: "tx1",
        nick: "bob",
        role: "a",
        phase: "started",
        at: 1,
        device: null,
        page: null,
        ourKey: null,
        theirKey: null,
        commitment: null,
        expected: null,
        expectedMmac: null,
        theirMac: null,
        theirMmac: null,
      },
    },
  };
}

describe("syncIdentity", () => {
  it("with no identity anywhere, makes one: a master, this device registered and listed at version 1, then its keys", async () => {
    const { store } = browser();

    expect(await sync(store)).toBe("ready");

    expect(calls()).toEqual(["GET list", "POST devices", "PUT list", "POST keys"]);
    const mine = await stored(store);
    if (mine.M === null || mine.own === null) throw new Error("no identity stored");
    const held = await grappa.api.getE2eList(NICK, SLUG);
    expect(held).toEqual({ master: mine.M, ver: 1, devices: [mine.E], sig: expect.any(String) });
    expect(mine.M).not.toBe(mine.E);
    expect(mine.own).toEqual({
      master: mine.M,
      cert: expect.any(String),
      certVer: 1,
      list: { ver: 1, devices: [mine.E], sig: held?.sig },
      did: did(olm(), mine.E),
    });
    // The certificate is the master's over this device's key, at version 1:
    // the first list that holds the device.
    expect(olm().verify_ed25519(mine.M, certSigText(1, mine.E), mine.own.cert)).toBe(true);
    // The device grappa holds is this one, its bundle full, the keys published.
    expect(await grappa.api.listE2eDevices(NICK, SLUG)).toEqual([
      { did: mine.own.did, ...idBlockOf(mine.E) },
    ]);
    expect(await grappa.api.getE2eDeviceKeys(NICK, SLUG, mine.own.did)).toEqual({
      one_time_keys: 50,
      fallback: true,
    });
    expect(mine.unpublished).toBe(0);
  });

  it("a wiped browser on an account whose identity grappa holds is 'elsewhere': nothing is written, here or on grappa", async () => {
    await sync(browser().store);
    const held = await grappa.api.getE2eList(NICK, SLUG);
    const devices = await grappa.api.listE2eDevices(NICK, SLUG);
    vi.clearAllMocks();
    const { store, vault } = browser();

    expect(await sync(store)).toBe("elsewhere");

    expect(calls()).toEqual(["GET list"]);
    expect(vault.records.size).toBe(0);
    expect(await grappa.api.getE2eList(NICK, SLUG)).toEqual(held);
    expect(await grappa.api.listE2eDevices(NICK, SLUG)).toEqual(devices);
  });

  it("a new identity's PKMSGs name the version its certificate was issued at: 1, its first list's", async () => {
    const { store } = browser();
    await sync(store);
    const mine = await stored(store);
    if (mine.M === null || mine.own === null) throw new Error("no identity stored");
    // Bob's KEYS, as grappa answers the KEYREQ the engine sends: his list, and a key of his device.
    const bobMaster = new (olm().Account)();
    const bobDevice = new (olm().Account)();
    bobDevice.generate_one_time_keys(1);
    const [otk = ""] = bobDevice.one_time_keys();
    const devices = [bobDevice.ed25519_key()];
    const keys = encodePayload({
      v: 2,
      master: {
        ed25519: bobMaster.ed25519_key(),
        list: { ver: 1, devices },
        sig: bobMaster.sign(listSigText(1, devices)),
      },
      devices: [
        {
          id: idBlock(bobDevice, bobMaster.ed25519_key()),
          otk: { key: otk, fallback: false, sig: bobDevice.sign(`${OTK_SIG_PREFIX}${otk}`) },
        },
      ],
    });
    bobMaster.free();
    bobDevice.free();

    const pkmsg = await store.withAccount(SLOT, async ({ account, own, state }) => {
      if (own === null) throw new Error("no identity stored");
      const engine = new Engine(olm(), account, own, state, NICK, 394, () => 0);
      engine.send("bob", { t: "text", body: "hi" }, "hi", null, null);
      return engine.receive("bob", "keys", "q83vEjRWeJA", "*", keys).outbound;
    });

    expect(pkmsg.map((o) => [o.verb, decodePayload(o.payload).master])).toEqual([
      ["pkmsg", { ed25519: mine.M, cert: mine.own.cert, ver: 1 }],
    ]);
  });

  it("an identity of its own that grappa now holds under another master is 'elsewhere', and nothing changes", async () => {
    const { store } = browser();
    await sync(store);
    const before = await stored(store);
    // Dropped on grappa, and another browser made a new identity since.
    await grappa.api.clearE2eKeys(NICK, SLUG);
    await sync(browser().store);
    const held = await grappa.api.getE2eList(NICK, SLUG);
    vi.clearAllMocks();

    expect(await sync(store)).toBe("elsewhere");

    expect(calls()).toEqual(["GET list"]);
    expect(await grappa.api.getE2eList(NICK, SLUG)).toEqual(held);
    expect(await stored(store)).toEqual(before);
  });

  it("an identity whose own master's list no longer names this device is 'elsewhere', and nothing changes", async () => {
    const { store } = browser();
    await sync(store);
    // The master lists another device instead, at version 2: grappa drops this one.
    await store.withAccount(SLOT, async ({ master }) => {
      if (master === null) throw new Error("no master");
      const other = new (olm().Account)();
      await grappa.api.registerE2eDevice(NICK, SLUG, idBlock(other, master.ed25519_key()));
      const devices = [other.ed25519_key()];
      await grappa.api.putE2eList(NICK, SLUG, {
        master: master.ed25519_key(),
        ver: 2,
        devices,
        sig: master.sign(listSigText(2, devices)),
      });
      other.free();
    });
    const before = await stored(store);
    vi.clearAllMocks();

    expect(await sync(store)).toBe("elsewhere");

    expect(calls()).toEqual(["GET list"]);
    expect(await stored(store)).toEqual(before);
  });

  it("a list under another master that names this very device is 'elsewhere': the device is ours, the master is not", async () => {
    const { store } = browser();
    await sync(store);
    const [mine] = await grappa.api.listE2eDevices(NICK, SLUG);
    if (mine === undefined) throw new Error("no device registered");
    // Dropped on grappa; another master registers this device's public id
    // block again and lists it.
    await grappa.api.clearE2eKeys(NICK, SLUG);
    const mallory = new (olm().Account)();
    await grappa.api.registerE2eDevice(NICK, SLUG, mine);
    await grappa.api.putE2eList(NICK, SLUG, {
      master: mallory.ed25519_key(),
      ver: 1,
      devices: [mine.ed25519],
      sig: mallory.sign(listSigText(1, [mine.ed25519])),
    });
    mallory.free();
    const before = await stored(store);
    vi.clearAllMocks();

    expect(await sync(store)).toBe("elsewhere");

    expect(calls()).toEqual(["GET list"]);
    expect(await stored(store)).toEqual(before);
  });

  it("an identity grappa dropped comes back as it was: this device registered again, listed one version up", async () => {
    const { store } = browser();
    await sync(store);
    const before = await stored(store);
    await grappa.api.clearE2eKeys(NICK, SLUG);
    vi.clearAllMocks();

    expect(await sync(store)).toBe("ready");

    expect(calls()).toEqual(["GET list", "POST devices", "PUT list", "GET keys", "POST keys"]);
    const held = await grappa.api.getE2eList(NICK, SLUG);
    expect(held).toEqual({
      master: before.M,
      ver: 2,
      devices: [before.E],
      sig: expect.any(String),
    });
    const after = await stored(store);
    expect(after.M).toBe(before.M);
    expect(after.E).toBe(before.E);
    expect(after.own).toEqual({
      ...before.own,
      list: { ver: 2, devices: [before.E], sig: held?.sig },
    });
    expect(await grappa.api.getE2eDeviceKeys(NICK, SLUG, after.own?.did ?? "")).toEqual({
      one_time_keys: 50,
      fallback: true,
    });
  });

  it("a device holding no master (one paired to it) cannot list itself again: with the list gone it is 'elsewhere'", async () => {
    const { store } = browser();
    const master = new (olm().Account)();
    await store.withAccount(SLOT, async (session) => {
      const E = session.account.ed25519_key();
      session.own = {
        master: master.ed25519_key(),
        cert: master.sign(certSigText(1, E)),
        certVer: 1,
        list: { ver: 1, devices: [E], sig: master.sign(listSigText(1, [E])) },
        did: did(olm(), E),
      };
    });
    master.free();

    expect(await sync(store)).toBe("elsewhere");

    expect(calls()).toEqual(["GET list"]);
  });

  it("a known identity asks grappa what its device's bundle has left, and sends only that", async () => {
    const { store } = browser();
    await sync(store);
    const [first] = uploads();
    const mine = await stored(store);
    // Bob, on a browser of his own, asks for keys three times: three one-time keys go.
    const bob = browser();
    await syncIdentity(bob.store, "Bob", "bob-slot", SLUG);
    const from = await bob.store.withAccount("bob-slot", async ({ own }) => own?.did ?? "");
    for (let i = 0; i < 3; i++) {
      await grappa.api.sendE2e("Bob", SLUG, {
        target: NICK,
        verb: "keyreq",
        from,
        to: "*",
        payload: '{"v":2}',
        priority: "control",
        expiresAt: null,
      });
    }
    vi.clearAllMocks();

    expect(await sync(store)).toBe("ready");

    expect(calls()).toEqual(["GET list", "GET keys", "POST keys"]);
    const [sent] = uploads();
    expect(sent?.one_time_keys).toHaveLength(3);
    expect(sent?.fallback).toBeNull();
    // Keys already sent were marked published: these three are new.
    const before = new Set(first?.one_time_keys.map((k) => k.key));
    expect(sent?.one_time_keys.some((k) => before.has(k.key))).toBe(false);
    expect(await grappa.api.getE2eDeviceKeys(NICK, SLUG, mine.own?.did ?? "")).toEqual({
      one_time_keys: 50,
      fallback: true,
    });
  });

  it("stores the identity with its keys before the keys leave, so a failed upload resends the same keys", async () => {
    const { store, vault } = browser();
    let sealedAtUpload: string[] | undefined;
    vi.mocked(api.uploadE2eDeviceKeys).mockImplementationOnce(async () => {
      sealedAtUpload = await sealedKeys(vault);
      throw new Error("503");
    });

    await expect(sync(store)).rejects.toThrow("503");
    const [failed] = uploads();
    expect(sealedAtUpload).toEqual(failed?.one_time_keys.map((k) => k.key));
    expect(sealedAtUpload).toHaveLength(50);

    // The retry is the same identity, not a new one, with the same keys.
    expect(await sync(store)).toBe("ready");
    const [, retried] = uploads();
    expect(retried?.one_time_keys).toEqual(failed?.one_time_keys);
    expect(retried?.fallback).toEqual(failed?.fallback);
    expect(api.putE2eList).toHaveBeenCalledTimes(1);
    expect(api.registerE2eDevice).toHaveBeenCalledTimes(1);
  });

  // `getE2eList` answers null both for "no list" and for a network that does
  // not resolve for the subject (one uniform 404): the write after it 404s
  // the same way, and that must fail the sync, never set anything up.
  it("a 404 from registering the device after an absent list fails the sync and stores nothing", async () => {
    const { store, vault } = browser();
    vi.mocked(api.registerE2eDevice).mockRejectedValueOnce(new api.ApiError(404, "not_found"));

    await expect(sync(store)).rejects.toMatchObject({ status: 404, code: "not_found" });

    expect(calls()).toEqual(["GET list", "POST devices"]);
    expect(vault.records.size).toBe(0);
  });

  it("a 404 from putting the list after an absent list fails the sync and stores nothing", async () => {
    const { store, vault } = browser();
    vi.mocked(api.putE2eList).mockRejectedValueOnce(new api.ApiError(404, "not_found"));

    await expect(sync(store)).rejects.toMatchObject({ status: 404, code: "not_found" });

    expect(calls()).toEqual(["GET list", "POST devices", "PUT list", "DELETE device"]);
    expect(vault.records.size).toBe(0);
  });

  // The PUT just proved the network resolves and that grappa holds our list:
  // dropping the record would leave a master on grappa nobody holds.
  it("a 404 from the key upload after the list was put keeps the record, and fails the sync", async () => {
    const { store } = browser();
    vi.mocked(api.uploadE2eDeviceKeys).mockRejectedValueOnce(new api.ApiError(404, "not_found"));

    await expect(sync(store)).rejects.toMatchObject({ status: 404, code: "not_found" });

    expect(calls()).toEqual(["GET list", "POST devices", "PUT list", "POST keys"]);
    const mine = await stored(store);
    expect(mine.own?.master).toBe(mine.M);
    expect(await grappa.api.getE2eList(NICK, SLUG)).toMatchObject({
      master: mine.M,
      devices: [mine.E],
    });
  });

  // A device registered and never listed holds one of the subject's four
  // rooms on grappa for good.
  it("a list put that fails after the device registered drops the device again; the put's error is the outcome", async () => {
    const { store, vault } = browser();
    vi.mocked(api.putE2eList).mockRejectedValueOnce(new Error("503"));

    await expect(sync(store)).rejects.toThrow("503");

    expect(calls()).toEqual(["GET list", "POST devices", "PUT list", "DELETE device"]);
    expect(await grappa.api.listE2eDevices(NICK, SLUG)).toEqual([]);
    expect(vault.records.size).toBe(0);
  });

  it("a put grappa took whose answer was lost: the cleanup's refusal (a listed device) is logged, the put's error stands", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store } = browser();
    vi.mocked(api.putE2eList).mockImplementationOnce(async (t, s, list) => {
      await grappa.api.putE2eList(t, s, list);
      throw new Error("connection reset");
    });

    await expect(sync(store)).rejects.toThrow("connection reset");

    expect(calls()).toEqual(["GET list", "POST devices", "PUT list", "DELETE device"]);
    // grappa refused to drop a device its list names: it is still there.
    const [left] = await grappa.api.listE2eDevices(NICK, SLUG);
    expect(left).toBeDefined();
    expect(warn).toHaveBeenCalledWith(
      `[e2e] could not drop the unlisted device ${left?.did} on ${SLUG}`,
      expect.objectContaining({ status: 409, code: "listed_device" }),
    );
  });

  it("a list put that fails while an identity grappa dropped is listed again drops the device again, and keeps the record", async () => {
    const { store } = browser();
    await sync(store);
    const before = await stored(store);
    await grappa.api.clearE2eKeys(NICK, SLUG);
    vi.clearAllMocks();
    vi.mocked(api.putE2eList).mockRejectedValueOnce(new Error("503"));

    await expect(sync(store)).rejects.toThrow("503");

    expect(calls()).toEqual(["GET list", "POST devices", "PUT list", "DELETE device"]);
    expect(await grappa.api.listE2eDevices(NICK, SLUG)).toEqual([]);
    expect(await stored(store)).toEqual(before);
  });

  it("two browsers bootstrapping one account at once: the second to put its list is 'elsewhere', and leaves no device behind", async () => {
    // Both look before either puts: each finds no list.
    let looked = 0;
    let bothLooked: () => void = () => undefined;
    const barrier = new Promise<void>((resolve) => {
      bothLooked = resolve;
    });
    vi.mocked(api.getE2eList).mockImplementation(async (t, s) => {
      const held = await grappa.api.getE2eList(t, s);
      looked += 1;
      if (looked === 2) bothLooked();
      await barrier;
      return held;
    });
    const a = browser();
    const b = browser();

    // Both settled before anything is read: a sync still running would reach
    // the next test's grappa.
    const settled = await Promise.allSettled([sync(a.store), sync(b.store)]);
    const states = settled.map((r) =>
      r.status === "fulfilled" ? r.value : `rejected: ${r.reason}`,
    );

    expect([...states].sort()).toEqual(["elsewhere", "ready"]);
    const winner = states[0] === "ready" ? a : b;
    const loser = states[0] === "ready" ? b : a;
    expect(loser.vault.records.size).toBe(0);
    const mine = await stored(winner.store);
    expect(await grappa.api.getE2eList(NICK, SLUG)).toMatchObject({
      master: mine.M,
      devices: [mine.E],
    });
    // Exactly one device on grappa, the listed one: the loser's went.
    expect((await grappa.api.listE2eDevices(NICK, SLUG)).map((d) => d.ed25519)).toEqual([mine.E]);
  });

  it("four orphan devices filling every room with no list held are dropped, and the registration goes through", async () => {
    const stranger = new (olm().Account)();
    for (let i = 0; i < 4; i++) {
      const orphan = new (olm().Account)();
      await grappa.api.registerE2eDevice(NICK, SLUG, idBlock(orphan, stranger.ed25519_key()));
      orphan.free();
    }
    stranger.free();
    const { store } = browser();

    expect(await sync(store)).toBe("ready");

    expect(calls()).toEqual([
      "GET list",
      "POST devices",
      "GET devices",
      "DELETE device",
      "DELETE device",
      "DELETE device",
      "DELETE device",
      "POST devices",
      "PUT list",
      "POST keys",
    ]);
    const mine = await stored(store);
    expect((await grappa.api.listE2eDevices(NICK, SLUG)).map((d) => d.ed25519)).toEqual([mine.E]);
  });

  it("an orphan device that cannot be dropped is logged, the others go, and the registration goes through", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const stranger = new (olm().Account)();
    for (let i = 0; i < 4; i++) {
      const orphan = new (olm().Account)();
      await grappa.api.registerE2eDevice(NICK, SLUG, idBlock(orphan, stranger.ed25519_key()));
      orphan.free();
    }
    stranger.free();
    const [stuck] = await grappa.api.listE2eDevices(NICK, SLUG);
    const refused = new Error("503");
    vi.mocked(api.removeE2eDevice).mockRejectedValueOnce(refused);
    const { store } = browser();

    expect(await sync(store)).toBe("ready");

    expect(warn).toHaveBeenCalledWith(
      `[e2e] could not drop the orphan device ${stuck?.did} on ${SLUG}`,
      refused,
    );
    const mine = await stored(store);
    expect((await grappa.api.listE2eDevices(NICK, SLUG)).map((d) => d.ed25519)).toEqual([
      stuck?.ed25519,
      mine.E,
    ]);
  });

  it("a fifth device refused again after the orphans went fails the sync", async () => {
    const stranger = new (olm().Account)();
    for (let i = 0; i < 4; i++) {
      const orphan = new (olm().Account)();
      await grappa.api.registerE2eDevice(NICK, SLUG, idBlock(orphan, stranger.ed25519_key()));
      orphan.free();
    }
    stranger.free();
    // The deletes answer without dropping anything: the retry is refused too.
    vi.mocked(api.removeE2eDevice).mockResolvedValue(undefined);
    const { store, vault } = browser();

    await expect(sync(store)).rejects.toMatchObject({ status: 409, code: "too_many_devices" });

    expect(calls().filter((door) => door === "POST devices")).toHaveLength(2);
    expect(vault.records.size).toBe(0);
  });

  // A relist whose put grappa took, its answer lost before the record was
  // stored: the record still names the version below.
  it("our own master's list at a version above the stored one is taken, so a later relist goes above it", async () => {
    const { store } = browser();
    await sync(store);
    const before = await stored(store);
    await store.withAccount(SLOT, async ({ master }) => {
      if (master === null) throw new Error("no master");
      await grappa.api.putE2eList(NICK, SLUG, {
        master: master.ed25519_key(),
        ver: 2,
        devices: [before.E],
        sig: master.sign(listSigText(2, [before.E])),
      });
    });
    const held = await grappa.api.getE2eList(NICK, SLUG);

    expect(await sync(store)).toBe("ready");
    expect((await stored(store)).own?.list).toEqual({
      ver: 2,
      devices: [before.E],
      sig: held?.sig,
    });

    await grappa.api.clearE2eKeys(NICK, SLUG);
    expect(await sync(store)).toBe("ready");
    expect(await grappa.api.getE2eList(NICK, SLUG)).toMatchObject({ ver: 3 });
  });

  it("a list of our master at a higher version that does not verify is not taken", async () => {
    const { store } = browser();
    await sync(store);
    const before = await stored(store);
    if (before.own === null || before.M === null) throw new Error("no identity stored");
    // grappa verifies what it is put; only a grappa that lies serves this.
    vi.mocked(api.getE2eList).mockResolvedValueOnce({
      master: before.M,
      ver: 5,
      devices: [before.E],
      sig: before.own.list.sig,
    });

    expect(await sync(store)).toBe("ready");

    expect((await stored(store)).own?.list).toEqual(before.own.list);
  });

  it("two tabs bootstrapping one slot at once make one identity: one master, one device, one list", async () => {
    // Two tabs: one IndexedDB and one Web Locks, a store each.
    const vault = memoryVault();
    const lock = memoryLock();
    const tabA = accountStore(olm(), vault, lock);
    const tabB = accountStore(olm(), vault, lock);

    expect(await Promise.all([sync(tabA), sync(tabB)])).toEqual(["ready", "ready"]);

    expect(api.registerE2eDevice).toHaveBeenCalledTimes(1);
    expect(api.putE2eList).toHaveBeenCalledTimes(1);
    expect(await grappa.api.listE2eDevices(NICK, SLUG)).toHaveLength(1);
    const [a, b] = [await stored(tabA), await stored(tabB)];
    expect(a.M).not.toBeNull();
    expect(b.M).toBe(a.M);
    expect(b.E).toBe(a.E);
  });

  // On a fresh login the drain meets the slot before the page's own sync has
  // made the identity, and asks for a sync too: it must join the running one,
  // not queue a second behind it.
  it("a sync asked for while one runs on the page joins it; the next one runs again", async () => {
    const { store } = browser();

    expect(await Promise.all([sync(store), sync(store)])).toEqual(["ready", "ready"]);
    expect(calls()).toEqual(["GET list", "POST devices", "PUT list", "POST keys"]);

    // Joined while it runs, never remembered after: a later ask syncs again,
    // and a full bundle takes no upload.
    expect(await sync(store)).toBe("ready");
    expect(calls().slice(4)).toEqual(["GET list", "GET keys"]);
  });

  it("a v1 record left in the browser starts the slot over with a new identity", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { store, vault } = browser();
    const old = new (olm().Account)();
    const v1 = { account: old.pickle(), state: { ...newState(), v: 1, peers: {} } };
    vault.records.set(SLOT, await seal(await vault.wrappingKey(), SLOT, JSON.stringify(v1)));

    expect(await sync(store)).toBe("ready");

    expect(calls()).toEqual(["GET list", "POST devices", "PUT list", "POST keys"]);
    expect((await stored(store)).E).not.toBe(old.ed25519_key());
    expect(warn).toHaveBeenCalledTimes(1);
    old.free();
  });
});

describe("replaceIdentity", () => {
  it("from 'elsewhere', deletes the identity grappa holds and makes a new one here; the slot is then ready", async () => {
    await sync(browser().store);
    const old = await grappa.api.getE2eList(NICK, SLUG);
    const { store } = browser();
    expect(await sync(store)).toBe("elsewhere");
    vi.clearAllMocks();

    await replaceIdentity(store, NICK, SLOT, SLUG);

    expect(calls()).toEqual(["DELETE keys", "POST devices", "PUT list", "POST keys"]);
    const mine = await stored(store);
    expect(mine.M).not.toBe(old?.master);
    expect(await grappa.api.getE2eList(NICK, SLUG)).toEqual({
      master: mine.M,
      ver: 1,
      devices: [mine.E],
      sig: mine.own?.list.sig,
    });
    // The device that held the old identity went with it.
    expect((await grappa.api.listE2eDevices(NICK, SLUG)).map((d) => d.ed25519)).toEqual([mine.E]);
    expect(await sync(store)).toBe("ready");
  });

  it("a new identity that fails after the old one was deleted is made again by the next sync, never the old one listed again", async () => {
    const { store } = browser();
    await sync(store);
    const old = await stored(store);
    vi.mocked(api.registerE2eDevice).mockRejectedValueOnce(new Error("503"));

    await expect(replaceIdentity(store, NICK, SLOT, SLUG)).rejects.toThrow("503");
    expect(await grappa.api.getE2eList(NICK, SLUG)).toBeNull();
    vi.clearAllMocks();

    expect(await sync(store)).toBe("ready");

    expect(calls()).toEqual(["GET list", "POST devices", "PUT list", "POST keys"]);
    const mine = await stored(store);
    expect(mine.M).not.toBeNull();
    expect(mine.M).not.toBe(old.M);
    expect(mine.E).not.toBe(old.E);
    expect(await grappa.api.getE2eList(NICK, SLUG)).toMatchObject({ master: mine.M, ver: 1 });
  });

  it("makes a new device and master over the old ones; the trust placed in others stays, the old device's state goes", async () => {
    const { store } = browser();
    await sync(store);
    await store.withAccount(SLOT, async ({ state }) => {
      Object.assign(state, lived());
    });
    const before = await stored(store);
    vi.clearAllMocks();

    await replaceIdentity(store, NICK, SLOT, SLUG);

    expect(calls()).toEqual(["DELETE keys", "POST devices", "PUT list", "POST keys"]);
    const after = await stored(store);
    expect(after.M).not.toBe(before.M);
    expect(after.E).not.toBe(before.E);
    expect(after.own?.list).toEqual({ ver: 1, devices: [after.E], sig: expect.any(String) });
    expect(after.state).toEqual({
      ...newState(),
      masters: before.state.masters,
      devices: before.state.devices,
      pins: before.state.pins,
    });
  });
});

describe("mountIdentitySync", () => {
  // A sync runs real vodozemac and WebCrypto, so how long it takes depends on
  // the machine: wait for what it does, never for a fixed time. Every "did
  // not happen" below is read after something that happens later.
  const until = (assertion: () => void) => vi.waitFor(assertion, { timeout: 4000 });

  // The signals are module state: each case starts from no network list, and
  // uses its own subject, since the page-wide record of synced slots stays.
  // Each network is a grappa of its own: an identity is per network.
  beforeEach(() => {
    setList(undefined);
    const grappas = new Map<string, Grappa>();
    routeApi(api, (slug) => {
      const found = grappas.get(slug) ?? new Grappa();
      grappas.set(slug, found);
      return found;
    });
  });

  it("syncs each network once per page, and a network that appears later", async () => {
    setBearer("tok");
    setMe({ kind: "user", id: "a1" });
    const found = vi.fn();
    const dispose = createRoot((d) => {
      mountIdentitySync(found);
      return d;
    });
    setList([
      { id: 1, slug: "azzurra" },
      { id: 2, slug: "libera" },
    ]);
    await until(() => expect(api.uploadE2eDeviceKeys).toHaveBeenCalledTimes(2));
    expect(
      vi
        .mocked(api.putE2eList)
        .mock.calls.map((call) => call[1])
        .sort(),
    ).toEqual(["azzurra", "libera"]);

    // A refetch of the same list syncs nothing again: no second look at
    // either list, read once the network that appears afterwards is synced.
    setList([
      { id: 1, slug: "azzurra" },
      { id: 2, slug: "libera" },
    ]);
    setList([
      { id: 1, slug: "azzurra" },
      { id: 2, slug: "libera" },
      { id: 3, slug: "oftc" },
    ]);
    await until(() => expect(api.uploadE2eDeviceKeys).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.putE2eList).mock.calls.map((call) => call[1])).toContain("oftc");
    expect(api.getE2eList).toHaveBeenCalledTimes(3);
    await until(() => expect(found).toHaveBeenCalledTimes(3));
    expect(found.mock.calls.sort()).toEqual([
      ["azzurra", "ready"],
      ["libera", "ready"],
      ["oftc", "ready"],
    ]);
    dispose();
  });

  it("tells what each sync found: an identity grappa holds from another browser is elsewhere", async () => {
    setBearer("tok");
    setMe({ kind: "user", id: "d4" });
    // Another browser of the account made the identity on libera first.
    expect(await syncIdentity(browser().store, "tok", "elsewhere:libera", "libera")).toBe("ready");
    const found = vi.fn();
    const dispose = createRoot((d) => {
      mountIdentitySync(found);
      return d;
    });
    setList([
      { id: 1, slug: "azzurra" },
      { id: 2, slug: "libera" },
    ]);
    await until(() => expect(found).toHaveBeenCalledTimes(2));
    expect(found.mock.calls.sort()).toEqual([
      ["azzurra", "ready"],
      ["libera", "elsewhere"],
    ]);
    dispose();
  });

  it("retries a network whose sync failed when the list next changes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setBearer("tok");
    setMe({ kind: "user", id: "b2" });
    vi.mocked(api.registerE2eDevice).mockRejectedValueOnce(new Error("offline"));
    const found = vi.fn();
    const dispose = createRoot((d) => {
      mountIdentitySync(found);
      return d;
    });
    setList([{ id: 1, slug: "azzurra" }]);
    // The warning is the failed attempt's last step.
    await until(() =>
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("azzurra"), expect.anything()),
    );
    expect(api.uploadE2eDeviceKeys).not.toHaveBeenCalled();

    expect(found).not.toHaveBeenCalled();
    setList([{ id: 1, slug: "azzurra" }]);
    await until(() => expect(api.uploadE2eDeviceKeys).toHaveBeenCalledTimes(1));
    await until(() => expect(found.mock.calls).toEqual([["azzurra", "ready"]]));
    dispose();
  });

  it("does nothing while logged out, and syncs once logged in", async () => {
    setBearer(null);
    setMe(null);
    const dispose = createRoot((d) => {
      mountIdentitySync(() => undefined);
      return d;
    });
    setList([{ id: 1, slug: "azzurra" }]);
    setMe({ kind: "user", id: "c3" });
    setBearer("tok");
    await until(() => expect(api.uploadE2eDeviceKeys).toHaveBeenCalledTimes(1));
    // One sync, with the bearer: nothing ran with the list alone.
    expect(vi.mocked(api.getE2eList).mock.calls.map((call) => call[0])).toEqual(["tok"]);
    dispose();
  });
});

describe("accountSlot", () => {
  it("keys an account on the subject and the network, so neither shares one", () => {
    const slots = new Set([
      accountSlot({ kind: "user", id: "a1" }, 1),
      accountSlot({ kind: "user", id: "a1" }, 2),
      accountSlot({ kind: "visitor", id: "a1" }, 1),
      accountSlot({ kind: "user", id: "b2" }, 1),
    ]);
    expect(slots.size).toBe(4);
  });
});
