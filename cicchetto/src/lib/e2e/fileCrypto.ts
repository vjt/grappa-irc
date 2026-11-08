// issue 2517 — the cryptography of an end-to-end encrypted attachment: one
// AES-256-GCM key and one IV per file, the digest over the CIPHERTEXT, and
// the base64 spellings `wire.ts` already uses for everything on the wire.
//
// WebCrypto does the work (`crypto.subtle`), so the key never leaves the
// page and nothing here is hand-rolled: the GCM tag is the default 128 bits,
// which is the 16 bytes grappa's encrypted upload door adds to the cap
// (§4k). The key is generated EXTRACTABLE on purpose — it has to travel, in
// the Olm message, to the peer and to this account's other devices.

import { base64Unpadded, unbase64 } from "./wire";

/** The sealed form of a file: the ciphertext as it is uploaded, and what the inner carries. */
export type SealedBytes = {
  ciphertext: Uint8Array<ArrayBuffer>;
  /** 32 bytes, standard base64. */
  key: string;
  /** 12 bytes, standard base64. */
  iv: string;
  /** SHA-256 of `ciphertext`, standard base64. */
  sha256: string;
};

const IV_BYTES = 12;

/**
 * `plaintext` sealed under a fresh key and IV. The ciphertext is exactly
 * `plaintext.length + 16`: the GCM tag, which WebCrypto appends.
 */
export async function sealBytes(plaintext: Uint8Array<ArrayBuffer>): Promise<SealedBytes> {
  const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  const raw = await crypto.subtle.exportKey("raw", key);
  const ciphertext = new Uint8Array(sealed);
  return {
    ciphertext,
    key: base64Unpadded(new Uint8Array(raw)),
    iv: base64Unpadded(iv),
    sha256: await sha256Base64(ciphertext),
  };
}

/**
 * The plaintext of `ciphertext`, or null when it does not open: a wrong key,
 * a wrong IV, or a single changed byte — GCM authenticates, so a tampered
 * file fails here rather than decrypting to garbage.
 */
export async function openBytes(
  ciphertext: Uint8Array<ArrayBuffer>,
  key: string,
  iv: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const imported = await crypto.subtle.importKey(
      "raw",
      unbase64(key),
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: unbase64(iv) },
      imported,
      ciphertext,
    );
    return new Uint8Array(opened);
  } catch {
    return null;
  }
}

/** SHA-256 of `bytes`, standard base64: the digest the inner carries. */
export async function sha256Base64(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return base64Unpadded(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}
