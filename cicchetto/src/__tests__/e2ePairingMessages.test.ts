// issue 2430 — the pairing channel's codec, and the signing and checks of a
// device added through it. Real vodozemac, real Accounts: the master signs, the
// new device vouches for itself, and `acceptSigned` judges what came back the
// way the joiner will.
import { describe, expect, it } from "vitest";
import { idBlock } from "../lib/e2e/keyBundle";
import {
  acceptSigned,
  decodePairMessage,
  encodePairMessage,
  issueDevice,
  type PairMessage,
  unwrapInitial,
  wrapInitial,
} from "../lib/e2e/pairingMessages";
import { certSigText, idSigText, listSigText, MAX_DEVICES } from "../lib/e2e/wire";
import { olm } from "./helpers/olm";

const enc = new TextEncoder();
const dec = new TextDecoder();

type Own = Parameters<typeof issueDevice>[2];

/** A master with `n` devices already listed (version `ver`), as the holder's record has it. */
function holder(n: number, ver = 3) {
  const master = new (olm().Account)();
  const devices = Array.from({ length: n }, () => new (olm().Account)().ed25519_key()).sort();
  const own: Own = {
    master: master.ed25519_key(),
    cert: "unused",
    certVer: 1,
    list: { ver, devices, sig: master.sign(listSigText(ver, devices)) },
    did: "unused",
  };
  return { master, own };
}

function joiner(master: string) {
  const device = new (olm().Account)();
  return { device, id: idBlock(device, master) };
}

function lines(m: PairMessage): PairMessage {
  const back = decodePairMessage(olm(), encodePairMessage(m));
  if (back === null) throw new Error("did not decode");
  return back;
}

function raw(value: unknown): Uint8Array {
  return enc.encode(JSON.stringify(value));
}

describe("the pairing messages", () => {
  const master = new (olm().Account)().ed25519_key();
  const dev = new (olm().Account)();
  const id = idBlock(dev, master);
  const signedList = { ver: 2, devices: [id.ed25519], sig: "s" };
  const all: PairMessage[] = [
    { v: 1, t: "hello" },
    { v: 1, t: "offer", networks: [{ network: "azzurra", master }], full: ["libera"] },
    {
      v: 1,
      t: "join",
      devices: [{ network: "azzurra", id }],
      skipped: [{ network: "oftc", reason: "paired" }],
    },
    {
      v: 1,
      t: "signed",
      devices: [{ network: "azzurra", cert: "c", list: signedList }],
      refused: [{ network: "libera", reason: "list-changed" }],
    },
    { v: 1, t: "done", paired: ["azzurra"] },
  ];

  it("decode of encode is the identity for each of the five kinds", () => {
    for (const m of all) expect(lines(m)).toEqual(m);
  });

  it("encodes as compact JSON with v first", () => {
    expect(dec.decode(encodePairMessage({ v: 1, t: "hello" }))).toBe('{"v":1,"t":"hello"}');
  });

  it("a message with v 2, an unknown t, a non-canonical key or an unknown reason decodes to null", () => {
    const join = all[2] as Extract<PairMessage, { t: "join" }>;
    const bad: unknown[] = [
      { v: 2, t: "hello" },
      { v: 1, t: "bye" },
      { v: 1 },
      { v: 1, t: "done", paired: "azzurra" },
      { ...join, devices: [{ network: "azzurra", id: { ...id, ed25519: `${id.ed25519}=` } }] },
      { ...join, devices: [{ network: "azzurra", id: { ...id, curve25519: "AAAA" } }] },
      { ...join, skipped: [{ network: "oftc", reason: "because" }] },
      { ...all[3], refused: [{ network: "libera", reason: "nope" }] },
      { ...all[1], networks: [{ network: "azzurra", master: "AAAA" }] },
    ];
    for (const m of bad) expect(decodePairMessage(olm(), raw(m))).toBeNull();
    expect(decodePairMessage(olm(), enc.encode("{nope"))).toBeNull();
    expect(decodePairMessage(olm(), enc.encode("[]"))).toBeNull();
  });

  it("an extra field is ignored", () => {
    expect(decodePairMessage(olm(), raw({ v: 1, t: "hello", extra: 1 }))).toEqual({
      v: 1,
      t: "hello",
    });
  });
});

describe("the initial payload", () => {
  it("unwrapInitial of wrapInitial is the message, and the wrapped form fits the relay charset", () => {
    const m = "Zm9v+/ct|a2V5Pz8/é";
    const wrapped = wrapInitial(m);
    expect(wrapped).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(unwrapInitial(wrapped)).toBe(m);
  });

  it("unwrapInitial refuses what is not base64url", () => {
    expect(unwrapInitial("a|b")).toBeNull();
    expect(unwrapInitial("ab+/")).toBeNull();
  });
});

describe("issueDevice", () => {
  it("puts the device in at ver+1, sorted, and its certificate names that ver", () => {
    const { master, own } = holder(2);
    const { id } = joiner(own.master);

    const out = issueDevice(olm(), master, own, id);

    if (typeof out === "string") throw new Error(out);
    expect(out.list.ver).toBe(own.list.ver + 1);
    expect(out.list.devices).toEqual([...own.list.devices, id.ed25519].sort());
    const accepted = acceptSigned(olm(), own.master, id.ed25519, out);
    expect(accepted).toEqual({ cert: out.cert, certVer: own.list.ver + 1, list: out.list });
  });

  it("refuses an id block signed over another master as failed", () => {
    const { master, own } = holder(1);
    const { id } = joiner(new (olm().Account)().ed25519_key());
    expect(issueDevice(olm(), master, own, id)).toBe("failed");
  });

  it("refuses an id block whose signature is not the device's as failed", () => {
    const { master, own } = holder(1);
    const { id } = joiner(own.master);
    const other = idBlock(new (olm().Account)(), own.master);
    expect(issueDevice(olm(), master, own, { ...id, sig: other.sig })).toBe("failed");
    expect(issueDevice(olm(), master, own, { ...id, sig: "garbage" })).toBe("failed");
  });

  // Each key spelled the way the decoder refuses, with an S1 that verifies:
  // only the canonical check stands between it and the list.
  it("refuses an id block whose keys are not canonical as failed, though its S1 verifies", () => {
    const { master, own } = holder(1);
    const { device, id } = joiner(own.master);
    const padded = `${id.curve25519}=`;
    const paddedCurve = {
      ...id,
      curve25519: padded,
      sig: device.sign(idSigText(padded, own.master)),
    };
    expect(olm().verify_ed25519(id.ed25519, idSigText(padded, own.master), paddedCurve.sig)).toBe(
      true,
    );
    expect(issueDevice(olm(), master, own, paddedCurve)).toBe("failed");
    expect(issueDevice(olm(), master, own, { ...id, ed25519: `${id.ed25519}=` })).toBe("failed");
  });

  it("answers paired for a device already listed", () => {
    const { master, own } = holder(1);
    const { id } = joiner(own.master);
    const listed: Own = { ...own, list: { ...own.list, devices: [id.ed25519] } };
    expect(issueDevice(olm(), master, listed, id)).toBe("paired");
  });

  it("answers full for a list of 4", () => {
    const { master, own } = holder(MAX_DEVICES);
    const { id } = joiner(own.master);
    expect(issueDevice(olm(), master, own, id)).toBe("full");
  });
});

describe("acceptSigned", () => {
  function issued() {
    const { master, own } = holder(1);
    const { id } = joiner(own.master);
    const out = issueDevice(olm(), master, own, id);
    if (typeof out === "string") throw new Error(out);
    return { master, own, id, out };
  }

  it("accepts what issueDevice made", () => {
    const { own, id, out } = issued();
    expect(acceptSigned(olm(), own.master, id.ed25519, out)).not.toBeNull();
  });

  it("refuses a list without the device", () => {
    const { master, own, id } = issued();
    const devices = [...own.list.devices];
    const list = { ver: 9, devices, sig: master.sign(listSigText(9, devices)) };
    const cert = master.sign(certSigText(9, id.ed25519));
    expect(acceptSigned(olm(), own.master, id.ed25519, { cert, list })).toBeNull();
  });

  it("refuses a bad list signature", () => {
    const { own, id, out } = issued();
    const list = { ...out.list, sig: own.list.sig };
    expect(acceptSigned(olm(), own.master, id.ed25519, { cert: out.cert, list })).toBeNull();
  });

  it("refuses a certificate over another ver", () => {
    const { master, own, id, out } = issued();
    const cert = master.sign(certSigText(out.list.ver + 1, id.ed25519));
    expect(acceptSigned(olm(), own.master, id.ed25519, { cert, list: out.list })).toBeNull();
  });

  it("refuses a list signed by another master", () => {
    const { own, id, out } = issued();
    const stranger = new (olm().Account)().ed25519_key();
    expect(acceptSigned(olm(), stranger, id.ed25519, out)).toBeNull();
    expect(own.master).not.toBe(stranger);
  });
});
