// Channel E2E (wire v3) — the group session store and the v3/gkey wire
// shapes, against the fake Megolm adapter (`helpers/e2eMegolmFake.ts`).
// No wasm runs here: the fake models the adapter contract, and these
// tests prove the store's rules (create/rotate/delete, supersede,
// persistence round-trip) and the payload shapes, not vodozemac.
import { describe, expect, it } from "vitest";
import {
  buildPeriodicRotation,
  createOutbound,
  decryptChannel,
  deleteOutbound,
  dropChannel,
  dropInboundFrom,
  encryptChannel,
  exportOutboundKey,
  GROUP_ROTATION_INTERVAL_MS,
  type GroupSessionsState,
  gkeyInner,
  importInbound,
  inboundFor,
  newGroupSessionsState,
  outboundFor,
  rotateOutboundForLeave,
  rotationDue,
} from "../lib/e2e/groupSessions";
import type { MegolmAdapter } from "../lib/e2e/megolm";
import {
  decodePayload,
  encodePayload,
  GROUP_WIRE_VERSION,
  PayloadError,
  parseChannelPayload,
  parseGkeyInner,
} from "../lib/e2e/wire";
import { fakeMegolmAdapter } from "./helpers/e2eMegolmFake";

const CHAN = "#grappa";
const NOW = 1_000_000;

/** Two devices: Alice sends, Bob receives. Each holds its own adapter (its own epochs). */
function pair(): { alice: MegolmAdapter; bob: MegolmAdapter } {
  return { alice: fakeMegolmAdapter(), bob: fakeMegolmAdapter() };
}

/** Alice's current epoch key, as Bob would receive it in a gkey. */
function aliceKey(
  aliceGroups: GroupSessionsState,
  alice: MegolmAdapter,
): { sid: string; key: string } {
  const exported = exportOutboundKey(aliceGroups, alice, CHAN);
  if (exported === undefined) throw new Error("alice has no epoch");
  return exported;
}

/** Bob imports Alice's epoch key. */
function bobImports(
  bobGroups: GroupSessionsState,
  bob: MegolmAdapter,
  sid: string,
  key: string,
): void {
  expect(importInbound(bobGroups, bob, CHAN, "alice", sid, key, NOW)).toBe("imported");
}

describe("wire v3 shapes", () => {
  it("parses the §4f channel payload, and refuses a wrong version, a missing field, or a negative index", () => {
    const payload = { v: 3, ch: "#grappa", sid: "sid-1", i: 0, body: "Y2lwaGVy" };
    expect(parseChannelPayload(payload)).toEqual(payload);
    expect(() => parseChannelPayload({ ...payload, v: 2 })).toThrow(PayloadError);
    expect(() => parseChannelPayload({ ...payload, i: -1 })).toThrow(PayloadError);
    expect(() => parseChannelPayload({ ...payload, i: 1.5 })).toThrow(PayloadError);
    expect(() => parseChannelPayload({ v: 3, ch: "#grappa", sid: "sid-1", i: 0 })).toThrow(
      PayloadError,
    );
    expect(() => parseChannelPayload({ ...payload, body: "" })).toThrow(PayloadError);
  });

  it("encodes a channel payload as compact JSON with version 3", () => {
    const text = encodePayload({ v: GROUP_WIRE_VERSION, ch: CHAN, sid: "s", i: 2, body: "eQ" });
    expect(text).toBe('{"v":3,"ch":"#grappa","sid":"s","i":2,"body":"eQ"}');
    expect(parseChannelPayload(decodePayload(text)).i).toBe(2);
  });

  it("parses a gkey inner, and refuses one naming another type or missing a field", () => {
    const inner = { t: "gkey", ch: "#grappa", sid: "sid-1", key: "a2V5" };
    expect(parseGkeyInner(inner)).toEqual(inner);
    expect(() => parseGkeyInner({ ...inner, t: "text" })).toThrow(PayloadError);
    expect(() => parseGkeyInner({ t: "gkey", ch: "#grappa", sid: "sid-1" })).toThrow(PayloadError);
    expect(() => parseGkeyInner({ ...inner, key: "" })).toThrow(PayloadError);
  });
});

describe("group session store", () => {
  it("creates an outbound epoch, encrypts under it with rising chain indices, and deletes it", () => {
    const groups = newGroupSessionsState();
    const adapter = fakeMegolmAdapter();
    expect(outboundFor(groups, CHAN)).toBeUndefined();
    const created = createOutbound(groups, adapter, CHAN, NOW);
    expect(created.sid).toMatch(/^fake-sid-/);
    expect(created.messages).toBe(0);
    const first = encryptChannel(groups, adapter, CHAN, "hello", NOW);
    const second = encryptChannel(groups, adapter, CHAN, "again", NOW);
    expect(first.index).toBe(0);
    expect(second.index).toBe(1);
    expect(first.sid).toBe(created.sid);
    expect(outboundFor(groups, CHAN)?.messages).toBe(2);
    deleteOutbound(groups, CHAN);
    expect(outboundFor(groups, CHAN)).toBeUndefined();
  });

  it("round-trips through JSON: a sealed record reloaded keeps the epoch and its chain index", () => {
    const groups = newGroupSessionsState();
    const adapter = fakeMegolmAdapter();
    encryptChannel(groups, adapter, CHAN, "one", NOW);
    encryptChannel(groups, adapter, CHAN, "two", NOW);
    const sid = outboundFor(groups, CHAN)?.sid;
    const reloaded = JSON.parse(JSON.stringify(groups)) as GroupSessionsState;
    expect(outboundFor(reloaded, CHAN)?.sid).toBe(sid);
    const third = encryptChannel(reloaded, adapter, CHAN, "three", NOW);
    expect(third.index).toBe(2);
    expect(third.sid).toBe(sid);
  });

  it("encrypts for Alice and decrypts for Bob once Bob holds her epoch key", () => {
    const { alice, bob } = pair();
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    const sent = encryptChannel(aliceGroups, alice, CHAN, "hello bob", NOW);
    const { sid, key } = aliceKey(aliceGroups, alice);
    expect(sent.sid).toBe(sid);
    bobImports(bobGroups, bob, sid, key);
    const read = decryptChannel(bobGroups, bob, CHAN, "alice", sent.payload, NOW);
    expect(read).toEqual({ ok: true, kind: "text", sid, index: 0, body: "hello bob" });
  });

  it("refuses a channel message with no session, a tampered body, a replay, or another channel's name", () => {
    const { alice, bob } = pair();
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    const sent = encryptChannel(aliceGroups, alice, CHAN, "hello", NOW);
    // No session at all.
    expect(decryptChannel(bobGroups, bob, CHAN, "alice", sent.payload, NOW)).toEqual({
      ok: false,
      reason: "no-session",
      sid: sent.sid,
    });
    const { sid, key } = aliceKey(aliceGroups, alice);
    bobImports(bobGroups, bob, sid, key);
    // Tampered body: the fake ciphertext no longer parses.
    const tampered = encodePayload({ ...decodePayload(sent.payload), body: "!!!not-base64!!!" });
    expect(decryptChannel(bobGroups, bob, CHAN, "alice", tampered, NOW)).toEqual({
      ok: false,
      reason: "decryption-failed",
      sid,
    });
    // A replay of the same chain index: the session already read it.
    expect(decryptChannel(bobGroups, bob, CHAN, "alice", sent.payload, NOW)).toEqual({
      ok: true,
      kind: "text",
      sid,
      index: 0,
      body: "hello",
    });
    expect(decryptChannel(bobGroups, bob, CHAN, "alice", sent.payload, NOW)).toEqual({
      ok: false,
      reason: "decryption-failed",
      sid,
    });
    // Another channel's name in the envelope: the inbox channel rules.
    const other = encryptChannel(aliceGroups, alice, "#other", "hi", NOW);
    expect(decryptChannel(bobGroups, bob, CHAN, "alice", other.payload, NOW)).toEqual({
      ok: false,
      reason: "channel-mismatch",
      sid: other.sid,
    });
    // Garbage that is not a payload at all.
    expect(decryptChannel(bobGroups, bob, CHAN, "alice", "not json", NOW)).toEqual({
      ok: false,
      reason: "bad-payload",
      sid: null,
    });
  });

  it("imports a gkey once: a re-sent key is a no-op, a key for another sid is refused", () => {
    const { alice, bob } = pair();
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    encryptChannel(aliceGroups, alice, CHAN, "hi", NOW);
    const { sid, key } = aliceKey(aliceGroups, alice);
    expect(importInbound(bobGroups, bob, CHAN, "alice", sid, key, NOW)).toBe("imported");
    expect(importInbound(bobGroups, bob, CHAN, "alice", sid, key, NOW)).toBe("already-held");
    expect(() => importInbound(bobGroups, bob, CHAN, "alice", "another-sid", key, NOW)).toThrow(
      /opened/,
    );
    // A key Megolm refuses, for a session id nothing holds yet: refused, never stored.
    expect(() =>
      importInbound(bobGroups, bob, CHAN, "alice", "third-sid", "not-a-key", NOW),
    ).toThrow();
    expect(inboundFor(bobGroups, CHAN, "alice", "third-sid")).toBeUndefined();
  });

  it("supersedes: a sender's new epoch drops their old inbound session", () => {
    const { alice, bob } = pair();
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    encryptChannel(aliceGroups, alice, CHAN, "epoch one", NOW);
    const first = aliceKey(aliceGroups, alice);
    bobImports(bobGroups, bob, first.sid, first.key);
    expect(inboundFor(bobGroups, CHAN, "alice", first.sid)).toBeDefined();
    // Alice rotates (a member left) and Bob imports the new key.
    rotateOutboundForLeave(aliceGroups, alice, CHAN, NOW);
    const second = aliceKey(aliceGroups, alice);
    expect(second.sid).not.toBe(first.sid);
    bobImports(bobGroups, bob, second.sid, second.key);
    expect(inboundFor(bobGroups, CHAN, "alice", first.sid)).toBeUndefined();
    expect(inboundFor(bobGroups, CHAN, "alice", second.sid)).toBeDefined();
  });

  it("drops a departed sender's inbound sessions, and everything on our own leave", () => {
    const { alice, bob } = pair();
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    encryptChannel(aliceGroups, alice, CHAN, "hi", NOW);
    const { sid, key } = aliceKey(aliceGroups, alice);
    bobImports(bobGroups, bob, sid, key);
    dropInboundFrom(bobGroups, CHAN, "alice");
    expect(inboundFor(bobGroups, CHAN, "alice", sid)).toBeUndefined();
    bobImports(bobGroups, bob, sid, key);
    dropChannel(bobGroups, CHAN);
    expect(inboundFor(bobGroups, CHAN, "alice", sid)).toBeUndefined();
    expect(outboundFor(bobGroups, CHAN)).toBeUndefined();
  });

  it("rotating on a leave deletes the old outbound and mints a new epoch", () => {
    const groups = newGroupSessionsState();
    const adapter = fakeMegolmAdapter();
    encryptChannel(groups, adapter, CHAN, "before", NOW);
    const oldSid = outboundFor(groups, CHAN)?.sid;
    const rotated = rotateOutboundForLeave(groups, adapter, CHAN, NOW);
    expect(rotated.oldSid).toBe(oldSid);
    expect(rotated.newSid).not.toBe(oldSid);
    expect(outboundFor(groups, CHAN)?.sid).toBe(rotated.newSid);
    expect(outboundFor(groups, CHAN)?.messages).toBe(0);
    // The new key opens the new epoch for a peer.
    const bobGroups = newGroupSessionsState();
    const bob = fakeMegolmAdapter();
    expect(importInbound(bobGroups, bob, CHAN, "alice", rotated.newSid, rotated.key, NOW)).toBe(
      "imported",
    );
  });

  it("builds the gkey inner for the current epoch, and none without one", () => {
    const groups = newGroupSessionsState();
    const adapter = fakeMegolmAdapter();
    expect(gkeyInner(groups, adapter, CHAN)).toBeUndefined();
    const created = createOutbound(groups, adapter, CHAN, NOW);
    const inner = gkeyInner(groups, adapter, CHAN);
    expect(inner?.t).toBe("gkey");
    expect(inner?.ch).toBe("#grappa");
    expect(inner?.sid).toBe(created.sid);
    expect(typeof inner?.key).toBe("string");
  });
});

describe("periodic rotation", () => {
  it("is not due for a fresh epoch, nor for one that never spoke, and is due after a day", () => {
    const groups = newGroupSessionsState();
    const adapter = fakeMegolmAdapter();
    expect(rotationDue(groups, CHAN, NOW)).toBe(false);
    createOutbound(groups, adapter, CHAN, NOW);
    expect(rotationDue(groups, CHAN, NOW + GROUP_ROTATION_INTERVAL_MS)).toBe(false);
    encryptChannel(groups, adapter, CHAN, "spoke", NOW);
    expect(rotationDue(groups, CHAN, NOW + GROUP_ROTATION_INTERVAL_MS - 1)).toBe(false);
    expect(rotationDue(groups, CHAN, NOW + GROUP_ROTATION_INTERVAL_MS)).toBe(true);
  });

  it("sends one channel message under the old epoch, and the reader rotates onto the new one", () => {
    const { alice, bob } = pair();
    const aliceGroups = newGroupSessionsState();
    const bobGroups = newGroupSessionsState();
    encryptChannel(aliceGroups, alice, CHAN, "day one", NOW);
    const { sid: oldSid, key } = aliceKey(aliceGroups, alice);
    bobImports(bobGroups, bob, oldSid, key);
    const later = NOW + GROUP_ROTATION_INTERVAL_MS;
    const rotated = buildPeriodicRotation(aliceGroups, alice, CHAN, later);
    expect(rotated).not.toBeNull();
    expect(rotated?.oldSid).toBe(oldSid);
    expect(rotated?.newSid).not.toBe(oldSid);
    // The rotation message is a v3 payload naming the OLD sid.
    const envelope = parseChannelPayload(decodePayload(rotated?.payload ?? ""));
    expect(envelope.sid).toBe(oldSid);
    // Bob reads it: a rotation, not a text.
    const read = decryptChannel(bobGroups, bob, CHAN, "alice", rotated?.payload ?? "", later);
    expect(read).toEqual({
      ok: true,
      kind: "rotated",
      sid: oldSid,
      index: 1,
      newSid: rotated?.newSid,
    });
    // The old epoch is dead for Bob now: an old-epoch message replays as undecryptable.
    // (The first message's index was already read; a fresh old-epoch line would
    // fail the same way — the session is gone.)
    expect(inboundFor(bobGroups, CHAN, "alice", oldSid)).toBeUndefined();
    expect(inboundFor(bobGroups, CHAN, "alice", rotated?.newSid ?? "")).toBeDefined();
    // And a message under the NEW epoch reads.
    const next = encryptChannel(aliceGroups, alice, CHAN, "day two", later);
    expect(next.sid).toBe(rotated?.newSid);
    expect(decryptChannel(bobGroups, bob, CHAN, "alice", next.payload, later)).toEqual({
      ok: true,
      kind: "text",
      sid: rotated?.newSid,
      index: 0,
      body: "day two",
    });
  });

  it("builds nothing without an epoch, or when the epoch never spoke", () => {
    const groups = newGroupSessionsState();
    const adapter = fakeMegolmAdapter();
    expect(
      buildPeriodicRotation(groups, adapter, CHAN, NOW + GROUP_ROTATION_INTERVAL_MS),
    ).toBeNull();
    createOutbound(groups, adapter, CHAN, NOW);
    expect(
      buildPeriodicRotation(groups, adapter, CHAN, NOW + GROUP_ROTATION_INTERVAL_MS),
    ).toBeNull();
  });
});
