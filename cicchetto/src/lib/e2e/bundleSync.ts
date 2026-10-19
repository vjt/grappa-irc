// issue 2430 — keeps grappa's copy of this subject's key bundle full, per
// network, so a peer's KEYREQ is answered while every cic tab is closed
// (CLIENT_PROTOCOL §4f).
//
// Once per page load and per (subject, network), and again for a network
// that appears later: the bundle needs no live IRC link (grappa stores it per
// binding), so this does not wait for one. The other refill point, after each
// PKMSG this client receives (each used up a one-time key), comes with the
// slice that reads PKMSGs.

import { createEffect } from "solid-js";
import { clearE2eKeys, getE2eKeys, uploadE2eKeys } from "../api";
import { token } from "../auth";
import { networks, user } from "../networks";
import {
  type AccountStore,
  accountStore,
  E2E_DATABASE,
  indexedDbVault,
  webLock,
} from "./accountStore";
import { topUp } from "./keyBundle";
import { loadOlm } from "./olm";

const NOTHING_HELD = { one_time_keys: 0, fallback: false };

/** The account slot of a subject on a network: one identity key per network. */
export function accountSlot(subject: { kind: string; id: string }, networkId: number): string {
  return `${subject.kind}:${subject.id}:${networkId}`;
}

/**
 * Brings the bundle grappa holds for `slot` on `networkSlug` up to full.
 *
 * A NEW account (none stored, or the stored one lost) first drops whatever
 * grappa holds: those keys belong to an account that is gone, and a peer
 * handed one would open a session nobody can decrypt. The account is stored
 * with its new keys BEFORE they are uploaded, so grappa never holds a key
 * whose private half was not kept, and marked published only once grappa
 * has them; an upload that fails is resent, the same keys, next time.
 */
export async function syncKeyBundle(
  store: AccountStore,
  bearer: string,
  slot: string,
  networkSlug: string,
): Promise<void> {
  await store.withAccount(slot, async ({ account, created, persist }) => {
    if (created) await clearE2eKeys(bearer, networkSlug);
    const held = created ? NOTHING_HELD : await getE2eKeys(bearer, networkSlug);
    const upload = topUp(account, held);
    if (upload !== null) {
      await persist();
      await uploadE2eKeys(bearer, networkSlug, upload);
    }
    account.mark_keys_as_published();
  });
}

let browserStore: Promise<AccountStore> | undefined;

function store(): Promise<AccountStore> {
  browserStore ??= loadOlm().then((olm) => accountStore(olm, indexedDbVault(webLock), webLock));
  return browserStore;
}

// Slots synced (or syncing) on this page. A failed sync leaves the set, so the
// next change to the network list tries it again.
const synced = new Set<string>();

/** Syncs every network's bundle once per page load. Registered by main.tsx in a root. */
export function mountKeyBundleSync(): void {
  createEffect(() => {
    const bearer = token();
    const me = user();
    const list = networks();
    if (!bearer || !me || !list) return;
    for (const network of list) {
      const slot = accountSlot(me, network.id);
      if (synced.has(slot)) continue;
      synced.add(slot);
      void store()
        .then((s) => syncKeyBundle(s, bearer, slot, network.slug))
        .catch((err: unknown) => {
          synced.delete(slot);
          console.warn(`[e2e] key bundle sync failed for ${network.slug}`, err);
        });
    }
  });
}

declare global {
  interface Window {
    /**
     * TEST-ONLY (issue 2430, for the interop suite): deletes this browser's
     * E2E state, every account and the key that seals them. This page does
     * not sync again; the next page load starts each network over with a new
     * identity and replaces the bundle grappa holds. Ships in the bundle like
     * the other `__cic_*` hooks; it grants nothing a script in this origin
     * could not do with `indexedDB.deleteDatabase`.
     */
    __cic_e2eResetForTests?: () => Promise<void>;
  }
}

if (typeof window !== "undefined") {
  window.__cic_e2eResetForTests = () =>
    new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(E2E_DATABASE);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
}
