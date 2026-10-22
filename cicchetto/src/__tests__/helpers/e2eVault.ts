// issue 2430 — in-memory twins of the two browser services the E2E stores
// sit on and jsdom does not have: IndexedDB (a `Vault`) and Web Locks (a
// `Lock`, and the page's own liveness lock). Same contracts; everything
// above them, WebCrypto's AES-GCM included, stays real.
import type { Lock, Sealed, Vault } from "../../lib/e2e/accountStore";

export type MemoryVault = Vault & { records: Map<string, Sealed>; rekey(): void };

export function memoryVault(): MemoryVault {
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
export function memoryLock(): Lock {
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

// `navigator.locks` for the lock a page holds while it lives
// (`e2e/browser.ts`): every request is held for good, and `query` lists them.
export function installPageLocks(): void {
  const held: string[] = [];
  Object.defineProperty(navigator, "locks", {
    configurable: true,
    value: {
      request: (name: string) => {
        held.push(name);
        return new Promise(() => undefined);
      },
      query: async () => ({ held: held.map((name) => ({ name, mode: "exclusive" })) }),
    },
  });
}
