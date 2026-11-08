// Channel E2E (wire v3) — the orchestration over the group session
// store: key distribution, join/leave triggers, channel send/receive,
// periodic rotation. The DM sender is a fake that records the gkey
// payloads (and the Olm engine's tags); the Megolm adapter is the fake
// in `helpers/e2eMegolmFake.ts`. No wasm, no network.
import { describe, expect, it } from "vitest";
import {
  type ChannelE2eDeps,
  type ChannelE2eEvent,
  channelsWithEpoch,
  designatedSender,
  distributeKey,
  emitChannelE2eEvents,
  GKEY_TAG,
  onChannelE2eEvent,
  onMemberJoined,
  onMemberLeft,
  receiveChannel,
  receiveGkey,
  rotateDue,
  sendChannel,
} from "../lib/e2e/channelE2e";
import type { Outbound } from "../lib/e2e/engine";
import { inboundFor, newGroupSessionsState, outboundFor } from "../lib/e2e/groupSessions";
import type { MegolmAdapter } from "../lib/e2e/megolm";
import { encodePayload } from "../lib/e2e/wire";
import { fakeMegolmAdapter } from "./helpers/e2eMegolmFake";

const CHAN = "#grappa";
const NOW = 1_000_000;
const DAY = 86_400_000;

/** A fake DM sender: records every gkey it was asked to send, as the engine would queue it. */
function fakeDm() {
  const sent: { nick: string; inner: Record<string, unknown> }[] = [];
  const sendDm = (nick: string, inner: Record<string, unknown>): Outbound[] => {
    sent.push({ nick, inner });
    return [
      {
        target: nick,
        verb: "msg",
        from: "AaZaARRDyBk",
        to: "BoBBoBBoBBo",
        payload: encodePayload(inner),
        priority: "text",
        ref: "r1",
        tag: GKEY_TAG,
      },
    ];
  };
  return { sent, sendDm };
}

function deps(
  adapter: MegolmAdapter | null,
  ownNick: string,
  dm: ReturnType<typeof fakeDm>,
): ChannelE2eDeps {
  return {
    adapter,
    ownNick,
    ownDid: "AaZaARRDyBk",
    now: () => NOW,
    sendDm: dm.sendDm,
  };
}

/** Alice's side and Bob's side, each with a store, an adapter, and a fake DM sender. */
function sides() {
  const aliceDm = fakeDm();
  const bobDm = fakeDm();
  const aliceAdapter = fakeMegolmAdapter();
  const bobAdapter = fakeMegolmAdapter();
  return {
    alice: {
      groups: newGroupSessionsState(),
      adapter: aliceAdapter,
      dm: aliceDm,
      deps: deps(aliceAdapter, "alice", aliceDm),
    },
    bob: {
      groups: newGroupSessionsState(),
      adapter: bobAdapter,
      dm: bobDm,
      deps: deps(bobAdapter, "bob", bobDm),
    },
  };
}

describe("designatedSender", () => {
  it("is the folded-nick first member other than the newcomer", () => {
    expect(designatedSender(["bob", "Alice", "carol"], "carol")).toBe("Alice");
    expect(designatedSender(["bob", "Alice", "carol"], "Alice")).toBe("bob");
    expect(designatedSender(["alice"], "bob")).toBe("alice");
    expect(designatedSender(["bob"], "bob")).toBeUndefined();
    expect(designatedSender([], "bob")).toBeUndefined();
  });
});

describe("join", () => {
  it("the designated sender sends the epoch key to the newcomer only", () => {
    const { alice } = sides();
    // Alice is designated (first of alice/bob/carol, newcomer dave excluded).
    const res = onMemberJoined(alice.deps, alice.groups, CHAN, "dave", [
      "alice",
      "bob",
      "carol",
      "dave",
    ]);
    expect(res.events.some((e) => e.kind === "channel_rotated" && e.reason === "created")).toBe(
      true,
    );
    expect(alice.dm.sent).toHaveLength(1);
    expect(alice.dm.sent[0]?.nick).toBe("dave");
    const inner = alice.dm.sent[0]?.inner as { t: string; ch: string; sid: string; key: string };
    expect(inner.t).toBe("gkey");
    expect(inner.ch).toBe("#grappa");
    expect(inner.sid).toBe(outboundFor(alice.groups, CHAN)?.sid);
    expect(res.events).toContainEqual({
      kind: "channel_key_sent",
      channel: CHAN,
      to: "dave",
      sid: inner.sid,
    });
  });

  it("a member who is not designated sends nothing, and our own join sends nothing", () => {
    const s = sides();
    // Alice is designated (first of alice/bob, newcomer carol excluded) — Bob is not.
    expect(
      onMemberJoined(s.bob.deps, s.bob.groups, CHAN, "carol", ["alice", "bob", "carol"]).outbound,
    ).toEqual([]);
    expect(s.bob.dm.sent).toEqual([]);
    // Our own join: we wait for the key.
    expect(
      onMemberJoined(s.alice.deps, s.alice.groups, CHAN, "alice", ["alice", "bob"]).outbound,
    ).toEqual([]);
    expect(s.alice.dm.sent).toEqual([]);
  });

  it("a gkey received imports the epoch: the newcomer can then read the channel", () => {
    const s = sides();
    // Alice (designated) distributes to Dave; Dave imports and reads.
    const daveGroups = newGroupSessionsState();
    const daveAdapter = fakeMegolmAdapter();
    const daveDeps = deps(daveAdapter, "dave", fakeDm());
    onMemberJoined(s.alice.deps, s.alice.groups, CHAN, "dave", ["alice", "bob", "dave"]);
    const gkey = s.alice.dm.sent[0]?.inner as Record<string, unknown>;
    const received = receiveGkey(daveDeps, daveGroups, gkey, "alice");
    expect(received).toEqual([
      { kind: "channel_key_received", channel: CHAN, from: "alice", sid: gkey.sid as string },
    ]);
    // Alice sends a channel message; Dave reads it.
    const sent = sendChannel(s.alice.deps, s.alice.groups, CHAN, "welcome", [
      "alice",
      "bob",
      "dave",
    ]);
    const channelMsg = sent.outbound.find((o) => o.target === CHAN);
    expect(channelMsg?.verb).toBe("msg");
    expect(channelMsg?.to).toBe("*");
    expect(receiveChannel(daveDeps, daveGroups, CHAN, "alice", channelMsg?.payload ?? "")).toEqual([
      {
        kind: "channel_received",
        channel: CHAN,
        from: "alice",
        sid: gkey.sid as string,
        index: 0,
        body: "welcome",
      },
    ]);
    // A re-sent gkey is a no-op: no event, no throw.
    expect(receiveGkey(daveDeps, daveGroups, gkey, "alice")).toEqual([]);
  });

  it("a bad gkey is dropped, never stored, never thrown", () => {
    const s = sides();
    const badKey = { t: "gkey", ch: CHAN, sid: "sid-x", key: "not-a-key" };
    const events = receiveGkey(s.bob.deps, s.bob.groups, badKey, "alice");
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("channel_dropped");
    expect(inboundFor(s.bob.groups, CHAN, "alice", "sid-x")).toBeUndefined();
    expect(receiveGkey(s.bob.deps, s.bob.groups, { t: "text", body: "hi" }, "alice")).toEqual([
      expect.objectContaining({ kind: "channel_dropped", reason: "bad-gkey" }),
    ]);
  });
});

describe("leave", () => {
  it("rotates our epoch, distributes the new key to the members who remain, and drops the departed sender", () => {
    const s = sides();
    // Alice and Bob share an epoch: Alice sends, Bob reads.
    const aliceSent = sendChannel(s.alice.deps, s.alice.groups, CHAN, "before", [
      "alice",
      "bob",
      "carol",
    ]);
    const gkey = s.alice.dm.sent[0]?.inner as Record<string, unknown>;
    receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice");
    const channelMsg = aliceSent.outbound.find((o) => o.target === CHAN);
    expect(
      receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", channelMsg?.payload ?? ""),
    ).toEqual([expect.objectContaining({ kind: "channel_received", body: "before" })]);
    const oldSid = outboundFor(s.alice.groups, CHAN)?.sid;

    // Carol leaves. Alice rotates and distributes to Bob only.
    s.alice.dm.sent.length = 0;
    const res = onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "carol", ["alice", "bob"]);
    expect(res.events).toContainEqual({
      kind: "channel_rotated",
      channel: CHAN,
      oldSid,
      newSid: expect.any(String),
      reason: "member-left",
    });
    expect(outboundFor(s.alice.groups, CHAN)?.sid).not.toBe(oldSid);
    expect(s.alice.dm.sent.map((d) => d.nick)).toEqual(["bob"]);
    const newKey = s.alice.dm.sent[0]?.inner as { sid: string; key: string };
    expect(newKey.sid).toBe(outboundFor(s.alice.groups, CHAN)?.sid);
    // Bob imports the new epoch and reads what follows; the old epoch is dead for him.
    receiveGkey(s.bob.deps, s.bob.groups, s.alice.dm.sent[0]?.inner ?? {}, "alice");
    expect(inboundFor(s.bob.groups, CHAN, "alice", oldSid ?? "")).toBeUndefined();
    const after = sendChannel(s.alice.deps, s.alice.groups, CHAN, "after", ["alice", "bob"]);
    const afterMsg = after.outbound.find((o) => o.target === CHAN);
    expect(
      receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", afterMsg?.payload ?? ""),
    ).toEqual([expect.objectContaining({ kind: "channel_received", body: "after" })]);
  });

  it("our own leave drops the whole channel, and sends nothing", () => {
    const s = sides();
    sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    s.alice.dm.sent.length = 0;
    const res = onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "alice", ["bob"]);
    expect(res.outbound).toEqual([]);
    expect(res.events).toContainEqual({
      kind: "channel_dropped",
      channel: CHAN,
      reason: "own-leave",
    });
    expect(outboundFor(s.alice.groups, CHAN)).toBeUndefined();
  });
});

describe("sendChannel", () => {
  it("creates the epoch on first send, distributes the key first, then sends one channel message", () => {
    const s = sides();
    const res = sendChannel(s.alice.deps, s.alice.groups, CHAN, "hello all", [
      "alice",
      "bob",
      "carol",
    ]);
    // Two gkey DMs, then the channel message.
    expect(s.alice.dm.sent.map((d) => d.nick)).toEqual(["bob", "carol"]);
    expect(res.outbound).toHaveLength(3);
    expect(res.outbound[0]?.target).toBe("bob");
    expect(res.outbound[1]?.target).toBe("carol");
    const channel = res.outbound[2];
    expect(channel?.target).toBe(CHAN);
    expect(channel?.verb).toBe("msg");
    expect(channel?.to).toBe("*");
    expect(channel?.from).toBe("AaZaARRDyBk");
    expect(channel?.ref).toBeUndefined();
    expect(channel?.tag).toBeUndefined();
    // The second send reuses the epoch: no more gkeys.
    s.alice.dm.sent.length = 0;
    const again = sendChannel(s.alice.deps, s.alice.groups, CHAN, "again", [
      "alice",
      "bob",
      "carol",
    ]);
    expect(again.outbound).toHaveLength(1);
    expect(again.outbound[0]?.target).toBe(CHAN);
  });

  it("decrypts end to end across two stores, and skips our own echoes", () => {
    const s = sides();
    // Bob imports Alice's epoch through the join path.
    onMemberJoined(s.alice.deps, s.alice.groups, CHAN, "bob", ["alice", "bob"]);
    const gkey = s.alice.dm.sent[0]?.inner as Record<string, unknown>;
    receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice");
    const sent = sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi bob", ["alice", "bob"]);
    const payload = sent.outbound.find((o) => o.target === CHAN)?.payload ?? "";
    expect(receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", payload)).toEqual([
      expect.objectContaining({ kind: "channel_received", body: "hi bob" }),
    ]);
    // Our own message, coming back through the inbox, is skipped.
    expect(receiveChannel(s.alice.deps, s.alice.groups, CHAN, "alice", payload)).toEqual([]);
  });

  it("surfaces an unreadable channel message as undecryptable, never a throw", () => {
    const s = sides();
    const sent = sendChannel(s.alice.deps, s.alice.groups, CHAN, "secret", ["alice", "bob"]);
    const payload = sent.outbound.find((o) => o.target === CHAN)?.payload ?? "";
    // Bob holds no session: no-session.
    expect(receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", payload)).toEqual([
      {
        kind: "channel_undecryptable",
        channel: CHAN,
        from: "alice",
        sid: expect.any(String),
        reason: "no-session",
      },
    ]);
    // Garbage: bad-payload.
    expect(receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", "garbage")).toEqual([
      {
        kind: "channel_undecryptable",
        channel: CHAN,
        from: "alice",
        sid: null,
        reason: "bad-payload",
      },
    ]);
  });
});

describe("periodic rotation", () => {
  it("rotates a due epoch with one channel message, and the reader follows", () => {
    const s = sides();
    const tickNow = () => NOW + DAY;
    const aliceTickDeps: ChannelE2eDeps = { ...s.alice.deps, now: tickNow };
    const bobTickDeps: ChannelE2eDeps = { ...s.bob.deps, now: tickNow };
    // Share the epoch first.
    onMemberJoined(s.alice.deps, s.alice.groups, CHAN, "bob", ["alice", "bob"]);
    const gkey = s.alice.dm.sent[0]?.inner as Record<string, unknown>;
    receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice");
    sendChannel(s.alice.deps, s.alice.groups, CHAN, "day one", ["alice", "bob"]);
    const oldSid = outboundFor(s.alice.groups, CHAN)?.sid;

    // Not due before the day passes.
    expect(rotateDue(s.alice.deps, s.alice.groups, [CHAN]).outbound).toEqual([]);
    const res = rotateDue(aliceTickDeps, s.alice.groups, [CHAN]);
    expect(res.events).toContainEqual({
      kind: "channel_rotated",
      channel: CHAN,
      oldSid,
      newSid: expect.any(String),
      reason: "periodic",
    });
    expect(res.outbound).toHaveLength(1);
    expect(res.outbound[0]?.target).toBe(CHAN);
    expect(res.outbound[0]?.to).toBe("*");
    // Bob reads the rotation message, then a message under the new epoch.
    const rotationMsg = res.outbound[0]?.payload ?? "";
    expect(receiveChannel(bobTickDeps, s.bob.groups, CHAN, "alice", rotationMsg)).toEqual([
      {
        kind: "channel_key_received",
        channel: CHAN,
        from: "alice",
        sid: expect.any(String),
      },
    ]);
    const next = sendChannel(aliceTickDeps, s.alice.groups, CHAN, "day two", ["alice", "bob"]);
    const nextPayload = next.outbound.find((o) => o.target === CHAN)?.payload ?? "";
    expect(receiveChannel(bobTickDeps, s.bob.groups, CHAN, "alice", nextPayload)).toEqual([
      expect.objectContaining({ kind: "channel_received", body: "day two" }),
    ]);
    expect(channelsWithEpoch(s.alice.groups)).toEqual(["#grappa"]);
  });
});

describe("without the wasm exports", () => {
  it("every step reports megolm-unavailable and throws nothing", () => {
    const dm = fakeDm();
    const nullDeps: ChannelE2eDeps = {
      adapter: null,
      ownNick: "alice",
      ownDid: "AaZaARRDyBk",
      now: () => NOW,
      sendDm: dm.sendDm,
    };
    const groups = newGroupSessionsState();
    expect(sendChannel(nullDeps, groups, CHAN, "hi", ["alice", "bob"]).events).toEqual([
      expect.objectContaining({ kind: "channel_dropped", reason: "megolm-unavailable" }),
    ]);
    expect(receiveChannel(nullDeps, groups, CHAN, "bob", "{}")).toEqual([
      expect.objectContaining({ kind: "channel_undecryptable", reason: "megolm-unavailable" }),
    ]);
    expect(distributeKey(nullDeps, groups, CHAN, ["bob"]).events).toEqual([
      expect.objectContaining({ kind: "channel_dropped", reason: "megolm-unavailable" }),
    ]);
    expect(dm.sent).toEqual([]);
  });
});

describe("live listeners", () => {
  it("fans events out to subscribers, and stops on unsubscribe", () => {
    const seen: ChannelE2eEvent[] = [];
    const off = onChannelE2eEvent((e) => seen.push(e));
    emitChannelE2eEvents([{ kind: "channel_dropped", channel: CHAN, reason: "test" }]);
    expect(seen).toHaveLength(1);
    off();
    emitChannelE2eEvents([{ kind: "channel_dropped", channel: CHAN, reason: "test" }]);
    expect(seen).toHaveLength(1);
  });
});

// A note on what is NOT tested here: `decryptChannel`'s store of the
// inbound pickle after a decrypt is covered by the group-session tests
// (a second message under the same epoch reads at the next index).
describe("inbound pickle advance", () => {
  it("two messages under one epoch read in order", () => {
    const s = sides();
    onMemberJoined(s.alice.deps, s.alice.groups, CHAN, "bob", ["alice", "bob"]);
    const gkey = s.alice.dm.sent[0]?.inner as Record<string, unknown>;
    receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice");
    for (const body of ["one", "two"]) {
      const sent = sendChannel(s.alice.deps, s.alice.groups, CHAN, body, ["alice", "bob"]);
      const payload = sent.outbound.find((o) => o.target === CHAN)?.payload ?? "";
      expect(receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", payload)).toEqual([
        expect.objectContaining({ kind: "channel_received", body }),
      ]);
    }
    // The stored inbound pickle advanced: a fresh restore still reads on.
    const sid = (gkey as { sid: string }).sid;
    const stored = inboundFor(s.bob.groups, CHAN, "alice", sid);
    expect(stored).toBeDefined();
    const restored = s.bob.adapter.restoreInbound(stored?.pickle ?? "");
    expect(restored.sessionId()).toBe(sid);
    restored.free();
  });
});
