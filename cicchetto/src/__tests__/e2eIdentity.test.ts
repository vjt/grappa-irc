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
import type { Account } from "../lib/e2e/vodozemac/vodozemac_binding";
import type { IdBlock } from "../lib/e2e/wire";
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
    claimE2eDeviceKeys: vi.fn(),
    copyE2e: vi.fn(),
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
const {
  abandonJoin,
  accountSlot,
  addDevice,
  completeJoin,
  masterOf,
  mountIdentitySync,
  offerable,
  prepareJoin,
  replaceIdentity,
  syncIdentity,
} = await import("../lib/e2e/identity");

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
 * What `read` finds in the account of the slot's sealed record, read off the
 * vault without its lock: what a crash at this moment would leave.
 */
async function sealedAccount<T>(
  vault: MemoryVault,
  read: (account: Account) => T,
): Promise<T | undefined> {
  const sealed = vault.records.get(SLOT);
  if (sealed === undefined) return undefined;
  const record = JSON.parse(await open(await vault.wrappingKey(), SLOT, sealed)) as {
    account: string;
  };
  const account = olm().Account.from_pickle(record.account);
  const found = read(account);
  account.free();
  return found;
}

/** The one-time keys the slot's sealed record holds unpublished. */
const sealedKeys = (vault: MemoryVault) =>
  sealedAccount(vault, (account) => account.one_time_keys());

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
    siblings: { "E-sib": { did: "AbZbARRDyBk", curve25519: "K-sib" } },
    copyq: { "E-sib": [{ peer: "bob", body: "hi", at: 1 }] },
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

// The doors a QR pairing goes through, without the channel: the holder is the
// browser that holds the master, the joiner the new browser of the account.
describe("the pairing doors", () => {
  /** A browser whose identity the sync made: it holds the master. */
  async function holder(): Promise<{ vault: MemoryVault; store: AccountStore }> {
    const made = browser();
    expect(await sync(made.store)).toBe("ready");
    return made;
  }

  /** The master key the holder's QR offers. */
  async function offered(store: AccountStore): Promise<string> {
    const M = await masterOf(store, SLOT);
    if (M === null) throw new Error("no master here");
    return M;
  }

  /** The joiner's device, registered under `M`: what its `join` carries. */
  async function joined(store: AccountStore, M: string): Promise<{ id: IdBlock; did: string }> {
    const prepared = await prepareJoin(store, NICK, SLOT, SLUG, M);
    if (typeof prepared === "string") throw new Error(`the joiner refused: ${prepared}`);
    return prepared;
  }

  /** What the holder signs for the joiner's `id`. */
  async function signedFor(store: AccountStore, id: IdBlock) {
    const signed = await addDevice(store, NICK, SLOT, SLUG, id);
    if (typeof signed === "string") throw new Error(`the holder refused: ${signed}`);
    return signed;
  }

  /** A whole pairing: the joiner listed by the holder's master, and ready. */
  async function paired(holderStore: AccountStore, joinerStore: AccountStore) {
    const M = await offered(holderStore);
    const j = await joined(joinerStore, M);
    const signed = await signedFor(holderStore, j.id);
    expect(await completeJoin(joinerStore, NICK, SLOT, SLUG, M, signed)).toBe(true);
    return { M, j, signed };
  }

  /** `n` devices of other browsers registered on grappa, each vouching for `M`: their keys. */
  async function strangers(n: number, M: string): Promise<string[]> {
    const keys: string[] = [];
    for (let i = 0; i < n; i++) {
      const device = new (olm().Account)();
      await grappa.api.registerE2eDevice(NICK, SLUG, idBlock(device, M));
      keys.push(device.ed25519_key());
      device.free();
    }
    return keys;
  }

  /** The list the holder's master signs at `ver` over `devices`, as grappa takes it. */
  const listBy = (store: AccountStore, ver: number, devices: string[]) =>
    store.withAccount(SLOT, async ({ master }) => {
      if (master === null) throw new Error("no master here");
      const sorted = [...devices].sort();
      return {
        master: master.ed25519_key(),
        ver,
        devices: sorted,
        sig: master.sign(listSigText(ver, sorted)),
      };
    });

  it("a pairing through the doors leaves the new device ready and listed, its certificate at the new ver", async () => {
    const a = await holder();
    const b = browser();

    const M = await masterOf(a.store, SLOT);
    if (M === null) throw new Error("no master here");
    const j = await joined(b.store, M);
    const signed = await signedFor(a.store, j.id);
    expect(await completeJoin(b.store, NICK, SLOT, SLUG, M, signed)).toBe(true);
    expect(await sync(b.store)).toBe("ready");

    const [mineA, mineB] = [await stored(a.store), await stored(b.store)];
    expect(M).toBe(mineA.M);
    expect(j.id.ed25519).toBe(mineB.E);
    const held = await grappa.api.getE2eList(NICK, SLUG);
    expect(held).toEqual({
      master: M,
      ver: 2,
      devices: [mineA.E, mineB.E].sort(),
      sig: expect.any(String),
    });
    expect(mineB.M).toBeNull();
    expect(mineB.own).toEqual({
      master: M,
      cert: signed.cert,
      certVer: 2,
      list: { ver: 2, devices: held?.devices, sig: held?.sig },
      did: j.did,
    });
    expect(j.did).toBe(did(olm(), mineB.E));
    expect(olm().verify_ed25519(M, certSigText(2, mineB.E), signed.cert)).toBe(true);
    expect(mineA.own?.list).toEqual({ ver: 2, devices: held?.devices, sig: held?.sig });
    // completeJoin's sync filled the new device's bundle.
    expect(await grappa.api.getE2eDeviceKeys(NICK, SLUG, j.did)).toEqual({
      one_time_keys: 50,
      fallback: true,
    });
  });

  // The channel cannot outlive the page: a reload between the registration
  // and `signed` pairs again from the start, and must not leak a device into
  // the subject's four rooms.
  it("prepareJoin twice on one slot registers one device", async () => {
    const a = await holder();
    const M = await offered(a.store);
    expect(await grappa.api.listE2eDevices(NICK, SLUG)).toHaveLength(1);
    const b = browser();

    const first = await joined(b.store, M);
    expect(await grappa.api.listE2eDevices(NICK, SLUG)).toHaveLength(2);
    // The page reloads before the holder signs: a new store over the same browser.
    const second = await joined(accountStore(olm(), b.vault, memoryLock()), M);

    expect(second).toEqual(first);
    expect(await grappa.api.listE2eDevices(NICK, SLUG)).toHaveLength(2);
  });

  it("prepareJoin stores the device account before its id block leaves, so a reload registers the same key", async () => {
    const a = await holder();
    const M = await offered(a.store);
    const b = browser();
    let sealedAtRegister: string | undefined;
    vi.mocked(api.registerE2eDevice).mockImplementationOnce(async (t, s, id) => {
      sealedAtRegister = await sealedAccount(b.vault, (account) => account.ed25519_key());
      return grappa.api.registerE2eDevice(t, s, id);
    });

    const j = await joined(b.store, M);

    expect(sealedAtRegister).toBe(j.id.ed25519);
  });

  it("prepareJoin on a slot whose old identity grappa no longer lists makes a fresh account and keeps the pins", async () => {
    const b = browser();
    expect(await sync(b.store)).toBe("ready");
    await b.store.withAccount(SLOT, async ({ state }) => {
      Object.assign(state, lived());
    });
    const before = await stored(b.store);
    // Replaced since: grappa dropped it, and another browser made the one it holds now.
    await grappa.api.clearE2eKeys(NICK, SLUG);
    const a = await holder();
    const M = await offered(a.store);

    const j = await joined(b.store, M);

    const after = await stored(b.store);
    expect(after.E).not.toBe(before.E);
    expect(j.id.ed25519).toBe(after.E);
    expect(after.M).toBeNull();
    expect(after.own).toBeNull();
    expect(after.state).toEqual({
      ...newState(),
      masters: before.state.masters,
      devices: before.state.devices,
      pins: before.state.pins,
    });
    expect((await grappa.api.listE2eDevices(NICK, SLUG)).map((d) => d.ed25519).sort()).toEqual(
      [(await stored(a.store)).E, after.E].sort(),
    );
  });

  // The holder's put went through and the page went before `signed` came:
  // the key is listed, and the record holds no identity to speak for it.
  it("prepareJoin with no identity but a listed key makes a fresh account", async () => {
    const a = await holder();
    const M = await offered(a.store);
    const b = browser();
    const first = await joined(b.store, M);
    await signedFor(a.store, first.id);
    vi.clearAllMocks();

    const second = await joined(b.store, M);

    expect(second.id.ed25519).not.toBe(first.id.ed25519);
    expect(vi.mocked(api.registerE2eDevice).mock.calls.map((call) => call[2].ed25519)).toEqual([
      second.id.ed25519,
    ]);
    expect((await stored(b.store)).E).toBe(second.id.ed25519);
  });

  // The joiner read the network elsewhere and got the holder's offer; in
  // another tab its user then started a new identity there. Starting over
  // now would drop the master grappa holds, leaving its list to no browser.
  it("prepareJoin refuses an offer whose master grappa no longer holds, says why, and touches nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await holder();
    const M = await offered(a.store);
    const b = browser();
    await replaceIdentity(b.store, NICK, SLOT, SLUG);
    const before = await stored(b.store);
    const held = await grappa.api.getE2eList(NICK, SLUG);
    expect(held?.master).toBe(before.M);
    vi.clearAllMocks();

    expect(await prepareJoin(b.store, NICK, SLOT, SLUG, M)).toBe("failed");

    expect(warn).toHaveBeenCalledWith(
      `[e2e] grappa holds another master than the one offered on ${SLUG}: not paired there`,
    );
    expect(calls()).toEqual(["GET list"]);
    expect(await stored(b.store)).toEqual(before);
    expect(await grappa.api.getE2eList(NICK, SLUG)).toEqual(held);
  });

  it("prepareJoin answers failed, and says why, when grappa refuses the registration otherwise", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await holder();
    const M = await offered(a.store);
    const refused = new api.ApiError(503, "db_unavailable");
    vi.mocked(api.registerE2eDevice).mockRejectedValueOnce(refused);

    expect(await prepareJoin(browser().store, NICK, SLOT, SLUG, M)).toBe("failed");

    expect(warn).toHaveBeenCalledWith(
      `[e2e] could not register this device on ${SLUG} to pair it`,
      refused,
    );
    expect(await grappa.api.listE2eDevices(NICK, SLUG)).toHaveLength(1);
  });

  it("prepareJoin answers paired on a device already listed under that master, and changes nothing", async () => {
    const a = await holder();
    const b = browser();
    const { M } = await paired(a.store, b.store);
    const before = await stored(b.store);
    vi.clearAllMocks();

    expect(await prepareJoin(b.store, NICK, SLOT, SLUG, M)).toBe("paired");

    expect(calls()).toEqual(["GET list"]);
    expect(await stored(b.store)).toEqual(before);
  });

  // No list-held orphan sweep here: the holder's list is held, and every
  // device grappa holds may be one of its own.
  it("prepareJoin answers full when grappa holds 4 devices, and drops none of them", async () => {
    const a = await holder();
    const M = await offered(a.store);
    await strangers(3, M);
    vi.clearAllMocks();

    expect(await prepareJoin(browser().store, NICK, SLOT, SLUG, M)).toBe("full");

    expect(calls()).toEqual(["GET list", "POST devices"]);
    expect(await grappa.api.listE2eDevices(NICK, SLUG)).toHaveLength(4);
  });

  it("addDevice re-syncs once when another device put a list first, and keeps that device", async () => {
    const a = await holder();
    const M = await offered(a.store);
    const j = await joined(browser().store, M);
    const E = (await stored(a.store)).E;
    const [third = ""] = await strangers(1, M);
    const behind = await listBy(a.store, 2, [E, third]);
    vi.clearAllMocks();
    // Another device's put lands between the holder's sync and its own put.
    vi.mocked(api.putE2eList).mockImplementationOnce(async (t, s, list) => {
      await grappa.api.putE2eList(t, s, behind);
      return grappa.api.putE2eList(t, s, list);
    });

    const signed = await addDevice(a.store, NICK, SLOT, SLUG, j.id);

    const all = [E, j.id.ed25519, third].sort();
    expect(signed).toEqual({
      cert: expect.any(String),
      list: { ver: 3, devices: all, sig: expect.any(String) },
    });
    expect(api.putE2eList).toHaveBeenCalledTimes(2);
    expect(await grappa.api.getE2eList(NICK, SLUG)).toMatchObject({
      master: M,
      ver: 3,
      devices: all,
    });
    expect((await stored(a.store)).own?.list.ver).toBe(3);
    if (typeof signed === "string") throw new Error("refused");
    expect(olm().verify_ed25519(M, certSigText(3, j.id.ed25519), signed.cert)).toBe(true);
  });

  it("addDevice answers list-changed when the list moves twice", async () => {
    const a = await holder();
    const M = await offered(a.store);
    const j = await joined(browser().store, M);
    const E = (await stored(a.store)).E;
    const [third = "", fourth = ""] = await strangers(2, M);
    const lists = [
      await listBy(a.store, 2, [E, third]),
      await listBy(a.store, 3, [E, third, fourth]),
    ];
    vi.clearAllMocks();
    for (const behind of lists) {
      vi.mocked(api.putE2eList).mockImplementationOnce(async (t, s, list) => {
        await grappa.api.putE2eList(t, s, behind);
        return grappa.api.putE2eList(t, s, list);
      });
    }

    expect(await addDevice(a.store, NICK, SLOT, SLUG, j.id)).toBe("list-changed");

    expect(api.putE2eList).toHaveBeenCalledTimes(2);
    expect(await grappa.api.getE2eList(NICK, SLUG)).toEqual(lists[1]);
  });

  it("addDevice on a browser that is not the master answers failed and puts nothing", async () => {
    const a = await holder();
    const b = browser();
    const { M } = await paired(a.store, b.store);
    const j = await joined(browser().store, M);
    vi.clearAllMocks();

    expect(await addDevice(b.store, NICK, SLOT, SLUG, j.id)).toBe("failed");

    expect(api.putE2eList).not.toHaveBeenCalled();
    expect(await grappa.api.getE2eList(NICK, SLUG)).toMatchObject({ ver: 2 });
  });

  it("addDevice on a master whose identity grappa now holds under another answers failed and puts nothing", async () => {
    const a = await holder();
    const M = await offered(a.store);
    const j = await joined(browser().store, M);
    // Replaced since: grappa dropped it, and another browser made the one it holds now.
    await grappa.api.clearE2eKeys(NICK, SLUG);
    const now = await holder();
    vi.clearAllMocks();

    expect(await addDevice(a.store, NICK, SLOT, SLUG, j.id)).toBe("failed");

    expect(api.putE2eList).not.toHaveBeenCalled();
    expect(await grappa.api.getE2eList(NICK, SLUG)).toMatchObject({
      master: (await stored(now.store)).M,
      ver: 1,
    });
  });

  it("addDevice answers failed, and says why, for a device grappa does not hold", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await holder();
    const M = await offered(a.store);
    const before = await grappa.api.getE2eList(NICK, SLUG);
    const unregistered = new (olm().Account)();
    const id = idBlock(unregistered, M);
    unregistered.free();

    expect(await addDevice(a.store, NICK, SLOT, SLUG, id)).toBe("failed");

    expect(warn).toHaveBeenCalledWith(
      `[e2e] grappa refused the list with a new device on ${SLUG}: unknown_device`,
      expect.objectContaining({ status: 422, code: "unknown_device" }),
    );
    expect(await grappa.api.getE2eList(NICK, SLUG)).toEqual(before);
    expect((await stored(a.store)).own?.list.ver).toBe(1);
  });

  it("addDevice answers failed, and says why, for an id block that vouches for another master", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await holder();
    const before = await grappa.api.getE2eList(NICK, SLUG);
    // grappa holds the device (it never checks S1); its S1 names another master.
    const device = new (olm().Account)();
    const id = idBlock(device, new (olm().Account)().ed25519_key());
    device.free();
    await grappa.api.registerE2eDevice(NICK, SLUG, id);
    vi.clearAllMocks();

    expect(await addDevice(a.store, NICK, SLOT, SLUG, id)).toBe("failed");

    expect(warn).toHaveBeenCalledWith(
      `[e2e] the new device's id block does not vouch for this master on ${SLUG}`,
    );
    expect(api.putE2eList).not.toHaveBeenCalled();
    expect(await grappa.api.getE2eList(NICK, SLUG)).toEqual(before);
  });

  it("completeJoin refuses a certificate over another ver, says why, and writes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await holder();
    const b = browser();
    const M = await offered(a.store);
    const j = await joined(b.store, M);
    const signed = await signedFor(a.store, j.id);
    const cert = await a.store.withAccount(
      SLOT,
      async ({ master }) => master?.sign(certSigText(signed.list.ver + 1, j.id.ed25519)) ?? "",
    );
    vi.clearAllMocks();

    expect(await completeJoin(b.store, NICK, SLOT, SLUG, M, { ...signed, cert })).toBe(false);

    expect(warn).toHaveBeenCalledWith(
      `[e2e] the list or certificate the holder signed does not verify on ${SLUG}`,
    );
    expect((await stored(b.store)).own).toBeNull();
    expect(calls()).toEqual([]);
    // What the holder signed is taken.
    expect(await completeJoin(b.store, NICK, SLOT, SLUG, M, signed)).toBe(true);
  });

  // Once the signatures hold and the place is stored, the device IS listed
  // and placed: the sync after it only uploads keys, and the next sync (a
  // reload, a reconnect) uploads them if this one does not.
  it("completeJoin answers true once placed, though the sync after it fails or does not answer ready, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The sync throws: grappa does not answer the key status.
    {
      const a = await holder();
      const b = browser();
      const M = await offered(a.store);
      const j = await joined(b.store, M);
      const signed = await signedFor(a.store, j.id);
      const down = new api.ApiError(503, "db_unavailable");
      vi.mocked(api.getE2eDeviceKeys).mockRejectedValueOnce(down);

      expect(await completeJoin(b.store, NICK, SLOT, SLUG, M, signed)).toBe(true);

      expect((await stored(b.store)).own).toMatchObject({ master: M, certVer: 2, did: j.did });
      expect(warn).toHaveBeenCalledWith(
        `[e2e] the sync after pairing ${SLUG} failed; its keys go up at the next sync`,
        down,
      );
      // The next sync uploads them.
      expect(await sync(b.store)).toBe("ready");
      expect(await grappa.api.getE2eDeviceKeys(NICK, SLUG, j.did)).toEqual({
        one_time_keys: 50,
        fallback: true,
      });
    }
    // The sync reads no list on grappa: "elsewhere".
    {
      grappa = new Grappa();
      const a = await holder();
      const b = browser();
      const M = await offered(a.store);
      const j = await joined(b.store, M);
      const signed = await signedFor(a.store, j.id);
      vi.mocked(api.getE2eList).mockResolvedValueOnce(null);

      expect(await completeJoin(b.store, NICK, SLOT, SLUG, M, signed)).toBe(true);

      expect((await stored(b.store)).own).toMatchObject({ master: M, certVer: 2, did: j.did });
      expect(warn).toHaveBeenCalledWith(
        `[e2e] the sync after pairing ${SLUG} answered elsewhere; its keys go up at the next sync`,
      );
    }
  });

  it("abandonJoin tolerates not_found and listed_device, and warns on anything else", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const a = await holder();
    const M = await offered(a.store);
    const j = await joined(browser().store, M);
    const listed = (await stored(a.store)).own?.did ?? "";

    // Registered and never listed: dropped.
    await abandonJoin(NICK, SLUG, j.did);
    expect((await grappa.api.listE2eDevices(NICK, SLUG)).map((d) => d.did)).toEqual([listed]);
    // Gone already, and listed after all: nothing to drop.
    await abandonJoin(NICK, SLUG, j.did);
    await abandonJoin(NICK, SLUG, listed);
    expect(warn).not.toHaveBeenCalled();
    expect((await grappa.api.listE2eDevices(NICK, SLUG)).map((d) => d.did)).toEqual([listed]);

    // A refusal grappa names, but not one of the two: logged.
    const refused = new api.ApiError(503, "db_unavailable");
    vi.mocked(api.removeE2eDevice).mockRejectedValueOnce(refused);
    await abandonJoin(NICK, SLUG, j.did);
    expect(warn).toHaveBeenCalledWith(
      `[e2e] could not drop the unpaired device ${j.did} on ${SLUG}`,
      refused,
    );
  });

  it("offerable answers null on a browser without the master and stores no record", async () => {
    const empty = browser();

    expect(await offerable(empty.store, NICK, SLOT, SLUG)).toBeNull();

    expect(empty.vault.records.size).toBe(0);
    expect(calls()).toEqual([]);
    // A device paired to the identity holds no master either.
    const a = await holder();
    const b = browser();
    await paired(a.store, b.store);
    expect(await offerable(b.store, NICK, SLOT, SLUG)).toBeNull();
    // Nor does a master whose identity grappa now holds under another one.
    await grappa.api.clearE2eKeys(NICK, SLUG);
    await holder();
    expect(await offerable(a.store, NICK, SLOT, SLUG)).toBeNull();
  });

  it("offerable answers full on a list of 4", async () => {
    const a = await holder();
    const M = await offered(a.store);
    const others = await strangers(3, M);
    // Put by another device: the record learns of it from offerable's sync.
    await grappa.api.putE2eList(
      NICK,
      SLUG,
      await listBy(a.store, 2, [(await stored(a.store)).E, ...others]),
    );

    expect(await offerable(a.store, NICK, SLOT, SLUG)).toBe("full");
  });

  it("offerable answers the master on a ready master browser", async () => {
    const a = await holder();

    expect(await offerable(a.store, NICK, SLOT, SLUG)).toEqual({
      master: (await stored(a.store)).M,
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
