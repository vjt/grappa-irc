// issue 2430 — what cic keeps per (subject, network): this device's Olm
// account, the identity's master where this device made it, its place in the
// identity, and the E2E engine's state, sealed under a non-extractable key. The vault and the lock are the two browser services
// (IndexedDB, Web Locks) jsdom does not have; they are replaced by in-memory
// twins with the same contract, and everything else is real: the vodozemac
// binding, and WebCrypto's AES-GCM.
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountStore, type OwnIdentity, seal } from "../lib/e2e/accountStore";
import { newState } from "../lib/e2e/engine";
import { certSigText, listSigText } from "../lib/e2e/wire";
import { type MemoryVault, memoryLock, memoryVault } from "./helpers/e2eVault";
import { olm } from "./helpers/olm";

const SLOT = "user:0b5e:1";

/** Seals `record` (a string as it is, anything else as JSON) into `slot`, as the store seals one. */
async function seed(vault: MemoryVault, slot: string, record: unknown): Promise<void> {
  const plain = typeof record === "string" ? record : JSON.stringify(record);
  vault.records.set(slot, await seal(await vault.wrappingKey(), slot, plain));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("accountStore", () => {
  it("creates the account on first use, and restores the same identity after", async () => {
    const vault = memoryVault();
    const store = accountStore(olm(), vault, memoryLock());

    const first = await store.withAccount(SLOT, async ({ account, created }) => ({
      created,
      ed25519: account.ed25519_key(),
    }));
    const again = await store.withAccount(SLOT, async ({ account, created }) => ({
      created,
      ed25519: account.ed25519_key(),
    }));

    expect(first.created).toBe(true);
    expect(again).toEqual({ created: false, ed25519: first.ed25519 });
  });

  it("keeps one account per slot", async () => {
    const store = accountStore(olm(), memoryVault(), memoryLock());
    const identity = (slot: string) =>
      store.withAccount(slot, async ({ account }) => account.ed25519_key());

    expect(await identity("user:0b5e:1")).not.toBe(await identity("user:0b5e:2"));
  });

  it("stores the account sealed: no key material in the clear, and bound to its slot", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vault = memoryVault();
    const store = accountStore(olm(), vault, memoryLock());
    const ed25519 = await store.withAccount(SLOT, async ({ account }) => account.ed25519_key());

    const sealed = vault.records.get(SLOT);
    if (sealed === undefined) throw new Error("nothing stored");
    const bytes = new TextDecoder("latin1").decode(new Uint8Array(sealed.ciphertext));
    expect(bytes).not.toContain(ed25519);
    expect(bytes).not.toContain("ed25519");

    // The same record copied under another slot does not open there.
    vault.records.set("user:0b5e:9", sealed);
    const moved = await store.withAccount("user:0b5e:9", async ({ account, created }) => ({
      created,
      ed25519: account.ed25519_key(),
    }));
    expect(moved.created).toBe(true);
    expect(moved.ed25519).not.toBe(ed25519);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("starts a new account, and says so, when the stored one can no longer be opened", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vault = memoryVault();
    const store = accountStore(olm(), vault, memoryLock());
    const old = await store.withAccount(SLOT, async ({ account }) => account.ed25519_key());

    vault.rekey();
    const fresh = await store.withAccount(SLOT, async ({ account, created }) => ({
      created,
      ed25519: account.ed25519_key(),
    }));

    expect(fresh.created).toBe(true);
    expect(fresh.ed25519).not.toBe(old);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[e2e]"), expect.anything());
  });

  it("persist() stores the account as it is at that moment, even if the session then fails", async () => {
    const store = accountStore(olm(), memoryVault(), memoryLock());

    await expect(
      store.withAccount(SLOT, async ({ account, persist }) => {
        account.generate_one_time_keys(3);
        await persist();
        account.generate_one_time_keys(4);
        throw new Error("upload failed");
      }),
    ).rejects.toThrow("upload failed");

    const pending = await store.withAccount(
      SLOT,
      async ({ account }) => account.one_time_keys().length,
    );
    expect(pending).toBe(3);
  });

  it("a session that ends normally is stored; one that fails without persist() leaves the account as it was", async () => {
    const store = accountStore(olm(), memoryVault(), memoryLock());
    await store.withAccount(SLOT, async ({ account }) => account.generate_one_time_keys(2));

    await expect(
      store.withAccount(SLOT, async ({ account }) => {
        account.generate_one_time_keys(5);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(
      await store.withAccount(SLOT, async ({ account }) => account.one_time_keys().length),
    ).toBe(2);
  });

  it("stores the engine state in the same record, and restores it with the account", async () => {
    const vault = memoryVault();
    const store = accountStore(olm(), vault, memoryLock());

    const fresh = await store.withAccount(SLOT, async ({ state }) => {
      const before = structuredClone(state);
      state.pins.bob = "a-pinned-key";
      return before;
    });
    const restored = await store.withAccount(SLOT, async ({ state }) => state);

    expect(fresh).toEqual(newState());
    expect(restored).toEqual({ ...newState(), pins: { bob: "a-pinned-key" } });
    // Sealed like the account: nothing of it in the clear.
    const sealed = vault.records.get(SLOT);
    if (sealed === undefined) throw new Error("nothing stored");
    expect(new TextDecoder("latin1").decode(new Uint8Array(sealed.ciphertext))).not.toContain(
      "a-pinned-key",
    );
  });

  it("persist() stores the state with the account, so a failing session keeps both as persisted", async () => {
    const store = accountStore(olm(), memoryVault(), memoryLock());

    await expect(
      store.withAccount(SLOT, async ({ account, state, persist }) => {
        account.generate_one_time_keys(1);
        state.pins.bob = "kept";
        await persist();
        account.generate_one_time_keys(1);
        state.pins.carol = "lost";
        throw new Error("send failed");
      }),
    ).rejects.toThrow("send failed");

    expect(
      await store.withAccount(SLOT, async ({ account, state }) => ({
        keys: account.one_time_keys().length,
        pins: state.pins,
      })),
    ).toEqual({ keys: 1, pins: { bob: "kept" } });
  });

  it("keeps the master and this device's place in the identity in the same record, sealed, and restores them", async () => {
    const vault = memoryVault();
    const store = accountStore(olm(), vault, memoryLock());

    const made = await store.withAccount(SLOT, async (session) => {
      expect(session.master).toBeNull();
      expect(session.own).toBeNull();
      const master = session.newAccount();
      const device = session.account.ed25519_key();
      const devices = [device];
      const own: OwnIdentity = {
        master: master.ed25519_key(),
        cert: master.sign(certSigText(1, device)),
        certVer: 1,
        list: { ver: 1, devices, sig: master.sign(listSigText(1, devices)) },
        did: "AaZaARRDyBk",
      };
      session.master = master;
      session.own = own;
      return { master: master.ed25519_key(), device, own };
    });
    const restored = await store.withAccount(SLOT, async ({ account, master, own, created }) => ({
      created,
      device: account.ed25519_key(),
      master: master?.ed25519_key(),
      // The master restored is the one that signed: it signs the same again.
      signs: master?.sign(certSigText(1, account.ed25519_key())),
      own,
    }));

    expect(restored).toEqual({
      created: false,
      device: made.device,
      master: made.master,
      signs: made.own.cert,
      own: made.own,
    });
    const sealed = vault.records.get(SLOT);
    if (sealed === undefined) throw new Error("nothing stored");
    const bytes = new TextDecoder("latin1").decode(new Uint8Array(sealed.ciphertext));
    expect(bytes).not.toContain(made.master);
    expect(bytes).not.toContain(made.own.cert);
  });

  it("starts over on a record whose place in the identity names no certificate version, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vault = memoryVault();
    const Account = olm().Account;
    const device = new Account();
    const master = new Account();
    const ed25519 = device.ed25519_key();
    // A place from before it kept the list version its certificate names.
    const own = {
      master: master.ed25519_key(),
      cert: master.sign(certSigText(1, ed25519)),
      list: { ver: 1, devices: [ed25519], sig: master.sign(listSigText(1, [ed25519])) },
      did: "AaZaARRDyBk",
    };
    await seed(vault, SLOT, {
      account: device.pickle(),
      master: master.pickle(),
      own,
      state: newState(),
    });

    const opened = await accountStore(olm(), vault, memoryLock()).withAccount(
      SLOT,
      async (session) => ({
        created: session.created,
        own: session.own,
        ed25519: session.account.ed25519_key(),
      }),
    );

    expect(opened).toEqual({ created: true, own: null, ed25519: expect.any(String) });
    expect(opened.ed25519).not.toBe(ed25519);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("starting a new one"),
      expect.anything(),
    );
    device.free();
    master.free();
  });

  it("frees every account a session held when it ends: the one it loaded, and each one it made", async () => {
    const store = accountStore(olm(), memoryVault(), memoryLock());
    const frees: ReturnType<typeof vi.spyOn>[] = [];

    await store.withAccount(SLOT, async (session) => {
      frees.push(vi.spyOn(session.account, "free"));
      const master = session.newAccount();
      frees.push(vi.spyOn(master, "free"));
      session.master = master;
      // A new device account replaces the loaded one: both are the session's.
      session.account = session.newAccount();
      frees.push(vi.spyOn(session.account, "free"));
      // One made and never kept is the session's too.
      frees.push(vi.spyOn(session.newAccount(), "free"));
    });

    expect(frees.map((free) => free.mock.calls.length)).toEqual([1, 1, 1, 1]);
  });

  it.each([
    ["its master", "master"],
    ["its device account", "account"],
  ])(
    "frees what it already unpickled from a record whose pickle of %s is damaged, and starts over",
    async (_name, damaged) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const vault = memoryVault();
      const Account = olm().Account;
      const device = new Account();
      const master = new Account();
      const record = {
        account: damaged === "account" ? "not a pickle" : device.pickle(),
        master: damaged === "master" ? "not a pickle" : master.pickle(),
        own: null,
        state: newState(),
      };
      await seed(vault, SLOT, record);
      const unpickle = Account.from_pickle.bind(Account);
      const frees: ReturnType<typeof vi.spyOn>[] = [];
      vi.spyOn(Account, "from_pickle").mockImplementation((pickle: string) => {
        const opened = unpickle(pickle);
        frees.push(vi.spyOn(opened, "free"));
        return opened;
      });

      const created = await accountStore(olm(), vault, memoryLock()).withAccount(
        SLOT,
        async (session) => session.created,
      );

      expect(created).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      // Whatever opened before the damaged pickle failed was freed, once.
      expect(frees.map((free) => free.mock.calls.length)).toEqual(frees.map(() => 1));
      device.free();
      master.free();
    },
  );

  // Both the record a v1 cic stored, and one shaped like v2 around a state
  // that is not: the state's version alone decides.
  it.each([
    ["a v1 record, the format before the identity had devices", false],
    ["a record whose state is not v2", true],
  ])("starts over on %s, and says so", async (_name, v2Envelope) => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vault = memoryVault();
    const store = accountStore(olm(), vault, memoryLock());
    const old = new (olm().Account)();
    const v1State = {
      v: 1,
      peers: {},
      pins: { bob: "K" },
      sessions: {},
      seen: [],
      outq: {},
      keyreqAt: {},
      rekeyAt: {},
      sent: [],
      nextRef: 1,
      inbox: 7,
      sas: {},
    };
    const envelope = v2Envelope ? { master: null, own: null } : {};
    await seed(vault, SLOT, { account: old.pickle(), ...envelope, state: v1State });

    const opened = await store.withAccount(SLOT, async ({ account, state, created }) => ({
      created,
      ed25519: account.ed25519_key(),
      state,
    }));

    expect(opened.created).toBe(true);
    expect(opened.ed25519).not.toBe(old.ed25519_key());
    expect(opened.state).toEqual(newState());
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("starting a new one"),
      expect.anything(),
    );
    old.free();
  });

  it("starts over on a record that holds a bare pickle, the format before the state joined it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vault = memoryVault();
    const store = accountStore(olm(), vault, memoryLock());
    const old = new (olm().Account)();
    await seed(vault, SLOT, old.pickle());

    const opened = await store.withAccount(SLOT, async ({ account, created }) => ({
      created,
      ed25519: account.ed25519_key(),
    }));

    expect(opened.created).toBe(true);
    expect(opened.ed25519).not.toBe(old.ed25519_key());
    expect(warn).toHaveBeenCalledTimes(1);
    old.free();
  });

  it("starts over on a record that holds an account but no engine state", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vault = memoryVault();
    const store = accountStore(olm(), vault, memoryLock());
    const old = new (olm().Account)();
    await seed(vault, SLOT, { account: old.pickle(), master: null, own: null });

    const opened = await store.withAccount(SLOT, async ({ account, created }) => ({
      created,
      ed25519: account.ed25519_key(),
    }));

    expect(opened.created).toBe(true);
    expect(opened.ed25519).not.toBe(old.ed25519_key());
    expect(warn).toHaveBeenCalledTimes(1);
    old.free();
  });

  it("opens a record sealed before a state field existed, with that field empty", async () => {
    const vault = memoryVault();
    const store = accountStore(olm(), vault, memoryLock());
    const old = new (olm().Account)();
    // A v2 state from before `listAnsweredAt`.
    const { listAnsweredAt: _gone, ...before } = { ...newState(), pins: { bob: "K" }, inbox: 7 };
    await seed(vault, SLOT, { account: old.pickle(), master: null, own: null, state: before });

    const opened = await store.withAccount(SLOT, async ({ account, state, created }) => ({
      created,
      ed25519: account.ed25519_key(),
      state,
    }));

    expect(opened.created).toBe(false);
    expect(opened.ed25519).toBe(old.ed25519_key());
    expect(opened.state).toEqual({ ...newState(), pins: { bob: "K" }, inbox: 7 });
    old.free();
  });

  it("two sessions on one slot never interleave, so neither loses the other's keys", async () => {
    const store = accountStore(olm(), memoryVault(), memoryLock());
    await store.withAccount(SLOT, async () => undefined);

    const addOne = () =>
      store.withAccount(SLOT, async ({ account }) => {
        // Yield between load and store, where a second session would read the
        // account this one has not stored yet.
        await new Promise((resolve) => setTimeout(resolve, 5));
        account.generate_one_time_keys(1);
      });
    await Promise.all([addOne(), addOne()]);

    expect(
      await store.withAccount(SLOT, async ({ account }) => account.one_time_keys().length),
    ).toBe(2);
  });
});
