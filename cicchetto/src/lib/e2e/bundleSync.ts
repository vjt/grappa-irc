// issue 2430 — keeps grappa's copy of this subject's key bundle full, per
// network, so a peer's KEYREQ is answered while every cic tab is closed
// (CLIENT_PROTOCOL §4f).
//
// Once per page load and per (subject, network), and again for a network
// that appears later: the bundle needs no live IRC link (grappa stores it per
// binding), so this does not wait for one. The chat glue
// (`lib/encryptedChats.ts`) calls `syncKeyBundle` too: after a drain that
// opened pre-key messages (each used up a one-time key), and for a slot with
// no account yet, since only a sync may create one (`client.ts`).

import { createEffect } from "solid-js";
import { clearE2eKeys, getE2eKeys, uploadE2eKeys } from "../api";
import { token } from "../auth";
import { networks, user } from "../networks";
import { type AccountStore, E2E_DATABASE } from "./accountStore";
import { browserE2e } from "./browser";
import { topUp } from "./keyBundle";

const NOTHING_HELD = { one_time_keys: 0, fallback: false };

/** The account slot of a subject on a network: one identity key per network. */
export function accountSlot(subject: { kind: string; id: string }, networkId: number): string {
  return `${subject.kind}:${subject.id}:${networkId}`;
}

// Syncs running on this page, by slot, while they run.
const running = new Map<string, Promise<void>>();

/**
 * Brings the bundle grappa holds for `slot` on `networkSlug` up to full.
 *
 * A NEW account (none stored, or the stored one lost) first drops whatever
 * grappa holds: those keys belong to an account that is gone, and a peer
 * handed one would open a session nobody can decrypt. The account is stored
 * with its new keys BEFORE they are uploaded, so grappa never holds a key
 * whose private half was not kept, and marked published only once grappa
 * has them; an upload that fails is resent, the same keys, next time.
 *
 * Asked for while a sync for the slot runs, it joins that one: on a fresh
 * login the drain meets the slot before the page's sync has made the account
 * and would otherwise queue a second sync behind it. Joining loses nothing a
 * caller needs: a sync still running takes the account lock after whatever
 * the caller did under it (a drain that spent a one-time key), so it sees it.
 */
export function syncKeyBundle(
  store: AccountStore,
  bearer: string,
  slot: string,
  networkSlug: string,
): Promise<void> {
  const inFlight = running.get(slot);
  if (inFlight !== undefined) return inFlight;
  const sync = runSync(store, bearer, slot, networkSlug).finally(() => running.delete(slot));
  running.set(slot, sync);
  return sync;
}

async function runSync(
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
      void browserE2e()
        .then(({ accounts }) => syncKeyBundle(accounts, bearer, slot, network.slug))
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
     * E2E state, every account and the key that seals them. The next E2E
     * operation on this page, or the next page load, starts each network
     * over with a new identity and replaces the bundle grappa holds. Ships in the bundle like
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
