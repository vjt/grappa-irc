// issue 2430 — the Olm account: one per (subject, network), since vjt ruled
// ONE identity key per network, with the E2E engine's state for it (peers,
// pins, sessions, queues: `engine.ts`). Both live in IndexedDB as ONE record,
// vodozemac's pickle and the state as JSON, sealed with AES-GCM under a key
// WebCrypto created non-extractable, so the database alone (a profile copied
// off the disk) never yields the account: opening it takes this origin's
// running code. Nothing in the page can read the wrapping key's bytes
// either; it can only ask WebCrypto to use it.
//
// One record, because the two change together: a pre-key message uses up a
// one-time key of the account AND opens a session in the state, and storing
// one without the other leaves a session nobody can open again, or a key
// that opens one twice.
//
// Every read-modify-write of an account runs under an exclusive Web Lock
// named after its slot, so two tabs never load the same account, change it
// differently and store over each other (a one-time key generated in one tab
// and lost by the other would be published and never decryptable).

import { type E2eState, newState } from "./engine";
import type { Olm } from "./olm";
import type { Account } from "./vodozemac/vodozemac_binding";

/** A sealed record: AES-GCM ciphertext, and the IV it was sealed with. */
export type Sealed = { iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };

/** Where sealed accounts and the key that seals them are kept. */
export type Vault = {
  load(slot: string): Promise<Sealed | undefined>;
  store(slot: string, sealed: Sealed): Promise<void>;
  /** The AES-GCM key every account is sealed under, created on first use. */
  wrappingKey(): Promise<CryptoKey>;
};

/** An exclusive lock: `fn` runs once no other holder of `name` is running. */
export type Lock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

export type AccountSession = {
  account: Account;
  /** The engine's state for the account, changed in place and stored with it. */
  state: E2eState;
  /**
   * No usable account was stored, so this one is new: whatever key bundle
   * grappa holds for the slot belongs to an account that is gone.
   */
  created: boolean;
  /** Seals the account and the state as they are now into their slot. */
  persist(): Promise<void>;
};

export type AccountStore = {
  /**
   * Runs `fn` on the account of `slot` under the slot's lock, and stores the
   * account and its state when `fn` returns. A failing `fn` stores nothing
   * beyond what it `persist()`ed itself.
   */
  withAccount<T>(slot: string, fn: (session: AccountSession) => Promise<T>): Promise<T>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Seals `plain` under `key` for `slot`, the AES-GCM additional data. */
export async function seal(key: CryptoKey, slot: string, plain: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // The slot is the additional data: a record copied under another slot does
  // not open there.
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(slot) },
    key,
    encoder.encode(plain),
  );
  return { iv, ciphertext };
}

/** Opens what `seal` sealed for `slot`; throws if the key or the slot is not the one. */
export async function open(key: CryptoKey, slot: string, sealed: Sealed): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.iv, additionalData: encoder.encode(slot) },
    key,
    sealed.ciphertext,
  );
  return decoder.decode(plain);
}

/** What a sealed record holds. */
type StoredRecord = { account: string; state: E2eState };

function parseRecord(plain: string): StoredRecord {
  const record = JSON.parse(plain) as Partial<StoredRecord> | null;
  if (typeof record?.account !== "string" || record.state?.v !== 1) {
    throw new Error("not an account record");
  }
  return record as StoredRecord;
}

export function accountStore(olm: Olm, vault: Vault, lock: Lock): AccountStore {
  async function load(
    key: CryptoKey,
    slot: string,
  ): Promise<{ account: Account; state: E2eState } | undefined> {
    const sealed = await vault.load(slot);
    if (sealed === undefined) return undefined;
    try {
      const record = parseRecord(await open(key, slot, sealed));
      return { account: olm.Account.from_pickle(record.account), state: record.state };
    } catch (err) {
      // The wrapping key that sealed it is gone, or the record is damaged (or
      // a bare pickle from before the state joined it): it can never be
      // opened again, and the slot starts over. Peers that pinned the old
      // identity will see the new one as a different key.
      console.warn(
        `[e2e] the stored account for ${slot} cannot be opened; starting a new one`,
        err,
      );
      return undefined;
    }
  }

  return {
    withAccount: (slot, fn) =>
      lock(`grappa-e2e:account:${slot}`, async () => {
        const key = await vault.wrappingKey();
        const stored = await load(key, slot);
        const account = stored?.account ?? new olm.Account();
        const state = stored?.state ?? newState();
        const persist = async () =>
          vault.store(
            slot,
            await seal(key, slot, JSON.stringify({ account: account.pickle(), state })),
          );
        try {
          const result = await fn({ account, state, created: stored === undefined, persist });
          await persist();
          return result;
        } finally {
          account.free();
        }
      }),
  };
}

/** The IndexedDB database the E2E state lives in. Deleting it starts every account over. */
export const E2E_DATABASE = "grappa-e2e";

function settle<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function committed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** The object stores of sealed records: Olm accounts, and the chats read with them (`chatStore.ts`). */
export type VaultStore = "accounts" | "chats";

// One connection per operation, closed after it: a held connection would
// block `indexedDB.deleteDatabase` (the test-only wipe) until the tab closed.
// Version 2 added `chats`; an upgrade creates whichever store is missing.
async function withDatabase<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const request = indexedDB.open(E2E_DATABASE, 2);
  request.onupgradeneeded = () => {
    for (const name of ["keys", "accounts", "chats"]) {
      if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
    }
  };
  const db = await settle(request);
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

async function put(storeName: string, key: string, value: unknown): Promise<void> {
  await withDatabase(async (db) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value, key);
    // Durable once the transaction commits, not when the request succeeds:
    // the account must be on disk before its public keys leave the browser.
    await committed(tx);
  });
}

function get<T>(storeName: string, key: string): Promise<T | undefined> {
  return withDatabase((db) =>
    settle(db.transaction(storeName, "readonly").objectStore(storeName).get(key)),
  );
}

/**
 * The browser's vault over one object store of IndexedDB. Every store seals
 * under the same wrapping key, created once under `lock`.
 */
export function indexedDbVault(lock: Lock, store: VaultStore): Vault {
  return {
    load: (slot) => get<Sealed>(store, slot),
    store: (slot, sealed) => put(store, slot, sealed),
    // Two tabs creating the key at once would each seal under their own, and
    // one of them would overwrite the other's: a lock makes it one key.
    wrappingKey: () =>
      lock("grappa-e2e:wrapping-key", async () => {
        const held = await get<CryptoKey>("keys", "wrapping");
        if (held !== undefined) return held;
        const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
          "encrypt",
          "decrypt",
        ]);
        await put("keys", "wrapping", key);
        return key;
      }),
  };
}

/** The browser's lock: an exclusive Web Lock, shared by every tab of the origin. */
export const webLock: Lock = (name, fn) => navigator.locks.request(name, fn);
