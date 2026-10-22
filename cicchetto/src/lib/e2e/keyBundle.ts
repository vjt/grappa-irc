// issue 2430 — what a device publishes of itself (CLIENT_PROTOCOL §4f, wire
// v2): its signed id block, and the key bundle grappa hands out to peers.
//
// grappa answers a peer's KEYREQ with one KEYS for the whole user, connected
// client or not, so each device signs and uploads its keys ahead of time: its
// one-time keys and a fallback key, each with the device's signature over it.
// grappa stores them as they are and never checks one; the peer verifies
// every signature against the device key the master's list names.
//
// Nothing here persists or uploads anything: `topUp` decides what to send and
// generates the keys for it on the account, and the caller (`identity.ts`)
// stores the account BEFORE the public halves leave it, and marks them
// published once grappa has them.

import type { E2eKeysWireStatus } from "../wireTypes";
import type { Account } from "./vodozemac/vodozemac_binding";
import { ID_SIG_PREFIX, type IdBlock, OTK_SIG_PREFIX } from "./wire";

/**
 * How many one-time keys grappa holds for one device
 * (`Grappa.E2eKeys.max_one_time_keys/0`, vodozemac's own ceiling on the keys
 * an account publishes). An upload past it is refused whole, with 413.
 */
export const MAX_HOSTED_ONE_TIME_KEYS = 50;

/** A one-time or fallback key, with the device's signature over it. */
export type SignedKey = { key: string; sig: string };

/** What `POST …/e2e/devices/:did/keys` takes. */
export type BundleUpload = { one_time_keys: SignedKey[]; fallback: SignedKey | null };

/**
 * The id block of `device` under the master `master`: its Curve25519 and
 * Ed25519 keys, and its signature over `irc-e2e:v2:id:` + the curve key +
 * `:` + the master (S1), so no other master can list it.
 */
export function idBlock(device: Account, master: string): IdBlock {
  const curve25519 = device.curve25519_key();
  return {
    curve25519,
    ed25519: device.ed25519_key(),
    sig: device.sign(`${ID_SIG_PREFIX}${curve25519}:${master}`),
  };
}

/** `key` with the signature of `device` over `irc-e2e:v1:otk:` + the key (S2). */
export function signedKey(device: Account, key: string): SignedKey {
  return { key, sig: device.sign(`${OTK_SIG_PREFIX}${key}`) };
}

/**
 * What to upload so grappa, holding `held` for `device`, ends up with every
 * one-time key it has room for and a fallback key; `null` when it already
 * has both. Generates the keys it needs on `device`, unpublished.
 *
 * Keys an earlier upload never confirmed (still unpublished on the account)
 * go first, before any new one: they may already be on grappa, which skips a
 * key it holds, and resending one costs nothing. At most the room grappa has
 * left is sent, oldest first, so an upload is never refused for size. An
 * unpublished fallback key is the newest one and is always sent; otherwise a
 * new one is made only when grappa has none.
 */
export function topUp(device: Account, held: E2eKeysWireStatus): BundleUpload | null {
  const room = Math.max(0, MAX_HOSTED_ONE_TIME_KEYS - held.one_time_keys);
  const missing = room - device.one_time_keys().length;
  if (missing > 0) device.generate_one_time_keys(missing);
  if (!held.fallback && device.fallback_key() === undefined) device.generate_fallback_key();

  const oneTimeKeys = device
    .one_time_keys()
    .slice(0, room)
    .map((key) => signedKey(device, key));
  const fallbackKey = device.fallback_key();
  const fallback = fallbackKey === undefined ? null : signedKey(device, fallbackKey);

  return oneTimeKeys.length === 0 && fallback === null
    ? null
    : { one_time_keys: oneTimeKeys, fallback };
}
