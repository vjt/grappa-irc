// issue 2430 — the KEYS payloads cic uploads for grappa to hand out, and how
// many it tops the bundle up with. The payload is what a PEER verifies, so it
// is checked here the way a peer would: decoded from base64, and both
// signatures verified with an Ed25519 implementation that is not vodozemac's
// (node's), over the byte strings the agreed wire names.
import { createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keysPayload, MAX_HOSTED_ONE_TIME_KEYS, topUp } from "../lib/e2e/keyBundle";
import { olm } from "./helpers/olm";

type Keys = {
  v: number;
  id: { curve25519: string; ed25519: string; sig: string };
  otk: { key: string; fallback: boolean; sig: string };
};

const decode = (payload: string): Keys =>
  JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as Keys;

const unpadded = (b64: string): Buffer => Buffer.from(b64, "base64");

function ed25519Verifies(publicKey: string, message: string, signature: string): boolean {
  const key = createPublicKey({
    key: { kty: "OKP", crv: "Ed25519", x: unpadded(publicKey).toString("base64url") },
    format: "jwk",
  });
  return verify(null, Buffer.from(message, "utf8"), key, unpadded(signature));
}

const empty = { one_time_keys: 0, fallback: false };

describe("keysPayload", () => {
  it("is padded standard base64 of the agreed KEYS JSON, both signatures valid", () => {
    const account = new (olm().Account)();
    account.generate_one_time_keys(1);
    const [otk] = account.one_time_keys();
    if (otk === undefined) throw new Error("no one-time key generated");

    const payload = keysPayload(account, otk, false);

    expect(payload).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(payload.length % 4).toBe(0);
    const keys = decode(payload);
    expect(keys.v).toBe(1);
    expect(keys.id.curve25519).toBe(account.curve25519_key());
    expect(keys.id.ed25519).toBe(account.ed25519_key());
    expect(keys.otk).toMatchObject({ key: otk, fallback: false });
    // The two signed strings are the wire's: a peer verifying anything else
    // rejects every key cic publishes.
    expect(
      ed25519Verifies(keys.id.ed25519, `irc-e2e:v1:id:${keys.id.curve25519}`, keys.id.sig),
    ).toBe(true);
    expect(ed25519Verifies(keys.id.ed25519, `irc-e2e:v1:otk:${otk}`, keys.otk.sig)).toBe(true);
    // ...and a signature does not verify over the other string.
    expect(ed25519Verifies(keys.id.ed25519, `irc-e2e:v1:id:${otk}`, keys.otk.sig)).toBe(false);
    account.free();
  });

  it("marks the fallback key as such, and fits grappa's 1 KiB bound", () => {
    const account = new (olm().Account)();
    account.generate_fallback_key();
    const fallback = account.fallback_key();
    if (fallback === undefined) throw new Error("no fallback key generated");

    const payload = keysPayload(account, fallback, true);

    expect(decode(payload).otk).toMatchObject({ key: fallback, fallback: true });
    // One byte shorter than a one-time key's JSON ("true" vs "false"), so
    // between the two payloads one needs base64 padding: it is kept.
    expect(payload).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(payload.length % 4).toBe(0);
    expect(payload.length).toBeLessThanOrEqual(1024);
    account.free();
  });
});

describe("topUp", () => {
  it("fills an empty bundle: every one-time key grappa may hold, and a fallback key", () => {
    const account = new (olm().Account)();

    const upload = topUp(account, empty);

    expect(upload?.one_time_keys).toHaveLength(MAX_HOSTED_ONE_TIME_KEYS);
    expect(new Set(upload?.one_time_keys.map((p) => decode(p).otk.key)).size).toBe(
      MAX_HOSTED_ONE_TIME_KEYS,
    );
    expect(upload?.one_time_keys.every((p) => !decode(p).otk.fallback)).toBe(true);
    expect(decode(upload?.fallback ?? "").otk).toMatchObject({
      key: account.fallback_key(),
      fallback: true,
    });
    account.free();
  });

  it("adds only what grappa is missing", () => {
    const account = new (olm().Account)();

    const upload = topUp(account, { one_time_keys: MAX_HOSTED_ONE_TIME_KEYS - 3, fallback: true });

    expect(upload).toEqual({ one_time_keys: expect.any(Array), fallback: null });
    expect(upload?.one_time_keys).toHaveLength(3);
    // ...and generates no more than it sends: a key generated past grappa's
    // room would be marked published without ever reaching it.
    expect(account.one_time_keys()).toHaveLength(3);
    account.free();
  });

  it("sends nothing to a full bundle, and generates nothing", () => {
    const account = new (olm().Account)();

    expect(topUp(account, { one_time_keys: MAX_HOSTED_ONE_TIME_KEYS, fallback: true })).toBeNull();
    expect(account.one_time_keys()).toEqual([]);
    expect(account.fallback_key()).toBeUndefined();
    account.free();
  });

  it("resends the keys an earlier upload never confirmed before generating new ones", () => {
    const account = new (olm().Account)();
    account.generate_one_time_keys(5);
    account.generate_fallback_key();
    const pending = account.one_time_keys();

    const upload = topUp(account, { one_time_keys: 40, fallback: true });

    const sent = upload?.one_time_keys.map((p) => decode(p).otk.key) ?? [];
    expect(sent).toHaveLength(10);
    expect(sent.slice(0, 5)).toEqual(pending);
    // Five new ones, not ten: the five pending count towards the room.
    expect(account.one_time_keys()).toHaveLength(10);
    // An unconfirmed fallback key is the newest one: it goes up even though
    // grappa already holds one.
    expect(decode(upload?.fallback ?? "").otk.key).toBe(account.fallback_key());
    account.free();
  });

  it("never sends grappa more one-time keys than it has room for, oldest first", () => {
    const account = new (olm().Account)();
    account.generate_one_time_keys(5);
    const pending = account.one_time_keys();

    const upload = topUp(account, { one_time_keys: MAX_HOSTED_ONE_TIME_KEYS - 2, fallback: true });

    expect(upload?.one_time_keys.map((p) => decode(p).otk.key)).toEqual(pending.slice(0, 2));
    expect(topUp(account, { one_time_keys: MAX_HOSTED_ONE_TIME_KEYS, fallback: true })).toBeNull();
    account.free();
  });
});
