// Channel E2E (wire v4) — the orchestration over the epoch store: key
// distribution, join/leave triggers, channel send/receive, periodic
// rotation. The DM sender is a fake that records the gkey payloads;
// signing and verification use node:crypto Ed25519 test keys. No wasm,
// no network, no real timers.
import { generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newEpochId, newEpochKey } from "../lib/e2e/channelCrypto";
import {
  auditEpochRotation,
  type ChannelE2eDeps,
  type ChannelE2eEvent,
  channelsWithEpoch,
  designatedRotator,
  distributeKey,
  emitChannelE2eEvents,
  GKEY_TAG,
  onChannelE2eEvent,
  onKeyreq,
  onMemberJoined,
  onMemberLeft,
  receiveChannel,
  receiveGkey,
  requestKey,
  rotateDue,
  sendChannel,
} from "../lib/e2e/channelE2e";
import type { Outbound } from "../lib/e2e/engine";
import { epochFor, type GroupSessionsState, newGroupSessionsState } from "../lib/e2e/groupSessions";
import {
  decodePayload,
  encodePayload,
  fold,
  GROUP_WIRE_VERSION,
  parseChannelPayload,
} from "../lib/e2e/wire";

const CHAN = "#grappa";
const NOW = 1_000_000;
const DAY = 86_400_000;

type TestKey = { did: string; privateKey: KeyObject; publicKey: KeyObject };
type Clock = { t: number };

const RING = (() => {
  const ring = new Map<string, TestKey>();
  for (const nick of ["alice", "bob", "carol", "dave"]) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    ring.set(fold(nick), { did: `did-${fold(nick)}`, privateKey, publicKey });
  }
  return ring;
})();

function didFor(nick: string): string {
  const key = RING.get(fold(nick));
  if (key === undefined) throw new Error(`no key for ${nick}`);
  return key.did;
}

function signFor(ownNick: string) {
  return (text: string): string => {
    const key = RING.get(fold(ownNick));
    if (key === undefined) throw new Error(`no key for ${ownNick}`);
    return sign(null, Buffer.from(text, "utf8"), key.privateKey)
      .toString("base64")
      .replace(/=+$/, "");
  };
}

function verifyAll(nick: string, did: string, text: string, sig: string): boolean {
  const key = RING.get(fold(nick));
  if (key === undefined || key.did !== did) return false;
  try {
    return verify(null, Buffer.from(text, "utf8"), key.publicKey, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
}

/** A fake DM sender: records every gkey it was asked to send, as the engine would queue it. */
function fakeDm() {
  const sent: { nick: string; inner: Record<string, unknown> }[] = [];
  const sendDm: ChannelE2eDeps["sendDm"] = (nick, inner) => {
    sent.push({ nick, inner });
    return [
      {
        target: nick,
        verb: "msg",
        from: "did:fake",
        to: "did:peer",
        payload: encodePayload(inner),
        priority: "text",
      } satisfies Outbound,
    ];
  };
  return { sent, sendDm };
}

type Side = { deps: ChannelE2eDeps; groups: GroupSessionsState; dm: ReturnType<typeof fakeDm> };

/** One member's side: its own store, deps, and fake DM sender, on a shared fake clock. */
function makeSide(
  ownNick: string,
  clock: Clock,
  roster?: (channel: string) => string[] | undefined,
): Side {
  const dm = fakeDm();
  return {
    deps: {
      ownNick,
      ownDid: didFor(ownNick),
      now: () => clock.t,
      sign: signFor(ownNick),
      verify: verifyAll,
      rosterFor: roster,
      sendDm: dm.sendDm,
    },
    groups: newGroupSessionsState(),
    dm,
  };
}

/** Alice and Bob, each with a side on the same clock. */
function sides(clock: Clock, roster?: (channel: string) => string[] | undefined) {
  return { alice: makeSide("alice", clock, roster), bob: makeSide("bob", clock, roster) };
}

/** The channel `:msg` outbound of a send result, if any. */
function channelMsg(res: { outbound: Outbound[] }): Outbound | undefined {
  return res.outbound.find((o) => o.target === CHAN);
}

/** Alice and Bob share an epoch: Alice sends, Bob imports her gkey and reads the line. */
async function shareEpoch(s: ReturnType<typeof sides>, members: string[]) {
  const sent = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "before", members);
  const gkey = s.alice.dm.sent[0]?.inner as Record<string, unknown> | undefined;
  if (gkey === undefined) throw new Error("alice sent no gkey");
  expect(receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice", didFor("alice"))).toEqual([
    { kind: "channel_key_received", channel: CHAN, from: "alice", sid: gkey.sid as string },
  ]);
  const payload = channelMsg(sent)?.payload ?? "";
  const read = await receiveChannel(
    s.bob.deps,
    s.bob.groups,
    CHAN,
    "alice",
    didFor("alice"),
    payload,
  );
  expect(read).toEqual({
    events: [expect.objectContaining({ kind: "channel_received", body: "before" })],
    outbound: [],
  });
  return { sent, gkey };
}

describe("designatedRotator", () => {
  it("is the folded-nick-first holder, and undefined when nobody holds the epoch", () => {
    expect(designatedRotator(["bob", "alice", "carol"])).toBe("alice");
    expect(designatedRotator(["carol", "bob"])).toBe("bob");
    expect(designatedRotator(["bob"])).toBe("bob");
    expect(designatedRotator([])).toBeUndefined();
  });

  it("names its tag for a gkey DM", () => {
    expect(GKEY_TAG).toBe("gkey");
  });
});

describe("distributeKey", () => {
  it("creates the epoch and sends one gkey DM per other member, none to self", () => {
    const clock = { t: NOW };
    const s = sides(clock);
    const res = distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "carol"]);
    const sid = epochFor(s.alice.groups, CHAN)?.sid;
    expect(sid).toBeDefined();
    expect(res.events).toContainEqual({
      kind: "channel_rotated",
      channel: CHAN,
      oldSid: null,
      newSid: sid,
      reason: "created",
    });
    expect(res.events).toContainEqual({
      kind: "channel_key_sent",
      channel: CHAN,
      to: "bob",
      sid,
    });
    expect(res.events).toContainEqual({
      kind: "channel_key_sent",
      channel: CHAN,
      to: "carol",
      sid,
    });
    expect(s.alice.dm.sent.map((d) => d.nick)).toEqual(["bob", "carol"]);
    expect(res.outbound.map((o) => o.target)).toEqual(["bob", "carol"]);
    for (const sent of s.alice.dm.sent) {
      const inner = sent.inner as {
        t: string;
        ch: string;
        sid: string;
        key: string;
        holders: string[];
      };
      expect(inner.t).toBe("gkey");
      expect(inner.ch).toBe("#grappa");
      expect(inner.sid).toBe(sid);
      expect(inner.holders).toEqual(["alice", "bob", "carol"]);
    }
    // No gkey to self: Alice already holds the key she minted.
    expect(s.alice.dm.sent.some((d) => d.nick === "alice")).toBe(false);
  });

  it("reuses the held epoch: no rotation event, still one DM per other member", () => {
    const clock = { t: NOW };
    const s = sides(clock);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    const sid = epochFor(s.alice.groups, CHAN)?.sid;
    s.alice.dm.sent.length = 0;
    const res = distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    expect(res.events).not.toContainEqual(expect.objectContaining({ kind: "channel_rotated" }));
    expect(res.events).toEqual([{ kind: "channel_key_sent", channel: CHAN, to: "bob", sid }]);
    expect(res.outbound).toHaveLength(1);
  });
});

describe("requestKey", () => {
  it("broadcasts a key request on the channel when no epoch is held", () => {
    const clock = { t: NOW };
    const s = sides(clock);
    const res = requestKey(s.bob.deps, s.bob.groups, CHAN);
    expect(res.events).toEqual([{ kind: "channel_key_requested", channel: CHAN }]);
    expect(res.outbound).toHaveLength(1);
    const out = res.outbound[0];
    expect(out?.target).toBe(CHAN);
    expect(out?.verb).toBe("msg");
    expect(out?.to).toBe("*");
    expect(out?.from).toBe(didFor("bob"));
    expect(decodePayload(out?.payload ?? "")).toEqual({ v: 4, t: "keyreq", ch: "#grappa" });
  });

  it("asks nothing when an epoch is already held", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    expect(requestKey(s.alice.deps, s.alice.groups, CHAN)).toEqual({ events: [], outbound: [] });
  });
});

describe("onKeyreq", () => {
  it("answers once per asker per minute, then again after the minute", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const sid = epochFor(s.alice.groups, CHAN)?.sid;
    s.alice.dm.sent.length = 0;
    const first = onKeyreq(s.alice.deps, s.alice.groups, CHAN, "bob");
    expect(first.events).toEqual([{ kind: "channel_key_sent", channel: CHAN, to: "bob", sid }]);
    expect(first.outbound).toHaveLength(1);
    expect(s.alice.dm.sent.map((d) => d.nick)).toEqual(["bob"]);
    // A second ask inside the minute goes unanswered.
    expect(onKeyreq(s.alice.deps, s.alice.groups, CHAN, "bob")).toEqual({
      events: [],
      outbound: [],
    });
    // After the minute, the same asker is answered again.
    clock.t = NOW + 60_000;
    const again = onKeyreq(s.alice.deps, s.alice.groups, CHAN, "bob");
    expect(again.events).toEqual([{ kind: "channel_key_sent", channel: CHAN, to: "bob", sid }]);
    expect(again.outbound).toHaveLength(1);
  });

  it("ignores our own key request, and answers nothing with no epoch", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    expect(onKeyreq(s.alice.deps, s.alice.groups, CHAN, "bob")).toEqual({
      events: [],
      outbound: [],
    });
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    expect(onKeyreq(s.alice.deps, s.alice.groups, CHAN, "alice")).toEqual({
      events: [],
      outbound: [],
    });
    expect(onKeyreq(s.alice.deps, s.alice.groups, CHAN, "ALICE")).toEqual({
      events: [],
      outbound: [],
    });
  });
});

describe("onMemberJoined", () => {
  it("our own join drops the held epoch: it predates the rotation the others did without us", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    expect(epochFor(s.alice.groups, CHAN)).toBeDefined();
    const res = onMemberJoined(s.alice.deps, s.alice.groups, CHAN, "alice", ["alice", "bob"]);
    expect(res.outbound).toEqual([]);
    expect(res.events).toContainEqual({
      kind: "channel_dropped",
      channel: CHAN,
      reason: "rejoined",
      detail: expect.any(String),
    });
    expect(epochFor(s.alice.groups, CHAN)).toBeUndefined();
  });

  it("our own join with no epoch, and anyone else's join, send nothing", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    expect(onMemberJoined(s.alice.deps, s.alice.groups, CHAN, "alice", ["alice", "bob"])).toEqual({
      events: [],
      outbound: [],
    });
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    expect(
      onMemberJoined(s.alice.deps, s.alice.groups, CHAN, "dave", ["alice", "bob", "dave"]),
    ).toEqual({ events: [], outbound: [] });
    expect(s.alice.dm.sent).toHaveLength(1);
  });
});

describe("onMemberLeft", () => {
  it("rotates when a holder leaves and we are the designated rotator, and the peer follows", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await shareEpoch(s, ["alice", "bob", "carol"]);
    const oldSid = epochFor(s.alice.groups, CHAN)?.sid;
    s.alice.dm.sent.length = 0;
    const res = onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "carol", ["alice", "bob"]);
    expect(res.events).toContainEqual({
      kind: "channel_rotated",
      channel: CHAN,
      oldSid,
      newSid: expect.any(String),
      reason: "member-left",
    });
    expect(epochFor(s.alice.groups, CHAN)?.sid).not.toBe(oldSid);
    // The new key goes to the members who remain: Bob only, never Carol.
    expect(s.alice.dm.sent.map((d) => d.nick)).toEqual(["bob"]);
    expect(res.events).toContainEqual({
      kind: "channel_key_sent",
      channel: CHAN,
      to: "bob",
      sid: epochFor(s.alice.groups, CHAN)?.sid,
    });
    // Bob imports the new epoch and reads what follows; the old epoch is dead for him.
    expect(
      receiveGkey(
        s.bob.deps,
        s.bob.groups,
        s.alice.dm.sent[0]?.inner ?? {},
        "alice",
        didFor("alice"),
      ),
    ).toEqual([
      expect.objectContaining({
        kind: "channel_key_received",
        sid: epochFor(s.alice.groups, CHAN)?.sid,
      }),
    ]);
    const after = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "after", ["alice", "bob"]);
    const payload = channelMsg(after)?.payload ?? "";
    expect(
      await receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", didFor("alice"), payload),
    ).toEqual({
      events: [expect.objectContaining({ kind: "channel_received", body: "after" })],
      outbound: [],
    });
  });

  it("rotates nothing when we are not the designated rotator", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await shareEpoch(s, ["alice", "bob", "carol"]);
    const sid = epochFor(s.bob.groups, CHAN)?.sid;
    // Alice sorts first among the remaining holders, so Bob must not rotate.
    expect(onMemberLeft(s.bob.deps, s.bob.groups, CHAN, "carol", ["alice", "bob"])).toEqual({
      events: [],
      outbound: [],
    });
    expect(epochFor(s.bob.groups, CHAN)?.sid).toBe(sid);
    expect(s.bob.dm.sent).toEqual([]);
  });

  it("rotates nothing when the departed member never held the key, or no epoch is held", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    expect(onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "bob", ["alice"])).toEqual({
      events: [],
      outbound: [],
    });
    await shareEpoch(s, ["alice", "bob"]);
    expect(onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "dave", ["alice", "bob"])).toEqual({
      events: [],
      outbound: [],
    });
    expect(s.alice.dm.sent).toHaveLength(1);
  });

  it("our own leave drops the whole channel, and sends nothing", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    s.alice.dm.sent.length = 0;
    const res = onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "alice", ["bob"]);
    expect(res.outbound).toEqual([]);
    expect(res.events).toContainEqual({
      kind: "channel_dropped",
      channel: CHAN,
      reason: "own-leave",
    });
    expect(epochFor(s.alice.groups, CHAN)).toBeUndefined();
  });
});

describe("auditEpochRotation", () => {
  it("rotates when a holder is no longer on the roster, and distributes the new key", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob", "carol"]);
    const oldSid = epochFor(s.alice.groups, CHAN)?.sid;
    s.alice.dm.sent.length = 0;
    const res = auditEpochRotation(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    expect(res.events).toContainEqual({
      kind: "channel_rotated",
      channel: CHAN,
      oldSid,
      newSid: expect.any(String),
      reason: "member-left",
    });
    expect(s.alice.dm.sent.map((d) => d.nick)).toEqual(["bob"]);
    expect(epochFor(s.alice.groups, CHAN)?.sid).not.toBe(oldSid);
  });

  it("is quiet when every holder is still a member, or no epoch is held", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    expect(auditEpochRotation(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"])).toEqual({
      events: [],
      outbound: [],
    });
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    expect(auditEpochRotation(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"])).toEqual({
      events: [],
      outbound: [],
    });
  });
});

describe("sendChannel", () => {
  it("creates the epoch on first send, distributes the key first, then sends one channel message", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    const res = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hello all", [
      "alice",
      "bob",
      "carol",
    ]);
    expect(s.alice.dm.sent.map((d) => d.nick)).toEqual(["bob", "carol"]);
    expect(res.outbound).toHaveLength(3);
    expect(res.outbound[0]?.target).toBe("bob");
    expect(res.outbound[1]?.target).toBe("carol");
    const channel = res.outbound[2];
    expect(channel?.target).toBe(CHAN);
    expect(channel?.verb).toBe("msg");
    expect(channel?.to).toBe("*");
    expect(channel?.from).toBe(didFor("alice"));
    expect(channel?.ref).toBeUndefined();
    expect(channel?.tag).toBeUndefined();
    expect(res.events).toContainEqual(
      expect.objectContaining({ kind: "channel_rotated", reason: "created" }),
    );
    // The second send reuses the epoch: no more gkeys.
    s.alice.dm.sent.length = 0;
    const again = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "again", [
      "alice",
      "bob",
      "carol",
    ]);
    expect(again.outbound).toHaveLength(1);
    expect(again.outbound[0]?.target).toBe(CHAN);
  });

  it("audits before sending: a departed holder rotates the epoch first", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob", "carol"]);
    const oldSid = epochFor(s.alice.groups, CHAN)?.sid;
    s.alice.dm.sent.length = 0;
    const res = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "after carol left", [
      "alice",
      "bob",
    ]);
    expect(res.events).toContainEqual(
      expect.objectContaining({ kind: "channel_rotated", oldSid, reason: "member-left" }),
    );
    // The new key goes out first, then the channel message under the new epoch.
    expect(res.outbound).toHaveLength(2);
    expect(res.outbound[0]?.target).toBe("bob");
    expect(res.outbound[1]?.target).toBe(CHAN);
    const newSid = epochFor(s.alice.groups, CHAN)?.sid;
    expect(parseChannelPayload(decodePayload(res.outbound[1]?.payload ?? "")).sid).toBe(newSid);
  });
});

describe("receiveChannel", () => {
  it("decrypts end to end across two stores, with the right body and counter", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await shareEpoch(s, ["alice", "bob"]);
    const sent = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi bob", ["alice", "bob"]);
    const payload = channelMsg(sent)?.payload ?? "";
    const res = await receiveChannel(
      s.bob.deps,
      s.bob.groups,
      CHAN,
      "alice",
      didFor("alice"),
      payload,
    );
    expect(res.outbound).toEqual([]);
    expect(res.events).toEqual([
      {
        kind: "channel_received",
        channel: CHAN,
        from: "alice",
        sid: epochFor(s.bob.groups, CHAN)?.sid,
        counter: 1,
        body: "hi bob",
      },
    ]);
  });

  it("surfaces a replay as undecryptable, never a throw", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await shareEpoch(s, ["alice", "bob"]);
    const sent = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "once", ["alice", "bob"]);
    const payload = channelMsg(sent)?.payload ?? "";
    expect(
      await receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", didFor("alice"), payload),
    ).toEqual({
      events: [expect.objectContaining({ kind: "channel_received", body: "once" })],
      outbound: [],
    });
    const again = await receiveChannel(
      s.bob.deps,
      s.bob.groups,
      CHAN,
      "alice",
      didFor("alice"),
      payload,
    );
    expect(again.events).toEqual([
      {
        kind: "channel_undecryptable",
        channel: CHAN,
        from: "alice",
        sid: epochFor(s.bob.groups, CHAN)?.sid,
        reason: "replay",
      },
    ]);
  });

  it("surfaces a tampered signature as undecryptable", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await shareEpoch(s, ["alice", "bob"]);
    const sent = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "secret", ["alice", "bob"]);
    const payload = channelMsg(sent)?.payload ?? "";
    const envelope = decodePayload(payload);
    const sig = String(envelope.sig);
    const tampered = encodePayload({
      ...envelope,
      sig: `${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`,
    });
    const res = await receiveChannel(
      s.bob.deps,
      s.bob.groups,
      CHAN,
      "alice",
      didFor("alice"),
      tampered,
    );
    expect(res.events).toEqual([
      {
        kind: "channel_undecryptable",
        channel: CHAN,
        from: "alice",
        sid: epochFor(s.bob.groups, CHAN)?.sid,
        reason: "bad-signature",
      },
    ]);
  });

  it("surfaces an unreadable channel message as undecryptable, never a throw", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    const sent = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "secret", ["alice", "bob"]);
    const payload = channelMsg(sent)?.payload ?? "";
    // Bob holds no session: no-session.
    expect(
      await receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", didFor("alice"), payload),
    ).toEqual({
      events: [
        {
          kind: "channel_undecryptable",
          channel: CHAN,
          from: "alice",
          sid: expect.any(String),
          reason: "no-session",
        },
      ],
      outbound: [],
    });
    // Garbage: bad-payload.
    expect(
      await receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", didFor("alice"), "garbage"),
    ).toEqual({
      events: [
        {
          kind: "channel_undecryptable",
          channel: CHAN,
          from: "alice",
          sid: null,
          reason: "bad-payload",
        },
      ],
      outbound: [],
    });
  });

  it("carries no plaintext counter in the v4 envelope", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    const sent = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "count me", [
      "alice",
      "bob",
    ]);
    const envelope = decodePayload(channelMsg(sent)?.payload ?? "");
    expect(envelope.v).toBe(GROUP_WIRE_VERSION);
    expect(envelope.t).toBe("msg");
    expect(envelope.ch).toBe("#grappa");
    expect(typeof envelope.sid).toBe("string");
    expect(typeof envelope.body).toBe("string");
    expect(typeof envelope.sig).toBe("string");
    expect("i" in envelope).toBe(false);
    expect("c" in envelope).toBe(false);
  });

  it("skips our own messages coming back through the inbox", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    const sent = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const payload = channelMsg(sent)?.payload ?? "";
    expect(
      await receiveChannel(s.alice.deps, s.alice.groups, CHAN, "alice", didFor("alice"), payload),
    ).toEqual({ events: [], outbound: [] });
    expect(
      await receiveChannel(s.alice.deps, s.alice.groups, CHAN, "ALICE", didFor("alice"), payload),
    ).toEqual({ events: [], outbound: [] });
  });

  it("answers a newcomer's key request with a gkey DM, and ignores a foreign channel's", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const sid = epochFor(s.alice.groups, CHAN)?.sid;
    s.alice.dm.sent.length = 0;
    // Dave asks on the channel; Alice answers with a gkey DM to him.
    const dave = makeSide("dave", clock);
    const asked = requestKey(dave.deps, dave.groups, CHAN);
    const keyreq = asked.outbound[0]?.payload ?? "";
    const answered = await receiveChannel(
      s.alice.deps,
      s.alice.groups,
      CHAN,
      "dave",
      didFor("dave"),
      keyreq,
    );
    expect(answered.events).toEqual([{ kind: "channel_key_sent", channel: CHAN, to: "dave", sid }]);
    expect(s.alice.dm.sent.map((d) => d.nick)).toEqual(["dave"]);
    // A key request naming another channel is not ours to answer.
    const foreign = await receiveChannel(
      s.alice.deps,
      s.alice.groups,
      CHAN,
      "dave",
      didFor("dave"),
      // A keyreq envelope for #other, delivered on #grappa.
      encodePayload({ v: 4, t: "keyreq", ch: "#other" }),
    );
    expect(foreign.events).toEqual([
      {
        kind: "channel_undecryptable",
        channel: CHAN,
        from: "dave",
        sid: null,
        reason: "channel-mismatch",
      },
    ]);
  });
});

describe("receiveGkey", () => {
  it("imports a valid key, and a re-sent key is a no-op", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const gkey = s.alice.dm.sent[0]?.inner as Record<string, unknown>;
    const sid = gkey.sid as string;
    expect(receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice", didFor("alice"))).toEqual([
      { kind: "channel_key_received", channel: CHAN, from: "alice", sid },
    ]);
    expect(receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice", didFor("alice"))).toEqual([]);
    expect(epochFor(s.bob.groups, CHAN)?.sid).toBe(sid);
  });

  it("drops a key whose holders name someone off the roster when it would replace an epoch", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    const s = sides(clock, roster);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const first = s.alice.dm.sent[0]?.inner as Record<string, unknown>;
    receiveGkey(s.bob.deps, s.bob.groups, first, "alice", didFor("alice"));
    const oldSid = epochFor(s.bob.groups, CHAN)?.sid;
    // A newer epoch whose holders still name Carol, who is no longer on the roster.
    const stale = {
      t: "gkey",
      ch: CHAN,
      sid: newEpochId(),
      key: newEpochKey(),
      holders: ["alice", "bob", "carol"],
    };
    expect(receiveGkey(s.bob.deps, s.bob.groups, stale, "alice", didFor("alice"))).toEqual([
      {
        kind: "channel_dropped",
        channel: CHAN,
        reason: "stale-gkey",
        detail: expect.any(String),
      },
    ]);
    // The old epoch survives: nothing was stored.
    expect(epochFor(s.bob.groups, CHAN)?.sid).toBe(oldSid);
  });

  it("takes any well-formed key when no epoch is held yet, even with an off-roster holder", () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    const s = sides(clock, roster);
    const gkey = {
      t: "gkey",
      ch: CHAN,
      sid: newEpochId(),
      key: newEpochKey(),
      holders: ["alice", "bob", "carol"],
    };
    expect(receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice", didFor("alice"))).toEqual([
      { kind: "channel_key_received", channel: CHAN, from: "alice", sid: gkey.sid },
    ]);
  });

  it("drops a bad key, never stores it, never throws", () => {
    const clock = { t: NOW };
    const s = sides(clock);
    const badKey = { t: "gkey", ch: CHAN, sid: "sid-x", key: "not-a-key", holders: ["alice"] };
    expect(receiveGkey(s.bob.deps, s.bob.groups, badKey, "alice", didFor("alice"))).toEqual([
      {
        kind: "channel_dropped",
        channel: CHAN,
        reason: "bad-gkey",
        detail: expect.any(String),
      },
    ]);
    expect(epochFor(s.bob.groups, CHAN)).toBeUndefined();
    expect(
      receiveGkey(s.bob.deps, s.bob.groups, { t: "text", body: "hi" }, "alice", didFor("alice")),
    ).toEqual([expect.objectContaining({ kind: "channel_dropped", reason: "bad-gkey" })]);
  });
});

describe("rotateDue", () => {
  it("rotates a due epoch with one channel message, and the reader follows", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    const s = sides(clock, roster);
    await shareEpoch(s, ["alice", "bob"]);
    const oldSid = epochFor(s.alice.groups, CHAN)?.sid;

    // Not due before the day passes.
    expect((await rotateDue(s.alice.deps, s.alice.groups, [CHAN])).outbound).toEqual([]);
    clock.t = NOW + DAY;
    const res = await rotateDue(s.alice.deps, s.alice.groups, [CHAN]);
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
    // The rotation message names the OLD sid in its envelope.
    expect(parseChannelPayload(decodePayload(res.outbound[0]?.payload ?? "")).sid).toBe(oldSid);
    // Bob reads the rotation message, then a message under the new epoch.
    const rotationMsg = res.outbound[0]?.payload ?? "";
    expect(
      await receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", didFor("alice"), rotationMsg),
    ).toEqual({
      events: [
        {
          kind: "channel_key_received",
          channel: CHAN,
          from: "alice",
          sid: expect.any(String),
        },
      ],
      outbound: [],
    });
    const next = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "day two", ["alice", "bob"]);
    const nextPayload = channelMsg(next)?.payload ?? "";
    expect(
      await receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", didFor("alice"), nextPayload),
    ).toEqual({
      events: [expect.objectContaining({ kind: "channel_received", body: "day two" })],
      outbound: [],
    });
  });

  it("rotates nothing when the roster is unknown, we are not the rotator, or the epoch never spoke", async () => {
    const clock = { t: NOW };
    // No roster at all: the election cannot run.
    const noRoster = sides(clock);
    await sendChannel(noRoster.alice.deps, noRoster.alice.groups, CHAN, "hi", ["alice", "bob"]);
    clock.t = NOW + DAY;
    expect((await rotateDue(noRoster.alice.deps, noRoster.alice.groups, [CHAN])).outbound).toEqual(
      [],
    );
    // Bob holds the epoch but Alice sorts first: Bob must not rotate.
    // (Reset the clock so the epoch is a day old and due; the skip must
    // come from the election, not from the epoch being fresh.)
    clock.t = NOW;
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    const s = sides(clock, roster);
    await shareEpoch(s, ["alice", "bob"]);
    // Bob speaks under the imported epoch, so it is due a day later and
    // the skip below comes from the election, not from never speaking.
    await sendChannel(s.bob.deps, s.bob.groups, CHAN, "bob speaks", ["alice", "bob"]);
    clock.t = NOW + DAY;
    expect((await rotateDue(s.bob.deps, s.bob.groups, [CHAN])).outbound).toEqual([]);
    // An epoch that never spoke has nothing to rotate.
    const quiet = sides(clock, roster);
    distributeKey(quiet.alice.deps, quiet.alice.groups, CHAN, ["alice", "bob"]);
    expect((await rotateDue(quiet.alice.deps, quiet.alice.groups, [CHAN])).outbound).toEqual([]);
  });
});

describe("channelsWithEpoch", () => {
  it("lists the channels an epoch is held for, and drops one on leave", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    expect(channelsWithEpoch(s.alice.groups)).toEqual([]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "one", ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, "#other", "two", ["alice", "bob"]);
    expect(channelsWithEpoch(s.alice.groups).sort()).toEqual(["#grappa", "#other"]);
    onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "alice", ["bob"]);
    expect(channelsWithEpoch(s.alice.groups)).toEqual(["#other"]);
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
