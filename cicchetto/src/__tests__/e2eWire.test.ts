// issue 2430 — wire v2: the compact-JSON codec, the device id, the list
// rules every master block goes through, and what the shape parsers read.
// The fixed vectors (did, fb, the signed strings, the line count, the
// payloads a receiver accepts or refuses, the fold) are the conformance
// corpus every implementation reads: e2eVectors.test.ts (issue 2691).
import { describe, expect, it } from "vitest";
import {
  base64Unpadded,
  base64Url,
  certSigText,
  DEVICE_CAP,
  decodePayload,
  did,
  encodePayload,
  type IdBlock,
  listSigText,
  MAX_DEVICES,
  type MasterList,
  PayloadError,
  parseKeys,
  parseMasterList,
  parseMsg,
  parseNack,
  parsePkmsg,
  unbase64,
  validMasterList,
  WIRE_VERSION,
} from "../lib/e2e/wire";
import { olm } from "./helpers/olm";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("base64", () => {
  it("is unpadded as vodozemac prints it, and url-safe unpadded for a did", () => {
    expect(base64Unpadded(bytes(1, 2))).toBe("AQI");
    expect(base64Url(bytes(0xfb, 0xff, 0xbe))).toBe("-_--");
    expect(base64Url(bytes(1, 2))).toBe("AQI");
  });

  it("decodes both spellings to the same bytes", () => {
    expect(unbase64("AQI=")).toEqual(bytes(1, 2));
    expect(unbase64("AQI")).toEqual(bytes(1, 2));
    expect(unbase64("")).toEqual(bytes());
  });

  it("refuses what is not standard base64, with a PayloadError", () => {
    for (const text of ["AQ-_", "A", "AQI==x", "AQ I=", "AQI==="]) {
      expect(() => unbase64(text), text).toThrow(PayloadError);
    }
  });
});

describe("did", () => {
  it("is 11 characters of the url-safe alphabet for any key", () => {
    const o = olm();
    for (let i = 0; i < 20; i++) {
      expect(did(o, new o.Account().ed25519_key())).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });
});

describe("the signed strings", () => {
  it("verifies a certificate a master signed over the literal text, and not over another version", () => {
    const o = olm();
    const master = new o.Account();
    const device = new o.Account().ed25519_key();
    const cert = master.sign(`irc-e2e:v2:dev:2:${device}`);
    expect(o.verify_ed25519(master.ed25519_key(), certSigText(2, device), cert)).toBe(true);
    expect(o.verify_ed25519(master.ed25519_key(), certSigText(3, device), cert)).toBe(false);
    master.free();
  });

  it("is protocol 2 with at most 4 devices", () => {
    expect(WIRE_VERSION).toBe(2);
    expect(MAX_DEVICES).toBe(4);
  });

  // issue 2576: the cap is what an identity holds, the wire bound what a
  // receiver takes (a list of 4 an older client signed still reads); a cap
  // above the bound would sign lists no peer accepts.
  it("caps an identity at 3 devices, within the wire's bound", () => {
    expect(DEVICE_CAP).toBe(3);
    expect(DEVICE_CAP).toBeLessThanOrEqual(MAX_DEVICES);
  });
});

describe("validMasterList", () => {
  const o = olm();
  const master = new o.Account();
  const keys = () => Array.from({ length: 6 }, () => new o.Account().ed25519_key()).sort();

  function signed(ver: number, devices: string[]): MasterList {
    return {
      ed25519: master.ed25519_key(),
      list: { ver, devices },
      sig: master.sign(listSigText(ver, devices)),
    };
  }

  it("accepts a list signed by its own master, 1 to 4 devices", () => {
    const k = keys();
    for (let n = 1; n <= 4; n++) expect(validMasterList(o, signed(3, k.slice(0, n)))).toBe(true);
  });

  it("accepts a list whose JSON text spells ver as 1.0, signed over the text with 1", () => {
    // A Python sender writes the integer 1 as `1.0`; the signature is over "...:1:...".
    const k = keys().slice(0, 2);
    const text = `{"ed25519":"${master.ed25519_key()}","list":{"ver":1.0,"devices":${JSON.stringify(k)}},"sig":"${master.sign(listSigText(1, k))}"}`;
    expect(text).toContain('"ver":1.0');
    const parsed = parseMasterList(decodePayload(text));
    expect(validMasterList(o, parsed)).toBe(true);
  });

  it("accepts ver at both ends of 1..2^31-1", () => {
    expect(validMasterList(o, signed(1, keys().slice(0, 1)))).toBe(true);
    expect(validMasterList(o, signed(2 ** 31 - 1, keys().slice(0, 1)))).toBe(true);
  });

  it("refuses unsorted devices, even with a valid signature", () => {
    const [a, b] = keys();
    expect(validMasterList(o, signed(1, [b as string, a as string]))).toBe(false);
  });

  it("refuses a duplicated device key", () => {
    const [a] = keys();
    expect(validMasterList(o, signed(1, [a as string, a as string]))).toBe(false);
  });

  it("refuses two keys that give the same did", () => {
    // A 64-bit did collision cannot be found on demand, so make every key hash alike.
    const colliding = { ...o, sha256: () => new Uint8Array(32) } as typeof o;
    const list = signed(1, keys().slice(0, 2));
    expect(validMasterList(o, list)).toBe(true);
    expect(validMasterList(colliding, list)).toBe(false);
  });

  it("refuses 5 devices and an empty list", () => {
    expect(validMasterList(o, signed(1, keys().slice(0, 5)))).toBe(false);
    expect(validMasterList(o, signed(1, []))).toBe(false);
  });

  it("refuses ver 0, ver 2^31, a negative ver", () => {
    const k = keys().slice(0, 2);
    for (const ver of [0, 2 ** 31, -1])
      expect(validMasterList(o, signed(ver, k)), `${ver}`).toBe(false);
  });

  it("refuses a ver that is not an integer: 1.5, true, a string, NaN, even when the master signed it", () => {
    const k = keys().slice(0, 2);
    for (const ver of [1.5, true, "1", Number.NaN]) {
      // Signed over the very text the bad ver spells, so only the ver rule can refuse it.
      const list = signed(1, k);
      list.list.ver = ver as unknown as number;
      list.sig = master.sign(listSigText(ver as unknown as number, k));
      expect(validMasterList(o, list), String(ver)).toBe(false);
    }
  });

  it("refuses a list whose signature is not its master's over exactly this text", () => {
    const k = keys().slice(0, 2);
    const list = signed(2, k);
    expect(validMasterList(o, { ...list, sig: new o.Account().sign(listSigText(2, k)) })).toBe(
      false,
    );
    expect(validMasterList(o, { ...list, list: { ver: 3, devices: k } })).toBe(false);
    expect(validMasterList(o, { ...list, sig: "not a signature" })).toBe(false);
    expect(validMasterList(o, { ...list, ed25519: new o.Account().ed25519_key() })).toBe(false);
  });

  it("refuses a device key that is not in vodozemac's own spelling, even when the master signed it", () => {
    const k = keys()[0] as string;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    // The 43rd character carries 4 key bits and 2 padding bits: change only the latter.
    const twin = k.slice(0, -1) + alphabet[alphabet.indexOf(k.slice(-1)) ^ 1];
    expect(validMasterList(o, signed(1, [k]))).toBe(true);
    expect(validMasterList(o, signed(1, [twin]))).toBe(false);
    // vodozemac reads a padded spelling as the same key; the wire does not.
    expect(validMasterList(o, signed(1, [`${k}=`]))).toBe(false);
  });

  it("refuses a master key that is not in vodozemac's own spelling", () => {
    const k = keys().slice(0, 1);
    const padded = `${master.ed25519_key()}=`;
    expect(
      validMasterList(o, {
        ed25519: padded,
        list: { ver: 1, devices: k },
        sig: master.sign(listSigText(1, k)),
      }),
    ).toBe(false);
  });
});

describe("decodePayload", () => {
  it("reads back what encodePayload wrote: compact, ASCII, no space", () => {
    const payload = {
      v: 2,
      ck: "ZMI0jIqBCLFWnUOWBWnh99w4xfjO26wS6Cxjqanonlk",
      bodies: { If4x36FUomE: "AwogRf23quZfNQGC3F4H6p4ZKw+/bgQ" },
    };

    expect(encodePayload(payload)).toBe(
      '{"v":2,"ck":"ZMI0jIqBCLFWnUOWBWnh99w4xfjO26wS6Cxjqanonlk","bodies":{"If4x36FUomE":"AwogRf23quZfNQGC3F4H6p4ZKw+/bgQ"}}',
    );
    expect(encodePayload(payload)).toMatch(/^[\x21-\x7e]+$/);
    expect(decodePayload(encodePayload(payload))).toEqual(payload);
  });
});

describe("parsers", () => {
  const id: IdBlock = { curve25519: "K", ed25519: "E", sig: "S" };
  const list = { ed25519: "M", list: { ver: 1, devices: ["E"] }, sig: "S" };
  const entry = { id, otk: { key: "O", fallback: true, sig: "S2" } };

  it("parseKeys reads the master block and the device entries", () => {
    expect(parseKeys({ v: 2, master: list, devices: [entry] })).toEqual({
      master: list,
      devices: [{ id, otk: { key: "O", fallback: true, sig: "S2" } }],
    });
  });

  it("parseKeys treats a fallback that is not literally true as false", () => {
    const parsed = parseKeys({
      v: 2,
      master: list,
      devices: [{ ...entry, otk: { key: "O", sig: "S2" } }],
    });
    expect(parsed.devices[0]?.otk.fallback).toBe(false);
  });

  it("parsePkmsg reads the id, the certificate with the version it names, and the bodies by did", () => {
    const payload = {
      v: 2,
      id,
      master: { ed25519: "M", cert: "C", ver: 3 },
      bodies: { If4x36FUomE: "B", _Uw_z3_OAsk: "B2" },
    };
    expect(parsePkmsg(payload)).toEqual({
      id,
      master: { ed25519: "M", cert: "C", ver: 3 },
      bodies: { If4x36FUomE: "B", _Uw_z3_OAsk: "B2" },
    });
  });

  it("parsePkmsg takes the certificate's ver as a list's: an integer value in 1..2^31-1, 1.0 being 1", () => {
    const pkmsg = (ver: string) =>
      decodePayload(
        `{"v":2,"id":${JSON.stringify(id)},"master":{"ed25519":"M","cert":"C","ver":${ver}},"bodies":{"aaaaaaaaaaa":"B"}}`,
      );
    for (const [text, ver] of [
      ["1", 1],
      ["1.0", 1],
      [`${2 ** 31 - 1}`, 2 ** 31 - 1],
    ] as const) {
      expect(parsePkmsg(pkmsg(text)).master.ver, text).toBe(ver);
    }
  });

  it("parseMsg and parseNack read their fields", () => {
    expect(parseMsg({ v: 2, ck: "K", bodies: { aaaaaaaaaaa: "B" } })).toEqual({
      ck: "K",
      bodies: { aaaaaaaaaaa: "B" },
    });
    expect(parseNack({ v: 2, ref: "R" })).toEqual({ ref: "R" });
  });
});
