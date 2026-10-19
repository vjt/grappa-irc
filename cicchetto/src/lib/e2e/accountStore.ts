// issue 2430 — the Olm account: one per (subject, network), since vjt ruled
// ONE identity key per network. It lives in IndexedDB as vodozemac's pickle,
// sealed with AES-GCM under a key WebCrypto created non-extractable, so the
// database alone (a profile copied off the disk) never yields the account:
// opening it takes this origin's running code. Nothing in the page can read
// the wrapping key's bytes either; it can only ask WebCrypto to use it.
//
// Every read-modify-write of an account runs under an exclusive Web Lock
// named after its slot, so two tabs never load the same account, change it
// differently and store over each other (a one-time key generated in one tab
// and lost by the other would be published and never decryptable).

import type { Olm } from "./olm";
import type { Account } from "./vodozemac/vodozemac_binding";

/** A sealed pickle: AES-GCM ciphertext, and the IV it was sealed with. */
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
  /**
   * No usable account was stored, so this one is new: whatever key bundle
   * grappa holds for the slot belongs to an account that is gone.
   */
  created: boolean;
  /** Seals the account as it is now into its slot. */
  persist(): Promise<void>;
};

export type AccountStore = {
  /**
   * Runs `fn` on the account of `slot` under the slot's lock, and stores the
   * account when `fn` returns. A failing `fn` stores nothing beyond what it
   * `persist()`ed itself.
   */
  withAccount<T>(slot: string, fn: (session: AccountSession) => Promise<T>): Promise<T>;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function seal(key: CryptoKey, slot: string, pickle: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  // The slot is the additional data: a record copied under another slot does
  // not open there.
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(slot) },
    key,
    encoder.encode(pickle),
  );
  return { iv, ciphertext };
}

async function open(key: CryptoKey, slot: string, sealed: Sealed): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: sealed.iv, additionalData: encoder.encode(slot) },
    key,
    sealed.ciphertext,
  );
  return decoder.decode(plain);
}

export function accountStore(olm: Olm, vault: Vault, lock: Lock): AccountStore {
  async function load(key: CryptoKey, slot: string): Promise<Account | undefined> {
    const sealed = await vault.load(slot);
    if (sealed === undefined) return undefined;
    try {
      return olm.Account.from_pickle(await open(key, slot, sealed));
    } catch (err) {
      // The wrapping key that sealed it is gone, or the record is damaged:
      // it can never be opened again, and the slot starts over. Peers that
      // pinned the old identity will see the new one as a different key.
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
        const account = stored ?? new olm.Account();
        const persist = async () => vault.store(slot, await seal(key, slot, account.pickle()));
        try {
          const result = await fn({ account, created: stored === undefined, persist });
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

// One connection per operation, closed after it: a held connection would
// block `indexedDB.deleteDatabase` (the test-only wipe) until the tab closed.
async function withDatabase<T>(fn: (db: IDBDatabase) => Promise<T>): Promise<T> {
  const request = indexedDB.open(E2E_DATABASE, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore("keys");
    request.result.createObjectStore("accounts");
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

/** The browser's vault: IndexedDB, the wrapping key created once under `lock`. */
export function indexedDbVault(lock: Lock): Vault {
  return {
    load: (slot) => get<Sealed>("accounts", slot),
    store: (slot, sealed) => put("accounts", slot, sealed),
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
