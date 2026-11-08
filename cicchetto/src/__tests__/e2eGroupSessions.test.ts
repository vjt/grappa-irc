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
  encryptChannel,
  epochFor,
  epochHoldersStale,
  GROUP_ROTATION_INTERVAL_MS,
  type GroupSessionsState,
  gkeyInner,
  importEpoch,
  KEYREQ_ANSWER_THROTTLE_MS,
  keyreqAnswerDue,
  keyreqPayload,
  markKeyreqAnswered,
  newGroupSessionsState,
  REPLAY_WINDOW,
  rotateEpochForLeave,
  rotationDue,
} from "../lib/e2e/groupSessions";
import {
  channelSigText,
  decodePayload,
  encodePayload,
  fold,
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
  it("starts empty at version 2, with the documented constants", () => {
    expect(newGroupSessionsState()).toEqual({ v: 2, epochs: {}, keyreqAnsweredAt: {} });
    expect(newGroupSessionsState().v).toBe(2);
    expect(GROUP_ROTATION_INTERVAL_MS).toBe(86_400_000);
    expect(REPLAY_WINDOW).toBe(128);
    expect(KEYREQ_ANSWER_THROTTLE_MS).toBe(60_000);
  });

  it("creates an epoch with folded holders, found under any case of the channel", () => {
    const groups = newGroupSessionsState();
    expect(epochFor(groups, CHAN)).toBeUndefined();
    const created = createEpoch(groups, "#Grappa", ["Alice", "BOB"], NOW);
    expect(created.holders).toEqual(["alice", "bob"]);
    expect(created.createdAt).toBe(NOW);
    expect(created.messages).toBe(0);
    expect(created.counter).toBe(0);
    expect(created.receivedFrom).toBeNull();
    expect(created.seen).toEqual({});
    expect(epochFor(groups, CHAN)).toBe(created);
    expect(epochFor(groups, "#GRAPPA")).toBe(created);
  });

  it("builds the gkey inner for the current epoch, and none without one", () => {
    const groups = newGroupSessionsState();
    expect(gkeyInner(groups, CHAN)).toBeUndefined();
    const created = createEpoch(groups, CHAN, ["alice", "bob"], NOW);
    const inner = gkeyInner(groups, CHAN);
    expect(inner).toEqual({
      t: "gkey",
      ch: "#grappa",
      sid: created.sid,
      key: created.key,
      holders: ["alice", "bob"],
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
  it("round-trips with counter 0 then 1, and reports when it created the epoch", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    const first = await encryptChannel(
      aliceGroups,
      CHAN,
      "hello",
      ["alice", "bob"],
      signAlice,
      NOW,
    );
    expect(first.created).toBe(true);
    expect(first.counter).toBe(0);
    const second = await encryptChannel(
      aliceGroups,
      CHAN,
      "again",
      ["alice", "bob"],
      signAlice,
      NOW,
    );
    expect(second.created).toBe(false);
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
    const sent = await encryptChannel(aliceGroups, CHAN, "hello", ["alice", "bob"], signAlice, NOW);
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
    for (const body of ["zero", "one", "two"]) {
      sent.push(await encryptChannel(aliceGroups, CHAN, body, ["alice", "bob"], signAlice, NOW));
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
    const sent = await encryptChannel(aliceGroups, CHAN, "hello", ["alice", "bob"], signAlice, NOW);
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
    const other = await encryptChannel(
      aliceGroups,
      "#other",
      "hi",
      ["alice", "bob"],
      signAlice,
      NOW,
    );
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, other.payload, verifyAll, NOW),
    ).toEqual({ ok: false, reason: "channel-mismatch", sid: other.sid });
    // A payload under an epoch Bob no longer holds: Alice rotated away.
    rotateEpochForLeave(aliceGroups, CHAN, ["alice", "bob"], NOW);
    const after = await encryptChannel(
      aliceGroups,
      CHAN,
      "new epoch",
      ["alice", "bob"],
      signAlice,
      NOW,
    );
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
    const sent = await encryptChannel(aliceGroups, CHAN, "hello", ["alice", "bob"], signAlice, NOW);
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
    await encryptChannel(aliceGroups, CHAN, "hello", ["alice", "bob"], signAlice, NOW);
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
    await encryptChannel(aliceGroups, CHAN, "hi", ["alice", "bob"], signAlice, NOW);
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
        { t: "gkey", ch: CHAN, sid: newEpochId(), key: "not-a-key", holders: ["alice"] },
        ALICE_DID,
        NOW,
      ),
    ).toThrow();
    expect(epochFor(fresh, CHAN)).toBeUndefined();
  });

  it("supersedes by arrival: a new epoch replaces the one held", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    await encryptChannel(aliceGroups, CHAN, "epoch one", ["alice", "bob"], signAlice, NOW);
    const first = aliceGkey(aliceGroups);
    bobImports(bobGroups, aliceGroups, NOW);
    rotateEpochForLeave(aliceGroups, CHAN, ["alice", "bob"], NOW);
    const second = aliceGkey(aliceGroups);
    expect(second.sid).not.toBe(first.sid);
    expect(importEpoch(bobGroups, CHAN, second, ALICE_DID, NOW)).toBe("imported");
    expect(epochFor(bobGroups, CHAN)?.sid).toBe(second.sid);
  });
});

describe("rotation", () => {
  it("is not due without an epoch, nor for one that never spoke, and is due after a day", async () => {
    const groups = newGroupSessionsState();
    expect(rotationDue(groups, CHAN, NOW)).toBe(false);
    createEpoch(groups, CHAN, ["alice", "bob"], NOW);
    expect(rotationDue(groups, CHAN, NOW + DAY)).toBe(false);
    await encryptChannel(groups, CHAN, "spoke", ["alice", "bob"], signAlice, NOW);
    expect(rotationDue(groups, CHAN, NOW + DAY - 1)).toBe(false);
    expect(rotationDue(groups, CHAN, NOW + DAY)).toBe(true);
  });

  it("builds nothing without an epoch, or when the epoch never spoke", async () => {
    const groups = newGroupSessionsState();
    expect(await buildPeriodicRotation(groups, CHAN, signAlice, NOW + DAY)).toBeNull();
    createEpoch(groups, CHAN, ["alice", "bob"], NOW);
    expect(await buildPeriodicRotation(groups, CHAN, signAlice, NOW + DAY)).toBeNull();
  });

  it("sends one channel message under the old epoch, and the reader rotates onto the new one", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    await encryptChannel(aliceGroups, CHAN, "day one", ["alice", "bob"], signAlice, NOW);
    const oldSid = aliceGkey(aliceGroups).sid;
    bobImports(bobGroups, aliceGroups, NOW);
    expect(
      await decryptChannel(
        bobGroups,
        CHAN,
        "alice",
        ALICE_DID,
        (await encryptChannel(aliceGroups, CHAN, "read me", ["alice", "bob"], signAlice, NOW))
          .payload,
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
    const next = await encryptChannel(
      aliceGroups,
      CHAN,
      "day two",
      ["alice", "bob"],
      signAlice,
      later,
    );
    expect(next.sid).toBe(rotated?.newSid);
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, next.payload, verifyAll, later),
    ).toEqual({ ok: true, kind: "text", sid: rotated?.newSid, counter: 0, body: "day two" });
  });

  it("rotating on a leave deletes the old epoch and mints a new one the peer can import", async () => {
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    await encryptChannel(aliceGroups, CHAN, "before", ["alice", "bob"], signAlice, NOW);
    const oldSid = aliceGkey(aliceGroups).sid;
    const rotated = rotateEpochForLeave(aliceGroups, CHAN, ["alice", "bob"], NOW);
    expect(rotated.oldSid).toBe(oldSid);
    expect(rotated.newSid).not.toBe(oldSid);
    expect(epochFor(aliceGroups, CHAN)?.sid).toBe(rotated.newSid);
    expect(epochFor(aliceGroups, CHAN)?.messages).toBe(0);
    expect(
      importEpoch(
        bobGroups,
        CHAN,
        { t: "gkey", ch: CHAN, sid: rotated.newSid, key: rotated.key, holders: ["alice", "bob"] },
        ALICE_DID,
        NOW,
      ),
    ).toBe("imported");
    const after = await encryptChannel(
      aliceGroups,
      CHAN,
      "after",
      ["alice", "bob"],
      signAlice,
      NOW,
    );
    expect(
      await decryptChannel(bobGroups, CHAN, "alice", ALICE_DID, after.payload, verifyAll, NOW),
    ).toEqual({ ok: true, kind: "text", sid: rotated.newSid, counter: 0, body: "after" });
  });

  it("rotating on a leave with no epoch still mints one, with a null old sid", () => {
    const groups = newGroupSessionsState();
    const rotated = rotateEpochForLeave(groups, CHAN, ["alice", "bob"], NOW);
    expect(rotated.oldSid).toBeNull();
    expect(epochFor(groups, CHAN)?.sid).toBe(rotated.newSid);
  });
});

describe("holders and key requests", () => {
  it("spots a holder who left, and is quiet when all holders are present", async () => {
    const groups = newGroupSessionsState();
    expect(epochHoldersStale(groups, CHAN, ["alice"])).toBe(false);
    await encryptChannel(groups, CHAN, "hi", ["alice", "bob", "carol"], signAlice, NOW);
    expect(epochHoldersStale(groups, CHAN, ["alice", "bob"])).toBe(true);
    expect(epochHoldersStale(groups, CHAN, ["alice", "bob", "carol"])).toBe(false);
    // The fold is case-insensitive: the roster in display spelling still matches.
    expect(epochHoldersStale(groups, CHAN, ["Alice", "BOB", "Carol"])).toBe(false);
  });

  it("answers a key request once per asker per minute", () => {
    const groups = newGroupSessionsState();
    expect(keyreqAnswerDue(groups, CHAN, "bob", NOW)).toBe(true);
    markKeyreqAnswered(groups, CHAN, "bob", NOW);
    expect(keyreqAnswerDue(groups, CHAN, "bob", NOW)).toBe(false);
    expect(keyreqAnswerDue(groups, CHAN, "bob", NOW + KEYREQ_ANSWER_THROTTLE_MS - 1)).toBe(false);
    expect(keyreqAnswerDue(groups, CHAN, "bob", NOW + KEYREQ_ANSWER_THROTTLE_MS)).toBe(true);
    // The throttle is per asker and per channel.
    expect(keyreqAnswerDue(groups, CHAN, "carol", NOW)).toBe(true);
    expect(keyreqAnswerDue(groups, "#other", "bob", NOW)).toBe(true);
  });

  it("drops one epoch, or everything of a channel, and tolerates a missing one", async () => {
    const groups = newGroupSessionsState();
    dropEpoch(groups, CHAN);
    dropChannel(groups, CHAN);
    await encryptChannel(groups, CHAN, "hi", ["alice", "bob"], signAlice, NOW);
    dropEpoch(groups, CHAN);
    expect(epochFor(groups, CHAN)).toBeUndefined();
    await encryptChannel(groups, CHAN, "hi again", ["alice", "bob"], signAlice, NOW);
    dropChannel(groups, CHAN);
    expect(epochFor(groups, CHAN)).toBeUndefined();
  });
});
