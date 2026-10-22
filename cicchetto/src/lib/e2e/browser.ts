// issue 2430 — the browser's E2E stores, built once per page on first use:
// the vodozemac binding, the Olm accounts and the encrypted chats, both
// sealed in IndexedDB under one wrapping key and serialised by Web Locks.
// The bundle sync and the chat glue share them, so they share the locks'
// view of who holds what.

import { type AccountStore, accountStore, indexedDbVault, webLock } from "./accountStore";
import { type ChatStore, chatStore } from "./chatStore";
import { loadOlm, type Olm } from "./olm";

export type BrowserE2e = { olm: Olm; accounts: AccountStore; chats: ChatStore };

let stores: Promise<BrowserE2e> | undefined;

/** The page's stores. A failed load (the binding did not load) is forgotten, so the next call tries again. */
export function browserE2e(): Promise<BrowserE2e> {
  stores ??= loadOlm().then(
    (olm) => ({
      olm,
      accounts: accountStore(olm, indexedDbVault(webLock, "accounts"), webLock),
      chats: chatStore(indexedDbVault(webLock, "chats"), webLock),
    }),
    (err: unknown) => {
      stores = undefined;
      throw err;
    },
  );
  return stores;
}
