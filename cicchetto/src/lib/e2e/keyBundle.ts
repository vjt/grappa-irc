// issue 2430 — the key bundle cic builds for grappa to hand out to peers
// (CLIENT_PROTOCOL §4f "Your key bundle").
//
// grappa answers a peer's KEYREQ with one KEYS payload, connected client or
// not, so cic signs and uploads them ahead of time: one per one-time key and
// one for the fallback key. grappa stores them opaque and never reads one;
// the peer checks both signatures against the Ed25519 identity key it pins.
//
// Nothing here persists or uploads anything: `topUp` decides what to send and
// generates the keys for it on the account, and the caller (`bundleSync.ts`)
// stores the account BEFORE the public halves leave it, and marks them
// published once grappa has them.

import type { E2eKeysWireStatus } from "../wireTypes";
import type { Account } from "./vodozemac/vodozemac_binding";

/**
 * How many one-time keys grappa holds for one subject on one network
 * (`Grappa.E2eKeys.max_one_time_keys/0`, vodozemac's own ceiling on the keys
 * an account publishes). An upload past it is refused whole, with 413.
 */
export const MAX_HOSTED_ONE_TIME_KEYS = 50;

/** What `POST /networks/:network/e2e/keys` takes. */
export type BundleUpload = { one_time_keys: string[]; fallback: string | null };

const encoder = new TextEncoder();

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/**
 * The KEYS payload for one key of `account`, as the peer receives it: the
 * padded standard base64 of the agreed JSON. The identity block is signed
 * over `irc-e2e:v1:id:` + the Curve25519 identity key, the key over
 * `irc-e2e:v1:otk:` + the key, both with the Ed25519 identity key.
 */
export function keysPayload(account: Account, key: string, fallback: boolean): string {
  const curve25519 = account.curve25519_key();
  const json = JSON.stringify({
    v: 1,
    id: {
      curve25519,
      ed25519: account.ed25519_key(),
      sig: account.sign(`irc-e2e:v1:id:${curve25519}`),
    },
    otk: { key, fallback, sig: account.sign(`irc-e2e:v1:otk:${key}`) },
  });
  return base64(encoder.encode(json));
}

/**
 * What to upload so grappa, holding `held`, ends up with every one-time key
 * it has room for and a fallback key; `null` when it already has both.
 * Generates the keys it needs on `account`, unpublished.
 *
 * Keys an earlier upload never confirmed (still unpublished on the account)
 * go first, before any new one: they may already be on grappa, which skips a
 * key it holds, and resending one costs nothing. At most the room grappa has
 * left is sent, oldest first, so an upload is never refused for size. An
 * unpublished fallback key is the newest one and is always sent; otherwise a
 * new one is made only when grappa has none.
 */
export function topUp(account: Account, held: E2eKeysWireStatus): BundleUpload | null {
  const room = Math.max(0, MAX_HOSTED_ONE_TIME_KEYS - held.one_time_keys);
  const missing = room - account.one_time_keys().length;
  if (missing > 0) account.generate_one_time_keys(missing);
  if (!held.fallback && account.fallback_key() === undefined) account.generate_fallback_key();

  const oneTimeKeys = account
    .one_time_keys()
    .slice(0, room)
    .map((key) => keysPayload(account, key, false));
  const fallbackKey = account.fallback_key();
  const fallback = fallbackKey === undefined ? null : keysPayload(account, fallbackKey, true);

  return oneTimeKeys.length === 0 && fallback === null
    ? null
    : { one_time_keys: oneTimeKeys, fallback };
}
