// issue 2430 — the Olm account cic keeps per (subject, network), with the E2E
// engine's state for it, sealed under a non-extractable key. The vault and the lock are the two browser services
// (IndexedDB, Web Locks) jsdom does not have; they are replaced by in-memory
// twins with the same contract, and everything else is real: the vodozemac
// binding, and WebCrypto's AES-GCM.
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountStore } from "../lib/e2e/accountStore";
import { newState } from "../lib/e2e/engine";
import { memoryLock, memoryVault } from "./helpers/e2eVault";
import { olm } from "./helpers/olm";

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

  it("starts over on a record that holds a bare pickle, the format before the state joined it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const vault = memoryVault();
    const store = accountStore(olm(), vault, memoryLock());
    const old = new (olm().Account)();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(SLOT) },
      await vault.wrappingKey(),
      new TextEncoder().encode(old.pickle()),
    );
    vault.records.set(SLOT, { iv, ciphertext });

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
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(SLOT) },
      await vault.wrappingKey(),
      new TextEncoder().encode(JSON.stringify({ account: old.pickle() })),
    );
    vault.records.set(SLOT, { iv, ciphertext });

    const opened = await store.withAccount(SLOT, async ({ account, created }) => ({
      created,
      ed25519: account.ed25519_key(),
    }));

    expect(opened.created).toBe(true);
    expect(opened.ed25519).not.toBe(old.ed25519_key());
    expect(warn).toHaveBeenCalledTimes(1);
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
