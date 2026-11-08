// Channel E2E (wire v3) — the group session store and the channel
// send/receive paths against the REAL vodozemac binding (via the
// `helpers/olm` loader, `initSync` of the vendored bytes). This is the
// integration point for the Rust worker's Megolm exports: it proves the
// `megolm.ts` adapter translates to the real `GroupSession` /
// `InboundGroupSession` classes — `encrypt` returning a `GroupEncrypted`
// with `body` + `message_index`, `decrypt` returning a `GroupDecrypted`
// — and that two devices can exchange channel messages, rotate, and
// reject bad keys end to end. The fake-adapter tests prove the store's
// rules; these prove the crypto underneath them.
import { describe, expect, it } from "vitest";
import {
  buildPeriodicRotation,
  createOutbound,
  decryptChannel,
  encryptChannel,
  exportOutboundKey,
  type GroupSessionsState,
  gkeyInner,
  importInbound,
  newGroupSessionsState,
} from "../lib/e2e/groupSessions";
import { type MegolmAdapter, megolmFromBinding } from "../lib/e2e/megolm";
import { olm } from "./helpers/olm";

const CHAN = "#grappa";
const NOW = 1_000_000;

/** The real adapter over the vendored wasm binding. */
function realAdapter(): MegolmAdapter {
  return megolmFromBinding(olm());
}

/** Alice sends on the channel, Bob receives: each holds its own state. */
function pair(): {
  alice: MegolmAdapter;
  bob: MegolmAdapter;
  aliceGroups: GroupSessionsState;
  bobGroups: GroupSessionsState;
} {
  return {
    alice: realAdapter(),
    bob: realAdapter(),
    aliceGroups: newGroupSessionsState(),
    bobGroups: newGroupSessionsState(),
  };
}

/** Bob imports Alice's current epoch key, as a gkey DM would carry it. */
function bobImportsAliceKey(
  aliceGroups: GroupSessionsState,
  alice: MegolmAdapter,
  bobGroups: GroupSessionsState,
  bob: MegolmAdapter,
): { sid: string; key: string } {
  const inner = gkeyInner(aliceGroups, alice, CHAN);
  if (inner === undefined) throw new Error("alice has no epoch to share");
  importInbound(bobGroups, bob, CHAN, "alice", inner.sid, inner.key, NOW);
  return { sid: inner.sid, key: inner.key };
}

describe("channel E2E against the real Megolm binding", () => {
  it("round-trips a channel message: alice encrypts, bob decrypts", () => {
    const { alice, bob, aliceGroups, bobGroups } = pair();
    // The epoch is created and its key shared BEFORE any message is
    // encrypted under it: a session key carries the ratchet at the
    // sender's current index, so a key shared after message 0 cannot
    // decrypt message 0 — the newcomer reads from the join onward.
    createOutbound(aliceGroups, alice, CHAN, NOW);
    bobImportsAliceKey(aliceGroups, alice, bobGroups, bob);
    const sent = encryptChannel(aliceGroups, alice, CHAN, "ciao canale", NOW);
    expect(sent.created).toBe(false);
    expect(sent.index).toBe(0);
    const read = decryptChannel(bobGroups, bob, CHAN, "alice", sent.payload, NOW);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.kind).toBe("text");
    if (read.kind !== "text") return;
    expect(read.body).toBe("ciao canale");
    expect(read.index).toBe(0);
    expect(read.sid).toBe(sent.sid);
  });

  it("decrypts out of order, and refuses a replay", () => {
    const { alice, bob, aliceGroups, bobGroups } = pair();
    createOutbound(aliceGroups, alice, CHAN, NOW);
    bobImportsAliceKey(aliceGroups, alice, bobGroups, bob);
    const first = encryptChannel(aliceGroups, alice, CHAN, "uno", NOW);
    const second = encryptChannel(aliceGroups, alice, CHAN, "due", NOW);
    const third = encryptChannel(aliceGroups, alice, CHAN, "tre", NOW);
    const readSecond = decryptChannel(bobGroups, bob, CHAN, "alice", second.payload, NOW);
    expect(readSecond.ok).toBe(true);
    if (readSecond.ok && readSecond.kind === "text") expect(readSecond.body).toBe("due");
    const readFirst = decryptChannel(bobGroups, bob, CHAN, "alice", first.payload, NOW);
    expect(readFirst.ok).toBe(true);
    if (readFirst.ok && readFirst.kind === "text") expect(readFirst.body).toBe("uno");
    const readThird = decryptChannel(bobGroups, bob, CHAN, "alice", third.payload, NOW);
    expect(readThird.ok).toBe(true);
    if (readThird.ok && readThird.kind === "text") expect(readThird.body).toBe("tre");
    const replay = decryptChannel(bobGroups, bob, CHAN, "alice", second.payload, NOW);
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.reason).toBe("replay");
  });

  it("rotates periodically: bob consumes the grotate, then reads the new epoch", () => {
    const { alice, bob, aliceGroups, bobGroups } = pair();
    encryptChannel(aliceGroups, alice, CHAN, "prima", NOW);
    bobImportsAliceKey(aliceGroups, alice, bobGroups, bob);
    const rotation = buildPeriodicRotation(aliceGroups, alice, CHAN, NOW);
    expect(rotation).not.toBeNull();
    if (rotation === null) return;
    const consumed = decryptChannel(bobGroups, bob, CHAN, "alice", rotation.payload, NOW);
    expect(consumed.ok).toBe(true);
    if (!consumed.ok) return;
    expect(consumed.kind).toBe("rotated");
    if (consumed.kind !== "rotated") return;
    expect(consumed.newSid).toBe(rotation.newSid);
    const after = encryptChannel(aliceGroups, alice, CHAN, "dopo la rotazione", NOW);
    expect(after.sid).toBe(rotation.newSid);
    const read = decryptChannel(bobGroups, bob, CHAN, "alice", after.payload, NOW);
    expect(read.ok).toBe(true);
    if (read.ok && read.kind === "text") expect(read.body).toBe("dopo la rotazione");
  });

  it("a key shared late cannot decrypt messages sent before it: the newcomer reads from the join onward", () => {
    const { alice, bob, aliceGroups, bobGroups } = pair();
    const before = encryptChannel(aliceGroups, alice, CHAN, "prima che tu arrivassi", NOW);
    expect(before.index).toBe(0);
    bobImportsAliceKey(aliceGroups, alice, bobGroups, bob);
    const unreadable = decryptChannel(bobGroups, bob, CHAN, "alice", before.payload, NOW);
    expect(unreadable.ok).toBe(false);
    if (!unreadable.ok) expect(unreadable.reason).toBe("decryption-failed");
    const after = encryptChannel(aliceGroups, alice, CHAN, "dopo che sei arrivato", NOW);
    const read = decryptChannel(bobGroups, bob, CHAN, "alice", after.payload, NOW);
    expect(read.ok).toBe(true);
    if (read.ok && read.kind === "text") expect(read.body).toBe("dopo che sei arrivato");
  });

  it("rejects a bad session key at import, and a message of another epoch", () => {
    const { alice, bob, aliceGroups, bobGroups } = pair();
    expect(() =>
      importInbound(
        bobGroups,
        bob,
        CHAN,
        "alice",
        "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        "not-a-key",
        NOW,
      ),
    ).toThrow();
    const sent = encryptChannel(aliceGroups, alice, CHAN, "segreto", NOW);
    const read = decryptChannel(bobGroups, bob, CHAN, "alice", sent.payload, NOW);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe("no-session");
  });

  it("restores a pickled outbound session and keeps encrypting", () => {
    const { alice, bob, aliceGroups, bobGroups } = pair();
    const first = encryptChannel(aliceGroups, alice, CHAN, "uno", NOW);
    expect(first.index).toBe(0);
    // The store holds the pickle after the encrypt; a reload restores it.
    const reloaded = JSON.parse(JSON.stringify(aliceGroups)) as GroupSessionsState;
    const second = encryptChannel(reloaded, alice, CHAN, "due", NOW);
    expect(second.index).toBe(1);
    expect(second.sid).toBe(first.sid);
    bobImportsAliceKey(aliceGroups, alice, bobGroups, bob);
    const read = decryptChannel(bobGroups, bob, CHAN, "alice", second.payload, NOW);
    expect(read.ok).toBe(true);
    if (read.ok && read.kind === "text") expect(read.body).toBe("due");
    expect(exportOutboundKey(reloaded, alice, CHAN)?.sid).toBe(first.sid);
  });
});
