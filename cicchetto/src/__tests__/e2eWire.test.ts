// issue 2430 — the encodings around the E2E payloads: base64 as the agreed
// wire spells it (padded for the payload, unpadded inside it), the payload
// decoder every received message goes through first, and the line count
// that keeps cic from handing grappa a message it would refuse for length.
import { describe, expect, it } from "vitest";
import {
  base64,
  base64Unpadded,
  decodePayload,
  encodePayload,
  linesNeeded,
  MAX_FRAGMENTS,
  PayloadError,
  unbase64,
} from "../lib/e2e/wire";

const bytes = (...values: number[]) => new Uint8Array(values);

describe("base64", () => {
  it("is padded for the payload and unpadded for the fields inside it", () => {
    expect(base64(bytes(1, 2))).toBe("AQI=");
    expect(base64Unpadded(bytes(1, 2))).toBe("AQI");
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

describe("decodePayload", () => {
  it("reads back what encodePayload wrote, non-ASCII included", () => {
    const payload = { v: 1, body: "caffè ☕" };

    expect(encodePayload(payload)).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(decodePayload(encodePayload(payload))).toEqual(payload);
  });

  it("refuses anything but a JSON object in UTF-8, with a PayloadError", () => {
    const encode = (text: string) => base64(new TextEncoder().encode(text));
    for (const text of ["[1]", "null", "1", '"s"', "{"]) {
      expect(() => decodePayload(encode(text)), text).toThrow(PayloadError);
    }
    expect(() => decodePayload(base64(bytes(0x7b, 0xff, 0x7d)))).toThrow(PayloadError);
    expect(() => decodePayload("not base64!")).toThrow(PayloadError);
  });
});

describe("linesNeeded", () => {
  it("is one line for a short payload, and grows with the payload, the nick and the target", () => {
    const payload = "A".repeat(1000);

    expect(linesNeeded("keyreq", encodePayload({ v: 1 }), "alice", "bob")).toBe(1);
    expect(linesNeeded("msg", payload, "alice", "bob")).toBeGreaterThan(1);
    expect(linesNeeded("msg", payload + payload, "alice", "bob")).toBeGreaterThan(
      linesNeeded("msg", payload, "alice", "bob"),
    );
    // Every line carries our mask and the target: a longer one leaves less room.
    const long = "x".repeat(30);
    const room = (nick: string, target: string) =>
      [...Array(600).keys()].findIndex((n) => linesNeeded("msg", "A".repeat(n), nick, target) > 1);
    expect(room("a", "bob")).toBeGreaterThan(0);
    expect(room(long, "bob")).toBeLessThan(room("a", "bob"));
    expect(room("a", long)).toBeLessThan(room("a", "bob"));
  });

  it("goes past the fragment limit for a payload grappa refuses", () => {
    expect(linesNeeded("pkmsg", "A".repeat(64 * 512), "alice", "bob")).toBeGreaterThan(
      MAX_FRAGMENTS,
    );
  });
});
