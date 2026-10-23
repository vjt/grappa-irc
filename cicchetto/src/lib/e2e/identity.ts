// issue 2430 — this device's place in the subject's E2E identity on each
// network (CLIENT_PROTOCOL §4f, wire v2): one master key, the devices its
// signed list vouches for, and each device's key bundle on grappa, so a
// peer's KEYREQ is answered while every cic tab is closed. The master is a
// second vodozemac account, kept only for `ed25519_key()` and `sign()`, on
// the device that made the identity.
//
// An identity is NEVER replaced silently (vjt's ruling 6344779758). When
// grappa holds one this device cannot speak for (the browser was wiped, or
// another device made it), the slot is "elsewhere" and nothing is written,
// here or on grappa: only the user, explicitly, starts a new one over it
// (`replaceIdentity`).
//
// Once per page load and per (subject, network), and again for a network
// that appears later: the identity needs no live IRC link (grappa stores it
// per binding), so this does not wait for one. The chat glue
// (`lib/encryptedChats.ts`) calls `syncIdentity` too: after a drain that
// opened pre-key messages (each used up a one-time key), for a slot with no
// identity yet, since only a sync may make one (`client.ts`), and whenever
// grappa may have moved the identity under the page: another tab says it
// changed the network, this device's doors answer 404 or refuse it as a
// device they do not list, or the user confirms a new identity.
//
// A second browser of the account joins an identity through a QR pairing
// (X1-crypto): the doors each side goes through, per network, close this
// module (`masterOf` to `abandonJoin`).

import { createEffect } from "solid-js";
import {
  ApiError,
  clearE2eKeys,
  getE2eDeviceKeys,
  getE2eList,
  listE2eDevices,
  putE2eList,
  registerE2eDevice,
  removeE2eDevice,
  uploadE2eDeviceKeys,
} from "../api";
import { token } from "../auth";
import { networks, user } from "../networks";
import type { E2eKeysWireDeviceList, E2eKeysWireStatus } from "../wireTypes";
import {
  type AccountSession,
  type AccountStore,
  E2E_DATABASE,
  type OwnIdentity,
} from "./accountStore";
import { browserE2e } from "./browser";
import { newState } from "./engine";
import { idBlock, topUp } from "./keyBundle";
import { loadOlm } from "./olm";
import { acceptSigned, issueDevice, type PairRefusal } from "./pairingMessages";
import type { Account } from "./vodozemac/vodozemac_binding";
import {
  certSigText,
  did as didOf,
  type IdBlock,
  listSigText,
  MAX_DEVICES,
  type SignedList,
  validMasterList,
} from "./wire";

/** What a sync found: this device speaks for the slot's identity, or grappa holds one it cannot speak for. */
export type IdentityState = "ready" | "elsewhere";

const NOTHING_HELD: E2eKeysWireStatus = { one_time_keys: 0, fallback: false };

/** The account slot of a subject on a network: one identity per network. */
export function accountSlot(subject: { kind: string; id: string }, networkId: number): string {
  return `${subject.kind}:${subject.id}:${networkId}`;
}

// Syncs running on this page, by store and slot, while they run.
const running = new WeakMap<AccountStore, Map<string, Promise<IdentityState>>>();

// Thrown out of the account session when grappa holds an identity this
// device cannot speak for: a session that throws stores nothing, so the slot
// keeps whatever it held.
class Elsewhere extends Error {}

const refusedAs = (err: unknown, code: string): boolean =>
  err instanceof ApiError && err.code === code;

/**
 * Sets up, or keeps up, this device's place in the identity grappa holds for
 * `slot` on `networkSlug`, under the slot's lock:
 *
 *   - no identity here and none on grappa: a new one (a master, this device
 *     registered and listed at version 1, its keys); "elsewhere" when another
 *     browser puts its list first;
 *   - no identity here and one on grappa: "elsewhere";
 *   - an identity here that grappa lists this device in: its keys topped up,
 *     and grappa's list taken when it is our master's at a higher version;
 *   - an identity here whose list grappa dropped: this device registered and
 *     listed again, one version up, then its keys;
 *   - an identity here that grappa holds under another master, or whose
 *     list leaves this device out: "elsewhere".
 *
 * "elsewhere" writes nothing here, and nothing on grappa but the removal of
 * a device this sync registered and could not list. The record is stored
 * with its keys BEFORE they are uploaded, so grappa never holds a key whose
 * private half was not kept. Nothing is stored when the registration or the
 * list put fails, a 404 included: `getE2eList` reads a network that does not
 * resolve for the subject as no list, and the write after it 404s too. A 404
 * from the key upload, once the list is put, keeps the record: the put just
 * proved the network resolves and that grappa holds our list, so dropping
 * the record would leave a master on grappa that nobody holds.
 *
 * Asked for while a sync for the slot runs on this store, it joins that one:
 * on a fresh login the drain meets the slot before the page's sync has made
 * the identity and would otherwise queue a second sync behind it.
 */
export function syncIdentity(
  store: AccountStore,
  bearer: string,
  slot: string,
  networkSlug: string,
): Promise<IdentityState> {
  const syncs = running.get(store) ?? new Map<string, Promise<IdentityState>>();
  running.set(store, syncs);
  const inFlight = syncs.get(slot);
  if (inFlight !== undefined) return inFlight;
  const sync = runSync(store, bearer, slot, networkSlug).finally(() => syncs.delete(slot));
  syncs.set(slot, sync);
  return sync;
}

async function runSync(
  store: AccountStore,
  bearer: string,
  slot: string,
  slug: string,
): Promise<IdentityState> {
  try {
    await store.withAccount(slot, async (session) => {
      const held = await getE2eList(bearer, slug);
      const own = session.own;
      if (own === null) {
        if (held !== null) throw new Elsewhere();
        try {
          await bootstrap(session, bearer, slug);
        } catch (err) {
          // Another browser put its list between our look and our put: its
          // identity stands, and ours was never made.
          throw refusedAs(err, "master_mismatch") ? new Elsewhere() : err;
        }
        return;
      }
      let current = own;
      if (held === null) {
        current = await relist(session, own, bearer, slug);
      } else if (
        held.master !== own.master ||
        !held.devices.includes(session.account.ed25519_key())
      ) {
        throw new Elsewhere();
      } else if (held.ver > own.list.ver) {
        current = await adopt(session, own, held);
      }
      const status = await getE2eDeviceKeys(bearer, slug, current.did);
      await topUpKeys(session, bearer, slug, current.did, status);
    });
    return "ready";
  } catch (err) {
    if (err instanceof Elsewhere) return "elsewhere";
    throw err;
  }
}

/**
 * DESTRUCTIVE: deletes this account's whole E2E identity on grappa for
 * `networkSlug` (every device of it, with its keys and its queue, and the
 * master's list) and makes a new one here, with a new device account and a
 * new master. Every other device of the account is disowned, and every
 * contact sees a key alarm for the new master and must verify it again.
 *
 * Only an explicit, confirmed user action may call it: an identity is never
 * replaced silently (vjt 6344779758), and `syncIdentity` never does.
 *
 * The trust this device placed in others stays (their masters and devices,
 * the pins, what was verified); everything bound to the old device account
 * goes (sessions, queues, what was sent, SASes, the inbox watermark).
 */
export async function replaceIdentity(
  store: AccountStore,
  bearer: string,
  slot: string,
  networkSlug: string,
): Promise<void> {
  await store.withAccount(slot, async (session) => {
    await clearE2eKeys(bearer, networkSlug);
    startOver(session);
    // The old identity is gone from grappa: so is it here, before anything
    // else can fail. A bootstrap that fails now leaves a record without an
    // identity, and the next sync makes a new one, never the old one again.
    await session.persist();
    await bootstrap(session, bearer, networkSlug);
  });
}

// A new device account in the session, and no identity: of the old one's
// state only the trust placed in others stays (their masters and devices,
// the pins). What a new identity starts from, and a new place in one.
function startOver(session: AccountSession): void {
  const { masters, devices, pins } = session.state;
  session.account = session.newAccount();
  session.master = null;
  session.own = null;
  Object.assign(session.state, { ...newState(), masters, devices, pins });
}

// A new identity for the session's device, while grappa holds no list: a
// master, the device registered and listed by it at version 1, its
// certificate at that version (the first list that holds the device), then
// the device's keys.
async function bootstrap(session: AccountSession, bearer: string, slug: string): Promise<void> {
  const device = session.account;
  const master = session.newAccount();
  const { did, list } = await enlist(device, master, bearer, slug, 1);
  session.master = master;
  session.own = {
    master: master.ed25519_key(),
    cert: master.sign(certSigText(list.ver, device.ed25519_key())),
    certVer: list.ver,
    list,
    did,
  };
  await topUpKeys(session, bearer, slug, did, NOTHING_HELD);
}

// grappa dropped the identity's list (and with it its devices) while this
// device still holds the identity: the device registered again and listed one
// version above the last list, so peers that stored that one take this one.
// Its certificate stays: it names the first list that held the device. A
// device without the master (one paired to it) cannot do it.
async function relist(
  session: AccountSession,
  own: OwnIdentity,
  bearer: string,
  slug: string,
): Promise<OwnIdentity> {
  if (session.master === null) throw new Elsewhere();
  const { did, list } = await enlist(
    session.account,
    session.master,
    bearer,
    slug,
    own.list.ver + 1,
  );
  session.own = { ...own, list, did };
  return session.own;
}

// grappa holds our master's list at a version above the stored one, still
// naming this device: a relist whose put grappa took and whose answer was
// lost before the record was stored. Taken once it verifies, so the next
// relist goes above it rather than reusing a version peers may have stored.
async function adopt(
  session: AccountSession,
  own: OwnIdentity,
  held: E2eKeysWireDeviceList,
): Promise<OwnIdentity> {
  const list = { ver: held.ver, devices: held.devices, sig: held.sig };
  const signed = {
    ed25519: held.master,
    list: { ver: list.ver, devices: list.devices },
    sig: list.sig,
  };
  if (!validMasterList(await loadOlm(), signed)) return own;
  session.own = { ...own, list };
  await session.persist();
  return session.own;
}

// Registers `device` and puts the list `master` signs over it at `ver`, while
// grappa holds no list. A device registered and never listed holds one of
// the subject's four rooms on grappa for good, so a put that fails drops it
// again, best effort: the put's own error is the outcome, and a drop that
// fails too leaves its trace in the console.
async function enlist(
  device: Account,
  master: Account,
  bearer: string,
  slug: string,
  ver: number,
): Promise<{ did: string; list: SignedList }> {
  const did = await register(bearer, slug, idBlock(device, master.ed25519_key()));
  try {
    return { did, list: await putList(master, bearer, slug, ver, [device.ed25519_key()]) };
  } catch (err) {
    await removeE2eDevice(bearer, slug, did).catch((cause: unknown) => {
      console.warn(`[e2e] could not drop the unlisted device ${did} on ${slug}`, cause);
    });
    throw err;
  }
}

// With no list held, every device grappa holds for the subject is unlisted:
// an orphan by construction, since a device is paired only while a list
// exists. When they fill every room they are dropped, best effort (a drop
// that fails is logged), and the registration tried once more; refused
// again, the sync fails.
async function register(bearer: string, slug: string, id: IdBlock): Promise<string> {
  try {
    return (await registerE2eDevice(bearer, slug, id)).did;
  } catch (err) {
    if (!refusedAs(err, "too_many_devices")) throw err;
    for (const orphan of await listE2eDevices(bearer, slug)) {
      await removeE2eDevice(bearer, slug, orphan.did).catch((cause: unknown) => {
        console.warn(`[e2e] could not drop the orphan device ${orphan.did} on ${slug}`, cause);
      });
    }
    return (await registerE2eDevice(bearer, slug, id)).did;
  }
}

// The list `master` signs at `ver` over `devices`, sorted in plain string
// order as the wire requires, put on grappa.
async function putList(
  master: Account,
  bearer: string,
  slug: string,
  ver: number,
  devices: string[],
): Promise<SignedList> {
  const sorted = devices.slice().sort();
  const list = { ver, devices: sorted, sig: master.sign(listSigText(ver, sorted)) };
  await putE2eList(bearer, slug, { master: master.ed25519_key(), ...list });
  return list;
}

// Brings the bundle of device `did`, which grappa says holds `held`, up to
// full. The record is stored with the new keys before they leave, and they
// are marked published once grappa has them; an upload that fails is resent,
// the same keys, next time.
async function topUpKeys(
  session: AccountSession,
  bearer: string,
  slug: string,
  did: string,
  held: E2eKeysWireStatus,
): Promise<void> {
  const upload = topUp(session.account, held);
  if (upload !== null) {
    await session.persist();
    await uploadE2eDeviceKeys(bearer, slug, did, upload);
  }
  session.account.mark_keys_as_published();
}

// ── Pairing (X1-crypto). The browser that holds an identity's master (the
// holder) shows the QR; a new browser of the account (the joiner) scans it.
// Once both users confirmed, the holder's master lists the joiner's device on
// each network it is master of, and certifies it. These are the doors each
// side goes through per network, around the channel, whose messages
// `pairingMessages.ts` judges. The master never leaves the holder, and the
// joiner starts empty: only public keys and signatures cross.

// Carries what `peek` read out of an account session.
class Peeked<T> extends Error {
  constructor(readonly value: T) {
    super("peeked");
  }
}

// Reads the slot's record and stores nothing, not even a record for a slot
// that has none: a session that throws stores nothing, so the answer leaves
// in the throw.
async function peek<T>(
  store: AccountStore,
  slot: string,
  read: (session: AccountSession) => T,
): Promise<T> {
  try {
    return await store.withAccount(slot, async (session) => {
      throw new Peeked(read(session));
    });
  } catch (err) {
    if (err instanceof Peeked) return err.value;
    throw err;
  }
}

/** The holder: the master's key when this browser holds the slot's master, else null. Stores nothing. */
export function masterOf(store: AccountStore, slot: string): Promise<string | null> {
  return peek(store, slot, ({ master }) => master?.ed25519_key() ?? null);
}

/**
 * The holder: whether it can offer the network to a joiner, judged on the
 * list after a sync, grappa's latest: the master's key; "full" when the list
 * already names the four devices grappa allows; null when this browser holds
 * no master for the slot (nothing is synced or stored then) or the sync does
 * not answer "ready".
 */
export async function offerable(
  store: AccountStore,
  bearer: string,
  slot: string,
  slug: string,
): Promise<{ master: string } | "full" | null> {
  if ((await masterOf(store, slot)) === null) return null;
  if ((await syncIdentity(store, bearer, slot, slug)) !== "ready") return null;
  return peek(store, slot, ({ master, own }) => {
    if (master === null || own === null) return null;
    return own.list.devices.length >= MAX_DEVICES ? "full" : { master: master.ed25519_key() };
  });
}

// One try of `addDevice` met a list on grappa above the one it signed over.
const STALE = Symbol("stale_list");

/**
 * The holder: lists the joiner's device `id` on the network, at one version
 * above the list grappa holds, and certifies it at that version
 * (`issueDevice`, which first checks that the device vouches for this very
 * master). After a sync, so the list grows from grappa's latest. A put refused
 * as `stale_list` (another put landed between the sync and this one) syncs
 * again, which takes that list, and signs the device in over it, once: a
 * retry never puts a list that drops a device another put listed. Refusals:
 * "failed" (no master here, the sync is not "ready", the id block does not
 * vouch for the master, or grappa holds no such device), "paired", "full",
 * and "list-changed" when the list moved under the retry too.
 */
export async function addDevice(
  store: AccountStore,
  bearer: string,
  slot: string,
  slug: string,
  id: IdBlock,
): Promise<{ cert: string; list: SignedList } | PairRefusal> {
  const first = await listDevice(store, bearer, slot, slug, id);
  if (first !== STALE) return first;
  const retried = await listDevice(store, bearer, slot, slug, id);
  return retried === STALE ? "list-changed" : retried;
}

async function listDevice(
  store: AccountStore,
  bearer: string,
  slot: string,
  slug: string,
  id: IdBlock,
): Promise<{ cert: string; list: SignedList } | PairRefusal | typeof STALE> {
  if ((await syncIdentity(store, bearer, slot, slug)) !== "ready") return "failed";
  const olm = await loadOlm();
  return store.withAccount(slot, async (session) => {
    const { master, own } = session;
    if (master === null || own === null) return "failed";
    const issued = issueDevice(olm, master, own, id);
    if (issued === "failed") {
      console.warn(`[e2e] the new device's id block does not vouch for this master on ${slug}`);
    }
    if (typeof issued === "string") return issued;
    try {
      await putE2eList(bearer, slug, { master: master.ed25519_key(), ...issued.list });
    } catch (err) {
      if (refusedAs(err, "stale_list")) return STALE;
      if (!refusedAs(err, "unknown_device")) throw err;
      // The joiner's device is not (or no longer) registered.
      console.warn(
        `[e2e] grappa refused the list with a new device on ${slug}: unknown_device`,
        err,
      );
      return "failed";
    }
    session.own = { ...own, list: issued.list };
    return issued;
  });
}

/**
 * The joiner: its device on the network, to be listed under `master` (the key
 * the holder offered): the id block vouching for that master, and the did
 * grappa registered it as. The slot's device account is kept only when the
 * record holds no identity and grappa's list does not name its key, so a page
 * reloaded mid-pairing registers the same key again, which grappa takes as
 * the same device rather than one more of the subject's four; any other
 * account starts over, keeping only the trust placed in others. The record is
 * stored before the id block leaves. Refusals: "paired" (already listed under
 * that master), "full" (grappa holds four devices), "failed" (grappa holds
 * the list of another master, nothing touched; or the registration refused
 * otherwise, logged).
 */
export function prepareJoin(
  store: AccountStore,
  bearer: string,
  slot: string,
  slug: string,
  master: string,
): Promise<{ id: IdBlock; did: string } | PairRefusal> {
  return store.withAccount(slot, async (session) => {
    const held = await getE2eList(bearer, slug);
    // The identity was replaced since the offer, perhaps by this very browser
    // in another tab: starting over here could drop the master grappa holds
    // now, leaving its list to no browser. Only the user moves it.
    if (held !== null && held.master !== master) {
      console.warn(
        `[e2e] grappa holds another master than the one offered on ${slug}: not paired there`,
      );
      return "failed";
    }
    const listed = held?.devices.includes(session.account.ed25519_key()) ?? false;
    if (listed && session.own?.master === master) return "paired";
    if (listed || session.own !== null) startOver(session);
    const id = idBlock(session.account, master);
    await session.persist();
    try {
      return { id, did: (await registerE2eDevice(bearer, slug, id)).did };
    } catch (err) {
      if (refusedAs(err, "too_many_devices")) return "full";
      console.warn(`[e2e] could not register this device on ${slug} to pair it`, err);
      return "failed";
    }
  });
}

/**
 * The joiner: takes what the holder signed for its device on the network as
 * its place in the identity, once `acceptSigned` holds it (a list `master`
 * signed that names the device, and the master's certificate for it at that
 * list's version). True once that place is stored: the device is listed and
 * placed. The sync after it uploads the device's keys; one that throws or
 * does not answer "ready" is logged and changes nothing of that, since the
 * next sync (a reload, a reconnect) uploads them. False, nothing written,
 * when the signatures do not hold.
 */
export async function completeJoin(
  store: AccountStore,
  bearer: string,
  slot: string,
  slug: string,
  master: string,
  signed: { cert: string; list: SignedList },
): Promise<boolean> {
  const olm = await loadOlm();
  const placed = await store.withAccount(slot, async (session) => {
    const device = session.account.ed25519_key();
    const accepted = acceptSigned(olm, master, device, signed);
    if (accepted === null) {
      console.warn(`[e2e] the list or certificate the holder signed does not verify on ${slug}`);
      return false;
    }
    session.own = { master, ...accepted, did: didOf(olm, device) };
    return true;
  });
  if (!placed) return false;
  try {
    const state = await syncIdentity(store, bearer, slot, slug);
    if (state !== "ready") {
      console.warn(
        `[e2e] the sync after pairing ${slug} answered ${state}; its keys go up at the next sync`,
      );
    }
  } catch (err) {
    console.warn(
      `[e2e] the sync after pairing ${slug} failed; its keys go up at the next sync`,
      err,
    );
  }
  return true;
}

/**
 * The joiner: drops its device `did` from grappa when the pairing ended before
 * the holder listed it, so it holds none of the subject's four rooms. One gone
 * already (`not_found`), or listed after all (`listed_device`: the holder's
 * put went through), is left as it is; any other failure is logged, the
 * device left behind.
 */
export async function abandonJoin(bearer: string, slug: string, did: string): Promise<void> {
  try {
    await removeE2eDevice(bearer, slug, did);
  } catch (err) {
    if (refusedAs(err, "not_found") || refusedAs(err, "listed_device")) return;
    console.warn(`[e2e] could not drop the unpaired device ${did} on ${slug}`, err);
  }
}

// Slots synced (or syncing) on this page. A failed sync leaves the set, so the
// next change to the network list tries it again.
const synced = new Set<string>();

/**
 * Syncs every network's identity once per page load, and tells `found`
 * what each one found (the chat glue shows an identity held elsewhere).
 * Registered by main.tsx in a root.
 */
export function mountIdentitySync(found: (slug: string, state: IdentityState) => void): void {
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
        .then(({ accounts }) => syncIdentity(accounts, bearer, slot, network.slug))
        .then((state) => found(network.slug, state))
        .catch((err: unknown) => {
          synced.delete(slot);
          console.warn(`[e2e] identity sync failed for ${network.slug}`, err);
        });
    }
  });
}

declare global {
  interface Window {
    /**
     * TEST-ONLY (issue 2430, for the interop suite): deletes this browser's
     * E2E state, every account and the key that seals them, and nothing on
     * grappa. The identities grappa holds stay, so each network then reads
     * as held elsewhere until the user starts a new identity
     * (`replaceIdentity`). Ships in the bundle like the other `__cic_*`
     * hooks; it grants nothing a script in this origin could not do with
     * `indexedDB.deleteDatabase`.
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
