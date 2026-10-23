// issue 2430 — the E2E engine on real vodozemac accounts and sessions: our
// engine against peer devices that are real accounts, through the fake
// grappa v2 where a test needs grappa's doors (`helpers/e2eGrappa.ts`), and
// two engines end to end. Nothing is mocked inside the engine: a test that
// passes here passed through Olm.
import { describe, expect, it } from "vitest";
import type { OwnIdentity } from "../lib/e2e/accountStore";
import {
  type CopyResult,
  type DropReason,
  type E2eEvent,
  type E2eState,
  Engine,
  KEYREQ_RETRY_MS,
  LIST_TAG,
  LISTREQ_INTERVAL_MS,
  newState,
  OUTQ_MAX,
  OUTQ_TTL_MS,
  type Outbound,
  type PeerDevice,
  REKEY_INTERVAL_MS,
  type Result,
  SENT_MAX,
  SENT_MEMORY_MS,
} from "../lib/e2e/engine";
import { idBlock, type SignedKey } from "../lib/e2e/keyBundle";
import type { Account } from "../lib/e2e/vodozemac/vodozemac_binding";
import {
  base64Unpadded,
  certSigText,
  decodePayload,
  did,
  encodePayload,
  fb,
  ID_SIG_PREFIX,
  type IdBlock,
  type KeysEntry,
  listSigText,
  MAX_DEVICES,
  type MasterList,
  OTK_SIG_PREFIX,
  type ReceiveVerb,
  unbase64,
  validMasterList,
} from "../lib/e2e/wire";
import {
  enlist,
  FRAME_BUDGET_BASE,
  SLUG,
  signedList,
  throughDoor,
  uploadKeys,
} from "./helpers/e2eDevices";
import { type DeviceMessage, Grappa } from "./helpers/e2eGrappa";
import {
  deviceBlock,
  engineFor,
  enrolledAccount,
  type OwnDevice,
  ownAccount,
} from "./helpers/e2eSiblings";
import { olm } from "./helpers/olm";

function newMsgid(): string {
  return base64Unpadded(crypto.getRandomValues(new Uint8Array(8)));
}

/** A base64 key of 44 characters that decodes to 33 bytes. */
const KEY_OF_33_BYTES = base64Unpadded(new Uint8Array(33).fill(7)).padEnd(44, "=");

/** A payload with `edit` applied to its decoded JSON. */
function edited(payload: string, edit: (json: Record<string, unknown>) => void): string {
  const json = decodePayload(payload);
  edit(json);
  return encodePayload(json);
}

// --- wire v2: master trust ---------------------------------------------------
//
// One engine on real keys: the identity `identity.ts` makes (this device under
// its master), peers as real masters and devices. A device "bound" here is
// what a KEYS or a pre-key message leaves behind (its curve under its master,
// a session to it); the trust steps KEYS, PKMSG and `t:list` share are private
// to the engine and reached as a unit (`trust`).

const NOW = 1_700_000_000_000;

/** A subject's identity on the network, as `identity.ts` makes it: this device under its master. */
type Me = {
  nick: string;
  account: Account;
  /** Its master: what certifies its devices. */
  master: Account;
  own: OwnIdentity;
  state: E2eState;
  /** What its engines reported, in order (`record`). */
  events: E2eEvent[];
  /** Its clock (ms): every engine of it reads this. */
  now: number;
};

function me(nick: string): Me {
  const master = new (olm().Account)();
  const account = new (olm().Account)();
  const ed25519 = account.ed25519_key();
  return {
    nick,
    account,
    master,
    own: {
      master: master.ed25519_key(),
      cert: master.sign(certSigText(1, ed25519)),
      certVer: 1,
      list: { ver: 1, devices: [ed25519], sig: master.sign(listSigText(1, [ed25519])) },
      did: did(olm(), ed25519),
    },
    state: newState(),
    events: [],
    now: NOW,
  };
}

function engineOf(side: Me): Engine {
  return new Engine(
    olm(),
    side.account,
    side.own,
    side.state,
    side.nick,
    FRAME_BUDGET_BASE,
    () => side.now,
  );
}

/** A peer: its master, and its devices, each with its id block signed under that master. */
type PeerIdentity = { master: Account; devices: Account[] };

function peerWith(devices: number): PeerIdentity {
  return {
    master: new (olm().Account)(),
    devices: Array.from({ length: devices }, () => new (olm().Account)()),
  };
}

const keyOf = (account: Account): string => account.ed25519_key();

/** A list at `ver` of `devices`, keys sorted as the wire wants them. */
function listOf(ver: number, devices: Account[]): MasterList["list"] {
  return { ver, devices: devices.map(keyOf).sort() };
}

/** `device` bound under `master`, with a real session of `side` open to it: its pickle. */
function bind(side: Me, master: Account, device: Account): string {
  const ed25519 = device.ed25519_key();
  const curve25519 = device.curve25519_key();
  side.state.devices[ed25519] = {
    ed25519,
    curve25519,
    master: master.ed25519_key(),
    did: did(olm(), ed25519),
    proven: false,
    certVer: null,
  };
  device.generate_one_time_keys(1);
  const otk = device.one_time_keys()[0];
  if (otk === undefined) throw new Error("no one-time key");
  const session = side.account.create_outbound_session(curve25519, otk);
  const pickle = session.pickle();
  session.free();
  side.state.sessions[curve25519] = [pickle];
  return pickle;
}

/** The trust steps the engine keeps private (KEYS, PKMSG and `t:list` call them). */
type TrustSteps = {
  applyList(master: string, list: MasterList["list"]): void;
  checkMaster(nick: string, master: string, res: Result): "ok" | "alarm";
  refusal(master: string, id: IdBlock): DropReason | undefined;
  standing(master: string, ed25519: string, certVer: number | null): DropReason | undefined;
  trustedDevices(master: string): PeerDevice[];
  curveRefusal(id: IdBlock, proving: boolean): DropReason | undefined;
};

const trust = (engine: Engine): TrustSteps => engine as unknown as TrustSteps;

const noResult = (): Result => ({ events: [], outbound: [] });

/**
 * `nick` pinned to `master` as a first KEYS or pre-key message pins it:
 * unverified, and nothing asked of it (a pin by hand also asks for its list).
 */
function pinnedTo(side: Me, nick: string, master: string): void {
  expect(trust(engineOf(side)).checkMaster(nick, master, noResult())).toBe("ok");
}

/** `nick` pinned to `peer`'s master and its list at `ver` accepted, nothing of it bound yet. */
function listedPeer(side: Me, nick: string, peer: PeerIdentity, ver: number): void {
  pinnedTo(side, nick, keyOf(peer.master));
  trust(engineOf(side)).applyList(keyOf(peer.master), listOf(ver, peer.devices));
}

/** `nick` pinned to `peer`'s master and its list at `ver` accepted, its devices bound. */
function knownPeer(side: Me, nick: string, peer: PeerIdentity, ver: number): void {
  listedPeer(side, nick, peer, ver);
  for (const device of peer.devices) bind(side, peer.master, device);
}

describe("our identity", () => {
  it("names the master as our key, and this device by its own keys", () => {
    const a = me("alice");
    const engine = engineOf(a);

    expect(engine.fingerprint()).toBe(a.own.master);
    expect(engine.fingerprint()).not.toBe(a.account.ed25519_key());
    expect(engine.deviceKey()).toBe(a.account.ed25519_key());
    expect(engine.curve()).toBe(a.account.curve25519_key());
  });
});

describe("pins by hand", () => {
  it("pins a master never seen to the nick, verified as the user said, with no list yet", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const carol = peerWith(1);
    const engine = engineOf(a);

    expect(engine.pin("Bob", keyOf(bob.master), true).outcome).toBe("pinned");
    expect(engine.pin("carol", keyOf(carol.master), false).outcome).toBe("pinned");

    expect(engine.pinned("BOB")).toEqual({ master: keyOf(bob.master), verified: true, devices: 0 });
    expect(engine.pinned("carol")?.verified).toBe(false);
    expect(engine.pinned("dave")).toBeUndefined();
    expect(a.state.pins).toEqual({ bob: keyOf(bob.master), carol: keyOf(carol.master) });
    expect(a.state.masters[keyOf(bob.master)]).toEqual({
      nick: "Bob",
      verified: true,
      ver: 0,
      devices: [],
      revoked: [],
      revokedCurves: [],
    });
  });

  it("never takes a verification away, and gives one when the user pastes the master later", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const carol = peerWith(1);
    const engine = engineOf(a);

    engine.pin("bob", keyOf(bob.master), true);
    engine.pin("bob", keyOf(bob.master), false);
    engine.pin("carol", keyOf(carol.master), false);
    engine.pin("carol", keyOf(carol.master), true);

    expect(engine.pinned("bob")?.verified).toBe(true);
    expect(engine.pinned("carol")?.verified).toBe(true);
  });

  it("moves the nick to another master: the old one's device sessions go, its list stays", () => {
    const a = me("alice");
    const old = peerWith(2);
    const carol = peerWith(1);
    const fresh = peerWith(1);
    knownPeer(a, "bob", old, 3);
    knownPeer(a, "carol", carol, 1);
    const carolSessions = { ...a.state.sessions };
    for (const device of old.devices) delete carolSessions[device.curve25519_key()];

    expect(engineOf(a).pin("bob", keyOf(fresh.master), true).outcome).toBe("pinned");

    expect(engineOf(a).pinned("bob")).toEqual({
      master: keyOf(fresh.master),
      verified: true,
      devices: 0,
    });
    expect(a.state.sessions).toEqual(carolSessions);
    expect(a.state.masters[keyOf(old.master)]).toMatchObject(listOf(3, old.devices));
    expect(engineOf(a).pinned("carol")?.devices).toBe(1);
  });

  it("keeps the old master's device sessions while another nick still reaches it", () => {
    const a = me("alice");
    const old = peerWith(2);
    const fresh = peerWith(1);
    knownPeer(a, "bob", old, 1);
    engineOf(a).pin("bobby", keyOf(old.master), false);
    const sessions = structuredClone(a.state.sessions);

    expect(engineOf(a).pin("bob", keyOf(fresh.master), false).outcome).toBe("pinned");

    expect(engineOf(a).pinned("bob")?.master).toBe(keyOf(fresh.master));
    expect(a.state.sessions).toEqual(sessions);
    expect(engineOf(a).pinned("bobby")).toEqual({
      master: keyOf(old.master),
      verified: false,
      devices: 2,
    });
  });

  it("keeps the sessions of the master the nick is pinned to again", () => {
    const a = me("alice");
    const bob = peerWith(1);
    knownPeer(a, "bob", bob, 1);
    const sessionIds = () =>
      Object.entries(a.state.sessions).map(([curve, pickles]) => [curve, pickles.map(sessionIdOf)]);
    const sessions = sessionIds();

    expect(engineOf(a).pin("BOB", keyOf(bob.master), true).outcome).toBe("pinned");

    expect(sessionIds()).toEqual(sessions);
    expect(engineOf(a).pinned("bob")).toEqual({
      master: keyOf(bob.master),
      verified: true,
      devices: 1,
    });
  });

  it("refuses what is not an Ed25519 key in vodozemac's spelling, and our own master", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const engine = engineOf(a);

    expect(engine.pin("bob", "not a key", true).outcome).toBe("bad-key");
    expect(engine.pin("bob", "A".repeat(42), true).outcome).toBe("bad-key");
    expect(engine.pin("bob", KEY_OF_33_BYTES, true).outcome).toBe("bad-key");
    expect(engine.pin("bob", `${keyOf(bob.master)}=`, true).outcome).toBe("bad-key");
    expect(engine.pin("bob", a.own.master, true).outcome).toBe("own-key");
    expect(a.state.pins).toEqual({});
    expect(a.state.masters).toEqual({});
  });

  it("verifies a master a SAS confirmed under every nick pinned to it, and never one it does not know", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const engine = engineOf(a);
    engine.pin("bob", keyOf(bob.master), false);
    engine.pin("bobby", keyOf(bob.master), false);

    engine.verify("bob", keyOf(bob.master));
    engine.verify("bob", keyOf(peerWith(1).master));

    expect(engine.pinned("bob")?.verified).toBe(true);
    expect(engine.pinned("bobby")?.verified).toBe(true);
    expect(Object.keys(a.state.masters)).toEqual([keyOf(bob.master)]);
  });
});

describe("a master presented on the wire", () => {
  it("is pinned to a nick with no pin, unverified, on first use", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const res = noResult();

    expect(trust(engineOf(a)).checkMaster("Bob", keyOf(bob.master), res)).toBe("ok");

    expect(res).toEqual(noResult());
    expect(a.state.pins).toEqual({ bob: keyOf(bob.master) });
    expect(engineOf(a).pinned("bob")).toEqual({
      master: keyOf(bob.master),
      verified: false,
      devices: 0,
    });
    expect(a.state.masters[keyOf(bob.master)]).toMatchObject({ nick: "Bob", ver: 0, devices: [] });
  });

  it("is taken without a word when it is the master pinned to the nick", () => {
    const a = me("alice");
    const bob = peerWith(1);
    knownPeer(a, "bob", bob, 2);
    const before = structuredClone(a.state);
    const res = noResult();

    expect(trust(engineOf(a)).checkMaster("BOB", keyOf(bob.master), res)).toBe("ok");

    expect(res).toEqual(noResult());
    expect(a.state).toEqual(before);
  });

  it("raises the alarm when it is another master on a pinned nick, naming both, and stores nothing", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const other = peerWith(1);
    knownPeer(a, "bob", bob, 1);
    const before = structuredClone(a.state);
    const res = noResult();

    expect(trust(engineOf(a)).checkMaster("Bob", keyOf(other.master), res)).toBe("alarm");

    expect(res.events).toEqual([
      {
        kind: "key_alarm",
        nick: "Bob",
        pinned: keyOf(bob.master),
        presented: keyOf(other.master),
      },
    ]);
    expect(res.outbound).toEqual([]);
    expect(a.state).toEqual(before);
  });

  it("is refused when it is our own master, and nothing is pinned or stored", () => {
    const a = me("alice");
    const bob = peerWith(1);
    knownPeer(a, "bob", bob, 1);
    const before = structuredClone(a.state);
    const res = noResult();

    expect(trust(engineOf(a)).checkMaster("mallory", a.own.master, res)).toBe("alarm");

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "mallory", reason: "own-identity" }],
      outbound: [],
    });
    expect(a.state).toEqual(before);
    expect(engineOf(a).pinned("mallory")).toBeUndefined();
  });

  it("keeps the list and the verification it had when pinned under a new nick", () => {
    const a = me("alice");
    const bob = peerWith(2);
    knownPeer(a, "bob", bob, 3);
    engineOf(a).verify("bob", keyOf(bob.master));

    expect(trust(engineOf(a)).checkMaster("bobby", keyOf(bob.master), noResult())).toBe("ok");

    expect(a.state.pins).toEqual({ bob: keyOf(bob.master), bobby: keyOf(bob.master) });
    expect(engineOf(a).pinned("bobby")).toEqual({
      master: keyOf(bob.master),
      verified: true,
      devices: 2,
    });
    expect(a.state.masters[keyOf(bob.master)]).toMatchObject({ nick: "bob", ver: 3 });
  });
});

describe("lists (trust rule 3) and revocation (rule 5)", () => {
  it("replaces the stored list with a higher ver", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [one, two] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    pinnedTo(a, "bob", M);

    trust(engineOf(a)).applyList(M, listOf(1, [one]));
    expect(a.state.masters[M]).toMatchObject({ ver: 1, devices: [keyOf(one)] });

    trust(engineOf(a)).applyList(M, listOf(2, [one, two]));
    expect(a.state.masters[M]).toMatchObject({ ...listOf(2, [one, two]), revoked: [] });
  });

  it("changes nothing for an equal ver with the same keys", () => {
    const a = me("alice");
    const bob = peerWith(2);
    knownPeer(a, "bob", bob, 2);
    const before = structuredClone(a.state);

    trust(engineOf(a)).applyList(keyOf(bob.master), listOf(2, bob.devices));

    expect(a.state).toEqual(before);
  });

  it("ignores an equal ver with other keys: only the master could have made it", () => {
    const a = me("alice");
    const bob = peerWith(2);
    knownPeer(a, "bob", bob, 2);
    const before = structuredClone(a.state);

    trust(engineOf(a)).applyList(keyOf(bob.master), listOf(2, [bob.devices[0] as Account]));

    expect(a.state).toEqual(before);
  });

  it("ignores a lower ver as stale", () => {
    const a = me("alice");
    const bob = peerWith(2);
    knownPeer(a, "bob", bob, 2);
    const before = structuredClone(a.state);

    trust(engineOf(a)).applyList(keyOf(bob.master), listOf(1, [bob.devices[0] as Account]));

    expect(a.state).toEqual(before);
  });

  it("revokes a key a newer list leaves out, with its curve, and drops its sessions", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [gone, kept] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    knownPeer(a, "bob", bob, 1);
    const keptSessions = a.state.sessions[kept.curve25519_key()];

    trust(engineOf(a)).applyList(M, listOf(2, [kept]));

    expect(a.state.masters[M]).toMatchObject({
      ...listOf(2, [kept]),
      revoked: [keyOf(gone)],
      revokedCurves: [gone.curve25519_key()],
    });
    expect(a.state.sessions[gone.curve25519_key()]).toBeUndefined();
    expect(a.state.sessions[kept.curve25519_key()]).toEqual(keptSessions);
    expect(
      trust(engineOf(a))
        .trustedDevices(M)
        .map((d) => d.ed25519),
    ).toEqual([keyOf(kept)]);
  });

  it("no longer holds a key revoked once a still newer list names it again", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [back, kept] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    knownPeer(a, "bob", bob, 1);
    trust(engineOf(a)).applyList(M, listOf(2, [kept]));

    trust(engineOf(a)).applyList(M, listOf(3, [back, kept]));

    expect(a.state.masters[M]).toMatchObject({
      ...listOf(3, [back, kept]),
      revoked: [],
      revokedCurves: [],
    });
    expect(engineOf(a).pinned("bob")?.devices).toBe(2);
  });

  it("never drops the sessions of a device bound under another master, whatever a list names", () => {
    const a = me("alice");
    const carol = peerWith(1);
    const mallory = peerWith(1);
    const [carolsDevice] = carol.devices as [Account];
    const [mallorysDevice] = mallory.devices as [Account];
    knownPeer(a, "carol", carol, 1);
    const M = keyOf(mallory.master);
    pinnedTo(a, "mallory", M);
    trust(engineOf(a)).applyList(M, listOf(1, [carolsDevice, mallorysDevice]));
    const sessions = structuredClone(a.state.sessions);

    trust(engineOf(a)).applyList(M, listOf(2, [mallorysDevice]));

    expect(a.state.masters[M]).toMatchObject({ revoked: [keyOf(carolsDevice)], revokedCurves: [] });
    expect(a.state.sessions).toEqual(sessions);
    expect(engineOf(a).pinned("carol")?.devices).toBe(1);
  });
});

describe("trusted devices (trust rule 4)", () => {
  it("trusts the bound devices its master lists, and no other", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [listed, unlisted] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    pinnedTo(a, "bob", M);
    trust(engineOf(a)).applyList(M, listOf(1, [listed]));
    bind(a, bob.master, listed);
    bind(a, bob.master, unlisted);

    expect(
      trust(engineOf(a))
        .trustedDevices(M)
        .map((d) => d.ed25519),
    ).toEqual([keyOf(listed)]);
    expect(engineOf(a).pinned("bob")?.devices).toBe(1);
  });

  it("gives a master that lists another master's device nothing of it", () => {
    const a = me("alice");
    const carol = peerWith(1);
    const mallory = peerWith(1);
    const [carolsDevice] = carol.devices as [Account];
    knownPeer(a, "carol", carol, 1);
    const M = keyOf(mallory.master);
    pinnedTo(a, "mallory", M);

    trust(engineOf(a)).applyList(M, listOf(1, [carolsDevice]));

    expect(trust(engineOf(a)).trustedDevices(M)).toEqual([]);
    expect(engineOf(a).pinned("mallory")?.devices).toBe(0);
    expect(engineOf(a).pinned("carol")?.devices).toBe(1);
  });

  it("trusts a presented device its master lists, its S1 covering that master", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    const M = keyOf(bob.master);
    pinnedTo(a, "bob", M);
    trust(engineOf(a)).applyList(M, listOf(1, [device]));

    expect(trust(engineOf(a)).refusal(M, idBlock(device, M))).toBeUndefined();
  });

  it("refuses an id block whose S1 covers another master, though this master lists the key", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    const M = keyOf(bob.master);
    pinnedTo(a, "bob", M);
    trust(engineOf(a)).applyList(M, listOf(1, [device]));

    expect(trust(engineOf(a)).refusal(M, idBlock(device, keyOf(peerWith(1).master)))).toBe(
      "bad-identity-signature",
    );
  });

  it("refuses a revoked device as revoked, its S1 still good", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [gone, kept] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    knownPeer(a, "bob", bob, 1);
    trust(engineOf(a)).applyList(M, listOf(2, [kept]));

    expect(trust(engineOf(a)).refusal(M, idBlock(gone, M))).toBe("revoked-device");
  });

  it("refuses a device its master does not list, unless a certificate names a list version above the stored one", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [listed, unlisted] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    pinnedTo(a, "bob", M);
    trust(engineOf(a)).applyList(M, listOf(2, [listed]));
    // The version of a certificate whose signature the caller verified (PKMSG check 3); null: none.
    const standing = (certVer: number | null) =>
      trust(engineOf(a)).standing(M, keyOf(unlisted), certVer);

    // A KEYS entry carries no certificate.
    expect(trust(engineOf(a)).refusal(M, idBlock(unlisted, M))).toBe("unlisted-device");
    expect(standing(null)).toBe("unlisted-device");
    expect(standing(1)).toBe("stale-certificate");
    expect(standing(2)).toBe("stale-certificate");
    expect(standing(3)).toBeUndefined();
  });

  it("trusts a bound device its list leaves out while its certificate names a version above the stored list, and drops its sessions at a list of that version", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [listed, certified] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    pinnedTo(a, "bob", M);
    trust(engineOf(a)).applyList(M, listOf(1, [listed]));
    bind(a, bob.master, listed);
    const pickle = bind(a, bob.master, certified);
    // As a pre-key message on a certificate at version 3 binds it.
    (a.state.devices[keyOf(certified)] as PeerDevice).certVer = 3;
    const trusted = () =>
      trust(engineOf(a))
        .trustedDevices(M)
        .map((d) => d.ed25519);
    const both = [keyOf(listed), keyOf(certified)];

    expect(trusted()).toEqual(both);
    // A list below the certificate's version predates the device.
    trust(engineOf(a)).applyList(M, listOf(2, [listed]));
    expect(trusted()).toEqual(both);
    expect(a.state.sessions[certified.curve25519_key()]).toEqual([pickle]);

    // A list at the certificate's version that leaves the device out is its master's word on it.
    trust(engineOf(a)).applyList(M, listOf(3, [listed]));
    expect(trusted()).toEqual([keyOf(listed)]);
    expect(a.state.sessions[certified.curve25519_key()]).toBeUndefined();
    expect(a.state.sessions[listed.curve25519_key()]).toHaveLength(1);
    // Read off the versions, never stored as a verdict: a list naming it trusts it again.
    expect(a.state.masters[M]).toMatchObject({ revoked: [], revokedCurves: [] });
    trust(engineOf(a)).applyList(M, listOf(4, [listed, certified]));
    expect(trusted()).toEqual(both);
  });
});

// --- wire v2: KEYS, and one message to every trusted device -----------------
//
// Our engine through the fake grappa v2 (`helpers/e2eGrappa.ts`): its send
// door refuses what grappa's refuses (addresses, priorities, deadlines, size),
// and it answers a KEYREQ as `E2eKeys.answer/3` does, from what each listed
// device uploaded. A peer's devices are real accounts: each one reads its own
// body of what grappa routed to it, decrypted on its own account, and "the
// device answered" is a real answer decrypted on our session to it. A KEYS
// grappa would never build (forged, or claiming curves) is handed to the
// engine directly.

/**
 * The session each peer device holds with us: opened by our first pre-key
 * message to it, or by its own first one to us (`written`).
 */
const inbound = new Map<Account, string>();

const didOf = (account: Account): string => did(olm(), keyOf(account));

const eventsOf = <K extends E2eEvent["kind"]>(side: Me, kind: K) =>
  side.events.filter((e): e is Extract<E2eEvent, { kind: K }> => e.kind === kind);
const failedOf = (side: Me) => eventsOf(side, "send_failed").map((e) => [e.reason, e.tags]);
const dropsOf = (side: Me) => eventsOf(side, "dropped").map((e) => e.reason);

/** `res`, its events kept on `side`. */
function record(side: Me, res: Result): Result {
  side.events.push(...res.events);
  return res;
}

/** `side`'s device on grappa: registered under its nick, and listed by its master. */
async function joined(g: Grappa, side: Me): Promise<void> {
  await enlist(g, side.nick, side.master, [side.account], side.own.list);
}

/**
 * `peer` on grappa under `nick`: every device registered and listed at `ver`;
 * those in `keyed` upload their key bundle (`uploadKeys`).
 */
async function enrolled(
  g: Grappa,
  nick: string,
  peer: PeerIdentity,
  ver: number,
  keyed: Account[],
): Promise<void> {
  await enlist(g, nick, peer.master, peer.devices, signedList(peer.master, ver, peer.devices));
  for (const device of keyed) await uploadKeys(g, nick, device);
}

/**
 * What `side`'s engine produced goes through its device's send door, and
 * each msgid grappa names goes back to the engine (`throughDoor`). Answers
 * the msgids, in order.
 */
async function toDoor(g: Grappa, side: Me, res: Result): Promise<string[]> {
  record(side, res);
  return throughDoor(g, side.nick, side.own.did, res.outbound, (ref, msgid) =>
    engineOf(side).sent(ref, msgid),
  );
}

/** What grappa holds for `nick`'s device `deviceDid`, taken off its queue. */
async function drain(g: Grappa, nick: string, deviceDid: string): Promise<DeviceMessage[]> {
  const door = g.door(nick, deviceDid);
  const messages = await door.inbox(0);
  if (messages.length > 0) await door.ack(messages.map((m) => m.id));
  return messages;
}

/** `side`'s engine takes what grappa delivered to its device (the KEYS a KEYREQ brought). */
async function pump(g: Grappa, side: Me): Promise<void> {
  for (const m of await drain(g, side.nick, side.own.did)) {
    await toDoor(g, side, engineOf(side).receive(m.from, m.verb, m.msgid, m.fromDid, m.payload));
  }
}

/** `side` sends `body` to `nick` as text, tagged with it, and takes the KEYS a KEYREQ brings. */
async function say(g: Grappa, side: Me, nick: string, body: string): Promise<void> {
  await toDoor(g, side, engineOf(side).send(nick, { t: "text", body }, body, null, null));
  await pump(g, side);
}

const text = (body: string) => ({ t: "text", body });

/** `text(body)` as `side`'s engine writes it: with the version of its own list. */
const ours = (side: Me, body: string) => ({ ...text(body), lv: side.own.list.ver });

/** The bodies of a PKMSG or MSG payload, by did. */
const bodiesOf = (payload: string): Record<string, string> =>
  decodePayload(payload).bodies as Record<string, string>;

/**
 * `device`'s own body of a PKMSG or MSG payload, decrypted on its account: the
 * inner message. A pre-key message of a session it does not hold opens it.
 */
function opened(device: Account, verb: ReceiveVerb, payload: string): Record<string, unknown> {
  const mine = bodiesOf(payload)[didOf(device)];
  if (mine === undefined) throw new Error("no body for this device");
  const body = unbase64(mine);
  const held = inbound.get(device);
  let plaintext: Uint8Array;
  if (
    verb === "pkmsg" &&
    (held === undefined || sessionIdOf(held) !== olm().pre_key_session_id(body))
  ) {
    const sender = (decodePayload(payload).id as IdBlock).curve25519;
    const created = device.create_inbound_session(sender, body);
    const session = created.take_session();
    plaintext = created.plaintext();
    created.free();
    if (session === undefined) throw new Error("no inbound session");
    inbound.set(device, session.pickle());
    session.free();
  } else {
    const session = olm().Session.from_pickle(held ?? "");
    plaintext = session.decrypt(verb === "pkmsg" ? 0 : 1, body);
    inbound.set(device, session.pickle());
    session.free();
  }
  return JSON.parse(new TextDecoder().decode(plaintext)) as Record<string, unknown>;
}

/** What `device` of `nick` reads of what grappa holds for it: each message's verb and inner message. */
async function read(
  g: Grappa,
  nick: string,
  device: Account,
): Promise<{ verb: ReceiveVerb; inner: Record<string, unknown> }[]> {
  return (await drain(g, nick, didOf(device))).map((m) => ({
    verb: m.verb,
    inner: opened(device, m.verb, m.payload),
  }));
}

/**
 * `device` answers on the session it holds with `side`, and `side`'s session
 * to it decrypts the answer, as a receive does: that session has heard from
 * the device now, and writes it normal messages.
 */
function answers(side: Me, device: Account): void {
  const theirs = olm().Session.from_pickle(inbound.get(device) ?? "");
  const answer = theirs.encrypt(new TextEncoder().encode('{"t":"text","body":"hi"}'));
  inbound.set(device, theirs.pickle());
  theirs.free();
  const pickles = side.state.sessions[device.curve25519_key()] ?? [];
  const ours = olm().Session.from_pickle(pickles[0] ?? "");
  ours.decrypt(answer.message_type, answer.body);
  pickles[0] = ours.pickle();
  ours.free();
  answer.free();
}

/** A new one-time key of `device`, signed by `signer` (the device itself, unless forged). */
function oneTimeKey(device: Account, signer: Account): SignedKey {
  device.generate_one_time_keys(1);
  const keys = device.one_time_keys();
  const key = keys[keys.length - 1];
  if (key === undefined) throw new Error("no one-time key");
  return { key, sig: signer.sign(`${OTK_SIG_PREFIX}${key}`) };
}

/** `device`'s KEYS entry under `master`: its id block, and a new one-time key it signed. */
function entryOf(device: Account, master: Account): KeysEntry {
  return {
    id: idBlock(device, keyOf(master)),
    otk: { ...oneTimeKey(device, device), fallback: false },
  };
}

/** An entry of `device` claiming `curve25519`, its S1 over that curve and `master`. */
function claiming(device: Account, master: Account, curve25519: string, otk: SignedKey): KeysEntry {
  const id = {
    curve25519,
    ed25519: keyOf(device),
    sig: device.sign(`${ID_SIG_PREFIX}${curve25519}:${keyOf(master)}`),
  };
  return { id, otk: { ...otk, fallback: false } };
}

/** `peer`'s master block, its list naming `listed` at `ver`: what a KEYS and a `t:list` carry. */
function masterBlock(peer: PeerIdentity, ver: number, listed: Account[]): MasterList {
  const list = listOf(ver, listed);
  return {
    ed25519: keyOf(peer.master),
    list,
    sig: peer.master.sign(listSigText(list.ver, list.devices)),
  };
}

/** A KEYS from `peer`'s master, its list naming `listed` at `ver`, with `entries`. */
function keysPayload(
  peer: PeerIdentity,
  ver: number,
  listed: Account[],
  entries: KeysEntry[],
): string {
  return encodePayload({ v: 2, master: masterBlock(peer, ver, listed), devices: entries });
}

/** `side` sends `body` to `nick` (it waits for keys), then takes `keys` as the answer. */
function keysAfter(side: Me, nick: string, body: string, keys: string): Result {
  record(side, engineOf(side).send(nick, text(body), body, null, null));
  return record(side, engineOf(side).receive(nick, "keys", newMsgid(), "*", keys));
}

/** The session id of `side`'s newest session to `device`. */
const sessionTo = (side: Me, device: Account): string =>
  sessionIdOf(side.state.sessions[device.curve25519_key()]?.[0]);

describe("a KEYS (W receiver checks, in order)", () => {
  it("drops a KEYS nobody asked for, before reading any of it, and stores nothing", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const valid = keysPayload(bob, 1, bob.devices, [
      entryOf(bob.devices[0] as Account, bob.master),
    ]);

    record(a, engineOf(a).receive("Bob", "keys", newMsgid(), "*", valid));
    record(a, engineOf(a).receive("Bob", "keys", newMsgid(), "*", encodePayload({ v: 2 })));

    expect(dropsOf(a)).toEqual(["unsolicited-keys", "unsolicited-keys"]);
    expect(a.state).toEqual(newState());
  });

  it("drops a second KEYS for one KEYREQ: the first one answered it", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    keysAfter(a, "bob", "hello", keysPayload(bob, 1, [device], [entryOf(device, bob.master)]));
    expect(a.state.keysAwaited).toEqual({});
    const sessions = structuredClone(a.state.sessions);

    record(
      a,
      engineOf(a).receive(
        "bob",
        "keys",
        newMsgid(),
        "*",
        keysPayload(bob, 1, [device], [entryOf(device, bob.master)]),
      ),
    );

    expect(dropsOf(a)).toEqual(["unsolicited-keys"]);
    expect(a.state.sessions).toEqual(sessions);
  });

  it("drops a KEYS of more than 4 entries as malformed, and keeps waiting for keys", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    const five = Array.from({ length: 5 }, () => entryOf(device, bob.master));

    const res = keysAfter(a, "bob", "hello", keysPayload(bob, 1, [device], five));

    expect(res.outbound).toEqual([]);
    expect(dropsOf(a)).toEqual(["bad-payload"]);
    expect(a.state.pins).toEqual({});
    expect(a.state.outq.bob).toHaveLength(1);
    expect(a.state.keysAwaited).toEqual({ bob: true });
  });

  it("drops a KEYS whose list its master did not sign, pins nothing, and keeps waiting for keys", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    const forged = edited(keysPayload(bob, 1, [device], [entryOf(device, bob.master)]), (json) => {
      (json.master as Record<string, unknown>).sig = bob.master.sign(
        listSigText(2, [keyOf(device)]),
      );
    });

    const res = keysAfter(a, "bob", "hello", forged);

    expect(res.outbound).toEqual([]);
    expect(dropsOf(a)).toEqual(["bad-list"]);
    expect(a.state.pins).toEqual({});
    expect(a.state.masters).toEqual({});
    expect(a.state.devices).toEqual({});
    expect(a.state.outq.bob).toHaveLength(1);
    // Still waiting: the message is reported once it waited too long.
    a.now += OUTQ_TTL_MS;
    record(a, engineOf(a).tick());
    expect(failedOf(a)).toEqual([["keys-timeout", ["hello"]]]);
  });

  it("raises the alarm for another master on a pinned nick: nothing is opened, and what waited fails", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const other = peerWith(1);
    const [stranger] = other.devices as [Account];
    pinnedTo(a, "bob", keyOf(bob.master));

    const res = keysAfter(
      a,
      "Bob",
      "hello",
      keysPayload(other, 1, [stranger], [entryOf(stranger, other.master)]),
    );

    expect(res.outbound).toEqual([]);
    expect(eventsOf(a, "key_alarm")).toEqual([
      { kind: "key_alarm", nick: "Bob", pinned: keyOf(bob.master), presented: keyOf(other.master) },
    ]);
    expect(failedOf(a)).toEqual([["key-mismatch", ["hello"]]]);
    expect(a.state.pins).toEqual({ bob: keyOf(bob.master) });
    expect(Object.keys(a.state.masters)).toEqual([keyOf(bob.master)]);
    expect(a.state.devices).toEqual({});
    expect(a.state.sessions).toEqual({});
    expect(a.state.outq).toEqual({});
    expect(a.state.keysAwaited).toEqual({});
  });

  it("refuses a KEYS of our own master: no pin, nothing opened, and what waited fails", () => {
    const a = me("mallory");
    const ours = encodePayload({
      v: 2,
      master: {
        ed25519: a.own.master,
        list: { ver: a.own.list.ver, devices: a.own.list.devices },
        sig: a.own.list.sig,
      },
      devices: [
        {
          id: idBlock(a.account, a.own.master),
          otk: { ...oneTimeKey(a.account, a.account), fallback: false },
        },
      ],
    });

    const res = keysAfter(a, "alice", "hello", ours);

    expect(res.outbound).toEqual([]);
    expect(dropsOf(a)).toEqual(["own-identity"]);
    expect(failedOf(a)).toEqual([["key-mismatch", ["hello"]]]);
    expect(a.state.pins).toEqual({});
    expect(a.state.masters).toEqual({});
    expect(a.state.devices).toEqual({});
    expect(a.state.sessions).toEqual({});
  });

  it("applies its list before its entries: a device it adds is reached, one it drops is revoked", () => {
    const a = me("alice");
    const bob = peerWith(3);
    const [gone, kept, added] = bob.devices as [Account, Account, Account];
    const M = keyOf(bob.master);
    pinnedTo(a, "bob", M);
    trust(engineOf(a)).applyList(M, listOf(1, [gone, kept]));

    const res = keysAfter(
      a,
      "bob",
      "hello",
      keysPayload(
        bob,
        2,
        [kept, added],
        [gone, kept, added].map((d) => entryOf(d, bob.master)),
      ),
    );

    expect(dropsOf(a)).toEqual(["revoked-device"]);
    expect(a.state.masters[M]).toMatchObject({
      ...listOf(2, [kept, added]),
      revoked: [keyOf(gone)],
    });
    expect(Object.keys(a.state.devices).sort()).toEqual([keyOf(kept), keyOf(added)].sort());
    expect(res.outbound.map((o) => [o.verb, o.to])).toEqual([["pkmsg", "*"]]);
    expect(Object.keys(bodiesOf(res.outbound[0]?.payload ?? "")).sort()).toEqual(
      [didOf(kept), didOf(added)].sort(),
    );
  });

  it("skips an entry whose id block its device did not sign for this master, and reaches the others", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [liar, honest] = bob.devices as [Account, Account];
    const elsewhere = {
      id: idBlock(liar, keyOf(peerWith(1).master)),
      otk: { ...oneTimeKey(liar, liar), fallback: false },
    };

    const res = keysAfter(
      a,
      "bob",
      "hello",
      keysPayload(bob, 1, [liar, honest], [elsewhere, entryOf(honest, bob.master)]),
    );

    expect(dropsOf(a)).toEqual(["bad-identity-signature"]);
    expect(Object.keys(a.state.devices)).toEqual([keyOf(honest)]);
    expect(res.outbound.map((o) => [o.verb, o.to])).toEqual([["pkmsg", didOf(honest)]]);
  });

  it("skips an entry whose one-time key its device did not sign, and reaches the others", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [liar, honest] = bob.devices as [Account, Account];
    const forged = {
      id: idBlock(liar, keyOf(bob.master)),
      otk: { ...oneTimeKey(liar, honest), fallback: false },
    };

    const res = keysAfter(
      a,
      "bob",
      "hello",
      keysPayload(bob, 1, [liar, honest], [forged, entryOf(honest, bob.master)]),
    );

    expect(dropsOf(a)).toEqual(["bad-otk-signature"]);
    expect(Object.keys(a.state.devices)).toEqual([keyOf(honest)]);
    expect(res.outbound.map((o) => [o.verb, o.to])).toEqual([["pkmsg", didOf(honest)]]);
  });

  it("skips an entry of a device the stored list does not name, and reaches the listed one", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [listed, unlisted] = bob.devices as [Account, Account];

    const res = keysAfter(
      a,
      "bob",
      "hello",
      keysPayload(bob, 1, [listed], [entryOf(unlisted, bob.master), entryOf(listed, bob.master)]),
    );

    expect(dropsOf(a)).toEqual(["unlisted-device"]);
    expect(Object.keys(a.state.devices)).toEqual([keyOf(listed)]);
    expect(res.outbound.map((o) => [o.verb, o.to])).toEqual([["pkmsg", didOf(listed)]]);
  });

  it("takes only the first entry of a device: a later one never stands in for it", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    const forged = {
      id: idBlock(device, keyOf(bob.master)),
      otk: { ...oneTimeKey(device, bob.master), fallback: false },
    };

    const res = keysAfter(
      a,
      "bob",
      "hello",
      keysPayload(bob, 1, [device], [forged, entryOf(device, bob.master)]),
    );

    expect(res.outbound).toEqual([]);
    expect(dropsOf(a)).toEqual(["bad-otk-signature"]);
    expect(a.state.devices).toEqual({});
    expect(a.state.sessions).toEqual({});
    expect(a.state.outq.bob).toHaveLength(1);
  });

  it("skips an entry whose one-time key vodozemac cannot read, and reaches the others", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [broken, fine] = bob.devices as [Account, Account];
    const unreadable = {
      id: idBlock(broken, keyOf(bob.master)),
      otk: {
        key: KEY_OF_33_BYTES,
        fallback: false,
        sig: broken.sign(`${OTK_SIG_PREFIX}${KEY_OF_33_BYTES}`),
      },
    };

    const res = keysAfter(
      a,
      "bob",
      "hello",
      keysPayload(bob, 1, [broken, fine], [unreadable, entryOf(fine, bob.master)]),
    );

    expect(eventsOf(a, "dropped")).toEqual([
      {
        kind: "dropped",
        nick: "bob",
        reason: "bad-payload",
        verb: "keys",
        detail: expect.any(String),
      },
    ]);
    expect(Object.keys(a.state.devices)).toEqual([keyOf(fine)]);
    expect(res.outbound.map((o) => [o.verb, o.to])).toEqual([["pkmsg", didOf(fine)]]);
  });

  it("opens a session only to a device without one, and never holds the other back", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [writing, silent] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    pinnedTo(a, "bob", M);
    trust(engineOf(a)).applyList(M, listOf(1, [writing, silent]));
    bind(a, bob.master, writing);
    const before = sessionTo(a, writing);

    // A message for the silent device alone waits for its keys; text sent
    // meanwhile goes to the device with a session at once, and waits for the
    // silent one, under the same KEYREQ.
    const first = record(a, engineOf(a).send("bob", text("one"), "one", null, keyOf(silent)));
    const second = record(a, engineOf(a).send("bob", text("two"), "two", null, null));
    expect(first.outbound.map((o) => o.verb)).toEqual(["keyreq"]);
    expect(second.outbound.map((o) => [o.tag, o.verb, o.to])).toEqual([
      ["two", "pkmsg", didOf(writing)],
    ]);
    expect(opened(writing, "pkmsg", second.outbound[0]?.payload ?? "").body).toBe("two");
    expect(eventsOf(a, "send_queued").map((e) => e.tag)).toEqual(["one"]);

    const res = record(
      a,
      engineOf(a).receive(
        "bob",
        "keys",
        newMsgid(),
        "*",
        keysPayload(
          bob,
          1,
          [writing, silent],
          [entryOf(writing, bob.master), entryOf(silent, bob.master)],
        ),
      ),
    );

    expect(a.state.sessions[writing.curve25519_key()]).toHaveLength(1);
    expect(sessionTo(a, writing)).toBe(before);
    expect(a.state.sessions[silent.curve25519_key()]).toHaveLength(1);
    // In order, each to the silent device alone: nothing goes twice to the other.
    expect(res.outbound.map((o) => [o.tag, o.verb, o.to])).toEqual([
      ["one", "pkmsg", didOf(silent)],
      ["two", "pkmsg", didOf(silent)],
    ]);
    const [one, two] = res.outbound as [Outbound, Outbound];
    expect(opened(silent, "pkmsg", one.payload).body).toBe("one");
    expect(opened(silent, "pkmsg", two.payload).body).toBe("two");
    expect(a.state.outq).toEqual({});
    expect(a.state.keysAwaited).toEqual({});
  });

  it("keeps a device's proof when a KEYS opens a new session to it", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    knownPeer(a, "bob", bob, 1);
    (a.state.devices[keyOf(device)] as PeerDevice).proven = true;
    delete a.state.sessions[device.curve25519_key()];

    keysAfter(a, "bob", "hello", keysPayload(bob, 1, [device], [entryOf(device, bob.master)]));

    expect(a.state.devices[keyOf(device)]?.proven).toBe(true);
    expect(a.state.sessions[device.curve25519_key()]).toHaveLength(1);
  });
});

describe("curve rules on a KEYS entry (trust rule 4)", () => {
  it("refuses an entry claiming our own curve: nothing is bound, and no session goes to ourselves", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [liar, honest] = bob.devices as [Account, Account];
    const ours = a.account.curve25519_key();
    // Our own fallback key, handed back to us as the liar's one-time key.
    a.account.generate_fallback_key();
    const fallback = a.account.fallback_key() ?? "";
    const claim = claiming(liar, bob.master, ours, {
      key: fallback,
      sig: liar.sign(`${OTK_SIG_PREFIX}${fallback}`),
    });

    const res = keysAfter(
      a,
      "bob",
      "hello",
      keysPayload(bob, 1, [liar, honest], [claim, entryOf(honest, bob.master)]),
    );

    expect(dropsOf(a)).toEqual(["own-identity"]);
    expect(a.state.devices[keyOf(liar)]).toBeUndefined();
    expect(a.state.sessions[ours]).toBeUndefined();
    expect(res.outbound.map((o) => o.to)).toEqual([didOf(honest)]);
  });

  it("refuses our own curve in another spelling too: a padded copy never reaches a session", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [liar] = bob.devices as [Account];
    const padded = `${a.account.curve25519_key()}=`;
    a.account.generate_fallback_key();
    const fallback = a.account.fallback_key() ?? "";
    const claim = claiming(liar, bob.master, padded, {
      key: fallback,
      sig: liar.sign(`${OTK_SIG_PREFIX}${fallback}`),
    });

    const res = keysAfter(a, "bob", "hello", keysPayload(bob, 1, [liar], [claim]));

    expect(res.outbound).toEqual([]);
    expect(dropsOf(a)).toEqual(["non-canonical-key"]);
    expect(a.state.devices).toEqual({});
    expect(a.state.sessions).toEqual({});
  });

  it("refuses an entry claiming a curve bound to another device, whose sessions stay", () => {
    const a = me("alice");
    const carol = peerWith(1);
    const [holder] = carol.devices as [Account];
    knownPeer(a, "carol", carol, 1);
    const sessions = structuredClone(a.state.sessions);
    const bob = peerWith(2);
    const [liar, honest] = bob.devices as [Account, Account];
    const stolen = holder.curve25519_key();
    const claim = claiming(liar, bob.master, stolen, oneTimeKey(holder, liar));

    const res = keysAfter(
      a,
      "bob",
      "hello",
      keysPayload(bob, 1, [liar, honest], [claim, entryOf(honest, bob.master)]),
    );

    expect(dropsOf(a)).toEqual(["curve-already-bound"]);
    expect(a.state.devices[keyOf(liar)]).toBeUndefined();
    expect(a.state.devices[keyOf(holder)]?.master).toBe(keyOf(carol.master));
    expect(a.state.sessions[stolen]).toEqual(sessions[stolen]);
    expect(res.outbound.map((o) => o.to)).toEqual([didOf(honest)]);
  });

  it("refuses an entry that gives a bound device another curve, and the device keeps its own", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    knownPeer(a, "bob", bob, 1);
    delete a.state.sessions[device.curve25519_key()];
    const other = new (olm().Account)();
    const curve = other.curve25519_key();
    const claim = claiming(device, bob.master, curve, oneTimeKey(other, device));

    const res = keysAfter(a, "bob", "hello", keysPayload(bob, 1, [device], [claim]));

    expect(res.outbound).toEqual([]);
    expect(dropsOf(a)).toEqual(["identity-curve-mismatch"]);
    expect(a.state.devices[keyOf(device)]?.curve25519).toBe(device.curve25519_key());
    expect(a.state.sessions).toEqual({});
    expect(a.state.outq.bob).toHaveLength(1);
    other.free();
  });

  it("refuses an entry whose curve is not in vodozemac's one spelling: a padded key binds nothing", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [padder, honest] = bob.devices as [Account, Account];
    const claim = claiming(
      padder,
      bob.master,
      `${padder.curve25519_key()}=`,
      oneTimeKey(padder, padder),
    );

    const res = keysAfter(
      a,
      "bob",
      "hello",
      keysPayload(bob, 1, [padder, honest], [claim, entryOf(honest, bob.master)]),
    );

    expect(dropsOf(a)).toEqual(["non-canonical-key"]);
    expect(a.state.devices[keyOf(padder)]).toBeUndefined();
    expect(a.state.sessions[padder.curve25519_key()]).toBeUndefined();
    expect(res.outbound.map((o) => o.to)).toEqual([didOf(honest)]);
  });

  it("refuses an entry whose curve vodozemac cannot read, and reaches the others", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [broken, honest] = bob.devices as [Account, Account];
    const claim = claiming(broken, bob.master, KEY_OF_33_BYTES, oneTimeKey(broken, broken));

    const res = keysAfter(
      a,
      "bob",
      "hello",
      keysPayload(bob, 1, [broken, honest], [claim, entryOf(honest, bob.master)]),
    );

    expect(dropsOf(a)).toEqual(["non-canonical-key"]);
    expect(a.state.devices[keyOf(broken)]).toBeUndefined();
    expect(res.outbound.map((o) => o.to)).toEqual([didOf(honest)]);
  });

  it("takes device keys only in vodozemac's one spelling", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    const id = idBlock(device, keyOf(bob.master));
    const rules = trust(engineOf(a));

    expect(rules.curveRefusal(id, false)).toBeUndefined();
    expect(rules.curveRefusal({ ...id, ed25519: `${id.ed25519}=` }, false)).toBe(
      "non-canonical-key",
    );
    expect(rules.curveRefusal({ ...id, ed25519: KEY_OF_33_BYTES }, false)).toBe(
      "non-canonical-key",
    );
    expect(rules.curveRefusal({ ...id, curve25519: `${id.curve25519}=` }, false)).toBe(
      "non-canonical-key",
    );
  });

  it("lets only a pre-key message take a curve another device claimed, never one a pre-key message proved", () => {
    const a = me("alice");
    const carol = peerWith(1);
    const [holder] = carol.devices as [Account];
    knownPeer(a, "carol", carol, 1);
    const bob = peerWith(1);
    const [claimant] = bob.devices as [Account];
    const claim = claiming(
      claimant,
      bob.master,
      holder.curve25519_key(),
      oneTimeKey(holder, claimant),
    );
    const rules = trust(engineOf(a));

    // Its holder's own id block again is no claim on another's curve.
    expect(rules.curveRefusal(idBlock(holder, keyOf(carol.master)), false)).toBeUndefined();
    expect(rules.curveRefusal(claim.id, false)).toBe("curve-already-bound");
    expect(rules.curveRefusal(claim.id, true)).toBeUndefined();
    (a.state.devices[keyOf(holder)] as PeerDevice).proven = true;
    expect(rules.curveRefusal(claim.id, true)).toBe("curve-already-bound");
  });
});

describe("sending to every trusted device", () => {
  it("asks for keys once, then sends one PKMSG to * with a body for each device, bound to it by fb", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(2);
    const [d1, d2] = bob.devices as [Account, Account];
    await enrolled(g, "Bob", bob, 1, bob.devices);

    const res = engineOf(a).send("bob", text("hello"), "hello", null, null);

    expect(res).toEqual({
      events: [{ kind: "send_queued", nick: "bob", queued: 1, tag: "hello" }],
      outbound: [
        {
          target: "bob",
          verb: "keyreq",
          from: a.own.did,
          to: "*",
          payload: encodePayload({ v: 2 }),
          priority: "control",
        },
      ],
    });
    await toDoor(g, a, res);
    await pump(g, a);

    const [pkmsg, ...more] = g.sends.filter((s) => s.verb !== "keyreq");
    expect(more).toEqual([]);
    expect(pkmsg).toMatchObject({
      by: "alice",
      target: "bob",
      verb: "pkmsg",
      from: a.own.did,
      to: "*",
      priority: "text",
    });
    expect(decodePayload(pkmsg?.payload ?? "")).toEqual({
      v: 2,
      id: idBlock(a.account, a.own.master),
      master: { ed25519: a.own.master, cert: a.own.cert, ver: 1 },
      bodies: { [didOf(d1)]: expect.any(String), [didOf(d2)]: expect.any(String) },
    });
    for (const device of [d1, d2]) {
      expect(await read(g, "Bob", device)).toEqual([
        {
          verb: "pkmsg",
          inner: { ...ours(a, "hello"), fb: fb(olm(), keyOf(a.account), keyOf(device)) },
        },
      ]);
    }
    // The KEYS pinned bob's master on first use, with its list.
    expect(engineOf(a).pinned("bob")).toEqual({
      master: keyOf(bob.master),
      verified: false,
      devices: 2,
    });
    expect(a.state.keysAwaited).toEqual({});
    expect(a.state.outq).toEqual({});
    expect(failedOf(a)).toEqual([]);
    // What a NACK is held against: the msgid, and each device it covered with its session.
    expect(a.state.sent).toEqual([
      {
        ref: expect.any(String),
        msgid: pkmsg?.msgid,
        nick: "bob",
        master: keyOf(bob.master),
        devices: {
          [didOf(d1)]: { ed25519: keyOf(d1), sessionId: sessionTo(a, d1) },
          [didOf(d2)]: { ed25519: keyOf(d2), sessionId: sessionTo(a, d2) },
        },
        msg: expect.objectContaining({ tag: "hello", sends: 1 }),
        at: NOW,
      },
    ]);
  });

  it("sends what waited for keys in order, each a PKMSG on one session per device", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(2);
    await enrolled(g, "Bob", bob, 1, bob.devices);
    const engine = engineOf(a);

    const one = engine.send("bob", text("one"), "one", null, null);
    const two = engine.send("bob", text("two"), "two", null, null);
    expect(one.outbound.map((o) => o.verb)).toEqual(["keyreq"]);
    expect(two.outbound).toEqual([]);
    await toDoor(g, a, one);
    await toDoor(g, a, two);
    await pump(g, a);

    expect(g.sends.filter((s) => s.verb !== "keyreq").map((s) => [s.verb, s.to])).toEqual([
      ["pkmsg", "*"],
      ["pkmsg", "*"],
    ]);
    for (const device of bob.devices) {
      expect((await read(g, "Bob", device)).map((r) => r.inner.body)).toEqual(["one", "two"]);
    }
    expect(Object.values(a.state.sessions).map((pickles) => pickles.length)).toEqual([1, 1]);
  });

  it("writes one MSG to * once every device has answered, with no fb in it", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(2);
    const [d1, d2] = bob.devices as [Account, Account];
    await enrolled(g, "Bob", bob, 1, bob.devices);
    await say(g, a, "bob", "hello");
    for (const device of bob.devices) {
      await read(g, "Bob", device);
      answers(a, device);
    }

    const res = engineOf(a).send("bob", text("again"), "again", null, null);

    expect(res.outbound.map((o) => [o.verb, o.to, o.priority])).toEqual([["msg", "*", "text"]]);
    expect(decodePayload(res.outbound[0]?.payload ?? "")).toEqual({
      v: 2,
      ck: a.account.curve25519_key(),
      bodies: { [didOf(d1)]: expect.any(String), [didOf(d2)]: expect.any(String) },
    });
    await toDoor(g, a, res);
    for (const device of bob.devices) {
      expect(await read(g, "Bob", device)).toEqual([{ verb: "msg", inner: ours(a, "again") }]);
    }
  });

  it("writes one MSG to the device that answered and one PKMSG to the one that has not, each to its did", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(2);
    const [answered, silent] = bob.devices as [Account, Account];
    await enrolled(g, "Bob", bob, 1, bob.devices);
    await say(g, a, "bob", "hello");
    await read(g, "Bob", answered);
    await read(g, "Bob", silent);
    answers(a, answered);

    const res = engineOf(a).send("bob", text("both"), "both", null, null);

    expect(res.outbound.map((o) => [o.verb, o.to])).toEqual([
      ["msg", didOf(answered)],
      ["pkmsg", didOf(silent)],
    ]);
    expect(res.outbound.map((o) => Object.keys(bodiesOf(o.payload)))).toEqual([
      [didOf(answered)],
      [didOf(silent)],
    ]);
    expect(new Set(res.outbound.map((o) => o.ref)).size).toBe(2);
    const msgids = await toDoor(g, a, res);
    expect(a.state.sent.slice(-2).map((s) => [s.msgid, s.devices])).toEqual([
      [
        msgids[0],
        { [didOf(answered)]: { ed25519: keyOf(answered), sessionId: sessionTo(a, answered) } },
      ],
      [msgids[1], { [didOf(silent)]: { ed25519: keyOf(silent), sessionId: sessionTo(a, silent) } }],
    ]);
    expect(await read(g, "Bob", answered)).toEqual([{ verb: "msg", inner: ours(a, "both") }]);
    expect(await read(g, "Bob", silent)).toEqual([
      {
        verb: "pkmsg",
        inner: { ...ours(a, "both"), fb: fb(olm(), keyOf(a.account), keyOf(silent)) },
      },
    ]);
  });

  it("reaches the devices a KEYS has keys for, fails nothing for a listed one it has none for, and lets its copies lapse unreported", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(2);
    const [keyed, keyless] = bob.devices as [Account, Account];
    await enrolled(g, "Bob", bob, 1, [keyed]);

    await say(g, a, "bob", "hello");

    expect(g.sends.filter((s) => s.verb === "pkmsg").map((s) => s.to)).toEqual([didOf(keyed)]);
    expect(failedOf(a)).toEqual([]);
    expect(a.state.keysAwaited).toEqual({});
    expect((await read(g, "Bob", keyed)).map((r) => r.inner.body)).toEqual(["hello"]);
    expect(await drain(g, "Bob", didOf(keyless))).toEqual([]);
    expect(engineOf(a).pinned("bob")?.devices).toBe(1);
    // The next message goes at once to the device it reaches (no KEYREQ: the
    // budget is spent), and a copy of each waits for the other device.
    const next = record(a, engineOf(a).send("bob", text("again"), "again", null, null));
    expect(next.outbound.map((o) => [o.verb, o.to])).toEqual([["pkmsg", didOf(keyed)]]);
    expect(a.state.outq.bob?.map((q) => [q.msg.tag, q.done])).toEqual([
      ["hello", [keyOf(keyed)]],
      ["again", [keyOf(keyed)]],
    ]);
    // Only first contact said "queued": it had reached no device then.
    expect(eventsOf(a, "send_queued").map((e) => e.tag)).toEqual(["hello"]);
    // Copies that reached a device lapse without a word.
    a.now += OUTQ_TTL_MS;
    record(a, engineOf(a).tick());
    expect(failedOf(a)).toEqual([]);
    expect(a.state.outq).toEqual({});
  });

  it("sends at once to the device with a session, asks keys for the one without, which then gets each message once", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(2);
    const [reached, late] = bob.devices as [Account, Account];
    await enrolled(g, "Bob", bob, 1, [reached]);
    await say(g, a, "bob", "hello");
    expect((await read(g, "Bob", reached)).map((r) => r.inner.body)).toEqual(["hello"]);
    await uploadKeys(g, "Bob", late);
    a.now += KEYREQ_RETRY_MS;

    const res = record(a, engineOf(a).send("bob", text("text"), "text", null, null));

    expect(res.outbound.map((o) => [o.verb, o.to])).toEqual([
      ["pkmsg", didOf(reached)],
      ["keyreq", "*"],
    ]);
    await toDoor(g, a, res);
    await pump(g, a);
    expect((await read(g, "Bob", late)).map((r) => r.inner.body)).toEqual(["hello", "text"]);
    expect((await read(g, "Bob", reached)).map((r) => r.inner.body)).toEqual(["text"]);
    expect(g.sends.filter((s) => s.verb === "pkmsg").map((s) => s.to)).toEqual([
      didOf(reached),
      didOf(reached),
      didOf(late),
      didOf(late),
    ]);
    expect(a.state.outq).toEqual({});
    expect(failedOf(a)).toEqual([]);
  });

  it("asks for keys at most once per nick in the retry interval, and a KEYS does not reset it", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [reached, late] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    pinnedTo(a, "bob", M);
    trust(engineOf(a)).applyList(M, listOf(1, [reached, late]));
    bind(a, bob.master, reached);
    const verbs = (res: Result) => res.outbound.map((o) => o.verb);

    expect(verbs(record(a, engineOf(a).send("bob", text("one"), "one", null, null)))).toEqual([
      "pkmsg",
      "keyreq",
    ]);
    // A KEYS still without the late device answers the KEYREQ, and the budget stands.
    record(
      a,
      engineOf(a).receive(
        "bob",
        "keys",
        newMsgid(),
        "*",
        keysPayload(bob, 1, [reached, late], [entryOf(reached, bob.master)]),
      ),
    );
    expect(a.state.keysAwaited).toEqual({});
    a.now += KEYREQ_RETRY_MS - 1;
    expect(verbs(record(a, engineOf(a).send("bob", text("two"), "two", null, null)))).toEqual([
      "pkmsg",
    ]);
    a.now += 1;
    expect(verbs(record(a, engineOf(a).send("bob", text("three"), "three", null, null)))).toEqual([
      "pkmsg",
      "keyreq",
    ]);
  });

  it("refuses a message meant for a device its master does not list, at once or once the list comes", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const carol = peerWith(1);
    const [carols] = carol.devices as [Account];
    const stranger = new (olm().Account)();
    knownPeer(a, "bob", bob, 1);

    expect(engineOf(a).send("bob", text("x"), "now", null, keyOf(stranger))).toEqual({
      events: [{ kind: "send_failed", nick: "bob", reason: "unpinned-key", tags: ["now"] }],
      outbound: [],
    });
    // With no list yet it waits for the KEYS, whose list does not name it either.
    pinnedTo(a, "carol", keyOf(carol.master));
    record(a, engineOf(a).send("carol", text("y"), "later", null, keyOf(stranger)));
    const res = record(
      a,
      engineOf(a).receive(
        "carol",
        "keys",
        newMsgid(),
        "*",
        keysPayload(carol, 1, [carols], [entryOf(carols, carol.master)]),
      ),
    );

    expect(res.outbound).toEqual([]);
    expect(failedOf(a)).toEqual([["unpinned-key", ["later"]]]);
    expect(a.state.outq).toEqual({});
    stranger.free();
  });

  it("sends a message meant for one device to that device alone", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [other, target] = bob.devices as [Account, Account];
    knownPeer(a, "bob", bob, 1);
    const untouched = structuredClone(a.state.sessions[other.curve25519_key()]);

    const res = record(a, engineOf(a).send("bob", text("only you"), "only", null, keyOf(target)));

    expect(res.outbound.map((o) => [o.verb, o.to])).toEqual([["pkmsg", didOf(target)]]);
    expect(opened(target, "pkmsg", res.outbound[0]?.payload ?? "").body).toBe("only you");
    expect(a.state.sessions[other.curve25519_key()]).toEqual(untouched);
  });

  it("sends first contact to a master pinned by hand before it, verified as the user said", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(2);
    await enrolled(g, "Bob", bob, 1, bob.devices);
    await toDoor(g, a, engineOf(a).pin("bob", keyOf(bob.master), true));

    await say(g, a, "bob", "hello");

    expect(
      g.sends.filter((s) => s.verb !== "keyreq").map((s) => [s.verb, s.to, s.priority]),
    ).toEqual([
      ["pkmsg", "*", "reactive"],
      ["pkmsg", "*", "text"],
    ]);
    expect(engineOf(a).pinned("bob")).toEqual({
      master: keyOf(bob.master),
      verified: true,
      devices: 2,
    });
  });

  it("never sends what waited for one master to another the nick is re-pinned to, and writes to the new one after", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const old = peerWith(1);
    const fresh = peerWith(1);
    const [device] = fresh.devices as [Account];
    await enrolled(g, "bob", fresh, 1, fresh.devices);
    pinnedTo(a, "bob", keyOf(old.master));
    const waiting = engineOf(a).send("bob", text("for the old one"), "old", null, null);
    expect(engineOf(a).pin("bob", keyOf(fresh.master), true).outcome).toBe("pinned");

    await toDoor(g, a, waiting);
    await pump(g, a);

    expect(failedOf(a)).toEqual([["key-mismatch", ["old"]]]);
    expect(eventsOf(a, "key_alarm")).toEqual([]);
    expect(g.sends.filter((s) => s.verb === "pkmsg").map((s) => s.priority)).toEqual(["reactive"]);
    await say(g, a, "bob", "for the new one");
    expect((await read(g, "bob", device)).map((r) => [r.inner.t, r.inner.body])).toEqual([
      ["listreq", undefined],
      ["text", "for the new one"],
    ]);
  });

  it("goes on writing on its sessions after the state and the account round-trip through JSON", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    await enrolled(g, "Bob", bob, 1, bob.devices);
    await say(g, a, "bob", "hello");
    await read(g, "Bob", device);

    a.state = JSON.parse(JSON.stringify(a.state)) as E2eState;
    const pickle = a.account.pickle();
    a.account.free();
    a.account = olm().Account.from_pickle(pickle);
    await say(g, a, "bob", "after");

    expect((await read(g, "Bob", device)).map((r) => r.inner.body)).toEqual(["after"]);
    expect(Object.values(a.state.sessions).flat()).toHaveLength(1);
  });

  it("sends a chal or an ack as control, a list or a listreq as reactive, the rest as text; only an order's answer carries its deadline", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    await enrolled(g, "Bob", bob, 1, bob.devices);
    await say(g, a, "bob", "hello");
    await read(g, "Bob", device);
    answers(a, device);
    const sendOne = (inner: Record<string, unknown>, tag: string, expiresAt: number | null) =>
      engineOf(a).send("bob", inner, tag, expiresAt, null).outbound;

    const outs = [
      ...sendOne({ t: "chal", nonce: "n" }, "chal", null),
      ...sendOne({ t: "ack", nonce: "n" }, "ack", 1_700_000_015),
      ...sendOne({ t: "list" }, "t:list", null),
      ...sendOne({ t: "listreq", lv: 1 }, "t:listreq", null),
      ...sendOne({ t: "sas.start" }, "sas", null),
    ];

    expect(outs.map((o) => [o.tag, o.verb, o.priority, o.expiresAt])).toEqual([
      ["chal", "msg", "control", undefined],
      ["ack", "msg", "control", 1_700_000_015],
      ["t:list", "msg", "reactive", undefined],
      ["t:listreq", "msg", "reactive", undefined],
      ["sas", "msg", "text", undefined],
    ]);
    // grappa's door takes every one of them: a deadline only on a control message.
    await toDoor(g, a, { events: [], outbound: outs });
    expect((await read(g, "Bob", device)).map((r) => r.inner.t)).toEqual([
      "chal",
      "ack",
      "list",
      "listreq",
      "sas.start",
    ]);
  });

  it("refuses a message too long for 64 lines, as a PKMSG and as a MSG, and no session moves", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    await enrolled(g, "Bob", bob, 1, bob.devices);
    await say(g, a, "bob", "hello");
    await read(g, "Bob", device);
    const sent = a.state.sent.length;

    const preKey = structuredClone(a.state.sessions);
    const asPkmsg = engineOf(a).send("bob", text("x".repeat(20_000)), "long", null, null);
    expect(asPkmsg).toEqual({
      events: [{ kind: "send_failed", nick: "bob", reason: "too-long", tags: ["long"] }],
      outbound: [],
    });
    expect(a.state.sessions).toEqual(preKey);

    answers(a, device);
    const normal = structuredClone(a.state.sessions);
    const asMsg = engineOf(a).send("bob", text("x".repeat(20_000)), "longer", null, null);
    expect(asMsg).toEqual({
      events: [{ kind: "send_failed", nick: "bob", reason: "too-long", tags: ["longer"] }],
      outbound: [],
    });
    expect(a.state.sessions).toEqual(normal);
    expect(a.state.sent).toHaveLength(sent);

    // Unharmed: the next message reads on the device.
    await say(g, a, "bob", "y".repeat(5_000));
    expect((await read(g, "Bob", device)).map((r) => r.inner.body)).toEqual(["y".repeat(5_000)]);
  });

  it("refuses a message whose PKMSG is too long though its MSG fits: nothing goes, no session moves", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(2);
    const [answered, silent] = bob.devices as [Account, Account];
    await enrolled(g, "Bob", bob, 1, bob.devices);
    await say(g, a, "bob", "hello");
    await read(g, "Bob", answered);
    await read(g, "Bob", silent);
    answers(a, answered);
    // Whether `size` characters reach `device` alone, sized by the engine on a copy of the state.
    const fits = (device: Account, size: number): boolean =>
      new Engine(
        olm(),
        a.account,
        a.own,
        structuredClone(a.state),
        a.nick,
        FRAME_BUDGET_BASE,
        () => a.now,
      ).send("bob", text("x".repeat(size)), "probe", null, keyOf(device)).outbound.length > 0;
    let size = 10_000;
    while (fits(silent, size)) size += 64;
    expect(fits(answered, size)).toBe(true);
    const sessions = structuredClone(a.state.sessions);
    const sent = structuredClone(a.state.sent);

    const res = engineOf(a).send("bob", text("x".repeat(size)), "long", null, null);

    expect(res).toEqual({
      events: [{ kind: "send_failed", nick: "bob", reason: "too-long", tags: ["long"] }],
      outbound: [],
    });
    expect(a.state.sessions).toEqual(sessions);
    expect(a.state.sent).toEqual(sent);
    expect(a.state.outq).toEqual({});
  });

  it("sends five trusted devices two messages, of four bodies and of one, each with its own msgid and record of the devices it covered", () => {
    const a = me("alice");
    const bob = peerWith(MAX_DEVICES + 1);
    const listed = bob.devices.slice(0, MAX_DEVICES);
    const [fifth] = bob.devices.slice(MAX_DEVICES) as [Account];
    // The list held names four; the fifth device came after it, on a certificate
    // of the next version. Each one has answered on its session, so all five get MSGs.
    listedPeer(a, "bob", { master: bob.master, devices: listed }, 1);
    for (const device of listed) {
      bind(a, bob.master, device);
      const [first] = engineOf(a).send("bob", text("hi"), "hi", null, keyOf(device)).outbound;
      opened(device, "pkmsg", first?.payload ?? "");
      answers(a, device);
    }
    takes(
      a,
      "bob",
      "pkmsg",
      didOf(fifth),
      { ...written(a, bob, fifth, text("me too"), "one-time"), master: certified(bob, fifth, 2) },
      newMsgid(),
    );
    expect(engineOf(a).pinned("bob")?.devices).toBe(MAX_DEVICES + 1);

    const res = engineOf(a).send("bob", text("all of you"), "all", null, null);

    expect(res.events).toEqual([]);
    expect(res.outbound.map((o) => [o.verb, o.to, Object.keys(bodiesOf(o.payload))])).toEqual([
      ["msg", "*", listed.map(didOf)],
      ["msg", didOf(fifth), [didOf(fifth)]],
    ]);
    const [four, one] = res.outbound as [Outbound, Outbound];
    for (const device of listed) {
      expect(opened(device, "msg", four.payload)).toEqual(ours(a, "all of you"));
    }
    expect(opened(fifth, "msg", one.payload)).toEqual(ours(a, "all of you"));
    // grappa names each message apart, and a NACK of one is held against its own devices.
    const msgids = [newMsgid(), newMsgid()];
    engineOf(a).sent(four.ref ?? "", msgids[0] ?? "");
    engineOf(a).sent(one.ref ?? "", msgids[1] ?? "");
    expect(a.state.sent.slice(-2).map((s) => [s.msgid, Object.keys(s.devices)])).toEqual([
      [msgids[0], listed.map(didOf)],
      [msgids[1], [didOf(fifth)]],
    ]);

    // The fifth NACKs: not the first message, which never went to it; the
    // second goes to it again alone, once keys bring it a fresh session.
    expect(nackBy(a, "bob", fifth, msgids[0]).events).toEqual([
      { kind: "dropped", nick: "bob", reason: "unknown-nack-ref", verb: "nack" },
    ]);
    const listedSessions = listed.map((device) => sessionTo(a, device));
    expect(verbsOf(nackBy(a, "bob", fifth, msgids[1]))).toEqual(["keyreq"]);
    expect(a.state.outq.bob?.map((q) => [q.msg.tag, q.only])).toEqual([["all", keyOf(fifth)]]);
    // grappa's list now names it, in the place of one it held.
    const keys = keysFrom(a, "bob", bob, 2, [...listed.slice(1), fifth], [fifth]);
    expect(keys.outbound.map((o) => [o.verb, o.to, o.tag])).toEqual([
      ["pkmsg", didOf(fifth), "all"],
    ]);
    expect(opened(fifth, "pkmsg", keys.outbound[0]?.payload ?? "").body).toBe("all of you");
    expect(listed.slice(1).map((device) => sessionTo(a, device))).toEqual(listedSessions.slice(1));
    expect(failedOf(a)).toEqual([]);
  });

  it("refuses a message it cannot size before the network publishes its line budget, and no session moves", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    await enrolled(g, "Bob", bob, 1, bob.devices);
    await say(g, a, "bob", "hello");
    await read(g, "Bob", device);
    const sessions = structuredClone(a.state.sessions);
    const sent = a.state.sent.length;
    const unsized = new Engine(olm(), a.account, a.own, a.state, a.nick, null, () => a.now);

    const res = unsized.send("bob", text("again"), "again", null, null);

    expect(res).toEqual({
      events: [{ kind: "send_failed", nick: "bob", reason: "no-budget", tags: ["again"] }],
      outbound: [],
    });
    expect(a.state.sessions).toEqual(sessions);
    expect(a.state.sent).toHaveLength(sent);
  });

  it("refuses a message before queuing it or asking for keys while no line budget is published", () => {
    const a = me("alice");
    const unsized = new Engine(olm(), a.account, a.own, a.state, a.nick, null, () => a.now);

    expect(unsized.send("bob", text("hello"), "hello", null, null)).toEqual({
      events: [{ kind: "send_failed", nick: "bob", reason: "no-budget", tags: ["hello"] }],
      outbound: [],
    });
    expect(a.state).toEqual(newState());
  });

  it("refuses what waited for keys as unsized when the KEYS comes before a line budget", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    record(a, engineOf(a).send("bob", text("hello"), "hello", null, null));
    const unsized = new Engine(olm(), a.account, a.own, a.state, a.nick, null, () => a.now);

    const res = record(
      a,
      unsized.receive(
        "bob",
        "keys",
        newMsgid(),
        "*",
        keysPayload(bob, 1, [device], [entryOf(device, bob.master)]),
      ),
    );

    expect(res.outbound).toEqual([]);
    expect(failedOf(a)).toEqual([["no-budget", ["hello"]]]);
    expect(a.state.sent).toEqual([]);
  });

  it("refuses to send to our own nick, before asking anyone for keys", () => {
    const a = me("alice");

    expect(engineOf(a).send("ALICE", text("me"), "me", null, null)).toEqual({
      events: [{ kind: "send_failed", nick: "ALICE", reason: "own-nick", tags: ["me"] }],
      outbound: [],
    });
  });

  it("gives up on a queue the peer never answers, and names the messages it lost", () => {
    const a = me("alice");

    record(a, engineOf(a).send("nobody", text("one"), "one", null, null));
    record(a, engineOf(a).send("nobody", text("two"), "two", null, null));
    a.now += OUTQ_TTL_MS - 1;
    record(a, engineOf(a).tick());
    expect(failedOf(a)).toEqual([]);
    a.now += 1;
    record(a, engineOf(a).tick());

    expect(failedOf(a)).toEqual([["keys-timeout", ["one", "two"]]]);
    expect(a.state.outq).toEqual({});
  });

  it("asks for keys again only after the retry interval", () => {
    const a = me("alice");
    const engine = engineOf(a);

    const first = engine.send("nobody", text("one"), "one", null, null);
    const soon = engine.send("nobody", text("two"), "two", null, null);
    a.now += KEYREQ_RETRY_MS;
    const later = engine.send("nobody", text("three"), "three", null, null);

    expect(first.outbound.map((o) => [o.verb, o.from, o.to])).toEqual([["keyreq", a.own.did, "*"]]);
    expect(soon.outbound).toEqual([]);
    expect(later.outbound.map((o) => [o.verb, o.from, o.to])).toEqual([["keyreq", a.own.did, "*"]]);
  });

  it("refuses a message past the queue's bound, and says so", () => {
    const a = me("alice");

    for (let i = 0; i <= OUTQ_MAX; i++) {
      record(a, engineOf(a).send("nobody", text(`m${i}`), `m${i}`, null, null));
    }

    expect(a.state.outq.nobody).toHaveLength(OUTQ_MAX);
    expect(failedOf(a)).toEqual([["queue-full", [`m${OUTQ_MAX}`]]]);
  });

  it("forgets a message grappa dropped after accepting it, and says whose it was", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(1);
    await enrolled(g, "Bob", bob, 1, bob.devices);
    await say(g, a, "bob", "lost");
    const msgid = g.sends.filter((s) => s.verb === "pkmsg")[0]?.msgid ?? "";
    const engine = engineOf(a);

    expect(engine.dropped(msgid)).toEqual({ nick: "bob", tag: "lost" });
    expect(engine.dropped(msgid)).toBeUndefined();
    expect(engine.dropped("bm90LW91cnM")).toBeUndefined();
    expect(a.state.sent).toEqual([]);
  });

  it("forgets a message grappa refused: it never left, and holds no room among the sent", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(1);
    await enrolled(g, "Bob", bob, 1, bob.devices);
    await say(g, a, "bob", "one");
    const engine = engineOf(a);
    const refused = engine.send("bob", text("refused"), "refused", null, null);
    const ref = refused.outbound[0]?.ref;
    if (ref === undefined) throw new Error("no ref");
    expect(a.state.sent.map((s) => s.ref)).toContain(ref);

    engine.discard(ref);

    expect(a.state.sent.map((s) => s.ref)).not.toContain(ref);
    expect(a.state.sent).toHaveLength(1);
  });
});

describe("a deleted chat, with devices", () => {
  it("forgets the nick's plaintext, waiting or kept for a re-send, and nobody else's", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(1);
    const carol = peerWith(1);
    await enrolled(g, "bob", bob, 1, bob.devices);
    await enrolled(g, "carol", carol, 1, carol.devices);
    await say(g, a, "bob", "sent to bob");
    await say(g, a, "carol", "sent to carol");
    await say(g, a, "dave", "waits for dave");
    await say(g, a, "erin", "waits for erin");
    const engine = engineOf(a);

    engine.forget("BOB");
    engine.forget("Dave");

    expect(a.state.sent.map((s) => s.nick)).toEqual(["carol"]);
    expect(Object.keys(a.state.outq)).toEqual(["erin"]);
    const kept = JSON.stringify(a.state);
    expect(kept).not.toMatch(/sent to bob|waits for dave/);
    expect(kept).toMatch(/sent to carol/);
  });

  it("never sends a message forgotten while it waited for keys", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(1);
    await enrolled(g, "Bob", bob, 1, bob.devices);
    const waiting = engineOf(a).send("bob", text("never"), "never", null, null);

    engineOf(a).forget("bob");
    await toDoor(g, a, waiting); // grappa answers the KEYREQ only now
    await pump(g, a);

    expect(g.sends.filter((s) => s.verb === "pkmsg")).toEqual([]);
    expect(failedOf(a)).toEqual([]);
    expect(a.state.outq).toEqual({});
  });
});

// --- wire v2: receiving a PKMSG or a MSG -------------------------------------
//
// A peer device is a real account writing to our device the way cic or a bot
// writes (`written`, `msgFrom`): on its own session with us, with its id block
// and its master's certificate, one body per recipient device. What the engine
// makes of it is read off its result and its state; what it would send back
// (a NACK, what waited for the device) is read off the result, and a body we
// send the device is decrypted on the device's own session (`opened`).

/** The certificate `peer`'s master gives its `device`, naming list version `ver`. */
const certOf = (peer: PeerIdentity, device: Account, ver: number): string =>
  peer.master.sign(certSigText(ver, keyOf(device)));

/** A PKMSG's master block: `peer`'s master, and its certificate for `device` at `ver`. */
const certified = (peer: PeerIdentity, device: Account, ver: number) => ({
  ed25519: keyOf(peer.master),
  cert: certOf(peer, device, ver),
  ver,
});

/** A key of `side`'s account a peer device opens a session to it on: a new one-time key, or the fallback key. */
function keyOfOurs(side: Me, kind: "one-time" | "fallback"): string {
  if (kind === "fallback") {
    side.account.generate_fallback_key();
    const fallback = side.account.fallback_key();
    if (fallback === undefined) throw new Error("no fallback key");
    return fallback;
  }
  side.account.generate_one_time_keys(1);
  const keys = side.account.one_time_keys();
  const key = keys[keys.length - 1];
  if (key === undefined) throw new Error("no one-time key");
  return key;
}

/**
 * The PKMSG `device` of `peer` writes to `side`'s device, decoded: its id block
 * and its master's certificate for it at version 1 (a device its master's first
 * list held, as a new identity's is), and one body: `inner`, with the `fb` that binds
 * the two devices unless `inner` names its own, as a pre-key message on the
 * device's session with us, which it opens on a key of ours (`on`) when it
 * holds none.
 */
function written(
  side: Me,
  peer: PeerIdentity,
  device: Account,
  inner: Record<string, unknown>,
  on: "one-time" | "fallback",
): Record<string, unknown> {
  const held = inbound.get(device);
  const session =
    held === undefined
      ? device.create_outbound_session(side.account.curve25519_key(), keyOfOurs(side, on))
      : olm().Session.from_pickle(held);
  const plaintext = JSON.stringify({ fb: fb(olm(), keyOf(device), keyOf(side.account)), ...inner });
  const encrypted = session.encrypt(new TextEncoder().encode(plaintext));
  inbound.set(device, session.pickle());
  session.free();
  const preKey = encrypted.message_type === 0;
  const body = base64Unpadded(encrypted.body);
  encrypted.free();
  if (!preKey) throw new Error("the device heard back on its session: it writes MSGs now");
  return {
    v: 2,
    id: idBlock(device, keyOf(peer.master)),
    master: certified(peer, device, 1),
    bodies: { [side.own.did]: body },
  };
}

/** The MSG `device` writes to `side`'s device on the session it holds with us, decoded: `plaintext` as is. */
function msgFrom(side: Me, device: Account, plaintext: string): Record<string, unknown> {
  const session = olm().Session.from_pickle(inbound.get(device) ?? "");
  const encrypted = session.encrypt(new TextEncoder().encode(plaintext));
  inbound.set(device, session.pickle());
  session.free();
  const normal = encrypted.message_type === 1;
  const body = base64Unpadded(encrypted.body);
  encrypted.free();
  if (!normal) throw new Error("the device never heard back on its session");
  return { v: 2, ck: device.curve25519_key(), bodies: { [side.own.did]: body } };
}

/** `payload` with the last byte of `side`'s body flipped (inside the MAC). */
function spoiled(side: Me, payload: Record<string, unknown>): Record<string, unknown> {
  const bodies = payload.bodies as Record<string, string>;
  const body = unbase64(bodies[side.own.did] ?? "");
  body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 0xff;
  return { ...payload, bodies: { ...bodies, [side.own.did]: base64Unpadded(body) } };
}

/**
 * `side` and each of `devices` of `peer` on one session both have used: `nick`
 * pinned to the master, its list at 1 accepted, and a first message of `side`
 * read on each device. The devices write MSGs to `side` from now on.
 */
function talking(side: Me, nick: string, peer: PeerIdentity, ...devices: Account[]): void {
  listedPeer(side, nick, peer, 1);
  for (const device of devices) {
    bind(side, peer.master, device);
    const [first] = engineOf(side).send(nick, text("hello"), "hello", null, keyOf(device)).outbound;
    opened(device, "pkmsg", first?.payload ?? "");
  }
}

/** `side` takes `payload` as `verb` from `nick`, the frame's `from` being `fromDid`: its result, its events kept. */
function takes(
  side: Me,
  nick: string,
  verb: ReceiveVerb,
  fromDid: string,
  payload: Record<string, unknown>,
  msgid: string,
): Result {
  return record(side, engineOf(side).receive(nick, verb, msgid, fromDid, encodePayload(payload)));
}

/** The NACK of `msgid` `side`'s device sends `nick`'s device `to`. */
const nackOf = (side: Me, nick: string, to: string, msgid: string): Outbound => ({
  target: nick,
  verb: "nack",
  from: side.own.did,
  to,
  payload: encodePayload({ v: 2, ref: msgid }),
  priority: "control",
});

/** The inner messages `side` was handed to read, in order. */
const readBy = (side: Me) => eventsOf(side, "received").map((e) => e.inner);

describe("a PKMSG (W receiver checks, in order)", () => {
  it("reads a pre-key message from a listed device of the pinned master, and binds that device as proven", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [device] = bob.devices as [Account, Account];
    listedPeer(a, "bob", bob, 1);

    const res = takes(
      a,
      "Bob",
      "pkmsg",
      didOf(device),
      written(a, bob, device, text("hello"), "one-time"),
      newMsgid(),
    );

    expect(res).toEqual({
      events: [
        {
          kind: "received",
          nick: "Bob",
          master: keyOf(bob.master),
          device: keyOf(device),
          verified: false,
          inner: text("hello"),
        },
      ],
      outbound: [],
    });
    expect(a.state.devices[keyOf(device)]).toEqual({
      ed25519: keyOf(device),
      curve25519: device.curve25519_key(),
      master: keyOf(bob.master),
      did: didOf(device),
      proven: true,
      certVer: 1,
    });
    expect(sessionTo(a, device)).toBe(sessionIdOf(inbound.get(device)));
    expect(a.state.seen).toEqual([sessionIdOf(inbound.get(device))]);
    expect(engineOf(a).pinned("bob")?.devices).toBe(1);
  });

  it("pins the master to a nick with none on first use, and reads on under the list and the verification it already had", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    listedPeer(a, "bob", bob, 1);
    engineOf(a).verify("bob", keyOf(bob.master));

    takes(
      a,
      "bob_away",
      "pkmsg",
      didOf(device),
      written(a, bob, device, text("from my other nick"), "one-time"),
      newMsgid(),
    );

    expect(eventsOf(a, "received")).toEqual([
      {
        kind: "received",
        nick: "bob_away",
        master: keyOf(bob.master),
        device: keyOf(device),
        verified: true,
        inner: text("from my other nick"),
      },
    ]);
    expect(a.state.pins).toEqual({ bob: keyOf(bob.master), bob_away: keyOf(bob.master) });
    expect(engineOf(a).pinned("bob_away")).toEqual({
      master: keyOf(bob.master),
      verified: true,
      devices: 1,
    });
  });

  it("drops a PKMSG whose frame names another device than its id block, and reads nothing", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [writer, other] = bob.devices as [Account, Account];
    listedPeer(a, "bob", bob, 1);

    const res = takes(
      a,
      "bob",
      "pkmsg",
      didOf(other),
      written(a, bob, writer, text("x"), "one-time"),
      newMsgid(),
    );

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "bad-from", verb: "pkmsg" }],
      outbound: [],
    });
    expect(a.state.devices).toEqual({});
    expect(a.state.sessions).toEqual({});
    expect(a.state.seen).toEqual([]);
  });

  it("drops a PKMSG whose master or device key is not in vodozemac's one spelling, and pins nothing", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [one, two] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    listedPeer(a, "bob", bob, 1);
    // Every signature good over the spelling it carries: only the spelling is wrong.
    const paddedMaster = written(a, bob, one, text("x"), "one-time");
    paddedMaster.master = { ...certified(bob, one, 1), ed25519: `${M}=` };
    paddedMaster.id = {
      curve25519: one.curve25519_key(),
      ed25519: keyOf(one),
      sig: one.sign(`${ID_SIG_PREFIX}${one.curve25519_key()}:${M}=`),
    };
    const paddedDevice = written(a, bob, two, text("y"), "one-time");
    paddedDevice.id = { ...idBlock(two, M), ed25519: `${keyOf(two)}=` };
    paddedDevice.master = {
      ed25519: M,
      cert: bob.master.sign(certSigText(1, `${keyOf(two)}=`)),
      ver: 1,
    };
    const before = structuredClone(a.state);

    takes(a, "bob", "pkmsg", didOf(one), paddedMaster, newMsgid());
    takes(a, "bob", "pkmsg", didOf(two), paddedDevice, newMsgid());

    expect(a.events).toEqual([
      { kind: "dropped", nick: "bob", reason: "non-canonical-key", verb: "pkmsg" },
      { kind: "dropped", nick: "bob", reason: "non-canonical-key", verb: "pkmsg" },
    ]);
    expect(a.state).toEqual(before);
  });

  it("drops a PKMSG missing a field, of another wire version, or naming no valid version for its certificate, as malformed", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    listedPeer(a, "bob", bob, 1);
    const v1 = { ...written(a, bob, device, text("x"), "one-time"), v: 1 };
    const noCert = written(a, bob, device, text("y"), "one-time");
    noCert.master = { ed25519: keyOf(bob.master), ver: 1 };
    const noVer = written(a, bob, device, text("z"), "one-time");
    noVer.master = { ed25519: keyOf(bob.master), cert: certOf(bob, device, 1) };
    const verZero = written(a, bob, device, text("w"), "one-time");
    verZero.master = certified(bob, device, 0);

    for (const pkmsg of [v1, noCert, noVer, verZero]) {
      takes(a, "bob", "pkmsg", didOf(device), pkmsg, newMsgid());
    }

    expect(dropsOf(a)).toEqual(["bad-payload", "bad-payload", "bad-payload", "bad-payload"]);
    expect(a.state.sessions).toEqual({});
  });

  it("drops a message for other devices of ours without a word back: no NACK, no pin, no session", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    const pkmsg = written(a, bob, device, text("for your other devices"), "one-time");
    const body = (pkmsg.bodies as Record<string, string>)[a.own.did] ?? "";
    // A `*` message to two devices of ours that are not this one.
    const [laptop, phone] = peerWith(2).devices as [Account, Account];
    pkmsg.bodies = { [didOf(laptop)]: body, [didOf(phone)]: body };

    const res = takes(a, "bob", "pkmsg", didOf(device), pkmsg, newMsgid());

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "not-for-us", verb: "pkmsg" }],
      outbound: [],
    });
    expect(a.state).toEqual(newState());
  });

  it("drops a PKMSG whose certificate its master did not sign, before any pin or alarm", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    const forger = peerWith(1);
    listedPeer(a, "bob", bob, 1);
    pinnedTo(a, "bobby", keyOf(forger.master));
    const forged = (): Record<string, unknown> => ({
      ...written(a, bob, device, text("x"), "one-time"),
      master: { ...certified(forger, device, 1), ed25519: keyOf(bob.master) },
    });
    const before = structuredClone(a.state);

    // From a nick with no pin (TOFU would pin it), and from one pinned to another master.
    takes(a, "bob_away", "pkmsg", didOf(device), forged(), newMsgid());
    takes(a, "bobby", "pkmsg", didOf(device), forged(), newMsgid());

    expect(a.events).toEqual([
      { kind: "dropped", nick: "bob_away", reason: "bad-cert", verb: "pkmsg" },
      { kind: "dropped", nick: "bobby", reason: "bad-cert", verb: "pkmsg" },
    ]);
    expect(a.state).toEqual(before);
  });

  it("drops a PKMSG whose certificate names another version than the one its master signed, as a bad certificate", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    listedPeer(a, "bob", bob, 1);
    // Signed at version 1, presented as version 2.
    const raised = {
      ...written(a, bob, device, text("x"), "one-time"),
      master: { ...certified(bob, device, 1), ver: 2 },
    };
    const before = structuredClone(a.state);

    const res = takes(a, "bob", "pkmsg", didOf(device), raised, newMsgid());

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "bad-cert", verb: "pkmsg" }],
      outbound: [],
    });
    expect(a.state).toEqual(before);
  });

  it("drops a PKMSG whose device did not sign its curve and this master, before any pin or alarm", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    const other = peerWith(1);
    listedPeer(a, "bob", bob, 1);
    pinnedTo(a, "bobby", keyOf(other.master));
    // Its S1 covers another master.
    const forged = (): Record<string, unknown> => ({
      ...written(a, bob, device, text("x"), "one-time"),
      id: idBlock(device, keyOf(other.master)),
    });
    const before = structuredClone(a.state);

    takes(a, "bob_away", "pkmsg", didOf(device), forged(), newMsgid());
    takes(a, "bobby", "pkmsg", didOf(device), forged(), newMsgid());

    expect(a.events).toEqual([
      { kind: "dropped", nick: "bob_away", reason: "bad-identity-signature", verb: "pkmsg" },
      { kind: "dropped", nick: "bobby", reason: "bad-identity-signature", verb: "pkmsg" },
    ]);
    expect(a.state).toEqual(before);
  });

  it("raises the alarm for another master on a pinned nick: no NACK, nothing read or bound", () => {
    const a = me("alice");
    const old = peerWith(1);
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    // Its list is known, under another nick: only the pin stands in the way.
    listedPeer(a, "bob_was_here", bob, 1);
    pinnedTo(a, "bob", keyOf(old.master));
    const before = structuredClone(a.state);

    const res = takes(
      a,
      "Bob",
      "pkmsg",
      didOf(device),
      written(a, bob, device, text("it's me, new identity"), "one-time"),
      newMsgid(),
    );

    expect(res).toEqual({
      events: [
        { kind: "key_alarm", nick: "Bob", pinned: keyOf(old.master), presented: keyOf(bob.master) },
      ],
      outbound: [],
    });
    expect(a.state).toEqual(before);
  });

  it("refuses a PKMSG of our own master: nothing pinned, read or bound", () => {
    const a = me("alice");
    // Another device of ours, its certificate our master's.
    const ours: PeerIdentity = { master: a.master, devices: [new (olm().Account)()] };
    const [twin] = ours.devices as [Account];

    const res = takes(
      a,
      "mallory",
      "pkmsg",
      didOf(twin),
      written(a, ours, twin, text("me again"), "one-time"),
      newMsgid(),
    );

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "mallory", reason: "own-identity" }],
      outbound: [],
    });
    expect(a.state).toEqual(newState());
  });

  it("drops a PKMSG of a device its master revoked, with no NACK and no alarm, whatever version its certificate names", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [gone, kept] = bob.devices as [Account, Account];
    listedPeer(a, "bob", bob, 1);
    trust(engineOf(a)).applyList(keyOf(bob.master), listOf(2, [kept]));

    // A certificate above the stored list's version: revoked wins all the same.
    const res = takes(
      a,
      "bob",
      "pkmsg",
      didOf(gone),
      { ...written(a, bob, gone, text("still here"), "one-time"), master: certified(bob, gone, 3) },
      newMsgid(),
    );

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "revoked-device", verb: "pkmsg" }],
      outbound: [],
    });
    expect(a.state.devices).toEqual({});
    expect(a.state.sessions).toEqual({});
  });

  it("drops a PKMSG of a device its stored list leaves out whose certificate names a version that list has reached: stale, no NACK, nothing flushed", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [listed, unlisted] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    pinnedTo(a, "bob", M);
    trust(engineOf(a)).applyList(M, listOf(3, [listed]));
    record(a, engineOf(a).send("bob", text("waiting"), "waiting", null, null));
    const at = (ver: number) => ({
      ...written(a, bob, unlisted, text("a new laptop"), "one-time"),
      master: certified(bob, unlisted, ver),
    });

    const older = takes(a, "bob", "pkmsg", didOf(unlisted), at(2), newMsgid());
    const equal = takes(a, "bob", "pkmsg", didOf(unlisted), at(3), newMsgid());

    for (const res of [older, equal]) {
      expect(res).toEqual({
        events: [{ kind: "dropped", nick: "bob", reason: "stale-certificate", verb: "pkmsg" }],
        outbound: [],
      });
    }
    expect(a.state.devices).toEqual({});
    expect(a.state.sessions).toEqual({});
    expect(a.state.seen).toEqual([]);
    expect(a.state.outq.bob?.map((q) => q.msg.tag)).toEqual(["waiting"]);
  });

  it("drops a certificate its master did not sign as bad-cert before its version is judged: never stale, never admitted", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [listed, unlisted] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    listedPeer(a, "bob", { master: bob.master, devices: [listed] }, 3);
    const forger = peerWith(1);
    const pkmsg = (master: object) => ({
      ...written(a, bob, unlisted, text("x"), "one-time"),
      master,
    });
    const before = structuredClone(a.state);

    // Another key's signature on a version the stored list has reached.
    takes(
      a,
      "bob",
      "pkmsg",
      didOf(unlisted),
      pkmsg({ ...certified(forger, unlisted, 2), ed25519: M }),
      newMsgid(),
    );
    // Signed at version 2, presented above the stored list's.
    takes(
      a,
      "bob",
      "pkmsg",
      didOf(unlisted),
      pkmsg({ ...certified(bob, unlisted, 2), ver: 4 }),
      newMsgid(),
    );

    expect(dropsOf(a)).toEqual(["bad-cert", "bad-cert"]);
    expect(a.state).toEqual(before);
  });

  it("reads the first message of a master never seen on its device's certificate, with no list of it held, and pins it on first use", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];

    const res = takes(
      a,
      "bob",
      "pkmsg",
      didOf(device),
      written(a, bob, device, text("first contact"), "one-time"),
      newMsgid(),
    );

    expect(res).toEqual({
      events: [
        {
          kind: "received",
          nick: "bob",
          master: keyOf(bob.master),
          device: keyOf(device),
          verified: false,
          inner: text("first contact"),
        },
      ],
      outbound: [],
    });
    expect(engineOf(a).pinned("bob")).toEqual({
      master: keyOf(bob.master),
      verified: false,
      devices: 1,
    });
    expect(a.state.masters[keyOf(bob.master)]).toMatchObject({ ver: 0, devices: [] });
    expect(a.state.devices[keyOf(device)]).toMatchObject({ proven: true, certVer: 1 });
    expect(sessionTo(a, device)).toBe(sessionIdOf(inbound.get(device)));
    // The answer reaches the device at once; keys are asked for, to learn the list.
    const reply = engineOf(a).send("bob", text("hi bob"), "hi", null, null);
    expect(reply.outbound.map((o) => [o.verb, o.to])).toEqual([
      ["msg", didOf(device)],
      ["keyreq", "*"],
    ]);
    expect(opened(device, "msg", reply.outbound[0]?.payload ?? "")).toEqual(ours(a, "hi bob"));
  });

  it("admits a device on a certificate one version above the stored list until a list at that version leaves it out: then its sessions go, nothing more goes to it, and its PKMSGs are stale", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [listed, fresh] = bob.devices as [Account, Account];
    listedPeer(a, "bob", { master: bob.master, devices: [listed] }, 2);
    const pkmsg = () => ({
      ...written(a, bob, fresh, text("my new laptop"), "one-time"),
      master: certified(bob, fresh, 3),
    });

    takes(a, "bob", "pkmsg", didOf(fresh), pkmsg(), newMsgid());
    expect(readBy(a)).toEqual([text("my new laptop")]);
    expect(
      trust(engineOf(a))
        .trustedDevices(keyOf(bob.master))
        .map((d) => d.ed25519),
    ).toEqual([keyOf(fresh)]);

    // A message goes to the admitted device at once and asks keys for the listed
    // one; the KEYS brings a list at version 3 that leaves the admitted device out.
    const keys = keysAfter(
      a,
      "bob",
      "before",
      keysPayload(bob, 3, [listed], [entryOf(listed, bob.master)]),
    );

    expect(a.state.sessions[fresh.curve25519_key()]).toBeUndefined();
    expect(keys.outbound.map((o) => Object.keys(bodiesOf(o.payload)))).toEqual([[didOf(listed)]]);
    expect(
      trust(engineOf(a))
        .trustedDevices(keyOf(bob.master))
        .map((d) => d.ed25519),
    ).toEqual([keyOf(listed)]);
    const after = engineOf(a).send("bob", text("after"), "after", null, null);
    expect(after.outbound.map((o) => Object.keys(bodiesOf(o.payload)))).toEqual([[didOf(listed)]]);
    const res = takes(a, "bob", "pkmsg", didOf(fresh), pkmsg(), newMsgid());
    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "stale-certificate", verb: "pkmsg" }],
      outbound: [],
    });
    expect(readBy(a)).toEqual([text("my new laptop")]);
    expect(failedOf(a)).toEqual([]);
  });

  it("refuses a PKMSG claiming a curve a pre-key message proved for another device, which keeps it", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [holder] = bob.devices as [Account];
    const mallory = peerWith(1);
    const [claimant] = mallory.devices as [Account];
    const curve = holder.curve25519_key();
    listedPeer(a, "bob", bob, 1);
    listedPeer(a, "mallory", mallory, 1);
    takes(
      a,
      "bob",
      "pkmsg",
      didOf(holder),
      written(a, bob, holder, text("mine"), "one-time"),
      newMsgid(),
    );
    const sessions = structuredClone(a.state.sessions);
    // Mallory's pre-key message claims bob's curve, signed by mallory's device.
    const claim = {
      ...written(a, mallory, claimant, text("i am bob's curve"), "one-time"),
      id: {
        curve25519: curve,
        ed25519: keyOf(claimant),
        sig: claimant.sign(`${ID_SIG_PREFIX}${curve}:${keyOf(mallory.master)}`),
      },
    };

    const res = takes(a, "mallory", "pkmsg", didOf(claimant), claim, newMsgid());

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "mallory", reason: "curve-already-bound", verb: "pkmsg" }],
      outbound: [],
    });
    expect(a.state.devices[keyOf(claimant)]).toBeUndefined();
    expect(a.state.devices[keyOf(holder)]?.proven).toBe(true);
    expect(a.state.sessions).toEqual(sessions);
  });

  /** A PKMSG of `peer`'s `device`, signed and certified, its curve padded out of the one spelling. */
  const paddedCurve = (side: Me, peer: PeerIdentity, device: Account) => {
    const padded = `${device.curve25519_key()}=`;
    return {
      ...written(side, peer, device, text("x"), "one-time"),
      id: {
        curve25519: padded,
        ed25519: keyOf(device),
        sig: device.sign(`${ID_SIG_PREFIX}${padded}:${keyOf(peer.master)}`),
      },
    };
  };

  it("refuses a PKMSG whose curve is not in vodozemac's one spelling as malformed, before it pins anything: a padded copy binds nothing", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];

    const res = takes(a, "bob", "pkmsg", didOf(device), paddedCurve(a, bob, device), newMsgid());

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "non-canonical-key", verb: "pkmsg" }],
      outbound: [],
    });
    expect(a.state.pins).toEqual({});
    expect(a.state.masters).toEqual({});
    expect(a.state.devices).toEqual({});
    expect(a.state.sessions).toEqual({});
  });

  it("refuses a PKMSG with a padded curve, of another master on a pinned nick, as malformed: no key alarm", () => {
    const a = me("alice");
    const bob = peerWith(1);
    listedPeer(a, "bob", bob, 1);
    const mallory = peerWith(1);
    const [device] = mallory.devices as [Account];

    const res = takes(
      a,
      "bob",
      "pkmsg",
      didOf(device),
      paddedCurve(a, mallory, device),
      newMsgid(),
    );

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "non-canonical-key", verb: "pkmsg" }],
      outbound: [],
    });
    expect(a.state.pins).toEqual({ bob: keyOf(bob.master) });
    expect(a.state.masters[keyOf(mallory.master)]).toBeUndefined();
  });

  it("NACKs a pre-key message whose session it opened before and holds no more, and never reads it again", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    listedPeer(a, "bob", bob, 1);
    // On our fallback key, which a replay could open the session on again.
    const pkmsg = written(a, bob, device, text("once"), "fallback");
    takes(a, "bob", "pkmsg", didOf(device), pkmsg, newMsgid());
    a.state.sessions = {};
    const msgid = newMsgid();

    const res = takes(a, "bob", "pkmsg", didOf(device), pkmsg, msgid);

    expect(res).toEqual({
      events: [
        { kind: "replayed", nick: "bob", sessionId: sessionIdOf(inbound.get(device)) },
        { kind: "undecryptable", nick: "bob", msgid, reason: "replayed-session" },
      ],
      outbound: [nackOf(a, "bob", didOf(device), msgid)],
    });
    expect(readBy(a)).toEqual([text("once")]);
    expect(a.state.sessions).toEqual({});
  });

  it("never reads a pre-key message twice on the session it opened: the session refuses it, and it is NACKed", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    listedPeer(a, "bob", bob, 1);
    const pkmsg = written(a, bob, device, text("once"), "one-time");
    takes(a, "bob", "pkmsg", didOf(device), pkmsg, newMsgid());
    const msgid = newMsgid();

    const res = takes(a, "bob", "pkmsg", didOf(device), pkmsg, msgid);

    expect(res).toEqual({
      events: [{ kind: "undecryptable", nick: "bob", msgid, reason: "decryption-failed" }],
      outbound: [nackOf(a, "bob", didOf(device), msgid)],
    });
    expect(readBy(a)).toEqual([text("once")]);
  });

  it("reads each pre-key message a device writes before it hears back, on the one session the first opened", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    listedPeer(a, "bob", bob, 1);
    const one = written(a, bob, device, text("one"), "one-time");
    const two = written(a, bob, device, text("two"), "one-time");

    takes(a, "bob", "pkmsg", didOf(device), one, newMsgid());
    takes(a, "bob", "pkmsg", didOf(device), two, newMsgid());

    expect(readBy(a)).toEqual([text("one"), text("two")]);
    expect(a.state.sessions[device.curve25519_key()]).toHaveLength(1);
    expect(a.state.seen).toHaveLength(1);
  });

  it("NACKs a pre-key message it cannot open a session from, and binds nothing", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    listedPeer(a, "bob", bob, 1);
    const msgid = newMsgid();

    const res = takes(
      a,
      "bob",
      "pkmsg",
      didOf(device),
      spoiled(a, written(a, bob, device, text("x"), "one-time")),
      msgid,
    );

    expect(res).toEqual({
      events: [{ kind: "undecryptable", nick: "bob", msgid, reason: "session-creation" }],
      outbound: [nackOf(a, "bob", didOf(device), msgid)],
    });
    expect(a.state.devices).toEqual({});
    expect(a.state.sessions).toEqual({});
  });

  it("drops a pre-key message whose fb binds another pair of devices: no session, nothing flushed, its id seen and a replay NACKed", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    listedPeer(a, "bob", bob, 1);
    record(a, engineOf(a).send("bob", text("waiting"), "waiting", null, null));
    const elsewhere = new (olm().Account)();
    // Built for another device: its fb names that one. On our fallback key,
    // which a replay could open the session on again.
    const pkmsg = written(
      a,
      bob,
      device,
      { ...text("not for you"), fb: fb(olm(), keyOf(device), keyOf(elsewhere)) },
      "fallback",
    );

    const res = takes(a, "bob", "pkmsg", didOf(device), pkmsg, newMsgid());

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "inner-key-mismatch" }],
      outbound: [],
    });
    expect(a.state.devices).toEqual({});
    expect(a.state.sessions).toEqual({});
    expect(a.state.seen).toEqual([sessionIdOf(inbound.get(device))]);
    expect(a.state.outq.bob?.map((q) => q.msg.tag)).toEqual(["waiting"]);
    const msgid = newMsgid();
    expect(takes(a, "bob", "pkmsg", didOf(device), pkmsg, msgid)).toEqual({
      events: [
        { kind: "replayed", nick: "bob", sessionId: sessionIdOf(inbound.get(device)) },
        { kind: "undecryptable", nick: "bob", msgid, reason: "replayed-session" },
      ],
      outbound: [nackOf(a, "bob", didOf(device), msgid)],
    });
    expect(readBy(a)).toEqual([]);
    elsewhere.free();
  });

  it("drops a later pre-key message on a held session whose fb binds another pair of devices", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    const elsewhere = new (olm().Account)();
    listedPeer(a, "bob", bob, 1);
    takes(
      a,
      "bob",
      "pkmsg",
      didOf(device),
      written(a, bob, device, text("one"), "one-time"),
      newMsgid(),
    );
    const rebound = written(
      a,
      bob,
      device,
      { ...text("two"), fb: fb(olm(), keyOf(device), keyOf(elsewhere)) },
      "one-time",
    );

    takes(a, "bob", "pkmsg", didOf(device), rebound, newMsgid());

    expect(dropsOf(a)).toEqual(["inner-key-mismatch"]);
    expect(readBy(a)).toEqual([text("one")]);
    elsewhere.free();
  });

  it("lets a curve's real holder take it back from a device that only claimed it, and sends the holder what waited", () => {
    const a = me("alice");
    const mallory = peerWith(1);
    const [claimant] = mallory.devices as [Account];
    const bob = peerWith(1);
    const [holder] = bob.devices as [Account];
    const curve = holder.curve25519_key();
    const claim = (): string =>
      keysPayload(
        mallory,
        1,
        [claimant],
        [claiming(claimant, mallory.master, curve, oneTimeKey(holder, claimant))],
      );
    // Mallory's KEYS claims bob's curve, and hands out one of bob's one-time keys as its own.
    keysAfter(a, "mallory", "for mallory", claim());
    expect(a.state.devices[keyOf(claimant)]).toMatchObject({ curve25519: curve, proven: false });
    // Bob's own KEYS is refused while the claim stands: what is for bob waits.
    keysAfter(a, "bob", "for bob", keysPayload(bob, 1, [holder], [entryOf(holder, bob.master)]));
    expect(dropsOf(a)).toEqual(["curve-already-bound"]);

    // Bob writes first: his pre-key message proves the curve is his.
    const res = takes(
      a,
      "bob",
      "pkmsg",
      didOf(holder),
      written(a, bob, holder, text("it is mine"), "one-time"),
      newMsgid(),
    );

    expect(readBy(a)).toEqual([text("it is mine")]);
    expect(a.state.devices[keyOf(holder)]).toMatchObject({ curve25519: curve, proven: true });
    expect(a.state.devices[keyOf(claimant)]).toBeUndefined();
    expect(a.state.sessions[curve]).toHaveLength(1);
    // What waited for bob goes to him at once, on the session he opened.
    expect(res.outbound.map((o) => [o.tag, o.verb, o.to])).toEqual([
      ["for bob", "msg", didOf(holder)],
    ]);
    expect(opened(holder, "msg", res.outbound[0]?.payload ?? "")).toEqual(ours(a, "for bob"));
    // Mallory cannot claim it again.
    a.now += KEYREQ_RETRY_MS;
    keysAfter(a, "mallory", "again", claim());
    expect(dropsOf(a)).toEqual(["curve-already-bound", "curve-already-bound"]);
  });

  it("sends what waited for a device to it as soon as its own pre-key message opens a session, ahead of anything newer", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [keyed, silent] = bob.devices as [Account, Account];
    // The KEYS has keys for one device only: the other's copy waits.
    const first = keysAfter(
      a,
      "bob",
      "hello",
      keysPayload(bob, 1, [keyed, silent], [entryOf(keyed, bob.master)]),
    );
    expect(first.outbound.map((o) => [o.tag, o.to])).toEqual([["hello", didOf(keyed)]]);
    expect(a.state.outq.bob?.map((q) => [q.msg.tag, q.done])).toEqual([["hello", [keyOf(keyed)]]]);

    const res = takes(
      a,
      "bob",
      "pkmsg",
      didOf(silent),
      written(a, bob, silent, text("hi, my laptop here"), "one-time"),
      newMsgid(),
    );
    const next = record(a, engineOf(a).send("bob", text("next"), "next", null, null));

    expect(res.outbound.map((o) => [o.tag, o.verb, o.to])).toEqual([
      ["hello", "msg", didOf(silent)],
    ]);
    expect(a.state.outq).toEqual({});
    expect(next.outbound.map((o) => [o.tag, o.verb, o.to])).toEqual([
      ["next", "msg", didOf(silent)],
      ["next", "pkmsg", didOf(keyed)],
    ]);
    const toSilent = [...res.outbound, ...next.outbound].filter((o) => o.to === didOf(silent));
    expect(toSilent.map((o) => opened(silent, o.verb as ReceiveVerb, o.payload).body)).toEqual([
      "hello",
      "next",
    ]);
    expect(failedOf(a)).toEqual([]);
  });
});

describe("a MSG (W receiver checks, in order)", () => {
  it("reads a MSG from a trusted device of the pinned master on its session", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);

    const res = takes(
      a,
      "bob",
      "msg",
      didOf(device),
      msgFrom(a, device, JSON.stringify(text("hi"))),
      newMsgid(),
    );

    expect(res).toEqual({
      events: [
        {
          kind: "received",
          nick: "bob",
          master: keyOf(bob.master),
          device: keyOf(device),
          verified: false,
          inner: text("hi"),
        },
      ],
      outbound: [],
    });
  });

  it("drops a MSG with no body for this device without a word back, and no session moves", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);
    const msg = msgFrom(a, device, JSON.stringify(text("for your phone")));
    const [phone] = peerWith(1).devices as [Account];
    msg.bodies = { [didOf(phone)]: (msg.bodies as Record<string, string>)[a.own.did] ?? "" };
    const sessions = structuredClone(a.state.sessions);

    const res = takes(a, "bob", "msg", didOf(device), msg, newMsgid());

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "not-for-us", verb: "msg" }],
      outbound: [],
    });
    expect(a.state.sessions).toEqual(sessions);
  });

  it("drops a MSG on a curve its master revoked, with no NACK", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [gone, kept] = bob.devices as [Account, Account];
    talking(a, "bob", bob, gone);
    const msg = msgFrom(a, gone, JSON.stringify(text("still here")));
    trust(engineOf(a)).applyList(keyOf(bob.master), listOf(2, [kept]));

    const res = takes(a, "bob", "msg", didOf(gone), msg, newMsgid());

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "revoked-device", verb: "msg" }],
      outbound: [],
    });
  });

  it("drops a MSG whose frame names another device than the one its curve belongs to", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [writer, other] = bob.devices as [Account, Account];
    talking(a, "bob", bob, writer);
    const sessions = structuredClone(a.state.sessions);

    const res = takes(
      a,
      "bob",
      "msg",
      didOf(other),
      msgFrom(a, writer, JSON.stringify(text("x"))),
      newMsgid(),
    );

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "bad-from", verb: "msg" }],
      outbound: [],
    });
    expect(a.state.sessions).toEqual(sessions);
  });

  it("NACKs a MSG its device's sessions cannot read, from this device to that one", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);
    const msgid = newMsgid();

    const res = takes(
      a,
      "bob",
      "msg",
      didOf(device),
      spoiled(a, msgFrom(a, device, JSON.stringify(text("x")))),
      msgid,
    );

    expect(res).toEqual({
      events: [{ kind: "undecryptable", nick: "bob", msgid, reason: "decryption-failed" }],
      outbound: [nackOf(a, "bob", didOf(device), msgid)],
    });
  });

  it("NACKs a MSG of a trusted device it holds no session with any more, so the device re-keys", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);
    const msg = msgFrom(a, device, JSON.stringify(text("lost")));
    a.state.sessions = {};
    const msgid = newMsgid();

    const res = takes(a, "bob", "msg", didOf(device), msg, msgid);

    expect(res).toEqual({
      events: [{ kind: "undecryptable", nick: "bob", msgid, reason: "no-session" }],
      outbound: [nackOf(a, "bob", didOf(device), msgid)],
    });
  });

  it("drops a MSG on a curve bound under another master, with no NACK", () => {
    const a = me("alice");
    const carol = peerWith(1);
    const [carols] = carol.devices as [Account];
    talking(a, "carol", carol, carols);
    listedPeer(a, "bob", peerWith(1), 1);

    const res = takes(
      a,
      "bob",
      "msg",
      didOf(carols),
      msgFrom(a, carols, JSON.stringify(text("from bob's nick"))),
      newMsgid(),
    );

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "unpinned-key", verb: "msg" }],
      outbound: [],
    });
  });

  it("drops a MSG of a device its certificate admitted once a list at that version leaves it out, with no NACK", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [kept, lapsed] = bob.devices as [Account, Account];
    knownPeer(a, "bob", { master: bob.master, devices: [kept] }, 1);
    takes(
      a,
      "bob",
      "pkmsg",
      didOf(lapsed),
      {
        ...written(a, bob, lapsed, text("a new laptop"), "one-time"),
        master: certified(bob, lapsed, 2),
      },
      newMsgid(),
    );
    expect(engineOf(a).trusted(keyOf(bob.master), keyOf(lapsed))).toBeDefined();
    const [reply] = sends(a, "bob", "welcome", lapsed).outbound;
    expect(reply?.verb).toBe("msg");
    opened(lapsed, "msg", reply?.payload ?? "");
    const msg = msgFrom(a, lapsed, JSON.stringify(text("still here")));
    // A list at the certificate's version leaves it out: never listed, so never revoked.
    trust(engineOf(a)).applyList(keyOf(bob.master), listOf(2, [kept]));

    const res = takes(a, "bob", "msg", didOf(lapsed), msg, newMsgid());

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "unpinned-key", verb: "msg" }],
      outbound: [],
    });
  });

  it("NACKs a MSG on a curve it never saw, so the sender opens a new session", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);
    const msg = msgFrom(a, device, JSON.stringify(text("are you there?")));
    // Our state was lost; bob writes on as before.
    a.state = newState();
    const msgid = newMsgid();

    const res = takes(a, "bob", "msg", didOf(device), msg, msgid);

    expect(res).toEqual({
      events: [{ kind: "undecryptable", nick: "bob", msgid, reason: "no-session" }],
      outbound: [nackOf(a, "bob", didOf(device), msgid)],
    });
  });

  it("never reads a MSG twice: its session refuses it again, and it is NACKed", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);
    const msg = msgFrom(a, device, JSON.stringify(text("once")));
    takes(a, "bob", "msg", didOf(device), msg, newMsgid());
    const msgid = newMsgid();

    const res = takes(a, "bob", "msg", didOf(device), msg, msgid);

    expect(res).toEqual({
      events: [{ kind: "undecryptable", nick: "bob", msgid, reason: "decryption-failed" }],
      outbound: [nackOf(a, "bob", didOf(device), msgid)],
    });
    expect(readBy(a)).toEqual([text("once")]);
  });

  it("reads a MSG on an older session, and answers on the session the device used", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);
    const old = inbound.get(device) ?? "";
    // The device opens a second session, then finds the first again and writes on it.
    inbound.delete(device);
    takes(
      a,
      "bob",
      "pkmsg",
      didOf(device),
      written(a, bob, device, text("a new session"), "one-time"),
      newMsgid(),
    );
    expect(a.state.sessions[device.curve25519_key()]).toHaveLength(2);
    inbound.set(device, old);

    takes(
      a,
      "bob",
      "msg",
      didOf(device),
      msgFrom(a, device, JSON.stringify(text("on the old one"))),
      newMsgid(),
    );
    const answer = record(a, engineOf(a).send("bob", text("answer"), "answer", null, null));

    expect(readBy(a)).toEqual([text("a new session"), text("on the old one")]);
    expect(sessionTo(a, device)).toBe(sessionIdOf(old));
    expect(answer.outbound.map((o) => o.verb)).toEqual(["msg"]);
    expect(opened(device, "msg", answer.outbound[0]?.payload ?? "")).toEqual(ours(a, "answer"));
  });

  it("drops a decrypted inner message that is not a typed JSON object", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);

    for (const plaintext of ["not json", "null", "[1,2]", '{"body":"no type"}', '{"t":5}']) {
      takes(a, "bob", "msg", didOf(device), msgFrom(a, device, plaintext), newMsgid());
    }

    expect(dropsOf(a)).toEqual([
      "undecodable-inner",
      "inner-without-type",
      "inner-without-type",
      "inner-without-type",
      "inner-without-type",
    ]);
    expect(readBy(a)).toEqual([]);
  });

  it("drops a MSG naming a curve vodozemac cannot read as malformed", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);
    const msg = { ...msgFrom(a, device, JSON.stringify(text("x"))), ck: KEY_OF_33_BYTES };

    const res = takes(a, "bob", "msg", didOf(device), msg, newMsgid());

    expect(res).toEqual({
      events: [
        {
          kind: "dropped",
          nick: "bob",
          reason: "bad-payload",
          verb: "msg",
          detail: expect.any(String),
        },
      ],
      outbound: [],
    });
  });

  it("reads on after its state and its account round-trip through JSON", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);

    a.state = JSON.parse(JSON.stringify(a.state)) as E2eState;
    const pickle = a.account.pickle();
    a.account.free();
    a.account = olm().Account.from_pickle(pickle);
    takes(
      a,
      "bob",
      "msg",
      didOf(device),
      msgFrom(a, device, JSON.stringify(text("after"))),
      newMsgid(),
    );

    expect(readBy(a)).toEqual([text("after")]);
  });
});

// --- wire v2: a NACK, and the device lists inside Olm -------------------------
//
// A NACK names the device that failed (the frame's `from`) and our msgid
// (`ref`): grappa names each message we hand it (`named`). Every inner message
// names the version of the list its writer holds (`lv`); lists travel inside
// Olm as `t:list`, asked for with `t:listreq`.

/** grappa's msgid for each payload of `res` that carries a message, told to `side`'s engine, in order. */
function named(side: Me, res: Result): string[] {
  return res.outbound.flatMap((o) => {
    if (o.ref === undefined) return [];
    const msgid = newMsgid();
    engineOf(side).sent(o.ref, msgid);
    return [msgid];
  });
}

/** `device` of `nick` NACKs our `msgid` (none: a msgid it never had): what `side` makes of it. */
const nackBy = (side: Me, nick: string, device: Account, msgid: string | undefined): Result =>
  takes(side, nick, "nack", didOf(device), { v: 2, ref: msgid ?? "bm90LW91cnM" }, newMsgid());

/** `side` sends `body` to `nick` (`only`: to that device alone): its result, its events kept. */
const sends = (side: Me, nick: string, body: string, only: Account | null): Result =>
  record(
    side,
    engineOf(side).send(nick, text(body), body, null, only === null ? null : keyOf(only)),
  );

const verbsOf = (res: Result) => res.outbound.map((o) => o.verb);

/** `side` takes a KEYS from `peer`'s master: its list naming `listed` at `ver`, with entries for `keyed`. */
const keysFrom = (
  side: Me,
  nick: string,
  peer: PeerIdentity,
  ver: number,
  listed: Account[],
  keyed: Account[],
): Result =>
  record(
    side,
    engineOf(side).receive(
      nick,
      "keys",
      newMsgid(),
      "*",
      keysPayload(
        peer,
        ver,
        listed,
        keyed.map((device) => entryOf(device, peer.master)),
      ),
    ),
  );

/** The KEYREQ `side`'s device sends `nick`. */
const keyreqOf = (side: Me, nick: string): Outbound => ({
  target: nick,
  verb: "keyreq",
  from: side.own.did,
  to: "*",
  payload: encodePayload({ v: 2 }),
  priority: "control",
});

describe("a NACK (W receiver checks, rev 2)", () => {
  it("re-keys the device that NACKed its newest session and sends it the message again alone, under its tag, once keys come: the other device's session stays", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [kept, failing] = bob.devices as [Account, Account];
    knownPeer(a, "bob", bob, 1);
    const sent = sends(a, "bob", "hello", null);
    expect(sent.outbound.map((o) => [o.verb, o.to])).toEqual([["pkmsg", "*"]]);
    const [msgid] = named(a, sent);
    const keptSessions = structuredClone(a.state.sessions[kept.curve25519_key()]);

    expect(nackBy(a, "bob", failing, msgid)).toEqual({
      events: [
        { kind: "rekeying", nick: "bob", master: keyOf(bob.master), device: keyOf(failing) },
      ],
      outbound: [keyreqOf(a, "bob")],
    });
    expect(a.state.sessions[failing.curve25519_key()]).toBeUndefined();
    // It waits for the keys, for that device alone, unannounced: the other one has it.
    expect(a.state.outq.bob?.map((q) => [q.msg.tag, q.msg.sends, q.only, q.done])).toEqual([
      ["hello", 2, keyOf(failing), []],
    ]);

    const keys = keysFrom(a, "bob", bob, 1, bob.devices, [failing]);

    expect(keys.outbound.map((o) => [o.verb, o.to, o.tag, o.priority])).toEqual([
      ["pkmsg", didOf(failing), "hello", "text"],
    ]);
    expect(Object.keys(bodiesOf(keys.outbound[0]?.payload ?? ""))).toEqual([didOf(failing)]);
    expect(opened(failing, "pkmsg", keys.outbound[0]?.payload ?? "").body).toBe("hello");
    expect(a.state.sessions[kept.curve25519_key()]).toEqual(keptSessions);
    expect(a.state.outq).toEqual({});
    expect(failedOf(a)).toEqual([]);
  });

  it("sends a message a device NACKed on an older session again on its newest, with no new session and no KEYREQ", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    knownPeer(a, "bob", bob, 1);
    const [msgid] = named(a, sends(a, "bob", "one", null));
    const older = sessionTo(a, device);
    // The device writes first on a session of its own: our newest to it now.
    takes(
      a,
      "bob",
      "pkmsg",
      didOf(device),
      written(a, bob, device, text("hi"), "one-time"),
      newMsgid(),
    );
    const newest = sessionTo(a, device);
    expect(newest).not.toBe(older);

    const res = nackBy(a, "bob", device, msgid);

    expect(res.events).toEqual([]);
    expect(res.outbound.map((o) => [o.verb, o.to, o.tag])).toEqual([["msg", didOf(device), "one"]]);
    expect(opened(device, "msg", res.outbound[0]?.payload ?? "").body).toBe("one");
    expect((a.state.sessions[device.curve25519_key()] ?? []).map(sessionIdOf)).toEqual([newest]);
    expect(a.state.keyreqSentAt).toEqual({});
    expect(a.state.rekeyAt).toEqual({});
  });

  it("acts only on the NACK of a device the message went to, and on each device's NACK of it once", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [target, other] = bob.devices as [Account, Account];
    knownPeer(a, "bob", bob, 1);
    const [msgid] = named(a, sends(a, "bob", "only you", target));
    const before = structuredClone(a.state);
    const unknown = { kind: "dropped", nick: "bob", reason: "unknown-nack-ref", verb: "nack" };

    expect(nackBy(a, "bob", other, msgid)).toEqual({ events: [unknown], outbound: [] });
    expect(a.state).toEqual(before);
    expect(verbsOf(nackBy(a, "bob", target, msgid))).toEqual(["keyreq"]);
    expect(nackBy(a, "bob", target, msgid)).toEqual({ events: [unknown], outbound: [] });
    expect(eventsOf(a, "rekeying")).toHaveLength(1);
  });

  it("starts one re-key per nick a minute however many devices NACK: one NACKing while keys are asked for joins it, one after them is refused a new session", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [one, two] = bob.devices as [Account, Account];
    knownPeer(a, "bob", bob, 1);
    const [first] = named(a, sends(a, "bob", "first", null));

    expect(verbsOf(nackBy(a, "bob", one, first))).toEqual(["keyreq"]);
    // The other device's NACK joins the re-key under way: no KEYREQ, no re-key
    // of its own. No device holds the message now, so it waits as queued.
    expect(nackBy(a, "bob", two, first)).toEqual({
      events: [{ kind: "send_queued", nick: "bob", queued: 2, tag: "first" }],
      outbound: [],
    });
    expect(eventsOf(a, "rekeying").map((e) => e.device)).toEqual([keyOf(one)]);
    expect(a.state.sessions).toEqual({});
    const keys = keysFrom(a, "bob", bob, 1, bob.devices, [one, two]);
    expect(keys.outbound.map((o) => [o.verb, o.to, o.tag])).toEqual([
      ["pkmsg", didOf(one), "first"],
      ["pkmsg", didOf(two), "first"],
    ]);

    // Within the minute a NACK on the fresh session gets no new one: the message
    // is lost, unless it reached another device; the failed session stays.
    a.now += REKEY_INTERVAL_MS - 1;
    const [second] = named(a, sends(a, "bob", "second", one));
    const [third] = named(a, sends(a, "bob", "third", null));
    const sessions = structuredClone(a.state.sessions);
    expect(nackBy(a, "bob", one, second).outbound).toEqual([]);
    expect(nackBy(a, "bob", one, third).outbound).toEqual([]);
    expect(failedOf(a)).toEqual([["rekey-throttled", ["second"]]]);
    expect(a.state.sessions).toEqual(sessions);
    // A minute after the re-key, the next NACK starts one.
    a.now += 1;
    expect(verbsOf(nackBy(a, "bob", two, third))).toEqual(["keyreq"]);
    expect(eventsOf(a, "rekeying").map((e) => e.device)).toEqual([keyOf(one), keyOf(two)]);
  });

  it("gives a message up once its re-send is NACKed too", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    knownPeer(a, "bob", bob, 1);
    const [first] = named(a, sends(a, "bob", "hello", null));
    nackBy(a, "bob", device, first);
    const [again] = named(a, keysFrom(a, "bob", bob, 1, bob.devices, [device]));

    expect(nackBy(a, "bob", device, again).outbound).toEqual([]);

    expect(failedOf(a)).toEqual([["resend-failed", ["hello"]]]);
    expect(eventsOf(a, "rekeying")).toHaveLength(1);
  });

  it("never acts on the word of another nick, nor for a nick pinned to another master since: the message is lost, as sent to its nick", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    knownPeer(a, "Bob", bob, 1);
    const [one] = named(a, sends(a, "Bob", "one", null));
    const [two] = named(a, sends(a, "Bob", "two", null));

    expect(nackBy(a, "carol", device, one).outbound).toEqual([]);
    engineOf(a).pin("bob", keyOf(peerWith(1).master), false);
    const sessions = structuredClone(a.state.sessions);
    expect(nackBy(a, "bob", device, two).outbound).toEqual([]);

    expect(failedOf(a)).toEqual([
      ["nack-from-another-nick", ["one"]],
      ["repinned", ["two"]],
    ]);
    expect(eventsOf(a, "send_failed")[0]?.nick).toBe("Bob");
    expect(eventsOf(a, "rekeying")).toEqual([]);
    expect(a.state.sessions).toEqual(sessions);
  });

  it("knows no NACK for a message long forgotten, nor for one of a chat the user deleted", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    knownPeer(a, "bob", bob, 1);
    const [old] = named(a, sends(a, "bob", "old", null));
    a.now += SENT_MEMORY_MS + 1;
    record(a, engineOf(a).tick());
    expect(a.state.sent).toEqual([]);
    const [deleted] = named(a, sends(a, "bob", "deleted", null));
    engineOf(a).forget("bob");

    nackBy(a, "bob", device, old);
    nackBy(a, "bob", device, deleted);

    expect(dropsOf(a)).toEqual(["unknown-nack-ref", "unknown-nack-ref"]);
    expect(eventsOf(a, "rekeying")).toEqual([]);
  });

  it("re-keys a device NACKing its newest session though it holds an older one: the keys open it a fresh session, and the message goes on that", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    const curve = device.curve25519_key();
    knownPeer(a, "bob", bob, 1);
    const older = sessionTo(a, device);
    takes(
      a,
      "bob",
      "pkmsg",
      didOf(device),
      written(a, bob, device, text("hi"), "one-time"),
      newMsgid(),
    );
    const [msgid] = named(a, sends(a, "bob", "lost", null));

    expect(verbsOf(nackBy(a, "bob", device, msgid))).toEqual(["keyreq"]);
    expect((a.state.sessions[curve] ?? []).map(sessionIdOf)).toEqual([older]);
    expect(a.state.outq.bob?.map((q) => q.msg.tag)).toEqual(["lost"]);

    const keys = keysFrom(a, "bob", bob, 1, bob.devices, [device]);

    const fresh = sessionTo(a, device);
    expect((a.state.sessions[curve] ?? []).map(sessionIdOf)).toEqual([fresh, older]);
    expect(keys.outbound.map((o) => [o.verb, o.to, o.tag])).toEqual([
      ["pkmsg", didOf(device), "lost"],
    ]);
    const payload = keys.outbound[0]?.payload ?? "";
    expect(olm().pre_key_session_id(unbase64(bodiesOf(payload)[didOf(device)] ?? ""))).toBe(fresh);
    expect(opened(device, "pkmsg", payload).body).toBe("lost");
    expect(a.state.outq).toEqual({});
  });

  it("waits for keys to send a message again to a device its certificate admits, whose session a NACK dropped: never an unknown device", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [listed, fresh] = bob.devices as [Account, Account];
    listedPeer(a, "bob", { master: bob.master, devices: [listed] }, 1);
    // The new device writes first, on a certificate of the next version.
    takes(
      a,
      "bob",
      "pkmsg",
      didOf(fresh),
      {
        ...written(a, bob, fresh, text("my new laptop"), "one-time"),
        master: certified(bob, fresh, 2),
      },
      newMsgid(),
    );
    const [msgid] = named(a, sends(a, "bob", "welcome", fresh));

    expect(verbsOf(nackBy(a, "bob", fresh, msgid))).toEqual(["keyreq"]);

    expect(a.state.outq.bob?.map((q) => [q.msg.tag, q.only])).toEqual([["welcome", keyOf(fresh)]]);
    expect(failedOf(a)).toEqual([]);
  });

  it("drops the NACK of a device its master no longer vouches for: no re-key, no re-send, and the re-key budget stays", () => {
    const a = me("alice");
    const bob = peerWith(3);
    const [kept, gone, lapsed] = bob.devices as [Account, Account, Account];
    const M = keyOf(bob.master);
    knownPeer(a, "bob", { master: bob.master, devices: [kept, gone] }, 1);
    takes(
      a,
      "bob",
      "pkmsg",
      didOf(lapsed),
      { ...written(a, bob, lapsed, text("hi"), "one-time"), master: certified(bob, lapsed, 2) },
      newMsgid(),
    );
    const res = sends(a, "bob", "x", null);
    expect(res.outbound.map((o) => [o.verb, o.to])).toEqual([
      ["msg", didOf(lapsed)],
      ["pkmsg", "*"],
    ]);
    const [toLapsed, toListed] = named(a, res);
    // A list at the certificate's version names neither.
    trust(engineOf(a)).applyList(M, listOf(2, [kept]));

    expect(nackBy(a, "bob", gone, toListed)).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "revoked-device", verb: "nack" }],
      outbound: [],
    });
    expect(nackBy(a, "bob", lapsed, toLapsed)).toEqual({
      events: [{ kind: "dropped", nick: "bob", reason: "stale-certificate", verb: "nack" }],
      outbound: [],
    });
    expect(a.state.rekeyAt).toEqual({});
    expect(a.state.keyreqSentAt).toEqual({});
    expect(a.state.outq).toEqual({});
    expect(eventsOf(a, "rekeying")).toEqual([]);
  });
});

describe("a NACK, and what its device became since", () => {
  it("drops the NACK of a device bound under another master since the message went to it", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    knownPeer(a, "bob", bob, 1);
    const [msgid] = named(a, sends(a, "bob", "x", null));
    // The same device key writes under another master, from another nick.
    const carol: PeerIdentity = { master: new (olm().Account)(), devices: [device] };
    takes(
      a,
      "carol",
      "pkmsg",
      didOf(device),
      written(a, carol, device, text("me"), "one-time"),
      newMsgid(),
    );
    expect(a.state.devices[keyOf(device)]?.master).toBe(keyOf(carol.master));

    // Its only payload went to that device: the message is lost.
    expect(nackBy(a, "bob", device, msgid)).toEqual({
      events: [
        { kind: "dropped", nick: "bob", reason: "revoked-device", verb: "nack" },
        { kind: "send_failed", nick: "bob", reason: "unpinned-key", tags: ["x"] },
      ],
      outbound: [],
    });
    expect(a.state.rekeyAt).toEqual({});
    expect(a.state.keyreqSentAt).toEqual({});
  });

  it("reports a message lost when the device its last payload went to NACKs it after its master stopped vouching for it, and only then", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [kept, gone] = bob.devices as [Account, Account];
    knownPeer(a, "bob", bob, 1);
    const [alone] = named(a, sends(a, "bob", "to gone", gone));
    const [both] = named(a, sends(a, "bob", "to both", null));
    trust(engineOf(a)).applyList(keyOf(bob.master), listOf(2, [kept]));
    const disowned = { kind: "dropped", nick: "bob", reason: "revoked-device", verb: "nack" };

    // The other device has the second message.
    expect(nackBy(a, "bob", gone, both)).toEqual({ events: [disowned], outbound: [] });
    expect(nackBy(a, "bob", gone, alone)).toEqual({
      events: [
        disowned,
        { kind: "send_failed", nick: "bob", reason: "unpinned-key", tags: ["to gone"] },
      ],
      outbound: [],
    });
    expect(a.state.rekeyAt).toEqual({});
    expect(a.state.keyreqSentAt).toEqual({});
    expect(a.state.outq).toEqual({});
  });

  it("forgets a device's re-key with its sessions once a newer list revokes it", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [kept, gone] = bob.devices as [Account, Account];
    knownPeer(a, "bob", bob, 1);
    const [msgid] = named(a, sends(a, "bob", "x", null));
    nackBy(a, "bob", gone, msgid);
    expect(a.state.rekeying).toEqual({ [keyOf(gone)]: true });

    trust(engineOf(a)).applyList(keyOf(bob.master), listOf(2, [kept]));

    expect(a.state.rekeying).toEqual({});
  });
});

describe("device lists inside Olm (lv, t:list, t:listreq)", () => {
  it("names our own list's version in every inner message it writes, over any the caller put there, and hands on none of a peer's", () => {
    const a = me("alice");
    const ours = a.own.list.devices;
    a.own.list = { ver: 3, devices: ours, sig: a.master.sign(listSigText(3, ours)) };
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);

    const res = engineOf(a).send(
      "bob",
      { t: "text", body: "x", lv: 99, fb: "forged" },
      "x",
      null,
      null,
    );
    const peer = takes(
      a,
      "bob",
      "msg",
      didOf(device),
      msgFrom(a, device, '{"t":"text","body":"y","lv":1}'),
      newMsgid(),
    );

    expect(opened(device, "pkmsg", res.outbound[0]?.payload ?? "")).toEqual({
      t: "text",
      body: "x",
      lv: 3,
      fb: fb(olm(), keyOf(a.account), keyOf(device)),
    });
    expect(peer).toEqual({
      events: [
        {
          kind: "received",
          nick: "bob",
          master: keyOf(bob.master),
          device: keyOf(device),
          verified: false,
          inner: text("y"),
        },
      ],
      outbound: [],
    });
  });

  it("asks a device whose message names a newer list than the stored one for it: once per version, and once per nick a minute", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);
    const says = (lv: number): Result =>
      takes(
        a,
        "bob",
        "msg",
        didOf(device),
        msgFrom(a, device, JSON.stringify({ t: "text", body: `lv ${lv}`, lv })),
        newMsgid(),
      );

    expect(says(1).outbound).toEqual([]);
    const asked = says(2);
    expect(asked.outbound.map((o) => [o.verb, o.to, o.priority, o.tag])).toEqual([
      ["msg", didOf(device), "reactive", LIST_TAG],
    ]);
    expect(opened(device, "msg", asked.outbound[0]?.payload ?? "")).toEqual({
      t: "listreq",
      lv: 1,
    });
    expect(says(2).outbound).toEqual([]);
    expect(says(3).outbound).toEqual([]);
    a.now += LISTREQ_INTERVAL_MS;
    expect(says(2).outbound).toEqual([]);
    expect(verbsOf(says(3))).toEqual(["msg"]);
    a.now += LISTREQ_INTERVAL_MS;
    expect(verbsOf(says(5))).toEqual(["msg"]);
    // Never a high-water mark: a lower version not asked for yet is asked.
    a.now += LISTREQ_INTERVAL_MS;
    expect(verbsOf(says(4))).toEqual(["msg"]);

    expect(readBy(a).map((inner) => inner.body)).toEqual([
      "lv 1",
      "lv 2",
      "lv 2",
      "lv 3",
      "lv 2",
      "lv 3",
      "lv 5",
      "lv 4",
    ]);
    expect(a.events.filter((e) => e.kind !== "received")).toEqual([]);
  });

  it("applies a t:list from a device of the pinned master as a KEYS list: a higher version revokes a device it leaves out, and nothing of it is shown", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [keeper, gone] = bob.devices as [Account, Account];
    const M = keyOf(bob.master);
    talking(a, "bob", bob, keeper);
    bind(a, bob.master, gone);
    const list = { t: "list", master: masterBlock(bob, 2, [keeper]), lv: 2 };

    const res = takes(
      a,
      "bob",
      "msg",
      didOf(keeper),
      msgFrom(a, keeper, JSON.stringify(list)),
      newMsgid(),
    );

    expect(res).toEqual({ events: [], outbound: [] });
    expect(a.state.masters[M]).toMatchObject({
      ...listOf(2, [keeper]),
      revoked: [keyOf(gone)],
      revokedCurves: [gone.curve25519_key()],
    });
    expect(a.state.sessions[gone.curve25519_key()]).toBeUndefined();
    expect(
      trust(engineOf(a))
        .trustedDevices(M)
        .map((d) => d.ed25519),
    ).toEqual([keyOf(keeper)]);
  });

  it("drops a t:list its master did not sign or that holds no list, and raises the alarm for one of another master: nothing is applied", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    const mallory = peerWith(1);
    talking(a, "bob", bob, device);
    const masters = structuredClone(a.state.masters);
    const says = (inner: Record<string, unknown>): Result =>
      takes(a, "bob", "msg", didOf(device), msgFrom(a, device, JSON.stringify(inner)), newMsgid());
    const forged = {
      ...masterBlock(bob, 2, [device]),
      sig: mallory.master.sign(listSigText(2, [keyOf(device)])),
    };

    says({ t: "list", master: forged, lv: 1 });
    says({ t: "list", master: "a list", lv: 1 });
    says({ t: "list", lv: 1 });
    says({ t: "list", master: masterBlock(mallory, 2, mallory.devices), lv: 1 });

    expect(a.events).toEqual([
      { kind: "dropped", nick: "bob", reason: "bad-list" },
      { kind: "dropped", nick: "bob", reason: "bad-list" },
      { kind: "dropped", nick: "bob", reason: "bad-list" },
      {
        kind: "key_alarm",
        nick: "bob",
        pinned: keyOf(bob.master),
        presented: keyOf(mallory.master),
      },
    ]);
    expect(a.state.masters).toEqual(masters);
  });

  it("answers a listreq with our list, to the device that asked alone, once per device a minute", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [one, two] = bob.devices as [Account, Account];
    talking(a, "bob", bob, one, two);
    const asks = (device: Account): Result =>
      takes(
        a,
        "bob",
        "msg",
        didOf(device),
        msgFrom(a, device, '{"t":"listreq","lv":1}'),
        newMsgid(),
      );

    const answer = asks(one);

    expect(answer.outbound.map((o) => [o.verb, o.to, o.priority, o.tag])).toEqual([
      ["msg", didOf(one), "reactive", LIST_TAG],
    ]);
    const inner = opened(one, "msg", answer.outbound[0]?.payload ?? "");
    expect(inner).toEqual({
      t: "list",
      master: {
        ed25519: a.own.master,
        list: { ver: 1, devices: a.own.list.devices },
        sig: a.own.list.sig,
      },
      lv: 1,
    });
    expect(validMasterList(olm(), inner.master as MasterList)).toBe(true);
    expect(asks(one).outbound).toEqual([]);
    expect(asks(one).outbound).toEqual([]);
    expect(verbsOf(asks(two))).toEqual(["msg"]);
    expect(dropsOf(a)).toEqual(["listreq-rate-limited", "listreq-rate-limited"]);
    a.now += LISTREQ_INTERVAL_MS;
    expect(verbsOf(asks(one))).toEqual(["msg"]);
    expect(readBy(a)).toEqual([]);
  });

  it("asks a nick pinned by hand for its list, waiting behind the keys it asks for, then on the reactive lane to every device, and says nothing of it", async () => {
    const g = new Grappa();
    const a = me("alice");
    await joined(g, a);
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    await enrolled(g, "Bob", bob, 1, bob.devices);

    const pin = engineOf(a).pin("bob", keyOf(bob.master), true);

    expect(pin).toEqual({ outcome: "pinned", events: [], outbound: [keyreqOf(a, "bob")] });
    expect(a.state.outq.bob?.map((q) => [q.msg.tag, q.only, q.done])).toEqual([
      [LIST_TAG, null, []],
    ]);
    await toDoor(g, a, pin);
    await pump(g, a);
    const [listreq, ...more] = g.sends.filter((s) => s.verb !== "keyreq");
    expect(more).toEqual([]);
    expect([listreq?.verb, listreq?.to, listreq?.priority]).toEqual([
      "pkmsg",
      didOf(device),
      "reactive",
    ]);
    expect(await read(g, "Bob", device)).toEqual([
      {
        verb: "pkmsg",
        inner: { t: "listreq", lv: 1, fb: fb(olm(), keyOf(a.account), keyOf(device)) },
      },
    ]);
    expect(a.events).toEqual([]);
    expect(a.state.outq).toEqual({});
    // Not the caller's either when grappa drops it.
    expect(engineOf(a).dropped(listreq?.msgid ?? "")).toBeUndefined();
  });

  it("asks the nick a SAS ran with for its list once it verifies the master, and only through that nick's pin", () => {
    const a = me("alice");
    const bob = peerWith(1);
    const [device] = bob.devices as [Account];
    talking(a, "bob", bob, device);

    const res = engineOf(a).verify("bob", keyOf(bob.master));
    const elsewhere = engineOf(a).verify("carol", keyOf(bob.master));

    expect(res.outbound.map((o) => [o.verb, o.to, o.priority, o.tag])).toEqual([
      ["pkmsg", didOf(device), "reactive", LIST_TAG],
    ]);
    expect(opened(device, "pkmsg", res.outbound[0]?.payload ?? "")).toMatchObject({
      t: "listreq",
      lv: 1,
    });
    expect(elsewhere).toEqual({ events: [], outbound: [] });
    expect(engineOf(a).pinned("bob")?.verified).toBe(true);
    expect(a.state.pins).toEqual({ bob: keyOf(bob.master) });
  });

  it("refuses the tag of its own list traffic to a caller: nothing of the engine's can pass for a caller's message", () => {
    const a = me("alice");

    expect(() => engineOf(a).send("bob", text("x"), LIST_TAG, null, null)).toThrow(LIST_TAG);
    expect(a.state).toEqual(newState());
  });

  it("asks the master a nick is re-pinned to by hand for its list once the minute allows, though the ask spent it on the master the alarm replaced", () => {
    const a = me("alice");
    const m1 = peerWith(1);
    const m2 = peerWith(1);
    const [device] = m2.devices as [Account];
    expect(verbsOf(record(a, engineOf(a).pin("bot", keyOf(m1.master), true)))).toEqual(["keyreq"]);
    // The keys show another master: the alarm, and the ask queued for the first goes nowhere.
    keysFrom(a, "bot", m2, 1, m2.devices, [device]);
    expect(eventsOf(a, "key_alarm")).toHaveLength(1);
    a.now += 10_000;

    // The user takes the master the alarm showed: the minute holds the ask back, never away.
    expect(record(a, engineOf(a).pin("bot", keyOf(m2.master), false))).toEqual({
      outcome: "pinned",
      events: [],
      outbound: [],
    });
    a.now += LISTREQ_INTERVAL_MS - 10_001;
    expect(record(a, engineOf(a).tick()).outbound).toEqual([]);
    a.now += 1;
    expect(record(a, engineOf(a).tick()).outbound).toEqual([keyreqOf(a, "bot")]);
    const keys = keysFrom(a, "bot", m2, 1, m2.devices, [device]);

    expect(keys.outbound.map((o) => [o.verb, o.to, o.priority, o.tag])).toEqual([
      ["pkmsg", didOf(device), "reactive", LIST_TAG],
    ]);
    expect(opened(device, "pkmsg", keys.outbound[0]?.payload ?? "")).toMatchObject({
      t: "listreq",
    });
    // Gone, it is asked no more.
    a.now += LISTREQ_INTERVAL_MS;
    expect(record(a, engineOf(a).tick()).outbound).toEqual([]);
    expect(a.events.filter((e) => e.kind === "send_failed" || e.kind === "send_queued")).toEqual(
      [],
    );
  });

  it("holds a pin's ask while no line budget is published, and sends it on the first tick that has one: the minute is spent only on a listreq that goes", () => {
    const a = me("alice");
    const bot = peerWith(1);
    const unsized = new Engine(olm(), a.account, a.own, a.state, a.nick, null, () => a.now);

    expect(record(a, unsized.pin("bot", keyOf(bot.master), true))).toEqual({
      outcome: "pinned",
      events: [],
      outbound: [],
    });
    expect(record(a, unsized.tick()).outbound).toEqual([]);
    expect(record(a, engineOf(a).tick()).outbound).toEqual([keyreqOf(a, "bot")]);

    expect(a.state.outq.bot?.map((q) => q.msg.tag)).toEqual([LIST_TAG]);
    expect(a.events).toEqual([]);
  });

  it("never holds a list ask for our own nick: a pin to it asks nothing, and nothing waits on the clock", () => {
    const a = me("alice");

    const pin = record(a, engineOf(a).pin("Alice", keyOf(peerWith(1).master), false));

    expect(pin).toEqual({ outcome: "pinned", events: [], outbound: [] });
    expect(a.state.listreqHeld).toEqual({});
    expect(engineOf(a).waitsOnTheClock()).toBe(false);
  });

  it("drops a held list ask once the nick it waits for is ours", () => {
    const a = me("alice");
    const unsized = new Engine(olm(), a.account, a.own, a.state, a.nick, null, () => a.now);
    record(a, unsized.pin("bob", keyOf(peerWith(1).master), true));
    expect(a.state.listreqHeld).toEqual({ bob: "bob" });

    a.nick = "Bob";
    const tick = record(a, engineOf(a).tick());

    expect(tick).toEqual({ events: [], outbound: [] });
    expect(a.state.listreqHeld).toEqual({});
    expect(engineOf(a).waitsOnTheClock()).toBe(false);
  });

  it("holds a pin's ask through the minute a device's own listreq spent, then sends it to every device of the nick", () => {
    const a = me("alice");
    const bot = peerWith(2);
    const [one, two] = bot.devices as [Account, Account];
    talking(a, "bot", bot, one, two);
    // The first device names a newer list: it alone is asked for it.
    const lv = takes(
      a,
      "bot",
      "msg",
      didOf(one),
      msgFrom(a, one, '{"t":"text","body":"x","lv":2}'),
      newMsgid(),
    );
    expect(lv.outbound.map((o) => [o.to, o.tag])).toEqual([[didOf(one), LIST_TAG]]);
    a.now += 1;

    expect(record(a, engineOf(a).pin("bot", keyOf(bot.master), true)).outbound).toEqual([]);
    a.now += LISTREQ_INTERVAL_MS - 2;
    expect(record(a, engineOf(a).tick()).outbound).toEqual([]);
    a.now += 1;
    const tick = record(a, engineOf(a).tick());

    expect(tick.outbound.map((o) => [o.verb, o.to, o.tag])).toEqual([
      ["msg", didOf(one), LIST_TAG],
      ["pkmsg", didOf(two), LIST_TAG],
    ]);
    expect(opened(two, "pkmsg", tick.outbound[1]?.payload ?? "")).toMatchObject({ t: "listreq" });
  });

  it("holds a pin's ask the full queue had no room for, and sends it once the queue drains", () => {
    const a = me("alice");
    for (let i = 0; i < OUTQ_MAX; i++)
      record(a, engineOf(a).send("bot", text(`m${i}`), `m${i}`, null, null));

    expect(record(a, engineOf(a).pin("bot", keyOf(peerWith(1).master), true)).outbound).toEqual([]);
    a.now += OUTQ_TTL_MS;
    const tick = record(a, engineOf(a).tick());

    expect(tick.outbound).toEqual([keyreqOf(a, "bot")]);
    expect(a.state.outq.bot?.map((q) => q.msg.tag)).toEqual([LIST_TAG]);
  });

  it("never reports its own list traffic lost: a listreq to a nick that never answers lapses without a word", () => {
    const a = me("alice");

    record(a, engineOf(a).pin("nobody", keyOf(peerWith(1).master), false));
    a.now += OUTQ_TTL_MS;
    record(a, engineOf(a).tick());

    expect(a.events).toEqual([]);
    expect(a.state.outq).toEqual({});
  });

  it("reports in a pin's own result a message the pin's list ask found lapsed in the queue", () => {
    const a = me("alice");
    record(a, engineOf(a).send("bob", text("x"), "x", null, null));
    a.now += OUTQ_TTL_MS;

    const pin = engineOf(a).pin("bob", keyOf(peerWith(1).master), true);

    expect(pin.events).toEqual([
      { kind: "send_failed", nick: "bob", reason: "keys-timeout", tags: ["x"] },
    ]);
  });

  it("reports in a SAS verification's own result a message its list ask found lapsed in the queue", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [talked, keyless] = bob.devices as [Account, Account];
    talking(a, "bob", bob, talked);
    record(a, engineOf(a).send("bob", text("x"), "x", null, keyOf(keyless)));
    a.now += OUTQ_TTL_MS;

    const res = engineOf(a).verify("bob", keyOf(bob.master));

    expect(res.events).toEqual([
      { kind: "send_failed", nick: "bob", reason: "keys-timeout", tags: ["x"] },
    ]);
  });
});

describe("what a copy that went somewhere changes", () => {
  it("reports no copy lost while another copy of the message waits for a device, and the message once nothing of it reached one", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [k] = bob.devices as [Account, Account];
    talking(a, "bob", bob, k);
    // k was re-keyed a moment ago: the next re-key is a minute away.
    const [first] = named(a, sends(a, "bob", "first", k));
    nackBy(a, "bob", k, first);
    keysFrom(a, "bob", bob, 1, bob.devices, [k]);
    // The message reaches k and waits for the other device, which has no keys on grappa.
    const [msgid] = named(a, sends(a, "bob", "second", null));
    expect(a.state.outq.bob?.map((q) => [q.msg.tag, q.only])).toEqual([["second", null]]);

    expect(nackBy(a, "bob", k, msgid).outbound).toEqual([]);
    expect(failedOf(a)).toEqual([]);
    a.now += OUTQ_TTL_MS;
    record(a, engineOf(a).tick());

    expect(failedOf(a)).toEqual([["keys-timeout", ["second"]]]);
  });

  it("judges a lapsing copy against a copy of its message still waiting beside it, and reports the message when the last one lapses", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [d1] = bob.devices as [Account, Account];
    talking(a, "bob", bob, d1);
    // It reaches d1 and waits for the other device, which has no keys on grappa.
    const [msgid] = named(a, sends(a, "bob", "late", null));
    a.now += KEYREQ_RETRY_MS + 10_000;
    // d1 NACKs it once that KEYREQ is old: a re-key, and a copy for d1 waits beside the first.
    expect(verbsOf(nackBy(a, "bob", d1, msgid))).toEqual(["keyreq"]);
    expect(a.state.outq.bob?.map((q) => q.only)).toEqual([null, keyOf(d1)]);

    a.now = NOW + OUTQ_TTL_MS;
    record(a, engineOf(a).tick());
    expect(a.state.outq.bob?.map((q) => q.only)).toEqual([keyOf(d1)]);
    expect(failedOf(a)).toEqual([]);
    a.now += OUTQ_TTL_MS;
    record(a, engineOf(a).tick());

    expect(failedOf(a)).toEqual([["keys-timeout", ["late"]]]);
  });

  it("judges a copy that can no longer go at a flush against a copy of its message still waiting there", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [gone, kept] = bob.devices as [Account, Account];
    knownPeer(a, "bob", bob, 1);
    const [msgid] = named(a, sends(a, "bob", "both", null));
    nackBy(a, "bob", gone, msgid);
    nackBy(a, "bob", kept, msgid);

    // The keys bring a list that drops one device, and no keys for the other.
    expect(keysFrom(a, "bob", bob, 2, [kept], []).outbound).toEqual([]);
    expect(a.state.outq.bob?.map((q) => q.only)).toEqual([keyOf(kept)]);
    expect(failedOf(a)).toEqual([]);
    a.now += OUTQ_TTL_MS;
    record(a, engineOf(a).tick());

    expect(failedOf(a)).toEqual([["keys-timeout", ["both"]]]);
  });

  it("judges a copy that lapsed unticked when a NACK re-sends its message only once the re-send waits: no loss, and the keys deliver it", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [d1] = bob.devices as [Account, Account];
    talking(a, "bob", bob, d1);
    // It reaches d1 and waits for the other device, which has no keys on grappa.
    const [msgid] = named(a, sends(a, "bob", "late", null));
    // A drain takes the whole inbox before it ticks: the copy lapsed, unreported.
    a.now += OUTQ_TTL_MS;

    expect(nackBy(a, "bob", d1, msgid)).toEqual({
      events: [
        { kind: "rekeying", nick: "bob", master: keyOf(bob.master), device: keyOf(d1) },
        { kind: "send_queued", nick: "bob", queued: 1, tag: "late" },
      ],
      outbound: [keyreqOf(a, "bob")],
    });
    const keys = keysFrom(a, "bob", bob, 1, bob.devices, [d1]);

    expect(keys.outbound.map((o) => [o.verb, o.to, o.tag])).toEqual([["pkmsg", didOf(d1), "late"]]);
    expect(opened(d1, "pkmsg", keys.outbound[0]?.payload ?? "").body).toBe("late");
    expect(failedOf(a)).toEqual([]);
  });

  it("reports a message at most once in one step, under the first reason the step met for it", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [d1] = bob.devices as [Account, Account];
    talking(a, "bob", bob, d1);
    // It reaches d1 and waits for the other device; d1's NACK joins the KEYREQ out.
    const [msgid] = named(a, sends(a, "bob", "late", null));
    expect(nackBy(a, "bob", d1, msgid).outbound).toEqual([]);
    expect(a.state.outq.bob?.map((q) => q.only)).toEqual([null, keyOf(d1)]);
    // The keys come to an engine with no line budget, with a list dropping the
    // other device: the first copy has nowhere to go, the second cannot be sized.
    const unsized = new Engine(olm(), a.account, a.own, a.state, a.nick, null, () => a.now);

    const res = record(
      a,
      unsized.receive(
        "bob",
        "keys",
        newMsgid(),
        "*",
        keysPayload(bob, 2, [d1], [entryOf(d1, bob.master)]),
      ),
    );

    expect(res.outbound).toEqual([]);
    expect(failedOf(a)).toEqual([["unpinned-key", ["late"]]]);
    expect(a.state.outq).toEqual({});
  });

  it("reports a message once when every copy of it lapses together", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [d1, d2] = bob.devices as [Account, Account];
    knownPeer(a, "bob", bob, 1);
    const [msgid] = named(a, sends(a, "bob", "both", null));
    nackBy(a, "bob", d1, msgid);
    nackBy(a, "bob", d2, msgid);
    expect(a.state.outq.bob).toHaveLength(2);

    a.now += OUTQ_TTL_MS;
    record(a, engineOf(a).tick());

    expect(failedOf(a)).toEqual([["keys-timeout", ["both"]]]);
  });

  it("reports nothing when a copy waiting for one device lapses after another copy of the message reached the other device", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [d1, d2] = bob.devices as [Account, Account];
    knownPeer(a, "bob", bob, 1);
    const [msgid] = named(a, sends(a, "bob", "both", null));
    nackBy(a, "bob", d1, msgid);
    nackBy(a, "bob", d2, msgid);
    // The keys bring a fresh session to the first device alone.
    const keys = keysFrom(a, "bob", bob, 1, bob.devices, [d1]);
    expect(keys.outbound.map((o) => [o.to, o.tag])).toEqual([[didOf(d1), "both"]]);
    expect(opened(d1, "pkmsg", keys.outbound[0]?.payload ?? "").body).toBe("both");
    named(a, keys);

    a.now += OUTQ_TTL_MS;
    record(a, engineOf(a).tick());

    expect(failedOf(a)).toEqual([]);
    expect(a.state.outq).toEqual({});
  });

  it("never reports a message lost for a copy too long at a flush when another device already has it", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [answered, late] = bob.devices as [Account, Account];
    talking(a, "bob", bob, answered);
    answers(a, answered);
    // The longest text whose pre-key copy still reaches `late`, sized on a copy of the state where it is bound.
    const probe: Me = { ...a, state: structuredClone(a.state), events: [] };
    bind(probe, bob.master, late);
    const fits = (device: Account, size: number): boolean =>
      engineOf(probe).send("bob", text("x".repeat(size)), "probe", null, keyOf(device)).outbound
        .length > 0;
    let size = 10_000;
    while (fits(late, size)) size += 64;
    expect(fits(answered, size)).toBe(true);
    const sent = sends(a, "bob", "x".repeat(size), null);
    expect(sent.outbound.map((o) => [o.verb, o.to])).toEqual([
      ["msg", didOf(answered)],
      ["keyreq", "*"],
    ]);

    const keys = keysFrom(a, "bob", bob, 1, bob.devices, [late]);

    expect(keys.outbound).toEqual([]);
    expect(failedOf(a)).toEqual([]);
    expect(a.state.outq).toEqual({});
  });

  it("asks for keys again on a tick only for what reached no device yet, and for a re-key whose KEYREQ waited out the budget, which a NACK meanwhile joins", () => {
    // Bob's third device has no keys on grappa: a message reaches the other two
    // and waits for it, and the KEYS that answered leaves it waiting.
    const waiting = (): {
      a: Me;
      bob: PeerIdentity;
      one: Account;
      two: Account;
      keyless: Account;
    } => {
      const a = me("alice");
      const bob = peerWith(3);
      const [one, two, keyless] = bob.devices as [Account, Account, Account];
      talking(a, "bob", bob, one, two);
      expect(verbsOf(sends(a, "bob", "went", null))).toEqual(["pkmsg", "keyreq"]);
      keysFrom(a, "bob", bob, 1, bob.devices, []);
      expect(a.state.outq.bob?.map((q) => q.done.length)).toEqual([2]);
      return { a, bob, one, two, keyless };
    };

    const went = waiting();
    went.a.now += KEYREQ_RETRY_MS;
    expect(record(went.a, engineOf(went.a).tick()).outbound).toEqual([]);

    const none = waiting();
    none.a.now += 1;
    expect(sends(none.a, "bob", "nowhere", none.keyless).outbound).toEqual([]);
    none.a.now += KEYREQ_RETRY_MS;
    expect(record(none.a, engineOf(none.a).tick()).outbound).toEqual([keyreqOf(none.a, "bob")]);

    // A NACK of a message the other device has: its re-send reached a device
    // too, and only the re-key it waits on asks again.
    const rekey = waiting();
    rekey.a.now += 1;
    const [msgid] = named(rekey.a, sends(rekey.a, "bob", "again", null));
    expect(nackBy(rekey.a, "bob", rekey.one, msgid)).toEqual({
      events: [expect.objectContaining({ kind: "rekeying" })],
      outbound: [],
    });
    expect(rekey.a.state.sent.some((s) => s.msg.tag === "again")).toBe(true);
    rekey.a.now += KEYREQ_RETRY_MS;
    expect(record(rekey.a, engineOf(rekey.a).tick()).outbound).toEqual([keyreqOf(rekey.a, "bob")]);

    // Another device NACKing before that KEYREQ joins the re-key it waits on.
    const joined = waiting();
    joined.a.now += 1;
    const [both] = named(joined.a, sends(joined.a, "bob", "again", null));
    nackBy(joined.a, "bob", joined.one, both);
    expect(nackBy(joined.a, "bob", joined.two, both)).toEqual({
      events: [{ kind: "send_queued", nick: "bob", queued: 4, tag: "again" }],
      outbound: [],
    });
    expect(eventsOf(joined.a, "rekeying")).toHaveLength(1);
    expect(failedOf(joined.a)).toEqual([]);

    // A NACK that joins keys asked for anyway starts no re-key: once those keys
    // come without the device's, a message the other device has asks no more.
    const asked = waiting();
    asked.a.now += KEYREQ_RETRY_MS;
    const sentAgain = sends(asked.a, "bob", "again", null);
    expect(verbsOf(sentAgain)).toEqual(["pkmsg", "keyreq"]);
    const [again] = named(asked.a, sentAgain);
    asked.a.now += 1;
    expect(nackBy(asked.a, "bob", asked.one, again)).toEqual({ events: [], outbound: [] });
    keysFrom(asked.a, "bob", asked.bob, 1, asked.bob.devices, []);
    asked.a.now += KEYREQ_RETRY_MS;
    expect(record(asked.a, engineOf(asked.a).tick()).outbound).toEqual([]);
  });

  it("reports a message grappa dropped or refused only once no copy of it is left on its way or waiting", () => {
    const a = me("alice");
    const bob = peerWith(3);
    const [answered, silent, keyless] = bob.devices as [Account, Account, Account];
    talking(a, "bob", bob, answered);
    answers(a, answered);
    bind(a, bob.master, silent);
    const engine = () => engineOf(a);

    // One message, two msgids: a MSG to one device, a PKMSG to the other; the third waits for keys.
    const dropping = sends(a, "bob", "dropped", null);
    expect(dropping.outbound.map((o) => [o.verb, o.to])).toEqual([
      ["msg", didOf(answered)],
      ["pkmsg", didOf(silent)],
      ["keyreq", "*"],
    ]);
    const [toAnswered, toSilent] = named(a, dropping);
    expect(engine().dropped(toAnswered ?? "")).toBeUndefined();
    expect(engine().dropped(toSilent ?? "")).toBeUndefined();
    // The copies it never had are what it still waits to deliver: lapsing, it is lost.
    a.now += OUTQ_TTL_MS;
    record(a, engine().tick());
    expect(failedOf(a)).toEqual([["keys-timeout", ["dropped"]]]);

    // A message grappa refused outright, part by part.
    record(
      a,
      engine().receive(
        "bob",
        "keys",
        newMsgid(),
        "*",
        keysPayload(bob, 1, bob.devices, [entryOf(keyless, bob.master)]),
      ),
    );
    const refused = sends(a, "bob", "refused", null);
    const refs = refused.outbound.map((o) => o.ref ?? "");
    expect(refs).toHaveLength(2);
    expect(engine().discard(refs[0] ?? "")).toBeUndefined();
    expect(engine().discard(refs[1] ?? "")).toEqual({ nick: "bob", tag: "refused" });
    expect(engine().discard(refs[1] ?? "")).toBeUndefined();
  });

  it("keeps a message's record past its age while a NACKed copy of it waits for keys: the copy lapsing reports nothing another device has", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [, failing] = bob.devices as [Account, Account];
    knownPeer(a, "bob", bob, 1);
    const [msgid] = named(a, sends(a, "bob", "M", null));
    a.now += SENT_MEMORY_MS - 1000;
    nackBy(a, "bob", failing, msgid);
    a.now += 2000;
    record(a, engineOf(a).tick());
    a.now += OUTQ_TTL_MS;
    record(a, engineOf(a).tick());

    // The device that did not NACK holds M: nothing may report it lost.
    expect(failedOf(a)).toEqual([]);
    // Nothing of it waits any more: its record goes as any old one does.
    expect(a.state.sent).toEqual([]);
  });

  it("keeps a message's record past the cap while a NACKed copy of it waits for keys: the copy lapsing reports nothing another device has", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [, failing] = bob.devices as [Account, Account];
    knownPeer(a, "bob", bob, 1);
    knownPeer(a, "carol", peerWith(1), 1);
    const [msgid] = named(a, sends(a, "bob", "M", null));
    nackBy(a, "bob", failing, msgid);
    // M's record is the oldest when the cap is reached.
    for (let i = 0; i < SENT_MAX; i++) sends(a, "carol", `c${i}`, null);
    a.now += OUTQ_TTL_MS;
    record(a, engineOf(a).tick());

    expect(failedOf(a)).toEqual([]);
    expect(a.state.sent).toHaveLength(SENT_MAX);
  });

  it("judges a NACKed copy lapsing in the step that ages its message's record out with the record still there: nothing is reported", () => {
    const a = me("alice");
    const bob = peerWith(2);
    const [, failing] = bob.devices as [Account, Account];
    knownPeer(a, "bob", bob, 1);
    const [msgid] = named(a, sends(a, "bob", "M", null));
    a.now += SENT_MEMORY_MS - OUTQ_TTL_MS + 500;
    nackBy(a, "bob", failing, msgid);
    a.now += OUTQ_TTL_MS;
    record(a, engineOf(a).tick());

    expect(failedOf(a)).toEqual([]);
  });
});

describe("two cic devices, recovery", () => {
  it("re-keys after the peer lost its session: the NACK of the replay brings a fresh session, and the message goes again on it, once", async () => {
    const g = new Grappa();
    const a = me("alice");
    const b = me("bob");
    await joined(g, a);
    await joined(g, b);
    await uploadKeys(g, "bob", b.account);
    // Bob holds alice's list, as a KEYS he asked for left it.
    pinnedTo(b, "alice", a.own.master);
    trust(engineOf(b)).applyList(a.own.master, {
      ver: a.own.list.ver,
      devices: a.own.list.devices,
    });
    await say(g, a, "bob", "one");
    await pump(g, b);
    b.state.sessions = {};
    a.now += KEYREQ_RETRY_MS;

    await say(g, a, "bob", "two");
    await pump(g, b); // the replay is NACKed
    await pump(g, a); // the NACK: a re-key, whose KEYREQ brings a KEYS
    await pump(g, a); // the KEYS: a fresh session, and "two" again on it
    await pump(g, b);

    expect(eventsOf(b, "received").map((e) => e.inner.body)).toEqual(["one", "two"]);
    expect(eventsOf(b, "replayed")).toHaveLength(1);
    expect(eventsOf(a, "rekeying")).toHaveLength(1);
    expect(g.sends.filter((s) => s.by === "alice").map((s) => s.verb)).toEqual([
      "keyreq",
      "pkmsg",
      "pkmsg",
      "keyreq",
      "pkmsg",
    ]);
    expect(a.state.sent.map((s) => [s.msg.tag, s.msg.sends])).toEqual([
      ["one", 1],
      ["two", 2],
    ]);
    expect(a.state.sessions[b.account.curve25519_key()]).toHaveLength(1);
    expect(failedOf(a)).toEqual([]);
    expect(failedOf(b)).toEqual([]);
  });
});

describe("two cic devices, end to end", () => {
  it("reads a peer's first message, answers it as a MSG on the session it opened, and the peer reads that", async () => {
    const g = new Grappa();
    const a = me("alice");
    const b = me("bob");
    await joined(g, a);
    await joined(g, b);
    await uploadKeys(g, "bob", b.account);
    // Bob holds alice's list, as a KEYS he asked for left it.
    pinnedTo(b, "alice", a.own.master);
    trust(engineOf(b)).applyList(a.own.master, {
      ver: a.own.list.ver,
      devices: a.own.list.devices,
    });

    await say(g, a, "bob", "hello");
    await pump(g, b);

    expect(eventsOf(b, "received")).toEqual([
      {
        kind: "received",
        nick: "alice",
        master: a.own.master,
        device: keyOf(a.account),
        verified: false,
        inner: text("hello"),
      },
    ]);
    const reply = engineOf(b).send("alice", text("hi alice"), "hi", null, null);
    expect(reply.outbound.map((o) => [o.verb, o.from, o.to])).toEqual([
      ["msg", b.own.did, a.own.did],
    ]);
    await toDoor(g, b, reply);
    await pump(g, a);
    expect(eventsOf(a, "received")).toEqual([
      {
        kind: "received",
        nick: "bob",
        master: b.own.master,
        device: keyOf(b.account),
        verified: false,
        inner: text("hi alice"),
      },
    ]);
    // Alice writes MSGs from now on too.
    const again = engineOf(a).send("bob", text("again"), "again", null, null);
    expect(again.outbound.map((o) => o.verb)).toEqual(["msg"]);
    await toDoor(g, a, again);
    await pump(g, b);
    expect(eventsOf(b, "received").map((e) => e.inner.body)).toEqual(["hello", "again"]);
    expect(failedOf(a)).toEqual([]);
    expect(failedOf(b)).toEqual([]);
  });
});

describe("two cic devices, first contact", () => {
  it("reads a first message from a master it never saw on its device's certificate, and its answer reaches that device at once", async () => {
    const g = new Grappa();
    const a = me("alice");
    const b = me("bob");
    await joined(g, a);
    await joined(g, b);
    await uploadKeys(g, "alice", a.account);
    await uploadKeys(g, "bob", b.account);

    await say(g, a, "bob", "hello");
    await pump(g, b);

    expect(eventsOf(b, "received").map((e) => [e.nick, e.master, e.inner])).toEqual([
      ["alice", a.own.master, text("hello")],
    ]);
    const reply = engineOf(b).send("alice", text("hi alice"), "hi", null, null);
    expect(reply.outbound.map((o) => [o.verb, o.to])).toEqual([
      ["msg", a.own.did],
      ["keyreq", "*"],
    ]);
    await toDoor(g, b, reply);
    // The KEYS brings alice's list, which names the device already reached.
    await pump(g, b);
    await pump(g, a);

    expect(eventsOf(a, "received").map((e) => e.inner)).toEqual([text("hi alice")]);
    expect(b.state.masters[a.own.master]).toMatchObject({ ver: 1, devices: [keyOf(a.account)] });
    expect(b.state.outq).toEqual({});
    expect(failedOf(a)).toEqual([]);
    expect(failedOf(b)).toEqual([]);
  });
});

function sessionIdOf(pickle: string | undefined): string {
  const session = olm().Session.from_pickle(pickle ?? "");
  try {
    return session.session_id();
  } finally {
    session.free();
  }
}

// --- S1: copies of what a device sends, to the account's other devices ------
//
// A device copies each text it sends, encrypted per sibling (another device
// on our own master's list), so every device of the account shows it. The
// sibling path stays apart from the peer path: siblings come from our own
// signed list, never from a pin, and their curves are never bound to a nick.

const curveOf = (account: Account): string => account.curve25519_key();

/** The session a pre-key copy for `sibling` belongs to. */
const preKeySessionOf = (payload: string, sibling: Account): string =>
  olm().pre_key_session_id(unbase64(bodiesOf(payload)[didOf(sibling)] ?? ""));

describe("S1 sibling copies — send", () => {
  it("copy() to a sibling with no session asks for its keys, then sends a PKMSG once siblingKeys() answers", async () => {
    const g = new Grappa();
    const alice = ownAccount("alice", 2);
    const [a, b] = alice.devices as [OwnDevice, OwnDevice];
    await enrolledAccount(g, alice);
    const blocks = await g.api.listE2eDevices("alice", SLUG);
    expect(engineFor(alice, a).setSiblings(blocks)).toEqual({ events: [], outbound: [] });

    expect(engineFor(alice, a).copy("bob", "hello")).toEqual({
      events: [{ kind: "sibling_keys_needed", did: b.own.did }],
      outbound: [],
      copies: [],
    });
    const keys = await g.door("alice", a.own.did).claim(b.own.did);
    const res = engineFor(alice, a).siblingKeys(b.own.did, keys);

    expect(res.events).toEqual([]);
    expect(res.outbound).toEqual([]);
    expect(res.copies.map((c) => [c.to, c.verb])).toEqual([[b.own.did, "pkmsg"]]);
    const [copy] = res.copies;
    if (copy === undefined) throw new Error("no copy");
    // A PKMSG as one to a peer: our master's certificate for this device, its
    // id block, and one body, the sibling's.
    expect(decodePayload(copy.payload)).toMatchObject({
      id: idBlock(a.account, keyOf(alice.master)),
      master: { ed25519: keyOf(alice.master), cert: a.own.cert, ver: 1 },
    });
    expect(Object.keys(bodiesOf(copy.payload))).toEqual([b.own.did]);
    expect(opened(b.account, copy.verb, copy.payload)).toEqual({
      t: "copy",
      peer: "bob",
      body: "hello",
      fb: fb(olm(), keyOf(a.account), keyOf(b.account)),
    });
    expect(await g.door("alice", a.own.did).copy(copy.to, copy.verb, copy.payload)).toEqual(
      expect.any(Number),
    );
    expect(a.state.copyq).toEqual({});
    expect(a.state.devices).toEqual({});
  });

  it("a second copy rides the same session", async () => {
    const g = new Grappa();
    const alice = ownAccount("alice", 2);
    const [a, b] = alice.devices as [OwnDevice, OwnDevice];
    await enrolledAccount(g, alice);
    engineFor(alice, a).setSiblings(await g.api.listE2eDevices("alice", SLUG));
    engineFor(alice, a).copy("bob", "one");
    const keys = await g.door("alice", a.own.did).claim(b.own.did);
    const [first] = engineFor(alice, a).siblingKeys(b.own.did, keys).copies;
    if (first === undefined) throw new Error("no copy");

    const again = engineFor(alice, a).copy("carol", "two");

    expect(again.events).toEqual([]);
    expect(again.copies.map((c) => [c.to, c.verb])).toEqual([[b.own.did, "pkmsg"]]);
    const [second] = again.copies;
    if (second === undefined) throw new Error("no copy");
    // Pre-key messages of one session, until the sibling answers on it.
    expect(preKeySessionOf(second.payload, b.account)).toBe(
      preKeySessionOf(first.payload, b.account),
    );
    expect(a.state.sessions[curveOf(b.account)]).toHaveLength(1);
    expect([first, second].map((c) => opened(b.account, c.verb, c.payload))).toEqual([
      { t: "copy", peer: "bob", body: "one", fb: fb(olm(), keyOf(a.account), keyOf(b.account)) },
      { t: "copy", peer: "carol", body: "two", fb: fb(olm(), keyOf(a.account), keyOf(b.account)) },
    ]);
  });

  it("setSiblings ignores a block outside our signed list, our own did, and a bad id signature", () => {
    const alice = ownAccount("alice", 3);
    const [a, b, c] = alice.devices as [OwnDevice, OwnDevice, OwnDevice];
    const master = keyOf(alice.master);

    const res = engineFor(alice, a).setSiblings([
      deviceBlock(a.account, master),
      // A did is its key's, whatever grappa prints beside it.
      { ...deviceBlock(b.account, master), did: c.own.did },
      deviceBlock(c.account, keyOf(new (olm().Account)())),
      deviceBlock(new (olm().Account)(), master),
    ]);

    expect(res).toEqual({
      events: [{ kind: "dropped", nick: "alice", reason: "sibling-bad-signature" }],
      outbound: [],
    });
    expect(a.state.siblings).toEqual({
      [keyOf(b.account)]: { did: b.own.did, curve25519: curveOf(b.account) },
    });
    expect(engineFor(alice, a).copy("bob", "hi").events).toEqual([
      { kind: "sibling_keys_needed", did: b.own.did },
    ]);
  });

  it("siblingKeys refuses a KEYS whose master is not ours", () => {
    const alice = ownAccount("alice", 2);
    const [a, b] = alice.devices as [OwnDevice, OwnDevice];
    const accounts = [a.account, b.account];
    engineFor(alice, a).setSiblings([deviceBlock(b.account, keyOf(alice.master))]);
    engineFor(alice, a).copy("bob", "hello");
    // Another master's valid list naming the sibling, with the sibling's own entry.
    const mallory = { master: new (olm().Account)(), devices: [] };
    const forged = keysPayload(mallory, 1, accounts, [entryOf(b.account, alice.master)]);

    expect(engineFor(alice, a).siblingKeys(b.own.did, forged)).toEqual({
      events: [
        { kind: "dropped", nick: "alice", reason: "sibling-not-ours", verb: "keys" },
        { kind: "dropped", nick: "bob", reason: "sibling-no-keys" },
      ],
      outbound: [],
      copies: [],
    });
    expect(a.state.sessions[curveOf(b.account)]).toBeUndefined();
    expect(a.state.copyq).toEqual({});
    // The same entry under our own master's list opens the session.
    engineFor(alice, a).copy("bob", "again");
    const ours = { master: alice.master, devices: [] };
    const keys = keysPayload(ours, 1, accounts, [entryOf(b.account, alice.master)]);
    expect(
      engineFor(alice, a)
        .siblingKeys(b.own.did, keys)
        .copies.map((c) => c.to),
    ).toEqual([b.own.did]);
  });

  it("a sibling removed by setSiblings drops its waiting copies as sibling-gone", async () => {
    const g = new Grappa();
    const alice = ownAccount("alice", 4);
    const [a, b, c, d] = alice.devices as [OwnDevice, OwnDevice, OwnDevice, OwnDevice];
    await enrolledAccount(g, alice);
    const claim = (sibling: OwnDevice) => g.door("alice", a.own.did).claim(sibling.own.did);
    engineFor(alice, a).setSiblings(await g.api.listE2eDevices("alice", SLUG));
    engineFor(alice, a).copy("bob", "one");
    engineFor(alice, a).copy("carol", "two");
    // c holds a session now; b and d still wait for keys.
    expect(engineFor(alice, a).siblingKeys(c.own.did, await claim(c)).copies).toHaveLength(2);

    // Our master puts a list without c and d, and grappa drops both.
    a.own.list = signedList(alice.master, 2, [a.account, b.account]);
    await enlist(g, "alice", alice.master, [], a.own.list);
    const res = engineFor(alice, a).setSiblings(await g.api.listE2eDevices("alice", SLUG));

    expect(res).toEqual({
      events: [
        { kind: "dropped", nick: "bob", reason: "sibling-gone" },
        { kind: "dropped", nick: "carol", reason: "sibling-gone" },
      ],
      outbound: [],
    });
    expect(Object.keys(a.state.siblings)).toEqual([keyOf(b.account)]);
    expect(a.state.sessions[curveOf(c.account)]).toBeUndefined();
    expect(a.state.copyq[keyOf(d.account)]).toBeUndefined();
    // b's copies still wait, and go once its keys come.
    const sent = engineFor(alice, a).siblingKeys(b.own.did, await claim(b));
    expect(sent.copies.map((x) => [x.to, opened(b.account, x.verb, x.payload).body])).toEqual([
      [b.own.did, "one"],
      [b.own.did, "two"],
    ]);
    expect(
      engineFor(alice, a)
        .copy("bob", "three")
        .copies.map((x) => x.to),
    ).toEqual([b.own.did]);
  });

  it("siblingKeys refuses a KEYS of our master whose list it did not sign, or whose entry is not the sibling admitted", () => {
    const alice = ownAccount("alice", 3);
    const [a, b, c] = alice.devices as [OwnDevice, OwnDevice, OwnDevice];
    const all = [a.account, b.account, c.account];
    const ours = { master: alice.master, devices: [] };
    const elsewhere = keyOf(new (olm().Account)());
    const keysWith = (listed: Account[], entry: KeysEntry) => keysPayload(ours, 1, listed, [entry]);
    const genuine = keysWith(all, entryOf(b.account, alice.master));
    const engine = () => engineFor(alice, a);
    engine().setSiblings([deviceBlock(b.account, keyOf(alice.master))]);
    const forgeries: [string, string][] = [
      [
        "a list signature over another list",
        edited(genuine, (json) => {
          (json.master as Record<string, unknown>).sig = alice.master.sign(
            listSigText(2, listOf(1, all).devices),
          );
        }),
      ],
      [
        "a list that does not name the sibling",
        keysWith([a.account, c.account], entryOf(b.account, alice.master)),
      ],
      ["another device's entry", keysWith(all, entryOf(c.account, alice.master))],
      [
        "the sibling's key claiming another curve",
        keysWith(
          all,
          claiming(b.account, alice.master, curveOf(c.account), oneTimeKey(b.account, b.account)),
        ),
      ],
      [
        "an id block signed under another master",
        keysWith(all, { ...entryOf(b.account, alice.master), id: idBlock(b.account, elsewhere) }),
      ],
      [
        "a one-time key another device signed",
        keysWith(all, {
          id: idBlock(b.account, keyOf(alice.master)),
          otk: { ...oneTimeKey(b.account, c.account), fallback: false },
        }),
      ],
      ["no JSON at all", "not a KEYS"],
    ];

    const refusals = forgeries.map(([what, keys]) => {
      engine().copy("bob", what);
      const res = engine().siblingKeys(b.own.did, keys);
      expect(res.copies).toEqual([]);
      expect(res.events[1]).toEqual({ kind: "dropped", nick: "bob", reason: "sibling-no-keys" });
      return [what, res.events[0]?.kind === "dropped" ? res.events[0].reason : undefined];
    });

    expect(refusals).toEqual([
      ["a list signature over another list", "sibling-bad-signature"],
      ["a list that does not name the sibling", "sibling-unknown"],
      ["another device's entry", "sibling-unknown"],
      ["the sibling's key claiming another curve", "sibling-unknown"],
      ["an id block signed under another master", "sibling-bad-signature"],
      ["a one-time key another device signed", "sibling-bad-signature"],
      ["no JSON at all", "bad-payload"],
    ]);
    expect(a.state.sessions[curveOf(b.account)]).toBeUndefined();
    engine().copy("bob", "genuine");
    expect(
      engine()
        .siblingKeys(b.own.did, genuine)
        .copies.map((x) => x.to),
    ).toEqual([b.own.did]);
  });

  it("a peer never binds a sibling's curve: a claim made before is evicted, one made after is our own", () => {
    const alice = ownAccount("alice", 2);
    const [a, b] = alice.devices as [OwnDevice, OwnDevice];
    const bob = peerWith(1);
    const [x] = bob.devices as [Account];
    const engine = () => engineFor(alice, a);
    const claim = () =>
      keysPayload(bob, 1, [x], [claiming(x, bob.master, curveOf(b.account), oneTimeKey(x, x))]);
    engine().send("bob", text("one"), "one", null, null);
    engine().receive("bob", "keys", newMsgid(), "*", claim());
    expect(a.state.devices[keyOf(x)]?.curve25519).toBe(curveOf(b.account));

    engine().setSiblings([deviceBlock(b.account, keyOf(alice.master))]);

    expect(a.state.devices[keyOf(x)]).toBeUndefined();
    expect(a.state.sessions[curveOf(b.account)]).toBeUndefined();
    expect(engine().copy("bob", "two").events).toEqual([
      { kind: "sibling_keys_needed", did: b.own.did },
    ]);
    alice.now += KEYREQ_RETRY_MS;
    engine().send("bob", text("three"), "three", null, null);
    expect(engine().receive("bob", "keys", newMsgid(), "*", claim()).events).toContainEqual({
      kind: "dropped",
      nick: "bob",
      reason: "own-identity",
      verb: "keys",
    });
    expect(a.state.devices[keyOf(x)]).toBeUndefined();
    expect(a.state.sessions[curveOf(b.account)]).toBeUndefined();
  });

  it("a copy waits for its sibling's keys at most OUTQ_TTL_MS, asking for them once while it waits", () => {
    const alice = ownAccount("alice", 2);
    const [a, b] = alice.devices as [OwnDevice, OwnDevice];
    const engine = () => engineFor(alice, a);
    const asked = [{ kind: "sibling_keys_needed", did: b.own.did }];
    engine().setSiblings([deviceBlock(b.account, keyOf(alice.master))]);

    expect(engine().copy("bob", "one").events).toEqual(asked);
    alice.now += 1000;
    expect(engine().copy("carol", "two").events).toEqual([]);
    expect(engine().waitsOnTheClock()).toBe(true);
    alice.now += OUTQ_TTL_MS - 1000;
    expect(engine().tick().events).toEqual([
      { kind: "dropped", nick: "bob", reason: "sibling-no-keys" },
    ]);
    alice.now += 1000;
    expect(engine().tick().events).toEqual([
      { kind: "dropped", nick: "carol", reason: "sibling-no-keys" },
    ]);
    expect(engine().waitsOnTheClock()).toBe(false);
    expect(engine().copy("dave", "three").events).toEqual(asked);
  });

  it("siblingKeys(null): no keys came, and the waiting copies are dropped as sibling-no-keys", () => {
    const alice = ownAccount("alice", 2);
    const [a, b] = alice.devices as [OwnDevice, OwnDevice];
    const engine = () => engineFor(alice, a);
    engine().setSiblings([deviceBlock(b.account, keyOf(alice.master))]);
    engine().copy("bob", "one");
    engine().copy("carol", "two");

    expect(engine().siblingKeys(b.own.did, null)).toEqual({
      events: [
        { kind: "dropped", nick: "bob", reason: "sibling-no-keys" },
        { kind: "dropped", nick: "carol", reason: "sibling-no-keys" },
      ],
      outbound: [],
      copies: [],
    });
    expect(a.state.copyq).toEqual({});
    // Still a sibling: the next copy asks for its keys again.
    expect(engine().copy("dave", "three").events).toEqual([
      { kind: "sibling_keys_needed", did: b.own.did },
    ]);
  });

  it("a session the sibling holds carries what waited for its keys, in order, whatever a KEYS brings", () => {
    const alice = ownAccount("alice", 2);
    const [a, b] = alice.devices as [OwnDevice, OwnDevice];
    const engine = () => engineFor(alice, a);
    const bodies = (res: CopyResult) =>
      res.copies.map((c) => opened(b.account, c.verb, c.payload).body);
    // A session to the sibling that no claim opened (as a pre-key copy from
    // it leaves one behind).
    const sessionAppears = () => {
      b.account.generate_one_time_keys(1);
      const session = a.account.create_outbound_session(
        curveOf(b.account),
        b.account.one_time_keys().at(-1) ?? "",
      );
      a.state.sessions[curveOf(b.account)] = [session.pickle()];
      session.free();
    };
    engine().setSiblings([deviceBlock(b.account, keyOf(alice.master))]);

    engine().copy("bob", "one");
    sessionAppears();
    expect(bodies(engine().copy("carol", "two"))).toEqual(["one", "two"]);

    delete a.state.sessions[curveOf(b.account)];
    engine().copy("dave", "three");
    sessionAppears();
    const res = engine().siblingKeys(b.own.did, "not a KEYS");
    expect(res.events).toEqual([
      {
        kind: "dropped",
        nick: "alice",
        reason: "bad-payload",
        verb: "keys",
        detail: expect.any(String),
      },
    ]);
    expect(bodies(res)).toEqual(["three"]);
    expect(a.state.copyq).toEqual({});
  });

  it("deleting a chat drops the copies of it still waiting for a sibling's keys", () => {
    const alice = ownAccount("alice", 2);
    const [a, b] = alice.devices as [OwnDevice, OwnDevice];
    const engine = () => engineFor(alice, a);
    engine().setSiblings([deviceBlock(b.account, keyOf(alice.master))]);
    engine().copy("bob", "one");
    engine().copy("carol", "two");
    engine().copy("Bob", "three");

    engine().forget("BOB");

    expect(a.state.copyq).toEqual({
      [keyOf(b.account)]: [{ peer: "carol", body: "two", at: alice.now }],
    });
  });

  it("a sibling our own list drops is gone before setSiblings runs again: no copy reaches it, and what waited for it drops as sibling-gone", () => {
    const alice = ownAccount("alice", 4);
    const [a, b, c, d] = alice.devices as [OwnDevice, OwnDevice, OwnDevice, OwnDevice];
    const all = alice.devices.map((x) => x.account);
    const keysFor = (sibling: OwnDevice) =>
      keysPayload({ master: alice.master, devices: [] }, 1, all, [
        entryOf(sibling.account, alice.master),
      ]);
    const engine = () => engineFor(alice, a);
    engine().setSiblings([b, c, d].map((x) => deviceBlock(x.account, keyOf(alice.master))));
    engine().copy("bob", "one");
    // b and d hold a session; c still waits for its keys.
    engine().siblingKeys(b.own.did, keysFor(b));
    engine().siblingKeys(d.own.did, keysFor(d));

    // Our master's list moves on without b and c (a relist on another device,
    // adopted here); nobody called setSiblings since.
    a.own.list = signedList(alice.master, 2, [a.account, d.account]);
    const res = engine().copy("carol", "two");

    expect(res.events).toEqual([{ kind: "dropped", nick: "bob", reason: "sibling-gone" }]);
    // The sibling it still names gets the copy.
    expect(res.copies.map((x) => [x.to, opened(d.account, x.verb, x.payload).body])).toEqual([
      [d.own.did, "two"],
    ]);
    expect(Object.keys(a.state.siblings)).toEqual([keyOf(d.account)]);
    expect(a.state.sessions[curveOf(b.account)]).toBeUndefined();
    expect(a.state.copyq).toEqual({});
  });

  it("siblingKeys opens nothing to a sibling our own list dropped, on a KEYS whose older list still names it", () => {
    const alice = ownAccount("alice", 3);
    const [a, b, c] = alice.devices as [OwnDevice, OwnDevice, OwnDevice];
    const engine = () => engineFor(alice, a);
    // Our master's list at version 1, validly signed, naming every device.
    const older = (sibling: OwnDevice) =>
      keysPayload(
        { master: alice.master, devices: [] },
        1,
        [a.account, b.account, c.account],
        [entryOf(sibling.account, alice.master)],
      );
    engine().setSiblings([b, c].map((x) => deviceBlock(x.account, keyOf(alice.master))));
    engine().copy("bob", "one");
    a.own.list = signedList(alice.master, 2, [a.account, c.account]);

    expect(engine().siblingKeys(b.own.did, older(b))).toEqual({
      events: [
        { kind: "dropped", nick: "bob", reason: "sibling-gone" },
        { kind: "dropped", nick: "alice", reason: "sibling-unknown", verb: "keys" },
      ],
      outbound: [],
      copies: [],
    });
    expect(a.state.sessions[curveOf(b.account)]).toBeUndefined();
    // The same older list opens a session to a sibling our list still names.
    const res = engine().siblingKeys(c.own.did, older(c));
    expect(res.copies.map((x) => [x.to, opened(c.account, x.verb, x.payload).body])).toEqual([
      [c.own.did, "one"],
    ]);
  });
});
