// issue 2430 — the pairing channel's messages (X1-crypto): what the two
// browsers say to each other over the ECIES channel that grappa's relay
// carries, and the signing and checking around them. Pure: no network, no
// storage. The channel (`pairing.ts`) moves opaque bytes; this module gives
// them meaning and judges them.
//
// Five kinds, `{"v":1,"t":…}` as compact JSON: the joiner's `hello`, the
// holder's `offer`, the joiner's `join`, the holder's `signed`, the joiner's
// `done`. A `network` is a slug. The channel's own authentication is the ECIES
// handshake plus the typed check code; what this module adds is that nothing
// the holder SIGNS, and nothing the joiner ACCEPTS, rests on the channel alone:
// every signature is verified against the keys it names.

import type { OwnIdentity } from "./accountStore";
import type { Olm } from "./olm";
import type { Account } from "./vodozemac/vodozemac_binding";
import {
  base64Url,
  certSigText,
  type IdBlock,
  idSigText,
  listSigText,
  MAX_DEVICES,
  type SignedList,
  unbase64,
  validMasterList,
} from "./wire";

/** The ECIES info string of the pairing channel, on both sides. */
export const PAIRING_INFO = "irc-e2e:v2:pair";

const REFUSALS = ["full", "paired", "list-changed", "failed"] as const;
/** Why a network was left out of a pairing. */
export type PairRefusal = (typeof REFUSALS)[number];

export type Hello = { v: 1; t: "hello" };
export type Offer = {
  v: 1;
  t: "offer";
  networks: { network: string; master: string }[];
  full: string[];
};
export type Join = {
  v: 1;
  t: "join";
  devices: { network: string; id: IdBlock }[];
  skipped: { network: string; reason: PairRefusal }[];
};
export type Signed = {
  v: 1;
  t: "signed";
  devices: { network: string; cert: string; list: SignedList }[];
  refused: { network: string; reason: PairRefusal }[];
};
export type Done = { v: 1; t: "done"; paired: string[] };
export type PairMessage = Hello | Offer | Join | Signed | Done;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

/** The message as the channel carries it: compact JSON, UTF-8. */
export function encodePairMessage(m: PairMessage): Uint8Array {
  return encoder.encode(JSON.stringify(m));
}

// The readers below return `undefined` for anything off-shape, and the caller
// maps one `undefined` to a null message: a refusal, never a throw.

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function list<T>(value: unknown, read: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: T[] = [];
  for (const item of value) {
    const got = read(item);
    if (got === undefined) return undefined;
    out.push(got);
  }
  return out;
}

function reason(value: unknown): PairRefusal | undefined {
  return REFUSALS.find((r) => r === value);
}

/** `key` when it is the canonical spelling of an Ed25519 key. */
function ed(olm: Olm, key: unknown): string | undefined {
  if (typeof key !== "string") return undefined;
  try {
    return olm.canonical_ed25519(key) === key ? key : undefined;
  } catch {
    return undefined;
  }
}

function curve(olm: Olm, key: unknown): string | undefined {
  if (typeof key !== "string") return undefined;
  try {
    return olm.canonical_curve25519(key) === key ? key : undefined;
  } catch {
    return undefined;
  }
}

function slug(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function id(olm: Olm, value: unknown): IdBlock | undefined {
  const o = rec(value);
  if (o === undefined) return undefined;
  const curve25519 = curve(olm, o.curve25519);
  const ed25519 = ed(olm, o.ed25519);
  const sig = text(o.sig);
  if (curve25519 === undefined || ed25519 === undefined || sig === undefined) return undefined;
  return { curve25519, ed25519, sig };
}

function signedList(olm: Olm, value: unknown): SignedList | undefined {
  const o = rec(value);
  if (o === undefined) return undefined;
  const devices = list(o.devices, (d) => ed(olm, d));
  const sig = text(o.sig);
  if (typeof o.ver !== "number" || devices === undefined || sig === undefined) return undefined;
  return { ver: o.ver, devices, sig };
}

/**
 * A message from the channel's bytes, or null for anything that is not one of
 * the five kinds at `v` 1 with every field present, well-typed and (for keys)
 * canonical. Unknown extra fields are ignored; an unknown `t` or `reason` is
 * not.
 */
export function decodePairMessage(olm: Olm, bytes: Uint8Array): PairMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoder.decode(bytes));
  } catch {
    return null;
  }
  const o = rec(parsed);
  if (o === undefined || o.v !== 1) return null;
  switch (o.t) {
    case "hello":
      return { v: 1, t: "hello" };
    case "offer": {
      const networks = list(o.networks, (n) => {
        const r = rec(n);
        const network = slug(r?.network);
        const master = ed(olm, r?.master);
        return network === undefined || master === undefined ? undefined : { network, master };
      });
      const full = list(o.full, slug);
      return networks === undefined || full === undefined
        ? null
        : { v: 1, t: "offer", networks, full };
    }
    case "join": {
      const devices = list(o.devices, (d) => {
        const r = rec(d);
        const network = slug(r?.network);
        const block = id(olm, r?.id);
        return network === undefined || block === undefined ? undefined : { network, id: block };
      });
      const skipped = list(o.skipped, refused);
      return devices === undefined || skipped === undefined
        ? null
        : { v: 1, t: "join", devices, skipped };
    }
    case "signed": {
      const devices = list(o.devices, (d) => {
        const r = rec(d);
        const network = slug(r?.network);
        const cert = text(r?.cert);
        const l = signedList(olm, r?.list);
        return network === undefined || cert === undefined || l === undefined
          ? undefined
          : { network, cert, list: l };
      });
      const refusals = list(o.refused, refused);
      return devices === undefined || refusals === undefined
        ? null
        : { v: 1, t: "signed", devices, refused: refusals };
    }
    case "done": {
      const paired = list(o.paired, slug);
      return paired === undefined ? null : { v: 1, t: "done", paired };
    }
    default:
      return null;
  }

  function refused(item: unknown): { network: string; reason: PairRefusal } | undefined {
    const r = rec(item);
    const network = slug(r?.network);
    const why = reason(r?.reason);
    return network === undefined || why === undefined ? undefined : { network, reason: why };
  }
}

/**
 * The joiner's first payload: vodozemac's `InitialMessage.encode()` carries a
 * `|` the relay refuses, so it travels as base64url of its UTF-8, unpadded.
 */
export function wrapInitial(message: string): string {
  return base64Url(encoder.encode(message));
}

/** Inverse of `wrapInitial`; null for anything the relay charset or UTF-8 refuses. */
export function unwrapInitial(payload: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) return null;
  try {
    return decoder.decode(unbase64(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return null;
  }
}

/**
 * What the holder signs to add a joiner's device to one network's list: the
 * list at `ver + 1` with the device in it, and the device's certificate naming
 * that version. `joinerId` comes from the joiner, so it is checked first: its
 * keys canonical, as the decoder reads an id block, and its own signature
 * (S1) vouching for this very master. Refusals: `failed` (either check),
 * `paired` (already listed), `full`.
 */
export function issueDevice(
  olm: Olm,
  master: Account,
  own: OwnIdentity,
  joinerId: IdBlock,
): { list: SignedList; cert: string } | PairRefusal {
  const { curve25519, ed25519, sig } = joinerId;
  if (id(olm, joinerId) === undefined) return "failed";
  if (!olm.verify_ed25519(ed25519, idSigText(curve25519, own.master), sig)) return "failed";
  if (own.list.devices.includes(ed25519)) return "paired";
  if (own.list.devices.length >= MAX_DEVICES) return "full";
  const ver = own.list.ver + 1;
  const devices = [...own.list.devices, ed25519].sort();
  return {
    list: { ver, devices, sig: master.sign(listSigText(ver, devices)) },
    cert: master.sign(certSigText(ver, ed25519)),
  };
}

/**
 * What the joiner takes from the holder's `signed`, or null: the list must be
 * a valid one signed by `masterKey`, hold `device`, and the certificate must be
 * the master's over `device` at that list's version.
 */
export function acceptSigned(
  olm: Olm,
  masterKey: string,
  device: string,
  signed: { cert: string; list: SignedList },
): { cert: string; certVer: number; list: SignedList } | null {
  const { list: l, cert } = signed;
  if (
    !validMasterList(olm, {
      ed25519: masterKey,
      list: { ver: l.ver, devices: l.devices },
      sig: l.sig,
    })
  ) {
    return null;
  }
  if (!l.devices.includes(device)) return null;
  if (!olm.verify_ed25519(masterKey, certSigText(l.ver, device), cert)) return null;
  return { cert, certVer: l.ver, list: l };
}
