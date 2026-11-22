// issue 2691 — cicchetto's reader of the E2E conformance corpus
// (src/lib/e2e/vectors/). grappa's ExUnit (`Grappa.E2eVectorsTest`) and
// shottino's test_e2e.c read the same files, each running its OWN code
// against the same rows: a protocol change one side misses is red on that
// side. The protocol is docs/E2E_PROTOCOL.md.
//
// cic implements every subject the corpus covers except the canonical did
// check, which only grappa makes (a frame address); cic's check of a did is
// its shape, applied where cic meets one: a key of `bodies`.
import { describe, expect, it } from "vitest";
import didVectors from "../lib/e2e/vectors/did.json";
import fbVectors from "../lib/e2e/vectors/fb.json";
import foldVectors from "../lib/e2e/vectors/fold.json";
import linesVectors from "../lib/e2e/vectors/lines_needed.json";
import payloadVectors from "../lib/e2e/vectors/payloads.json";
import signedVectors from "../lib/e2e/vectors/signed_strings.json";
import {
  certSigText,
  decodePayload,
  did,
  fb,
  fold,
  idSigText,
  linesNeeded,
  listSigText,
  otkSigText,
  PayloadError,
  parseKeys,
  parseMsg,
  parseNack,
  parsePkmsg,
  type SendVerb,
} from "../lib/e2e/wire";
import { olm } from "./helpers/olm";

type SignedCase =
  | { kind: "id"; curve25519: string; master: string; text: string }
  | { kind: "list"; ver: number; devices: string[]; text: string }
  | { kind: "cert"; ver: number; ed25519: string; text: string }
  | { kind: "otk"; key: string; text: string };

type LinesCase = {
  why: string;
  verb: SendVerb;
  from: string;
  to: string;
  budget: number;
  payload_size: number;
  lines: number | null;
};

type PayloadCase = {
  why: string;
  verb: "keys" | "pkmsg" | "msg" | "nack";
  text: string;
  accept: boolean;
  undecodable: boolean;
};

const signed = signedVectors.cases as SignedCase[];
const lines = linesVectors.cases as LinesCase[];
const payloads = payloadVectors.cases as PayloadCase[];

const parsers: Record<PayloadCase["verb"], (payload: Record<string, unknown>) => unknown> = {
  keys: parseKeys,
  pkmsg: parsePkmsg,
  msg: parseMsg,
  nack: parseNack,
};

function signedText(c: SignedCase): string {
  switch (c.kind) {
    case "id":
      return idSigText(c.curve25519, c.master);
    case "list":
      return listSigText(c.ver, c.devices);
    case "cert":
      return certSigText(c.ver, c.ed25519);
    case "otk":
      return otkSigText(c.key);
  }
}

describe("the E2E conformance corpus", () => {
  it("every file holds cases (guards an accidental empty array)", () => {
    expect(didVectors.derive.length).toBeGreaterThanOrEqual(2);
    expect(didVectors.not_keys.length).toBeGreaterThanOrEqual(1);
    expect(didVectors.spellings.length).toBeGreaterThanOrEqual(5);
    expect(fbVectors.cases.length).toBeGreaterThanOrEqual(2);
    expect(new Set(signed.map((c) => c.kind))).toEqual(new Set(["id", "list", "cert", "otk"]));
    expect(lines.length).toBeGreaterThanOrEqual(10);
    expect(payloads.length).toBeGreaterThanOrEqual(30);
    expect(foldVectors.cases.length).toBeGreaterThanOrEqual(5);
  });

  for (const c of didVectors.derive) {
    it(`did — derives ${c.did}: ${c.why}`, () => {
      expect(did(olm(), c.ed25519)).toBe(c.did);
    });
  }

  for (const c of didVectors.not_keys) {
    it(`did — refuses to derive from what is not a key: ${c.why}`, () => {
      expect(() => did(olm(), c.ed25519)).toThrow();
    });
  }

  for (const c of didVectors.spellings) {
    it(`did — a body keyed by ${JSON.stringify(c.did)} has the shape: ${c.shape} (${c.why})`, () => {
      const payload = decodePayload(JSON.stringify({ v: 2, ck: "K", bodies: { [c.did]: "B" } }));
      if (c.shape) expect(() => parseMsg(payload)).not.toThrow();
      else expect(() => parseMsg(payload)).toThrow(PayloadError);
    });
  }

  for (const c of fbVectors.cases) {
    it(`fb — ${c.why}`, () => {
      expect(fb(olm(), c.from, c.to)).toBe(c.fb);
    });
  }

  for (const [i, c] of signed.entries()) {
    it(`signed strings — row ${i}, the ${c.kind} text`, () => {
      expect(signedText(c)).toBe(c.text);
    });
  }

  for (const c of lines) {
    it(`lines needed — ${c.why}`, () => {
      expect(linesNeeded(c.verb, "A".repeat(c.payload_size), c.budget, c.from, c.to)).toBe(
        c.lines ?? Number.POSITIVE_INFINITY,
      );
    });
  }

  for (const c of payloads) {
    it(`payloads — ${c.verb}: ${c.why}`, () => {
      if (c.undecodable) {
        expect(() => decodePayload(c.text)).toThrow(PayloadError);
        return;
      }
      const decoded = decodePayload(c.text);
      if (c.accept) expect(() => parsers[c.verb](decoded)).not.toThrow();
      else expect(() => parsers[c.verb](decoded)).toThrow(PayloadError);
    });
  }

  for (const c of foldVectors.cases) {
    it(`fold — ${JSON.stringify(c.in)}: ${c.why}`, () => {
      expect(fold(c.in)).toBe(c.out);
    });
  }
});
