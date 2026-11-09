// Channel E2E (wire v4) — the epoch store: one AES-256-GCM key per
// channel epoch, shared by every member, with the per-sender counter
// inside the signed, encrypted part. Signing and verification use
// node:crypto Ed25519 test keys: no wasm, no network, no real timers.
import { generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptEpoch, newEpochId, newEpochKey } from "../lib/e2e/channelCrypto";
import {
  buildPeriodicRotation,
  type ChannelSigner,
  type ChannelVerifier,
  createEpoch,
  decryptChannel,
  dropChannel,
  dropEpoch,
  dropPendingSends,
  encryptChannel,
  epochFor,
  epochHoldersStale,
  epochRemainingHolders,
  expireHeldRows,
  GROUP_ROTATION_INTERVAL_MS,
  type GroupSessionsState,
  gkeyInner,
  HELD_ROW_TTL_MS,
  type HeldRow,
  holdRow,
  importEpoch,
  KEYREQ_ANSWER_THROTTLE_MS,
  keyreqAnswerDue,
  keyreqPayload,
  keyreqSentAtFor,
  MAX_HELD_ROWS,
  MAX_PENDING_SENDS,
  markKeyreqAnswered,
  markKeyreqSent,
  newGroupSessionsState,
  type PendingSend,
  queuePendingSend,
  REPLAY_WINDOW,
  type RosterDids,
  rotateEpochForLeave,
  rotationDue,
  takeHeldRows,
  takePendingSends,
} from "../lib/e2e/groupSessions";
import {
  channelSigText,
  decodePayload,
  encodePayload,
  fold,
  type GkeyInner,
  GROUP_WIRE_VERSION,
  PayloadError,
  parseChannelKeyreqPayload,
  parseChannelPayload,
  parseGkeyInner,
} from "../lib/e2e/wire";

const CHAN = "#grappa";
const NOW = 1_000_000;
const DAY = GROUP_ROTATION_INTERVAL_MS;

type TestKey = { did: string; privateKey: KeyObject; publicKey: KeyObject };

/** One Ed25519 device key per nick, with a fixed did each. */
function makeKeys(nicks: string[]): Map<string, TestKey> {
  const ring = new Map<string, TestKey>();
  for (const nick of nicks) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    ring.set(fold(nick), { did: `did-${fold(nick)}`, privateKey, publicKey });
  }
  return ring;
}

function didFor(ring: Map<string, TestKey>, nick: string): string {
  const key = ring.get(fold(nick));
  if (key === undefined) throw new Error(`no key for ${nick}`);
  return key.did;
}

function signer(ring: Map<string, TestKey>, ownNick: string): ChannelSigner {
  return (text) => {
    const key = ring.get(fold(ownNick));
    if (key === undefined) throw new Error(`no key for ${ownNick}`);
    return sign(null, Buffer.from(text, "utf8"), key.privateKey)
      .toString("base64")
      .replace(/=+$/, "");
  };
}

function verifier(ring: Map<string, TestKey>): ChannelVerifier {
  return (nick, did, text, sig) => {
    const key = ring.get(fold(nick));
    if (key === undefined || key.did !== did) return false;
    try {
      return verify(null, Buffer.from(text, "utf8"), key.publicKey, Buffer.from(sig, "base64"));
    } catch {
      return false;
    }
  };
}

/** `s` with the character at `i` swapped for a different base64 character. */
function flipChar(s: string, i: number): string {
  const at = s[i];
  if (at === undefined) throw new Error("flipChar past the end");
  return `${s.slice(0, i)}${at === "A" ? "B" : "A"}${s.slice(i + 1)}`;
}

/** Alice's epoch, as Bob would receive it in a gkey DM. */
function aliceGkey(aliceGroups: GroupSessionsState) {
  const inner = gkeyInner(aliceGroups, CHAN);
  if (inner === undefined) throw new Error("alice has no epoch");
  return inner;
}

/** Bob imports Alice's epoch key. */
function bobImports(bobGroups: GroupSessionsState, aliceGroups: GroupSessionsState, now: number) {
  expect(importEpoch(bobGroups, CHAN, aliceGkey(aliceGroups), didFor(RING, "alice"), now)).toBe(
    "imported",
  );
}

const RING = makeKeys(["alice", "bob", "carol"]);
const signAlice = signer(RING, "alice");
const verifyAll = verifier(RING);
const ALICE_DID = didFor(RING, "alice");

describe("state and constants", () => {
  it("starts empty at version 3, with the documented constants", () => {
    expect(newGroupSessionsState()).toEqual({
      v: 3,
      epochs: {},
      keyreqAnsweredAt: {},
      keyreqSentAt: {},
      held: [],
      pending: [],
    });
    expect(newGroupSessionsState().v).toBe(3);
    expect(GROUP_ROTATION_INTERVAL_MS).toBe(86_400_000);
    expect(REPLAY_WINDOW).toBe(128);
    expect(KEYREQ_ANSWER_THROTTLE_MS).toBe(60_000);
    expect(MAX_HELD_ROWS).toBe(32);
    expect(HELD_ROW_TTL_MS).toBe(3_600_000);
  });

  it("creates an epoch with did holders, found under any case of the channel", () => {
    const groups = newGroupSessionsState();
    expect(epochFor(groups, CHAN)).toBeUndefined();
    const created = createEpoch(
      groups,
      "#Grappa",
      [didFor(RING, "alice"), didFor(RING, "bob")],
      NOW,
    );
    expect(created.holders).toEqual([didFor(RING, "alice"), didFor(RING, "bob")]);
    expect(created.createdAt).toBe(NOW);
    expect(created.messages).toBe(0);
    expect(created.counter).toBe(0);
    expect(created.receivedFrom).toBeNull();
    expect(created.seen).toEqual({});
    expect(epochFor(groups, CHAN)).toBe(created);
    expect(epochFor(groups, "#GRAPPA")).toBe(created);
  });

  it("stores holder dids verbatim, never folded: a did is an identity, not a nick", () => {
    const groups = newGroupSessionsState();
    const mixed = ["Did-AbC123", "did-x"];
    const created = createEpoch(groups, CHAN, mixed, NOW);
    expect(created.holders).toEqual(mixed);
    const inner = gkeyInner(groups, CHAN);
    expect(inner?.holders).toEqual(mixed);
  });

  it("carries the nick mapping and the sent-to nicks in the gkey inner, and imports them back", () => {
    const groups = newGroupSessionsState();
    createEpoch(groups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW, {
      holderNicks: { alice: [didFor(RING, "alice")], bob: [didFor(RING, "bob")] },
      sentTo: ["carol"],
    });
    const inner = gkeyInner(groups, CHAN);
    expect(inner?.holderNicks).toEqual({
      alice: [didFor(RING, "alice")],
      bob: [didFor(RING, "bob")],
    });
    expect(inner?.sentTo).toEqual(["carol"]);
    // And an inner without them parses back to empty ones.
    const bare = newGroupSessionsState();
    createEpoch(bare, CHAN, [didFor(RING, "alice")], NOW);
    expect(gkeyInner(bare, CHAN)?.holderNicks).toBeUndefined();
    expect(gkeyInner(bare, CHAN)?.sentTo).toBeUndefined();
    const imported = newGroupSessionsState();
    markKeyreqSent(imported, CHAN, NOW);
    expect(inner).toBeDefined();
    expect(
      importEpoch(
        imported,
        CHAN,
        parseGkeyInner(inner as unknown as Record<string, unknown>),
        didFor(RING, "alice"),
        NOW,
      ),
    ).toBe("imported");
    expect(epochFor(imported, CHAN)?.holderNicks).toEqual({
      alice: [didFor(RING, "alice")],
      bob: [didFor(RING, "bob")],
    });
    expect(epochFor(imported, CHAN)?.sentTo).toEqual(["carol"]);
  });

  it("builds the gkey inner for the current epoch, and none without one", () => {
    const groups = newGroupSessionsState();
    expect(gkeyInner(groups, CHAN)).toBeUndefined();
    const created = createEpoch(groups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    const inner = gkeyInner(groups, CHAN);
    expect(inner).toEqual({
      t: "gkey",
      ch: "#grappa",
      sid: created.sid,
      key: created.key,
      seq: 0,
      holders: [didFor(RING, "alice"), didFor(RING, "bob")],
    });
    // A gkey names its holders, and the wire refuses one with none.
    expect(inner?.holders.length).toBeGreaterThan(0);
    expect(() =>
      parseGkeyInner({ t: "gkey", ch: CHAN, sid: "sid-1", key: newEpochKey(), holders: [] }),
    ).toThrow(PayloadError);
  });

  it("builds a key-request envelope the wire parses", () => {
    const payload = keyreqPayload(CHAN);
    expect(parseChannelKeyreqPayload(decodePayload(payload))).toEqual({
      v: GROUP_WIRE_VERSION,
      t: "keyreq",
      ch: "#grappa",
    });
    expect(GROUP_WIRE_VERSION).toBe(4);
  });
});

describe("encryptChannel / decryptChannel", () => {
  it("round-trips with counter 0 then 1 under an epoch created first", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    createEpoch(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    const first = await encryptChannel(aliceGroups, CHAN, "hello", signAlice);
    expect(first.counter).toBe(0);
    const second = await encryptChannel(aliceGroups, CHAN, "again", signAlice);
    expect(second.counter).toBe(1);
    expect(second.sid).toBe(first.sid);
    expect(epochFor(aliceGroups, CHAN)?.messages).toBe(2);

    bobImports(bobGroups, aliceGroups, NOW);
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, first.payload, verifyAll, NOW),
    ).toEqual({ ok: true, kind: "text", sid: first.sid, counter: 0, body: "hello" });
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, second.payload, verifyAll, NOW),
    ).toEqual({ ok: true, kind: "text", sid: first.sid, counter: 1, body: "again" });
  });

  it("refuses a replay of the same payload", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    createEpoch(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    const sent = await encryptChannel(aliceGroups, CHAN, "hello", signAlice);
    bobImports(bobGroups, aliceGroups, NOW);
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, sent.payload, verifyAll, NOW),
    ).toEqual({ ok: true, kind: "text", sid: sent.sid, counter: 0, body: "hello" });
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, sent.payload, verifyAll, NOW),
    ).toEqual({ ok: false, reason: "replay", sid: sent.sid });
  });

  it("accepts out-of-order messages inside the window, and refuses a replayed old counter", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    const sent = [];
    createEpoch(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    for (const body of ["zero", "one", "two"]) {
      sent.push(await encryptChannel(aliceGroups, CHAN, body, signAlice));
    }
    bobImports(bobGroups, aliceGroups, NOW);
    const read = (payload: string) =>
      decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, payload, verifyAll, NOW);
    // Delivered 2, 0, 1: all new, all accepted.
    expect(await read(sent[2]?.payload ?? "")).toEqual({
      ok: true,
      kind: "text",
      sid: sent[2]?.sid,
      counter: 2,
      body: "two",
    });
    expect(await read(sent[0]?.payload ?? "")).toEqual({
      ok: true,
      kind: "text",
      sid: sent[0]?.sid,
      counter: 0,
      body: "zero",
    });
    expect(await read(sent[1]?.payload ?? "")).toEqual({
      ok: true,
      kind: "text",
      sid: sent[1]?.sid,
      counter: 1,
      body: "one",
    });
    // Each of them a second time is a replay now.
    expect(await read(sent[0]?.payload ?? "")).toEqual({
      ok: false,
      reason: "replay",
      sid: sent[0]?.sid,
    });
    expect(await read(sent[2]?.payload ?? "")).toEqual({
      ok: false,
      reason: "replay",
      sid: sent[2]?.sid,
    });
  });

  it("refuses a message with no session, a wrong epoch, a bad signature, or a bad payload", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    createEpoch(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    const sent = await encryptChannel(aliceGroups, CHAN, "hello", signAlice);
    // No session at all.
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, sent.payload, verifyAll, NOW),
    ).toEqual({ ok: false, reason: "no-session", sid: sent.sid });
    bobImports(bobGroups, aliceGroups, NOW);
    // A signature that is not Alice's over this envelope.
    const envelope = decodePayload(sent.payload);
    const badSig = encodePayload({ ...envelope, sig: flipChar(String(envelope.sig), 0) });
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, badSig, verifyAll, NOW),
    ).toEqual({ ok: false, reason: "bad-signature", sid: sent.sid });
    // The right signature, but for a device Bob has no key for.
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", "did-unknown", sent.payload, verifyAll, NOW),
    ).toEqual({ ok: false, reason: "bad-signature", sid: sent.sid });
    // Another channel's name in the envelope: the inbox channel rules.
    createEpoch(aliceGroups, "#other", [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    const other = await encryptChannel(aliceGroups, "#other", "hi", signAlice);
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, other.payload, verifyAll, NOW),
    ).toEqual({ ok: false, reason: "channel-mismatch", sid: other.sid });
    // A payload under an epoch Bob no longer holds: Alice rotated away.
    rotateEpochForLeave(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    const after = await encryptChannel(aliceGroups, CHAN, "new epoch", signAlice);
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, after.payload, verifyAll, NOW),
    ).toEqual({ ok: false, reason: "no-session", sid: after.sid });
    // Garbage that is not a payload at all.
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, "not json", verifyAll, NOW),
    ).toEqual({ ok: false, reason: "bad-payload", sid: null });
  });

  it("refuses a message whose ciphertext was tampered with under a valid signature", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    createEpoch(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    const sent = await encryptChannel(aliceGroups, CHAN, "hello", signAlice);
    bobImports(bobGroups, aliceGroups, NOW);
    const envelope = parseChannelPayload(decodePayload(sent.payload));
    const tamperedBody = flipChar(envelope.body, 20);
    const tampered = encodePayload({
      ...envelope,
      body: tamperedBody,
      sig: signAlice(channelSigText(envelope.ch, envelope.sid, tamperedBody)),
    });
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, tampered, verifyAll, NOW),
    ).toEqual({ ok: false, reason: "decryption-failed", sid: sent.sid });
  });

  it("refuses a message whose inner plaintext is neither text nor a rotation", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    createEpoch(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    await encryptChannel(aliceGroups, CHAN, "hello", signAlice);
    bobImports(bobGroups, aliceGroups, NOW);
    const held = epochFor(bobGroups, CHAN);
    if (held === undefined) throw new Error("bob has no epoch");
    const ciphertext = await encryptEpoch(
      held.key,
      new TextEncoder().encode(encodePayload({ t: "nope" })),
    );
    const payload = encodePayload({
      v: GROUP_WIRE_VERSION,
      t: "msg",
      ch: CHAN,
      sid: held.sid,
      body: ciphertext,
      sig: signAlice(channelSigText(CHAN, held.sid, ciphertext)),
    });
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, payload, verifyAll, NOW),
    ).toEqual({ ok: false, reason: "bad-inner", sid: held.sid });
  });
});

describe("importEpoch", () => {
  it("imports once: a re-sent key is a no-op, a bad key throws and stores nothing", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    createEpoch(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    await encryptChannel(aliceGroups, CHAN, "hi", signAlice);
    const gkey = aliceGkey(aliceGroups);
    expect(importEpoch(bobGroups, CHAN, gkey, ALICE_DID, NOW)).toBe("imported");
    expect(importEpoch(bobGroups, CHAN, gkey, ALICE_DID, NOW)).toBe("already-held");
    expect(() =>
      importEpoch(
        bobGroups,
        CHAN,
        { ...gkey, sid: "another-sid", key: "not-a-key" },
        ALICE_DID,
        NOW,
      ),
    ).toThrow();
    expect(epochFor(bobGroups, CHAN)?.sid).toBe(gkey.sid);
    // A key of the wrong length for a fresh sid: refused, never stored.
    const fresh = newGroupSessionsState();
    expect(() =>
      importEpoch(
        fresh,
        CHAN,
        {
          t: "gkey",
          ch: CHAN,
          sid: newEpochId(),
          key: "not-a-key",
          seq: 0,
          holders: [didFor(RING, "alice")],
        },
        ALICE_DID,
        NOW,
      ),
    ).toThrow();
    expect(epochFor(fresh, CHAN)).toBeUndefined();
  });

  it("a rotation successor imports: a higher seq replaces the one held", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    createEpoch(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    await encryptChannel(aliceGroups, CHAN, "epoch one", signAlice);
    const first = aliceGkey(aliceGroups);
    bobImports(bobGroups, aliceGroups, NOW);
    const rotated = rotateEpochForLeave(
      aliceGroups,
      CHAN,
      [didFor(RING, "alice"), didFor(RING, "bob")],
      NOW,
    );
    expect(rotated.seq).toBe(1);
    const second = aliceGkey(aliceGroups);
    expect(second.sid).not.toBe(first.sid);
    expect(second.seq).toBe(1);
    expect(importEpoch(bobGroups, CHAN, second, ALICE_DID, NOW)).toBe("imported");
    expect(epochFor(bobGroups, CHAN)?.sid).toBe(second.sid);
  });

  it("the first valid gkey wins: a second gkey at the same seq is superseded", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    createEpoch(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    await encryptChannel(aliceGroups, CHAN, "epoch one", signAlice);
    const first = aliceGkey(aliceGroups);
    expect(first.seq).toBe(0);
    expect(importEpoch(bobGroups, CHAN, first, ALICE_DID, NOW)).toBe("imported");
    // A concurrent first epoch: same seq, different sid — a late
    // duplicate, or a mint that lost the race. It is dropped, and the
    // epoch already taken stays.
    const rival: GkeyInner = {
      t: "gkey",
      ch: CHAN,
      sid: newEpochId(),
      key: newEpochKey(),
      seq: 0,
      holders: [didFor(RING, "alice"), didFor(RING, "bob")],
    };
    expect(importEpoch(bobGroups, CHAN, rival, ALICE_DID, NOW)).toBe("superseded");
    expect(epochFor(bobGroups, CHAN)?.sid).toBe(first.sid);
    // A stale seq — below the held one — drops the same way, once the
    // epoch has advanced past it.
    rotateEpochForLeave(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    const second = aliceGkey(aliceGroups);
    expect(importEpoch(bobGroups, CHAN, second, ALICE_DID, NOW)).toBe("imported");
    expect(importEpoch(bobGroups, CHAN, { ...rival, sid: newEpochId() }, ALICE_DID, NOW)).toBe(
      "superseded",
    );
    expect(epochFor(bobGroups, CHAN)?.sid).toBe(second.sid);
  });
});

describe("rotation", () => {
  it("is not due without an epoch, nor for one that never spoke, and is due after a day", async () => {
    const groups = newGroupSessionsState();
    expect(rotationDue(groups, CHAN, NOW)).toBe(false);
    createEpoch(groups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    expect(rotationDue(groups, CHAN, NOW + DAY)).toBe(false);
    await encryptChannel(groups, CHAN, "spoke", signAlice);
    expect(rotationDue(groups, CHAN, NOW + DAY - 1)).toBe(false);
    expect(rotationDue(groups, CHAN, NOW + DAY)).toBe(true);
  });

  it("builds nothing without an epoch, or when the epoch never spoke", async () => {
    const groups = newGroupSessionsState();
    expect(await buildPeriodicRotation(groups, CHAN, signAlice, NOW + DAY)).toBeNull();
    createEpoch(groups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    expect(await buildPeriodicRotation(groups, CHAN, signAlice, NOW + DAY)).toBeNull();
  });

  it("sends one channel message under the old epoch, and the reader rotates onto the new one", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    createEpoch(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    await encryptChannel(aliceGroups, CHAN, "day one", signAlice);
    const oldSid = aliceGkey(aliceGroups).sid;
    bobImports(bobGroups, aliceGroups, NOW);
    expect(
      await decryptChannel(
        bobGroups,
        CHAN,
        "alice",
        ALICE_DID,
        (await encryptChannel(aliceGroups, CHAN, "read me", signAlice)).payload,
        verifyAll,
        NOW,
      ),
    ).toEqual({ ok: true, kind: "text", sid: oldSid, counter: 1, body: "read me" });

    const later = NOW + DAY;
    const rotated = await buildPeriodicRotation(aliceGroups, CHAN, signAlice, later);
    expect(rotated).not.toBeNull();
    expect(rotated?.oldSid).toBe(oldSid);
    expect(rotated?.newSid).not.toBe(oldSid);
    // The rotation message is a v4 payload naming the OLD sid.
    expect(parseChannelPayload(decodePayload(rotated?.payload ?? "")).sid).toBe(oldSid);
    // Alice already holds the new epoch.
    expect(epochFor(aliceGroups, CHAN)?.sid).toBe(rotated?.newSid);
    // Bob reads it: a rotation, not a text, at Alice's next counter.
    expect(
      await decryptChannel(
        bobGroups,
        CHAN,
        "alice",
        ALICE_DID,
        rotated?.payload ?? "",
        verifyAll,
        later,
      ),
    ).toEqual({ ok: true, kind: "rotated", sid: oldSid, counter: 2, newSid: rotated?.newSid });
    expect(epochFor(bobGroups, CHAN)?.sid).toBe(rotated?.newSid);
    // And a message under the NEW epoch reads.
    const next = await encryptChannel(aliceGroups, CHAN, "day two", signAlice);
    expect(next.sid).toBe(rotated?.newSid);
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, next.payload, verifyAll, later),
    ).toEqual({ ok: true, kind: "text", sid: rotated?.newSid, counter: 0, body: "day two" });
  });

  it("rotating on a leave deletes the old epoch and mints a new one the peer can import", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    createEpoch(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    await encryptChannel(aliceGroups, CHAN, "before", signAlice);
    const oldSid = aliceGkey(aliceGroups).sid;
    const rotated = rotateEpochForLeave(
      aliceGroups,
      CHAN,
      [didFor(RING, "alice"), didFor(RING, "bob")],
      NOW,
    );
    expect(rotated.oldSid).toBe(oldSid);
    expect(rotated.newSid).not.toBe(oldSid);
    expect(epochFor(aliceGroups, CHAN)?.sid).toBe(rotated.newSid);
    expect(epochFor(aliceGroups, CHAN)?.messages).toBe(0);
    expect(
      importEpoch(
        bobGroups,
        CHAN,
        {
          t: "gkey",
          ch: CHAN,
          sid: rotated.newSid,
          key: rotated.key,
          seq: 1,
          holders: [didFor(RING, "alice"), didFor(RING, "bob")],
        },
        ALICE_DID,
        NOW,
      ),
    ).toBe("imported");
    const after = await encryptChannel(aliceGroups, CHAN, "after", signAlice);
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, after.payload, verifyAll, NOW),
    ).toEqual({ ok: true, kind: "text", sid: rotated.newSid, counter: 0, body: "after" });
  });

  it("rotating on a leave with no epoch still mints one, with a null old sid", () => {
    const groups = newGroupSessionsState();
    const rotated = rotateEpochForLeave(
      groups,
      CHAN,
      [didFor(RING, "alice"), didFor(RING, "bob")],
      NOW,
    );
    expect(rotated.oldSid).toBeNull();
    expect(epochFor(groups, CHAN)?.sid).toBe(rotated.newSid);
  });
});

describe("key requests sent", () => {
  it("records when this device asked for a key, and clears it on import or drop", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    expect(keyreqSentAtFor(bobGroups, CHAN)).toBeUndefined();
    markKeyreqSent(bobGroups, "#Grappa", NOW);
    expect(keyreqSentAtFor(bobGroups, CHAN)).toBe(NOW);
    expect(keyreqSentAtFor(bobGroups, "#other")).toBeUndefined();
    // A successful import clears the outstanding request for the channel.
    createEpoch(aliceGroups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    await encryptChannel(aliceGroups, CHAN, "hi", signAlice);
    expect(importEpoch(bobGroups, CHAN, aliceGkey(aliceGroups), ALICE_DID, NOW)).toBe("imported");
    expect(keyreqSentAtFor(bobGroups, CHAN)).toBeUndefined();
    // Dropping the channel clears it too.
    markKeyreqSent(bobGroups, CHAN, NOW);
    dropChannel(bobGroups, CHAN);
    expect(keyreqSentAtFor(bobGroups, CHAN)).toBeUndefined();
    // Dropping just the epoch clears it as well.
    markKeyreqSent(bobGroups, CHAN, NOW);
    dropEpoch(bobGroups, CHAN);
    expect(keyreqSentAtFor(bobGroups, CHAN)).toBeUndefined();
  });

  it("tolerates a state sealed before the field existed", () => {
    const groups = newGroupSessionsState();
    delete (groups as Partial<GroupSessionsState>).keyreqSentAt;
    expect(keyreqSentAtFor(groups, CHAN)).toBeUndefined();
    markKeyreqSent(groups, CHAN, NOW);
    expect(keyreqSentAtFor(groups, CHAN)).toBe(NOW);
  });
});

describe("held rows", () => {
  const row = (sid: string, at: number, channel = CHAN): HeldRow => ({
    channel,
    sid,
    from: "alice",
    fromDid: ALICE_DID,
    payload: `payload-${sid}-${at}`,
    receivedAt: at,
  });

  it("holds rows, and takes back only the ones the new key unlocks", () => {
    const groups = newGroupSessionsState();
    expect(holdRow(groups, row("sid-1", NOW))).toEqual([]);
    expect(holdRow(groups, row("sid-1", NOW + 1))).toEqual([]);
    expect(holdRow(groups, row("sid-2", NOW + 2))).toEqual([]);
    expect(groups.held).toHaveLength(3);
    const taken = takeHeldRows(groups, CHAN, "sid-1");
    expect(taken.map((r) => r.payload)).toEqual(["payload-sid-1-1000000", "payload-sid-1-1000001"]);
    expect(groups.held).toHaveLength(1);
    expect(taken.every((r) => r.sid === "sid-1")).toBe(true);
    // Nothing left under that sid, and nothing under another channel.
    expect(takeHeldRows(groups, CHAN, "sid-1")).toEqual([]);
    expect(takeHeldRows(groups, "#other", "sid-2")).toEqual([]);
    expect(groups.held).toHaveLength(1);
  });

  it("drops the oldest rows past the cap, and returns them instead of losing them silently", () => {
    const groups = newGroupSessionsState();
    const dropped: HeldRow[] = [];
    for (let i = 0; i < MAX_HELD_ROWS + 2; i++) {
      dropped.push(...holdRow(groups, row(`sid-${i}`, NOW + i)));
    }
    expect(groups.held).toHaveLength(MAX_HELD_ROWS);
    expect(dropped.map((r) => r.payload)).toEqual([
      "payload-sid-0-1000000",
      "payload-sid-1-1000001",
    ]);
    expect(groups.held[0]?.payload).toBe("payload-sid-2-1000002");
  });

  it("expires rows older than the TTL, and keeps the fresh ones", () => {
    const groups = newGroupSessionsState();
    holdRow(groups, row("sid-old", NOW));
    holdRow(groups, row("sid-fresh", NOW + HELD_ROW_TTL_MS));
    const expired = expireHeldRows(groups, NOW + HELD_ROW_TTL_MS + 1);
    expect(expired.map((r) => r.sid)).toEqual(["sid-old"]);
    expect(groups.held.map((r) => r.sid)).toEqual(["sid-fresh"]);
    // A row exactly at the TTL is not older than it: it survives.
    expect(expireHeldRows(groups, NOW + HELD_ROW_TTL_MS)).toEqual([]);
    expect(groups.held).toHaveLength(1);
  });

  it("tolerates a state sealed before the field existed", () => {
    const groups = newGroupSessionsState();
    delete (groups as Partial<GroupSessionsState>).held;
    expect(holdRow(groups, row("sid-1", NOW))).toEqual([]);
    expect(groups.held).toHaveLength(1);
    expect(takeHeldRows(groups, CHAN, "sid-1")).toHaveLength(1);
    expect(expireHeldRows(groups, NOW + HELD_ROW_TTL_MS + 1)).toEqual([]);
  });
});

describe("pending sends", () => {
  it("refuses to encrypt without an epoch: the row waits, it never mints one", async () => {
    const groups = newGroupSessionsState();
    await expect(encryptChannel(groups, CHAN, "hello", signAlice)).rejects.toThrow(/no epoch/);
    expect(epochFor(groups, CHAN)).toBeUndefined();
  });

  it("queues rows in order, takes them back for one channel only, and drops them on cancel", () => {
    const groups = newGroupSessionsState();
    expect(queuePendingSend(groups, CHAN, "first", NOW)).toEqual([]);
    expect(queuePendingSend(groups, CHAN, "second", NOW + 1)).toEqual([]);
    expect(queuePendingSend(groups, "#other", "elsewhere", NOW + 2)).toEqual([]);
    expect(groups.pending).toHaveLength(3);
    const taken = takePendingSends(groups, CHAN);
    expect(taken.map((r) => r.body)).toEqual(["first", "second"]);
    expect(groups.pending).toHaveLength(1);
    expect(takePendingSends(groups, CHAN)).toEqual([]);
    expect(dropPendingSends(groups, "#other").map((r) => r.body)).toEqual(["elsewhere"]);
    expect(groups.pending).toHaveLength(0);
  });

  it("drops the oldest rows past the cap, and returns them instead of losing them silently", () => {
    const groups = newGroupSessionsState();
    const dropped: PendingSend[] = [];
    for (let i = 0; i < MAX_PENDING_SENDS + 2; i++) {
      dropped.push(...queuePendingSend(groups, CHAN, `row-${i}`, NOW + i));
    }
    expect(groups.pending).toHaveLength(MAX_PENDING_SENDS);
    expect(dropped.map((r) => r.body)).toEqual(["row-0", "row-1"]);
    expect(groups.pending[0]?.body).toBe("row-2");
  });

  it("a leave drops the queued rows with the channel; a rejoin keeps them", () => {
    const groups = newGroupSessionsState();
    queuePendingSend(groups, CHAN, "waiting", NOW);
    dropChannel(groups, CHAN);
    expect(groups.pending).toHaveLength(0);
    queuePendingSend(groups, CHAN, "waiting", NOW);
    dropEpoch(groups, CHAN);
    expect(groups.pending).toHaveLength(1);
    expect(takePendingSends(groups, CHAN).map((r) => r.body)).toEqual(["waiting"]);
  });

  it("tolerates a state sealed before the field existed", () => {
    const groups = newGroupSessionsState();
    delete (groups as Partial<GroupSessionsState>).pending;
    expect(queuePendingSend(groups, CHAN, "first", NOW)).toEqual([]);
    expect(groups.pending).toHaveLength(1);
    expect(takePendingSends(groups, CHAN)).toHaveLength(1);
    expect(dropPendingSends(groups, CHAN)).toEqual([]);
  });
});

describe("holders and key requests", () => {
  const roster = (nicks: string[], dids: string[]): RosterDids => ({ nicks, dids });

  it("spots a holder who left, and is quiet when all holders are present", () => {
    const groups = newGroupSessionsState();
    expect(epochHoldersStale(groups, CHAN, roster(["alice"], [didFor(RING, "alice")]))).toBe(false);
    createEpoch(
      groups,
      CHAN,
      [didFor(RING, "alice"), didFor(RING, "bob"), didFor(RING, "carol")],
      NOW,
      {
        holderNicks: {
          alice: [didFor(RING, "alice")],
          bob: [didFor(RING, "bob")],
          carol: [didFor(RING, "carol")],
        },
      },
    );
    expect(
      epochHoldersStale(
        groups,
        CHAN,
        roster(["alice", "bob"], [didFor(RING, "alice"), didFor(RING, "bob")]),
      ),
    ).toBe(true);
    expect(
      epochHoldersStale(
        groups,
        CHAN,
        roster(
          ["alice", "bob", "carol"],
          [didFor(RING, "alice"), didFor(RING, "bob"), didFor(RING, "carol")],
        ),
      ),
    ).toBe(false);
    // The remaining holders are the election input: present by did, or
    // settled by the mapping — a departed holder is out, and the rest
    // stay in holder order.
    expect(
      epochRemainingHolders(
        groups,
        CHAN,
        roster(["alice", "bob"], [didFor(RING, "alice"), didFor(RING, "bob")]),
      ),
    ).toEqual([didFor(RING, "alice"), didFor(RING, "bob")]);
    // A holder this cic never chatted with is settled by the mapping,
    // not dropped: its did is not in the roster's lists, but its nick is.
    expect(
      epochRemainingHolders(
        groups,
        CHAN,
        roster(["alice", "bob", "carol"], [didFor(RING, "alice")]),
      ),
    ).toEqual([didFor(RING, "alice"), didFor(RING, "bob"), didFor(RING, "carol")]);
    // No epoch, no holders.
    expect(
      epochRemainingHolders(
        newGroupSessionsState(),
        CHAN,
        roster(["alice"], [didFor(RING, "alice")]),
      ),
    ).toEqual([]);
    // The holder set is per did: the roster in dids still matches in any order.
    expect(
      epochHoldersStale(
        groups,
        CHAN,
        roster(
          ["carol", "alice", "bob"],
          [didFor(RING, "carol"), didFor(RING, "alice"), didFor(RING, "bob")],
        ),
      ),
    ).toBe(false);
  });

  it("a holder the auditor has not chatted with is settled by the nick mapping, not by rotation", () => {
    const groups = newGroupSessionsState();
    createEpoch(
      groups,
      CHAN,
      [didFor(RING, "alice"), didFor(RING, "bob"), didFor(RING, "carol")],
      NOW,
      {
        holderNicks: {
          alice: [didFor(RING, "alice")],
          bob: [didFor(RING, "bob")],
          carol: [didFor(RING, "carol")],
        },
      },
    );
    // Carol's dids are unknown to this cic (never chatted): her did is
    // not among the roster dids, but the mapping attributes it to a nick
    // still on the roster — so the epoch is not stale.
    expect(
      epochHoldersStale(
        groups,
        CHAN,
        roster(["alice", "bob", "carol"], [didFor(RING, "alice"), didFor(RING, "bob")]),
      ),
    ).toBe(false);
  });

  it("a sent-to member who left rotates, one still on the roster does not", () => {
    const groups = newGroupSessionsState();
    createEpoch(groups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW, {
      holderNicks: { alice: [didFor(RING, "alice")], bob: [didFor(RING, "bob")] },
      sentTo: ["carol"],
    });
    expect(
      epochHoldersStale(
        groups,
        CHAN,
        roster(["alice", "bob", "carol"], [didFor(RING, "alice"), didFor(RING, "bob")]),
      ),
    ).toBe(false);
    expect(
      epochHoldersStale(
        groups,
        CHAN,
        roster(["alice", "bob"], [didFor(RING, "alice"), didFor(RING, "bob")]),
      ),
    ).toBe(true);
  });

  it("a rename whose new nick's list has not landed yet rotates once, fail closed", () => {
    const groups = newGroupSessionsState();
    createEpoch(groups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW, {
      holderNicks: { alice: [didFor(RING, "alice")], bob: [didFor(RING, "bob")] },
    });
    // Bob renamed to Robert; this cic has not re-pinned the new nick,
    // so his did is neither among the roster dids nor attributed to a
    // nick on the roster — the audit rotates rather than risk a leak.
    // Once the list lands, the did check settles it (see the channel
    // step test "a rename rotates nothing").
    expect(
      epochHoldersStale(groups, CHAN, roster(["alice", "robert"], [didFor(RING, "alice")])),
    ).toBe(true);
  });

  it("answers a key request once per asker per minute", () => {
    const groups = newGroupSessionsState();
    expect(keyreqAnswerDue(groups, CHAN, didFor(RING, "bob"), NOW)).toBe(true);
    markKeyreqAnswered(groups, CHAN, didFor(RING, "bob"), NOW);
    expect(keyreqAnswerDue(groups, CHAN, didFor(RING, "bob"), NOW)).toBe(false);
    expect(
      keyreqAnswerDue(groups, CHAN, didFor(RING, "bob"), NOW + KEYREQ_ANSWER_THROTTLE_MS - 1),
    ).toBe(false);
    expect(
      keyreqAnswerDue(groups, CHAN, didFor(RING, "bob"), NOW + KEYREQ_ANSWER_THROTTLE_MS),
    ).toBe(true);
    // The throttle is per asker and per channel.
    expect(keyreqAnswerDue(groups, CHAN, didFor(RING, "carol"), NOW)).toBe(true);
    expect(keyreqAnswerDue(groups, "#other", didFor(RING, "bob"), NOW)).toBe(true);
  });

  it("drops one epoch, or everything of a channel, and tolerates a missing one", async () => {
    const groups = newGroupSessionsState();
    dropEpoch(groups, CHAN);
    dropChannel(groups, CHAN);
    createEpoch(groups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    await encryptChannel(groups, CHAN, "hi", signAlice);
    dropEpoch(groups, CHAN);
    expect(epochFor(groups, CHAN)).toBeUndefined();
    // After the drop there is no epoch to encrypt under: the row waits,
    // it does not mint one. The drop itself still tolerates the missing
    // epoch, and a fresh epoch drops the same way.
    await expect(encryptChannel(groups, CHAN, "hi again", signAlice)).rejects.toThrow(/no epoch/);
    createEpoch(groups, CHAN, [didFor(RING, "alice"), didFor(RING, "bob")], NOW);
    dropChannel(groups, CHAN);
    expect(epochFor(groups, CHAN)).toBeUndefined();
  });
});
