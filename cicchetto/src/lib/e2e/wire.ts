// issue 2430 — the payloads of the E2E verbs, as the wire agreed on 2430
// carries them (w2's proposal, acked: comments 6252857813, 6252874041), and
// the encodings around them.
//
// A payload is a JSON object, UTF-8, sent as ONE padded standard base64
// string: grappa cuts it into `\x01E2E <VERB> <msgid> <i>/<n> <chunk>\x01`
// lines and joins them back on the way in, so cic never sees a fragment.
// Binary fields inside (keys, signatures, Olm bodies) are standard base64
// WITHOUT padding, as vodozemac prints them.

/** The verbs cic sends through grappa's send door (it never sends KEYS: grappa answers KEYREQ). */
export type SendVerb = "keyreq" | "pkmsg" | "msg" | "nack";
/** The verbs grappa delivers to cic (it never delivers KEYREQ). */
export type ReceiveVerb = "keys" | "pkmsg" | "msg" | "nack";

export const WIRE_VERSION = 1;
export const ID_SIG_PREFIX = "irc-e2e:v1:id:";
export const OTK_SIG_PREFIX = "irc-e2e:v1:otk:";

/** A signed identity block: the Curve25519 key, claimed by the Ed25519 key. */
export type IdBlock = { curve25519: string; ed25519: string; sig: string };
export type KeysPayload = {
  v: number;
  id: IdBlock;
  otk: { key: string; fallback: boolean; sig: string };
};
export type PkmsgPayload = { v: number; id: IdBlock; body: string };
export type MsgPayload = { v: number; ck: string; body: string };
export type NackPayload = { v: number; ref: string };

/** A payload that does not decode, or lacks a field its verb needs. */
export class PayloadError extends Error {}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Standard base64 of `bytes`, padded. */
export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Standard base64 of `bytes`, unpadded, as vodozemac prints it. */
export function base64Unpadded(bytes: Uint8Array): string {
  return base64(bytes).replace(/=+$/, "");
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

/** A payload object as the send door takes it. */
export function encodePayload(payload: object): string {
  return base64(encoder.encode(JSON.stringify(payload)));
}

/** A payload as grappa delivered it, decoded to its JSON object. */
export function decodePayload(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decoder.decode(unbase64(text)));
  } catch (err) {
    if (err instanceof PayloadError) throw err;
    throw new PayloadError("undecodable payload");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PayloadError("payload is not a JSON object");
  }
  return value as Record<string, unknown>;
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

function idBlock(payload: Record<string, unknown>): IdBlock {
  const id = obj(payload, "id");
  return { curve25519: str(id, "curve25519"), ed25519: str(id, "ed25519"), sig: str(id, "sig") };
}

export function parseKeys(payload: Record<string, unknown>): KeysPayload {
  const otk = obj(payload, "otk");
  return {
    v: WIRE_VERSION,
    id: idBlock(payload),
    otk: { key: str(otk, "key"), fallback: otk.fallback === true, sig: str(otk, "sig") },
  };
}

export function parsePkmsg(payload: Record<string, unknown>): PkmsgPayload {
  return { v: WIRE_VERSION, id: idBlock(payload), body: str(payload, "body") };
}

export function parseMsg(payload: Record<string, unknown>): MsgPayload {
  return { v: WIRE_VERSION, ck: str(payload, "ck"), body: str(payload, "body") };
}

export function parseNack(payload: Record<string, unknown>): NackPayload {
  return { v: WIRE_VERSION, ref: str(payload, "ref") };
}

/** The ASCII case fold of a nick (CASEMAPPING=ascii, grappa's `canonical_target`). */
export function fold(nick: string): string {
  return nick.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

// How many lines a payload takes, counted the way irc-olm does
// (framing._chunk_budget): a 512-byte line, minus what the receiver's server
// puts in front of our text at its longest — our nick, an ident of bahamut's
// USERLEN, a host of its HOSTLEN — minus the CTCP head. grappa does its own
// count and refuses past 64 lines (413); this one is never smaller, so a
// message cic lets through is never refused for length.
const LINE_BYTES = 512;
const USERLEN = 10;
const HOSTLEN = 63;
export const MAX_FRAGMENTS = 64;

function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** The lines `payload` (encoded) needs when `ownNick` sends `verb` to `target`. */
export function linesNeeded(
  verb: SendVerb,
  payload: string,
  ownNick: string,
  target: string,
): number {
  const mask = `${ownNick}!~${"x".repeat(USERLEN)}@${"x".repeat(HOSTLEN)}`;
  const envelope = utf8Length(`:${mask} PRIVMSG ${target} :`) + 2;
  let total = 1;
  for (;;) {
    const head =
      utf8Length(`\x01E2E ${verb.toUpperCase()} ${"x".repeat(11)} ${total}/${total} `) + 1;
    const budget = LINE_BYTES - envelope - head;
    if (budget <= 0) return Number.POSITIVE_INFINITY;
    const need = Math.max(1, Math.ceil(payload.length / budget));
    if (need <= total) return total;
    total = need;
  }
}
