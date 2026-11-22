// Channel E2E (wire v4, CLIENT_PROTOCOL §4f) — the epoch cipher: one
// AES-256-GCM key per channel epoch, shared by every member of the epoch.
//
// There is no per-sender session here and no wasm in this module: the AEAD
// is WebCrypto (`crypto.subtle`), which the browser and the test runner
// both provide, and the epoch key is 32 random bytes that cross only inside
// the pairwise Olm DM (the gkey). A key is stored as standard base64
// unpadded in the sealed group state and imported per use; nothing in this
// module holds a CryptoKey between calls, so there is no key lifetime to
// manage. The ciphertext is the 12-byte random nonce prepended to the
// ciphertext plus the 16-byte GCM tag, base64 unpadded — one string, the
// `body` of the v4 envelope. Decryption fails (throws) on any tampering,
// including a nonce or tag cut short.

import { base64Unpadded, unbase64 } from "./wire";

/** The bytes of a fresh epoch id (16) or epoch key (32). */
export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

/** A fresh epoch id: 16 random bytes, standard base64 unpadded. */
export function newEpochId(): string {
  return base64Unpadded(randomBytes(16));
}

/** A fresh epoch key: 32 random bytes, standard base64 unpadded. */
export function newEpochKey(): string {
  return base64Unpadded(randomBytes(32));
}

/** Whether `key` is a 32-byte epoch key in the spelling the wire takes. */
export function isEpochKey(key: string): boolean {
  try {
    return unbase64(key).length === 32;
  } catch {
    return false;
  }
}

async function importEpochKey(key: string): Promise<CryptoKey> {
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = unbase64(key);
  } catch {
    throw new Error("not an epoch key");
  }
  if (bytes.length !== 32) throw new Error("not an epoch key");
  return globalThis.crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/**
 * Encrypts `plaintext` under the epoch `key`: the nonce prepended to the
 * ciphertext, base64 unpadded. A fresh random nonce every time, so the same
 * plaintext twice is two different bodies.
 */
export async function encryptEpoch(
  key: string,
  plaintext: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const cryptoKey = await importEpochKey(key);
  const nonce = randomBytes(12);
  const ciphertext = new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, plaintext),
  );
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.length);
  return base64Unpadded(out);
}

/**
 * Decrypts a `body` `encryptEpoch` produced, under the epoch `key`. Throws
 * on anything that is not that: a short body, a bad nonce, a failed tag.
 */
export async function decryptEpoch(key: string, body: string): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await importEpochKey(key);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = unbase64(body);
  } catch {
    throw new Error("not an epoch ciphertext");
  }
  if (bytes.length <= 12) throw new Error("not an epoch ciphertext");
  const nonce = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  return new Uint8Array(
    await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cryptoKey, ciphertext),
  );
}
