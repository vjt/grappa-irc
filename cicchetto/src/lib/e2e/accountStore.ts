// issue 2430 — what cic keeps per (subject, network), one identity per
// network as vjt ruled: this device's Olm account; the identity's master, a
// second account kept only for signing, on the device that made it; this
// device's place in the identity (`OwnIdentity`); and the E2E engine's state
// (masters, pins, sessions, queues: `engine.ts`). All of it lives in
// IndexedDB as ONE record, vodozemac's pickles and the rest as JSON, sealed
// with AES-GCM under a key WebCrypto created non-extractable, so the
// database alone (a profile copied off the disk) never yields an account:
// opening it takes this origin's running code. Nothing in the page can read
// the wrapping key's bytes either; it can only ask WebCrypto to use it.
//
// One record, because they change together: a pre-key message uses up a
// one-time key of the account AND opens a session in the state, and storing
// one without the other leaves a session nobody can open again, or a key
// that opens one twice; a new identity replaces the account, the master and
// the device's place at once (`identity.ts`).
//
// Every read-modify-write of a record runs under an exclusive Web Lock
// named after its slot, so two tabs never load the same account, change it
// differently and store over each other (a one-time key generated in one tab
// and lost by the other would be published and never decryptable).

import { type E2eState, newState } from "./engine";
import type { Olm } from "./olm";
import type { Account } from "./vodozemac/vodozemac_binding";
import type { SignedList } from "./wire";

/** A sealed record: AES-GCM ciphertext, and the IV it was sealed with. */
export type Sealed = { iv: Uint8Array<ArrayBuffer>; ciphertext: ArrayBuffer };

/** Where sealed accounts and the key that seals them are kept. */
export type Vault = {
  load(slot: string): Promise<Sealed | undefined>;
  store(slot: string, sealed: Sealed): Promise<void>;
  /** Deletes what is stored under `slot`; nothing stored there is fine. */
  remove(slot: string): Promise<void>;
  /** The AES-GCM key every account is sealed under, created on first use. */
  wrappingKey(): Promise<CryptoKey>;
};

/** An exclusive lock: `fn` runs once no other holder of `name` is running. */
export type Lock = <T>(name: string, fn: () => Promise<T>) => Promise<T>;

/** This device's place in the subject's identity on the network. */
export type OwnIdentity = {
  /** The master's Ed25519 key: what peers pin. */
  master: string;
  /** The master's certificate for this device, `M.sign(certSigText(certVer, E))`: every PKMSG carries it. */
  cert: string;
  /** The list version the certificate names: the first list that held this device. Every PKMSG names it. */
  certVer: number;
  /** The list the master last put on grappa, this device in it. */
  list: SignedList;
  /** This device's did, as grappa derived it: its `from`, and the `:did` of its doors. */
  did: string;
};

export type AccountSession = {
  /** This device's Olm account. A new identity puts a new one here (`identity.ts`). */
  account: Account;
  /** The master, on the device that made the identity; null on any other, and before one exists. */
  master: Account | null;
  /** This device's place in the identity; null before it has one. */
  own: OwnIdentity | null;
  /** The engine's state for the account, changed in place and stored with it. */
  state: E2eState;
  /** No usable record was stored, so the account is new and the slot holds no identity. */
  created: boolean;
  /**
   * A new account, with fresh keys. The session owns it like every account it
   * holds: put in `account` or `master` it is stored by `persist()`, and
   * either way it is freed when the session ends.
   */
  newAccount(): Account;
  /** Seals the account, the master, the device's place and the state as they are now into their slot. */
  persist(): Promise<void>;
};

export type AccountStore = {
  /**
   * Runs `fn` on the record of `slot` under the slot's lock, and stores it
   * when `fn` returns. A failing `fn` stores nothing beyond what it
   * `persist()`ed itself.
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

/** What a sealed record holds: the pickles, the device's place, the state. */
type StoredRecord = {
  account: string;
  master: string | null;
  own: OwnIdentity | null;
  state: E2eState;
};

/** What a record opens into. */
type Opened = {
  account: Account;
  master: Account | null;
  own: OwnIdentity | null;
  state: E2eState;
};

// Only a record of the current shape opens: one from before the identity had
// devices (a v1 state, without a master or a place), or a place from before
// the certificate named its list version (every PKMSG must carry it), is
// refused like a damaged one, and the slot starts over.
function parseRecord(plain: string): StoredRecord {
  const record = JSON.parse(plain) as Partial<StoredRecord> | null;
  if (
    typeof record?.account !== "string" ||
    (record.master !== null && typeof record.master !== "string") ||
    (record.own !== null && typeof record.own?.certVer !== "number") ||
    record.state?.v !== 2
  ) {
    throw new Error("not an account record");
  }
  return record as StoredRecord;
}

export function accountStore(olm: Olm, vault: Vault, lock: Lock): AccountStore {
  async function load(key: CryptoKey, slot: string): Promise<Opened | undefined> {
    const sealed = await vault.load(slot);
    if (sealed === undefined) return undefined;
    try {
      const record = parseRecord(await open(key, slot, sealed));
      // A field the state gained since the record was sealed starts empty.
      const state = { ...newState(), ...record.state };
      const account = olm.Account.from_pickle(record.account);
      try {
        const master = record.master === null ? null : olm.Account.from_pickle(record.master);
        return { account, master, own: record.own, state };
      } catch (err) {
        // A damaged master pickle: the account opened before it is no one's.
        account.free();
        throw err;
      }
    } catch (err) {
      // The wrapping key that sealed it is gone, or the record is damaged or
      // of an older shape (a v1 state, a bare pickle from before the state
      // joined it): it can never be opened again, and the slot starts over.
      // With no identity here, the next sync reads one grappa still holds as
      // held elsewhere, never replacing it (`identity.ts`), and makes a new
      // one only when grappa holds none.
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
        // Every account the session holds, loaded or made: freed when it ends.
        const held: Account[] = [];
        const hold = <A extends Account | null>(account: A): A => {
          if (account !== null) held.push(account);
          return account;
        };
        const session: AccountSession = {
          account: hold(stored?.account ?? new olm.Account()),
          master: hold(stored?.master ?? null),
          own: stored?.own ?? null,
          state: stored?.state ?? newState(),
          created: stored === undefined,
          newAccount: () => hold(new olm.Account()),
          persist: async () => {
            const record: StoredRecord = {
              account: session.account.pickle(),
              master: session.master?.pickle() ?? null,
              own: session.own,
              state: session.state,
            };
            await vault.store(slot, await seal(key, slot, JSON.stringify(record)));
          },
        };
        try {
          const result = await fn(session);
          await session.persist();
          return result;
        } finally {
          for (const account of held) account.free();
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

async function del(storeName: string, key: string): Promise<void> {
  await withDatabase(async (db) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).delete(key);
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
    remove: (slot) => del(store, slot),
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
