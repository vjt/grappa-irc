// issue 2430 — wire v2: the payloads of the E2E verbs and the encodings
// around them (spec: issue 2430 comments 6346236542, 6346686730 rev 2, and
// 6348464388 for the base64url did).
//
// A payload is a JSON object sent as its compact text (`JSON.stringify`, no
// spaces): grappa cuts that text into
// `\x01E2E <VERB> <msgid> <i>/<n> <from> <to> <chunk>\x01` lines and joins
// the chunks back on the way in, so cic never sees a fragment. Every string
// inside is base64 or punctuation, so nothing in it needs escaping for IRC.
// Keys and signatures are standard base64 WITHOUT padding, as vodozemac
// prints them; only a device id is base64url.

import type { Olm } from "./olm";

/** The verbs cic sends through grappa's send door (it never sends KEYS: grappa answers KEYREQ). */
export type SendVerb = "keyreq" | "pkmsg" | "msg" | "nack";
/** The verbs grappa delivers to cic (it never delivers KEYREQ). */
export type ReceiveVerb = "keys" | "pkmsg" | "msg" | "nack";
/** The verbs that carry an encrypted message: to a peer's devices, and a copy to a sibling's. */
export type MessageVerb = Extract<SendVerb, "pkmsg" | "msg">;

export const WIRE_VERSION = 2;
/** What a device signs to vouch for its curve key and its master: `E.sign(ID_SIG_PREFIX + K + ":" + M)`. */
export const ID_SIG_PREFIX = "irc-e2e:v2:id:";
/** Unchanged from v1: `E.sign(OTK_SIG_PREFIX + O)`. */
export const OTK_SIG_PREFIX = "irc-e2e:v1:otk:";
/** `M.sign(LIST_SIG_PREFIX + N + ":" + E1 + "," + E2 …)`, see `listSigText`. */
export const LIST_SIG_PREFIX = "irc-e2e:v2:list:";
/** The certificate of a device: `C = M.sign(CERT_PREFIX + N + ":" + E)`, see `certSigText`. */
export const CERT_PREFIX = "irc-e2e:v2:dev:";
/** The binding of a PKMSG's sender to its recipient, see `fb`. */
export const BIND_PREFIX = "irc-e2e:v2:bind:";
/** The most devices one master lists (grappa's `DeviceList.max_devices/0`). */
export const MAX_DEVICES = 4;

const MAX_VER = 2 ** 31 - 1;
const DID = /^[A-Za-z0-9_-]{11}$/;

/** A signed identity block: the Curve25519 key, claimed by the Ed25519 key. */
export type IdBlock = { curve25519: string; ed25519: string; sig: string };
/** A master's list of device Ed25519 keys at one version, with the master's signature. */
export type SignedList = { ver: number; devices: string[]; sig: string };
/** The master block of KEYS and `t:list`: the master key and its signed list. */
export type MasterList = {
  ed25519: string;
  list: { ver: number; devices: string[] };
  sig: string;
};
/**
 * The master block of a PKMSG: the master key, its certificate for the
 * sending device, and the list version the certificate names.
 */
export type MasterCert = { ed25519: string; cert: string; ver: number };
export type KeysEntry = { id: IdBlock; otk: { key: string; fallback: boolean; sig: string } };
export type KeysPayload = { master: MasterList; devices: KeysEntry[] };
/** `bodies` maps a recipient did to the Olm body for it. */
export type PkmsgPayload = { id: IdBlock; master: MasterCert; bodies: Record<string, string> };
export type MsgPayload = { ck: string; bodies: Record<string, string> };
export type NackPayload = { ref: string };
/**
 * The inner message of a copy (S1): the text `body` a device of the account
 * sent `peer`, encrypted to the account's other devices; a pre-key body adds
 * `fb`, as one to a peer does.
 */
export type CopyInner = { t: "copy"; peer: string; body: string };

/** A payload that does not decode, or lacks a field its verb needs. */
export class PayloadError extends Error {}

const encoder = new TextEncoder();

/** Standard base64 of `bytes`, unpadded, as vodozemac prints it. */
export function base64Unpadded(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, "");
}

/** Base64url (RFC 4648 §5) of `bytes`, unpadded: the spelling of a did. */
export function base64Url(bytes: Uint8Array): string {
  return base64Unpadded(bytes).replace(/\+/g, "-").replace(/\//g, "_");
}

/** The bytes of standard base64, padded or not. Throws PayloadError on anything else. */
export function unbase64(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text)) throw new PayloadError("not base64");
  const bare = text.replace(/=+$/, "");
  let binary: string;
  try {
    binary = atob(bare + "=".repeat((4 - (bare.length % 4)) % 4));
  } catch {
    throw new PayloadError("not base64");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** A payload object as the send door takes it: its compact JSON text. */
export function encodePayload(payload: object): string {
  return JSON.stringify(payload);
}

/** A payload as grappa delivered it, parsed to its JSON object. `NaN` and `Infinity` are not JSON: they throw. */
export function decodePayload(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new PayloadError("undecodable payload");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PayloadError("payload is not a JSON object");
  }
  return value as Record<string, unknown>;
}

/**
 * The device id of an Ed25519 key: base64url of the first 8 bytes of SHA-256
 * over the RAW 32 key bytes, never over the key's base64 text. A routing
 * label only; no trust rests on it. Throws when `ed25519` is not a key.
 */
export function did(olm: Olm, ed25519: string): string {
  return base64Url(olm.sha256(unbase64(olm.canonical_ed25519(ed25519))).slice(0, 8));
}

/**
 * The `fb` binding of a PKMSG body: the first 16 bytes of SHA-256 over the
 * sender's and the recipient's device keys, in that order, unpadded base64.
 */
export function fb(olm: Olm, fromE: string, toE: string): string {
  return base64Unpadded(olm.sha256(encoder.encode(`${BIND_PREFIX}${fromE}:${toE}`)).slice(0, 16));
}

/** The text a device signs for its id block (S1): its curve key, then the master it vouches for. */
export function idSigText(curve25519: string, master: string): string {
  return `${ID_SIG_PREFIX}${curve25519}:${master}`;
}

/** The text a master signs for a list: `N` in decimal, the keys in array order. */
export function listSigText(ver: number, devices: string[]): string {
  return `${LIST_SIG_PREFIX}${ver}:${devices.join(",")}`;
}

/**
 * The text a master signs for one of its devices: the version `N` of the
 * first list that held the device, in decimal as a list spells it, then the
 * device's key.
 */
export function certSigText(ver: number, ed25519: string): string {
  return `${CERT_PREFIX}${ver}:${ed25519}`;
}

/**
 * Whether `ver` is a version as the wire takes one, a list's or a
 * certificate's: an integer value in 1..2^31-1. Judges the parsed value, so
 * `1.0` is 1 and `true` is not an integer.
 */
export function validVer(ver: unknown): ver is number {
  return typeof ver === "number" && Number.isInteger(ver) && ver >= 1 && ver <= MAX_VER;
}

/**
 * Whether a master block obeys the list rules and its own signature: 1 to
 * `MAX_DEVICES` canonical keys, sorted strictly ascending in plain string
 * order, no two with the same did, `ver` valid (`validVer`), and `sig` the
 * master's over `listSigText`.
 */
export function validMasterList(olm: Olm, m: MasterList): boolean {
  const { ver, devices } = m.list;
  if (!Array.isArray(devices) || devices.length < 1 || devices.length > MAX_DEVICES) return false;
  if (!validVer(ver)) return false;
  for (let i = 1; i < devices.length; i++) {
    if (!((devices[i - 1] as string) < (devices[i] as string))) return false;
  }
  const dids = new Set<string>();
  try {
    for (const key of devices) {
      if (olm.canonical_ed25519(key) !== key) return false;
      dids.add(did(olm, key));
    }
    if (olm.canonical_ed25519(m.ed25519) !== m.ed25519) return false;
  } catch {
    return false;
  }
  if (dids.size !== devices.length) return false;
  return olm.verify_ed25519(m.ed25519, listSigText(ver, devices), m.sig);
}

function str(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== "string") throw new PayloadError(`missing ${field}`);
  return value;
}

function obj(parent: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = parent[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PayloadError(`missing ${field}`);
  }
  return value as Record<string, unknown>;
}

function version(payload: Record<string, unknown>): void {
  if (payload.v !== WIRE_VERSION) throw new PayloadError("unsupported version");
}

function idBlock(parent: Record<string, unknown>): IdBlock {
  const id = obj(parent, "id");
  return { curve25519: str(id, "curve25519"), ed25519: str(id, "ed25519"), sig: str(id, "sig") };
}

/** The master block of KEYS and `t:list`, shape only: `validMasterList` judges it. */
export function parseMasterList(master: Record<string, unknown>): MasterList {
  const list = obj(master, "list");
  const { ver, devices } = list;
  if (typeof ver !== "number") throw new PayloadError("missing ver");
  if (!Array.isArray(devices) || !devices.every((d) => typeof d === "string")) {
    throw new PayloadError("missing devices");
  }
  return {
    ed25519: str(master, "ed25519"),
    list: { ver, devices: devices as string[] },
    sig: str(master, "sig"),
  };
}

function bodies(payload: Record<string, unknown>): Record<string, string> {
  const raw = obj(payload, "bodies");
  const entries = Object.entries(raw);
  if (entries.length < 1 || entries.length > MAX_DEVICES) throw new PayloadError("bad bodies");
  const out: Record<string, string> = {};
  for (const [key, body] of entries) {
    if (!DID.test(key) || typeof body !== "string") throw new PayloadError("bad bodies");
    out[key] = body;
  }
  return out;
}

export function parseKeys(payload: Record<string, unknown>): KeysPayload {
  version(payload);
  const devices = payload.devices;
  if (!Array.isArray(devices) || devices.length > MAX_DEVICES)
    throw new PayloadError("missing devices");
  return {
    master: parseMasterList(obj(payload, "master")),
    devices: devices.map((entry): KeysEntry => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        throw new PayloadError("bad device entry");
      }
      const e = entry as Record<string, unknown>;
      const otk = obj(e, "otk");
      return {
        id: idBlock(e),
        otk: { key: str(otk, "key"), fallback: otk.fallback === true, sig: str(otk, "sig") },
      };
    }),
  };
}

export function parsePkmsg(payload: Record<string, unknown>): PkmsgPayload {
  version(payload);
  const master = obj(payload, "master");
  const { ver } = master;
  if (!validVer(ver)) throw new PayloadError("bad ver");
  return {
    id: idBlock(payload),
    master: { ed25519: str(master, "ed25519"), cert: str(master, "cert"), ver },
    bodies: bodies(payload),
  };
}

export function parseMsg(payload: Record<string, unknown>): MsgPayload {
  version(payload);
  return { ck: str(payload, "ck"), bodies: bodies(payload) };
}

export function parseNack(payload: Record<string, unknown>): NackPayload {
  version(payload);
  return { ref: str(payload, "ref") };
}

/** The ASCII case fold of a nick (CASEMAPPING=ascii, grappa's `canonical_target`). */
export function fold(nick: string): string {
  return nick.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// How many lines a payload takes, counted the way grappa does when it
// fragments (`Grappa.IRC.E2e.fragment/5`): refused past 64 lines (413). cic
// never computes the relayed-line reserve itself (#1108): the caller hands in
// `lineBudget`, the bytes one relayed line leaves for the PRIVMSG body, which
// is the network's published `frame_budget_base` minus the target's UTF-8 byte
// length (`LineSplit.frame_budget/2`). What is left here is the CTCP head.
export const MAX_FRAGMENTS = 64;

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/**
 * The lines `payload` (its compact JSON text) takes when sent as `verb` from
 * device `from` to `to` (a did or `*`) with `lineBudget` bytes per line. The
 * same arithmetic as grappa's `E2e.fragment/5`: a line's head
 * (`\x01E2E VERB msgid i/n from to ` and the closing `\x01`) widens with the
 * digits of `n`, so the smallest `n` whose `n` lines of room cover the payload
 * decides the chunk size, and grappa then cuts exactly `n` lines (the room for
 * `n - 1` was too small, and is never smaller than the room for `n`). `Infinity` when no `n` up to `MAX_FRAGMENTS` fits,
 * which grappa refuses.
 */
export function linesNeeded(
  verb: SendVerb,
  payload: string,
  lineBudget: number,
  from: string,
  to: string,
): number {
  const size = utf8Length(payload);
  for (let n = 1; n <= MAX_FRAGMENTS; n++) {
    const head = utf8Length(
      `\x01E2E ${verb.toUpperCase()} ${"x".repeat(11)} ${n}/${n} ${from} ${to} `,
    );
    const room = lineBudget - head - 1;
    if (room > 0 && room * n >= size) return n;
  }
  return Number.POSITIVE_INFINITY;
}
