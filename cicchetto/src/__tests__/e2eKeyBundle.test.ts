// issue 2430 — what a device publishes of itself (wire v2): its id block, and
// the signed keys it tops its bundle on grappa up with. Both are what a PEER
// verifies, so they are checked here the way a peer would: every signature
// verified with an Ed25519 implementation that is not vodozemac's (node's),
// over the byte strings the agreed wire names.
import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { idBlock, MAX_HOSTED_ONE_TIME_KEYS, signedKey, topUp } from "../lib/e2e/keyBundle";
import { olm } from "./helpers/olm";

function ed25519Verifies(publicKey: string, message: string, signature: string): boolean {
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKey, "base64").toString("base64url") },
    format: "jwk",
  });
  return verify(null, Buffer.from(message, "utf8"), key, Buffer.from(signature, "base64"));
}

/** Whether `signed` carries `device`'s signature over its key (S2). */
const s2 = (device: { ed25519_key(): string }, signed: { key: string; sig: string }) =>
  ed25519Verifies(device.ed25519_key(), `irc-e2e:v1:otk:${signed.key}`, signed.sig);

const empty = { one_time_keys: 0, fallback: false };

describe("idBlock", () => {
  it("is the device's two keys and its signature over its curve key and its master (S1)", () => {
    const device = new (olm().Account)();
    const master = new (olm().Account)().ed25519_key();

    const id = idBlock(device, master);

    expect(id).toEqual({
      curve25519: device.curve25519_key(),
      ed25519: device.ed25519_key(),
      sig: expect.stringMatching(/^[A-Za-z0-9+/]{86}$/),
    });
    expect(ed25519Verifies(id.ed25519, `irc-e2e:v2:id:${id.curve25519}:${master}`, id.sig)).toBe(
      true,
    );
    // The device vouches for ITS master: under another one the block is void.
    const other = new (olm().Account)().ed25519_key();
    expect(ed25519Verifies(id.ed25519, `irc-e2e:v2:id:${id.curve25519}:${other}`, id.sig)).toBe(
      false,
    );
    device.free();
  });
});

describe("signedKey", () => {
  it("is the key with the device's signature over irc-e2e:v1:otk: + the key (S2)", () => {
    const device = new (olm().Account)();
    device.generate_one_time_keys(1);
    const [otk] = device.one_time_keys();
    if (otk === undefined) throw new Error("no one-time key generated");

    const signed = signedKey(device, otk);

    expect(signed.key).toBe(otk);
    expect(s2(device, signed)).toBe(true);
    expect(ed25519Verifies(device.ed25519_key(), `irc-e2e:v2:id:${otk}`, signed.sig)).toBe(false);
    device.free();
  });
});

describe("topUp", () => {
  it("fills an empty bundle: the 50 one-time keys grappa holds a device, and a fallback key, each signed (S2)", () => {
    const device = new (olm().Account)();

    const upload = topUp(device, empty);

    expect(MAX_HOSTED_ONE_TIME_KEYS).toBe(50);
    expect(upload?.one_time_keys).toHaveLength(MAX_HOSTED_ONE_TIME_KEYS);
    expect(new Set(upload?.one_time_keys.map((k) => k.key)).size).toBe(MAX_HOSTED_ONE_TIME_KEYS);
    expect(upload?.one_time_keys.map((k) => k.key)).toEqual(device.one_time_keys());
    expect(upload?.one_time_keys.every((k) => s2(device, k))).toBe(true);
    expect(upload?.fallback?.key).toBe(device.fallback_key());
    expect(upload?.fallback && s2(device, upload.fallback)).toBe(true);
    device.free();
  });

  it("adds only what grappa is missing", () => {
    const device = new (olm().Account)();

    const upload = topUp(device, { one_time_keys: MAX_HOSTED_ONE_TIME_KEYS - 3, fallback: true });

    expect(upload).toEqual({ one_time_keys: expect.any(Array), fallback: null });
    expect(upload?.one_time_keys).toHaveLength(3);
    // ...and generates no more than it sends: a key generated past grappa's
    // room would be marked published without ever reaching it.
    expect(device.one_time_keys()).toHaveLength(3);
    device.free();
  });

  it("sends nothing to a full bundle, and generates nothing", () => {
    const device = new (olm().Account)();

    expect(topUp(device, { one_time_keys: MAX_HOSTED_ONE_TIME_KEYS, fallback: true })).toBeNull();
    expect(device.one_time_keys()).toEqual([]);
    expect(device.fallback_key()).toBeUndefined();
    device.free();
  });

  it("resends the keys an earlier upload never confirmed before generating new ones", () => {
    const device = new (olm().Account)();
    device.generate_one_time_keys(5);
    device.generate_fallback_key();
    const pending = device.one_time_keys();

    const upload = topUp(device, { one_time_keys: 40, fallback: true });

    const sent = upload?.one_time_keys.map((k) => k.key) ?? [];
    expect(sent).toHaveLength(10);
    expect(sent.slice(0, 5)).toEqual(pending);
    // Five new ones, not ten: the five pending count towards the room.
    expect(device.one_time_keys()).toHaveLength(10);
    // An unconfirmed fallback key is the newest one: it goes up even though
    // grappa already holds one.
    expect(upload?.fallback?.key).toBe(device.fallback_key());
    device.free();
  });

  it("never sends grappa more one-time keys than it has room for, oldest first", () => {
    const device = new (olm().Account)();
    device.generate_one_time_keys(5);
    const pending = device.one_time_keys();

    const upload = topUp(device, { one_time_keys: MAX_HOSTED_ONE_TIME_KEYS - 2, fallback: true });

    expect(upload?.one_time_keys.map((k) => k.key)).toEqual(pending.slice(0, 2));
    expect(topUp(device, { one_time_keys: MAX_HOSTED_ONE_TIME_KEYS, fallback: true })).toBeNull();
    device.free();
  });
});
