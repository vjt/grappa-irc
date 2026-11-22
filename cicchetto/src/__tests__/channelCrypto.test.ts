// Channel E2E (wire v4) — the epoch cipher: one AES-256-GCM key per
// channel epoch. No wasm runs here: WebCrypto does the AEAD, and these
// tests prove the cipher's rules (round-trip, tamper resistance, fresh
// nonces, key spelling) rather than the algorithm itself.
import { describe, expect, it } from "vitest";
import {
  decryptEpoch,
  encryptEpoch,
  isEpochKey,
  newEpochId,
  newEpochKey,
  randomBytes,
} from "../lib/e2e/channelCrypto";
import { unbase64 } from "../lib/e2e/wire";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `s` with the character at `i` swapped for a different base64 character. */
function flipChar(s: string, i: number): string {
  const at = s[i];
  if (at === undefined) throw new Error("flipChar past the end");
  return `${s.slice(0, i)}${at === "A" ? "B" : "A"}${s.slice(i + 1)}`;
}

describe("epoch keys", () => {
  it("mints a fresh 32-byte key, and a fresh 16-byte id, every time", () => {
    const key = newEpochKey();
    expect(unbase64(key).length).toBe(32);
    expect(newEpochKey()).not.toBe(key);
    const id = newEpochId();
    expect(unbase64(id).length).toBe(16);
    expect(newEpochId()).not.toBe(id);
    expect(newEpochId()).not.toBe(newEpochKey());
  });

  it("draws the requested number of random bytes", () => {
    const bytes = randomBytes(12);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBe(12);
    expect(randomBytes(12)).not.toEqual(bytes);
  });

  it("accepts a 32-byte key spelling, and refuses a short, long, or garbage one", () => {
    expect(isEpochKey(newEpochKey())).toBe(true);
    expect(isEpochKey("short")).toBe(false);
    expect(isEpochKey("!!!not-base64!!!")).toBe(false);
    expect(isEpochKey("")).toBe(false);
    const thirtyOne = Buffer.from(new Uint8Array(31)).toString("base64").replace(/=+$/, "");
    expect(isEpochKey(thirtyOne)).toBe(false);
    const thirtyThree = Buffer.from(new Uint8Array(33)).toString("base64").replace(/=+$/, "");
    expect(isEpochKey(thirtyThree)).toBe(false);
  });
});

describe("encryptEpoch / decryptEpoch", () => {
  it("round-trips bytes, including an empty plaintext", async () => {
    const key = newEpochKey();
    const body = await encryptEpoch(key, encoder.encode("hello channel"));
    expect(typeof body).toBe("string");
    expect(decoder.decode(await decryptEpoch(key, body))).toBe("hello channel");
    const empty = await encryptEpoch(key, encoder.encode(""));
    expect(decoder.decode(await decryptEpoch(key, empty))).toBe("");
  });

  it("encrypts the same plaintext twice to two different bodies (fresh nonce)", async () => {
    const key = newEpochKey();
    const plaintext = encoder.encode("same words");
    const first = await encryptEpoch(key, plaintext);
    const second = await encryptEpoch(key, plaintext);
    expect(first).not.toBe(second);
    expect(decoder.decode(await decryptEpoch(key, first))).toBe("same words");
    expect(decoder.decode(await decryptEpoch(key, second))).toBe("same words");
  });

  it("refuses a tampered ciphertext, a wrong key, and a short body", async () => {
    const key = newEpochKey();
    const body = await encryptEpoch(key, encoder.encode("tamper with me"));
    // A flipped byte inside the ciphertext: the GCM tag no longer checks.
    await expect(decryptEpoch(key, flipChar(body, 20))).rejects.toThrow();
    // A flipped byte inside the nonce: same failure, another place.
    await expect(decryptEpoch(key, flipChar(body, 4))).rejects.toThrow();
    // A truncated body: the tag is cut short.
    await expect(decryptEpoch(key, body.slice(0, -4))).rejects.toThrow();
    // The right ciphertext under the wrong key.
    await expect(decryptEpoch(newEpochKey(), body)).rejects.toThrow();
    // Bodies too short to hold a nonce.
    await expect(decryptEpoch(key, "AAAA")).rejects.toThrow(/not an epoch ciphertext/);
    await expect(decryptEpoch(key, "")).rejects.toThrow(/not an epoch ciphertext/);
    await expect(decryptEpoch(key, "!!!not-base64!!!")).rejects.toThrow();
  });

  it("refuses a key that is not a 32-byte epoch key", async () => {
    const plaintext = encoder.encode("hi");
    await expect(encryptEpoch("not-a-key", plaintext)).rejects.toThrow(/not an epoch key/);
    await expect(decryptEpoch("not-a-key", "AAAAAAAAAAAAAAAAAAAAAA")).rejects.toThrow(
      /not an epoch key/,
    );
  });
});
