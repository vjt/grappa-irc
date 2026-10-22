// issue 2430 — the browser's E2E stores, built once per page on first use:
// the vodozemac binding, the Olm accounts and the encrypted chats, both
// sealed in IndexedDB under one wrapping key and serialised by Web Locks.
// The bundle sync and the chat glue share them, so they share the locks'
// view of who holds what. And this page's part in the SASes (`sas.ts`).

import { type AccountStore, accountStore, indexedDbVault, webLock } from "./accountStore";
import { type ChatStore, chatStore } from "./chatStore";
import { loadOlm, type Olm } from "./olm";
import type { SasHost } from "./sas";

export type BrowserE2e = { olm: Olm; accounts: AccountStore; chats: ChatStore; sas: SasHost };

let stores: Promise<BrowserE2e> | undefined;

const PAGE_LOCK = "grappa-e2e:page:";

// This page as the other tabs see it: alive while it holds a Web Lock named
// after it, which the browser lets go when the page goes (closed, reloaded,
// discarded). A SAS whose secret a page holds needs that page alive.
function pageHost(): SasHost {
  const page = crypto.randomUUID();
  void navigator.locks.request(`${PAGE_LOCK}${page}`, () => new Promise<never>(() => {}));
  return {
    page,
    secrets: new Map(),
    alive: async () => {
      const { held = [] } = await navigator.locks.query();
      return new Set(
        held.flatMap(({ name }) =>
          name?.startsWith(PAGE_LOCK) ? [name.slice(PAGE_LOCK.length)] : [],
        ),
      );
    },
  };
}

/** The page's stores. A failed load (the binding did not load) is forgotten, so the next call tries again. */
export function browserE2e(): Promise<BrowserE2e> {
  stores ??= loadOlm().then(
    (olm) => ({
      olm,
      accounts: accountStore(olm, indexedDbVault(webLock, "accounts"), webLock),
      chats: chatStore(indexedDbVault(webLock, "chats"), webLock),
      sas: pageHost(),
    }),
    (err: unknown) => {
      stores = undefined;
      throw err;
    },
  );
  return stores;
}
