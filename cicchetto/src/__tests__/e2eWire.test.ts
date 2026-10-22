// issue 2430 — wire v2: the compact-JSON codec, the device id, the signed
// strings, the list rules every master block goes through, the shape
// parsers, and the line count that keeps cic from handing grappa a message it
// would refuse for length.
import { describe, expect, it } from "vitest";
import {
  base64Unpadded,
  base64Url,
  CERT_PREFIX,
  certSigText,
  decodePayload,
  did,
  encodePayload,
  fb,
  type IdBlock,
  LIST_SIG_PREFIX,
  linesNeeded,
  listSigText,
  MAX_DEVICES,
  MAX_FRAGMENTS,
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

// RFC 8032 §7.1 TEST 1 public key, and sha256("irc-e2e did vector 70"): the two
// vectors of the base64url did amendment (6348464388).
const E1 = "11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo";
const E2 = "7l01yXGoarYtEU3nwHF01/CIo8/r8U0lJ01TnULT9IY";

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
  it("is the base64url of the first 8 bytes of sha256 of the raw key, on both amendment vectors", () => {
    expect(did(olm(), E1)).toBe("If4x36FUomE");
    expect(did(olm(), E2)).toBe("_Uw_z3-OAsk");
  });

  it("is 11 characters of the url-safe alphabet for any key", () => {
    const o = olm();
    for (let i = 0; i < 20; i++) {
      expect(did(o, new o.Account().ed25519_key())).toMatch(/^[A-Za-z0-9_-]{11}$/);
    }
  });
});

describe("fb", () => {
  // python3 -I -c 'import base64,hashlib
  // E1=b"11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo";E2=b"7l01yXGoarYtEU3nwHF01/CIo8/r8U0lJ01TnULT9IY"
  // f=lambda a,b: base64.b64encode(hashlib.sha256(b"irc-e2e:v2:bind:"+a+b":"+b).digest()[:16]).rstrip(b"=").decode()
  // print(f(E1,E2));print(f(E2,E1))'
  it("matches the Python vectors, and is not symmetric", () => {
    expect(fb(olm(), E1, E2)).toBe("Rf23quZfNQGC3F4H6p4ZKw");
    expect(fb(olm(), E2, E1)).toBe("uitrgaXwYBvIfv1QB+/bgQ");
  });
});

describe("the signed strings", () => {
  it("spells the list text with N in decimal and the keys joined by commas", () => {
    expect(listSigText(7, [E1, E2])).toBe(`irc-e2e:v2:list:7:${E1},${E2}`);
    expect(LIST_SIG_PREFIX).toBe("irc-e2e:v2:list:");
  });

  it("spells the certificate text with the list version N in decimal, then the device key", () => {
    expect(certSigText(2, E1)).toBe(`irc-e2e:v2:dev:2:${E1}`);
    expect(CERT_PREFIX).toBe("irc-e2e:v2:dev:");
  });

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

  it("refuses anything but a JSON object, NaN and Infinity included, with a PayloadError", () => {
    for (const text of ["[1]", "null", "1", '"s"', "{", '{"v":NaN}', '{"v":Infinity}', "", "x"]) {
      expect(() => decodePayload(text), text).toThrow(PayloadError);
    }
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

  it("parseKeys refuses 5 entries, a missing field, and another version", () => {
    expect(() => parseKeys({ v: 2, master: list, devices: Array(5).fill(entry) })).toThrow(
      PayloadError,
    );
    expect(() => parseKeys({ v: 2, devices: [entry] })).toThrow(PayloadError);
    expect(() => parseKeys({ v: 2, master: list })).toThrow(PayloadError);
    expect(() => parseKeys({ v: 1, master: list, devices: [entry] })).toThrow(PayloadError);
    expect(() => parseKeys({ master: list, devices: [entry] })).toThrow(PayloadError);
  });

  it("parseMasterList refuses a ver that is not a number and a devices that is not strings", () => {
    expect(() => parseMasterList({ ...list, list: { ver: true, devices: ["E"] } })).toThrow(
      PayloadError,
    );
    expect(() => parseMasterList({ ...list, list: { ver: 1, devices: [1] } })).toThrow(
      PayloadError,
    );
    expect(() => parseMasterList({ ...list, list: { ver: 1 } })).toThrow(PayloadError);
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
    for (const text of ["0", `${2 ** 31}`, "-1", "1.5", "true", '"2"', "null"]) {
      expect(() => parsePkmsg(pkmsg(text)), text).toThrow(PayloadError);
    }
    const missing = { v: 2, id, master: { ed25519: "M", cert: "C" }, bodies: { aaaaaaaaaaa: "B" } };
    expect(() => parsePkmsg(missing)).toThrow(PayloadError);
  });

  it("parsePkmsg and parseMsg refuse no bodies, 5 bodies, a body key that is not a did, a non-string body", () => {
    const master = { ed25519: "M", cert: "C", ver: 1 };
    const five = Object.fromEntries(
      ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd", "eeeeeeeeeee"].map((d) => [
        d,
        "B",
      ]),
    );
    for (const bodies of [{}, five, { "a/aaaaaaaaa": "B" }, { aaaaaaaaaaa: 1 }, [], "B"]) {
      expect(() => parsePkmsg({ v: 2, id, master, bodies }), JSON.stringify(bodies)).toThrow(
        PayloadError,
      );
      expect(() => parseMsg({ v: 2, ck: "K", bodies }), JSON.stringify(bodies)).toThrow(
        PayloadError,
      );
    }
  });

  it("parseMsg and parseNack read their fields and refuse another version", () => {
    expect(parseMsg({ v: 2, ck: "K", bodies: { aaaaaaaaaaa: "B" } })).toEqual({
      ck: "K",
      bodies: { aaaaaaaaaaa: "B" },
    });
    expect(parseNack({ v: 2, ref: "R" })).toEqual({ ref: "R" });
    expect(() => parseNack({ v: 1, ref: "R" })).toThrow(PayloadError);
    expect(() => parseMsg({ v: 2, bodies: { aaaaaaaaaaa: "B" } })).toThrow(PayloadError);
    expect(() => parseNack({ v: 2 })).toThrow(PayloadError);
  });
});

describe("linesNeeded", () => {
  // The numbers are grappa's. `lineBudget` is what `LineSplit.frame_budget("vjt-claude", 512)`
  // gives in test/grappa/irc/e2e_test.exs:181: frame_budget_base(512) = 394 (512 less the
  // 107-byte worst-case source prefix, "PRIVMSG :" and CRLF) minus the 10-byte target, 384
  // (frame_budget == frame_budget_base - byte_size(target), line_split_test.exs:354).
  // The head of an MSG did -> did line is 50 bytes for "1/1" through "9/9" ("\x01E2E MSG "
  // + 11 + " " + "n/n " + 2 dids + " " + "\x01"), and 52 from "10/10": room 334, then 332,
  // as `E2e.fragment/5` computes it.
  const LINE_BUDGET = 384;
  const DID_A = "If4x36FUomE";
  const DID_B = "_Uw_z3-OAsk";
  const msg = (size: number) => linesNeeded("msg", "A".repeat(size), LINE_BUDGET, DID_A, DID_B);

  it("holds 334 bytes in one line and needs two for 335", () => {
    expect(msg(334)).toBe(1);
    expect(msg(335)).toBe(2);
  });

  it("widens the head with the digits of n: 9 lines hold 3006 bytes, the 10th line's room is 332", () => {
    expect(msg(9 * 334)).toBe(9);
    expect(msg(9 * 334 + 1)).toBe(10);
    expect(msg(10 * 332)).toBe(10);
    expect(msg(10 * 332 + 1)).toBe(11);
  });

  it("holds 64 x 332 = 21248 bytes in 64 lines and refuses one byte more", () => {
    expect(msg(64 * 332)).toBe(64);
    expect(msg(64 * 332 + 1)).toBeGreaterThan(MAX_FRAGMENTS);
  });

  it("charges the addresses: `*` addresses leave 20 bytes more per line", () => {
    const star = (size: number) => linesNeeded("msg", "A".repeat(size), LINE_BUDGET, "*", "*");
    expect(star(354)).toBe(1);
    expect(star(355)).toBe(2);
  });

  it("charges the verb: a PKMSG head is 2 bytes wider than a MSG head", () => {
    expect(linesNeeded("pkmsg", "A".repeat(332), LINE_BUDGET, DID_A, DID_B)).toBe(1);
    expect(linesNeeded("pkmsg", "A".repeat(333), LINE_BUDGET, DID_A, DID_B)).toBe(2);
  });

  it("is one line for a KEYREQ", () => {
    expect(linesNeeded("keyreq", encodePayload({ v: 2 }), LINE_BUDGET, DID_A, "*")).toBe(1);
  });

  it("is infinite when the budget leaves no room for the head", () => {
    expect(linesNeeded("msg", "A", 50, DID_A, DID_B)).toBe(Number.POSITIVE_INFINITY);
  });
});
