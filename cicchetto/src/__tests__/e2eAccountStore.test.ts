// issue 2430 — the Olm account cic keeps per (subject, network), sealed under
// a non-extractable key. The vault and the lock are the two browser services
// (IndexedDB, Web Locks) jsdom does not have; they are replaced by in-memory
// twins with the same contract, and everything else is real: the vodozemac
// binding, and WebCrypto's AES-GCM.
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountStore, type Lock, type Sealed, type Vault } from "../lib/e2e/accountStore";
import { olm } from "./helpers/olm";

function memoryVault(): Vault & { records: Map<string, Sealed>; rekey(): void } {
  const records = new Map<string, Sealed>();
  let key: Promise<CryptoKey> | undefined;
  return {
    records,
    load: async (slot) => records.get(slot),
    store: async (slot, sealed) => {
      records.set(slot, sealed);
    },
    wrappingKey: () => {
      key ??= crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
        "encrypt",
        "decrypt",
      ]);
      return key;
    },
    // The wrapping key is gone (its store was cleared on its own): what is
    // sealed under the old one can no longer be opened.
    rekey: () => {
      key = undefined;
    },
  };
}

// One holder per name at a time, the rest queued in order: what
// `navigator.locks.request(name, fn)` guarantees for an exclusive lock.
function memoryLock(): Lock {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const run = (tails.get(name) ?? Promise.resolve()).then(fn, fn);
    tails.set(
      name,
      run.catch(() => undefined),
    );
    return run;
  };
}

const SLOT = "user:0b5e:1";

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
