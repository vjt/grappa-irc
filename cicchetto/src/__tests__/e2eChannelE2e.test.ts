// Channel E2E (wire v4) — the orchestration over the epoch store: key
// distribution, join/leave triggers, channel send/receive, periodic
// rotation. The DM sender is a fake that records the gkey payloads;
// signing and verification use node:crypto Ed25519 test keys. No wasm,
// no network, no real timers.
import { generateKeyPairSync, type KeyObject, sign, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { atNick } from "../lib/e2e/byNick";
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
  keyFrom?: (channel: string) => string | undefined,
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
      keyFromFor: keyFrom,
      didsFor: (nick) => {
        const key = RING.get(fold(nick));
        return key === undefined ? undefined : [key.did];
      },
      sendDm: dm.sendDm,
    },
    groups: newGroupSessionsState(),
    dm,
  };
}

/** Alice and Bob, each with a side on the same clock. */
function sides(
  clock: Clock,
  roster?: (channel: string) => string[] | undefined,
  keyFrom?: (channel: string) => string | undefined,
) {
  return {
    alice: makeSide("alice", clock, roster, keyFrom),
    bob: makeSide("bob", clock, roster, keyFrom),
  };
}

/** The channel `:msg` outbound of a send result, if any. */
function channelMsg(res: { outbound: Outbound[] }): Outbound | undefined {
  return res.outbound.find((o) => o.target === CHAN);
}

/** Alice and Bob share an epoch: Alice mints it explicitly, Bob imports her gkey and reads the line. */
async function shareEpoch(s: ReturnType<typeof sides>, members: string[]) {
  distributeKey(s.alice.deps, s.alice.groups, CHAN, members);
  const gkey = s.alice.dm.sent[0]?.inner as Record<string, unknown> | undefined;
  if (gkey === undefined) throw new Error("alice sent no gkey");
  // Bob asked for the key first: a first epoch is only imported after asking.
  requestKey(s.bob.deps, s.bob.groups, CHAN);
  expect(receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice", didFor("alice"))).toEqual([
    { kind: "channel_key_received", channel: CHAN, from: "alice", sid: gkey.sid as string },
  ]);
  const sent = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "before", members);
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
    copies: [],
  });
  return { sent, gkey };
}

describe("designatedRotator", () => {
  it("is the first holder did, and undefined when nobody holds the epoch", () => {
    expect(designatedRotator([didFor("bob"), didFor("alice"), didFor("carol")])).toBe(
      didFor("alice"),
    );
    expect(designatedRotator([didFor("carol"), didFor("bob")])).toBe(didFor("bob"));
    expect(designatedRotator([didFor("bob")])).toBe(didFor("bob"));
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
      expect(inner.holders).toEqual([didFor("alice"), didFor("bob"), didFor("carol")]);
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

  it("sends the key by nick even to a member whose list is unknown, and records them sent-to", () => {
    const clock = { t: NOW };
    const s = sides(clock);
    // Dave is in the ring, but this cic has never seen his list: hide it.
    const known = s.alice.deps.didsFor;
    s.alice.deps.didsFor = (nick) => (fold(nick) === "dave" ? undefined : known(nick));
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "dave"]);
    // The DM goes out by nick anyway — the engine resolves his keys
    // lazily — so Dave can still read, once his keys land.
    expect(s.alice.dm.sent.map((d) => d.nick)).toEqual(["bob", "dave"]);
    const held = epochFor(s.alice.groups, CHAN);
    expect(held?.holders).toEqual([didFor("alice"), didFor("bob")]);
    expect(held?.sentTo).toEqual(["dave"]);
    expect(held?.holderNicks).toEqual({
      alice: [didFor("alice")],
      bob: [didFor("bob")],
    });
    const daveInner = s.alice.dm.sent.find((d) => d.nick === "dave")?.inner as Record<
      string,
      unknown
    >;
    expect(daveInner.sentTo).toEqual(["dave"]);
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
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    expect(requestKey(s.alice.deps, s.alice.groups, CHAN)).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
  });
});

describe("onKeyreq", () => {
  it("answers once per asker per minute, then again after the minute", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    const s = sides(clock, roster);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const sid = epochFor(s.alice.groups, CHAN)?.sid;
    s.alice.dm.sent.length = 0;
    const first = onKeyreq(s.alice.deps, s.alice.groups, CHAN, "bob", didFor("bob"));
    expect(first.events).toEqual([{ kind: "channel_key_sent", channel: CHAN, to: "bob", sid }]);
    expect(first.outbound).toHaveLength(1);
    expect(s.alice.dm.sent.map((d) => d.nick)).toEqual(["bob"]);
    // A second ask inside the minute goes unanswered.
    expect(onKeyreq(s.alice.deps, s.alice.groups, CHAN, "bob", didFor("bob"))).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    // After the minute, the same asker is answered again.
    clock.t = NOW + 60_000;
    const again = onKeyreq(s.alice.deps, s.alice.groups, CHAN, "bob", didFor("bob"));
    expect(again.events).toEqual([{ kind: "channel_key_sent", channel: CHAN, to: "bob", sid }]);
    expect(again.outbound).toHaveLength(1);
  });

  it("ignores our own key request, and answers nothing with no epoch", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    expect(onKeyreq(s.alice.deps, s.alice.groups, CHAN, "bob", didFor("bob"))).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    expect(onKeyreq(s.alice.deps, s.alice.groups, CHAN, "alice", didFor("alice"))).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    expect(onKeyreq(s.alice.deps, s.alice.groups, CHAN, "ALICE", didFor("alice"))).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
  });

  it("the topic designee mints the first epoch to answer a key request, and only then", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    const keyFrom = (channel: string) => (channel === CHAN ? "alice" : undefined);
    const s = sides(clock, roster, keyFrom);
    // Nobody holds an epoch yet: Alice is the designee, so she mints one
    // to answer Bob's ask — and the key reaches him.
    const answered = onKeyreq(s.alice.deps, s.alice.groups, CHAN, "bob", didFor("bob"));
    const sid = epochFor(s.alice.groups, CHAN)?.sid;
    expect(sid).toBeDefined();
    expect(answered.events).toContainEqual(
      expect.objectContaining({ kind: "channel_rotated", reason: "created", channel: CHAN }),
    );
    expect(answered.events).toContainEqual({
      kind: "channel_key_sent",
      channel: CHAN,
      to: "bob",
      sid,
    });
    expect(s.alice.dm.sent.map((d) => d.nick)).toContain("bob");
    // Bob imports it: the minted epoch is a real one.
    const gkey = s.alice.dm.sent.find((d) => d.nick === "bob")?.inner as
      | Record<string, unknown>
      | undefined;
    if (gkey === undefined) throw new Error("alice sent bob no gkey");
    requestKey(s.bob.deps, s.bob.groups, CHAN);
    expect(receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice", didFor("alice"))).toEqual([
      expect.objectContaining({ kind: "channel_key_received", from: "alice" }),
    ]);
    // A duplicate ask inside the minute does not mint a second epoch.
    clock.t = NOW + 1_000;
    expect(onKeyreq(s.alice.deps, s.alice.groups, CHAN, "bob", didFor("bob"))).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    expect(epochFor(s.alice.groups, CHAN)?.sid).toBe(sid);
  });

  it("a non-designee mints nothing on a key request: the newcomer waits", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    const keyFrom = (channel: string) => (channel === CHAN ? "carol" : undefined);
    const s = sides(clock, roster, keyFrom);
    expect(onKeyreq(s.alice.deps, s.alice.groups, CHAN, "bob", didFor("bob"))).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    expect(epochFor(s.alice.groups, CHAN)).toBeUndefined();
    expect(s.alice.dm.sent).toEqual([]);
    // And with no topic tag at all, nobody bootstraps either.
    const untagged = sides(clock, roster);
    expect(
      onKeyreq(untagged.alice.deps, untagged.alice.groups, CHAN, "bob", didFor("bob")),
    ).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    expect(epochFor(untagged.alice.groups, CHAN)).toBeUndefined();
  });

  it("names the asker in the holders of the key it answers with", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob", "dave"] : undefined);
    const s = sides(clock, roster);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    // Dave never received the epoch: he is not a holder yet.
    expect(epochFor(s.alice.groups, CHAN)?.holders).toEqual([didFor("alice"), didFor("bob")]);
    const sid = epochFor(s.alice.groups, CHAN)?.sid;
    const answered = onKeyreq(s.alice.deps, s.alice.groups, CHAN, "dave", didFor("dave"));
    // Dave is answered, and the enlarged key is re-distributed to Bob,
    // the other holder, so his set converges on Dave too.
    expect(answered.events).toEqual([
      { kind: "channel_key_sent", channel: CHAN, to: "dave", sid },
      { kind: "channel_key_sent", channel: CHAN, to: "bob", sid },
    ]);
    // The gkey Dave received names him in holders, and so does the stored epoch.
    const inner = s.alice.dm.sent.find((d) => d.nick === "dave")?.inner as { holders: string[] };
    expect(inner.holders).toEqual([didFor("alice"), didFor("bob"), didFor("dave")]);
    expect(epochFor(s.alice.groups, CHAN)?.holders).toEqual([
      didFor("alice"),
      didFor("bob"),
      didFor("dave"),
    ]);
    // A second answer does not duplicate him.
    clock.t = NOW + 60_000;
    onKeyreq(s.alice.deps, s.alice.groups, CHAN, "dave", didFor("dave"));
    expect(epochFor(s.alice.groups, CHAN)?.holders).toEqual([
      didFor("alice"),
      didFor("bob"),
      didFor("dave"),
    ]);
  });

  it("answers only while the asker is on the roster, and not without one", async () => {
    const clock = { t: NOW };
    let members = ["alice", "bob", "dave"];
    const roster = (channel: string) => (channel === CHAN ? members : undefined);
    const s = sides(clock, roster);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const sid = epochFor(s.alice.groups, CHAN)?.sid;
    // Dave is on the roster: answered, and the enlarged key is
    // re-distributed to Bob, the other holder.
    expect(onKeyreq(s.alice.deps, s.alice.groups, CHAN, "dave", didFor("dave")).events).toEqual([
      { kind: "channel_key_sent", channel: CHAN, to: "dave", sid },
      { kind: "channel_key_sent", channel: CHAN, to: "bob", sid },
    ]);
    // Dave left: the same ask, answered again a minute later, goes unanswered.
    members = ["alice", "bob"];
    clock.t = NOW + 60_000;
    expect(onKeyreq(s.alice.deps, s.alice.groups, CHAN, "dave", didFor("dave"))).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    // With no roster held at all, nothing is answered either.
    const noRoster = sides(clock);
    await sendChannel(noRoster.alice.deps, noRoster.alice.groups, CHAN, "hi", ["alice", "bob"]);
    expect(
      onKeyreq(noRoster.alice.deps, noRoster.alice.groups, CHAN, "bob", didFor("bob")),
    ).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
  });

  it("moves a sent-to asker into the holders and the nick mapping, and clears their sent-to", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob", "dave"] : undefined);
    const s = sides(clock, roster);
    const known = s.alice.deps.didsFor;
    s.alice.deps.didsFor = (nick) => (fold(nick) === "dave" ? undefined : known(nick));
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "dave"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob", "dave"]);
    expect(epochFor(s.alice.groups, CHAN)?.sentTo).toEqual(["dave"]);
    const sid = epochFor(s.alice.groups, CHAN)?.sid;
    const answered = onKeyreq(s.alice.deps, s.alice.groups, CHAN, "dave", didFor("dave"));
    // Dave is answered, and the enlarged key is re-distributed to Bob,
    // the other holder, so his set converges on Dave too.
    expect(answered.events).toEqual([
      { kind: "channel_key_sent", channel: CHAN, to: "dave", sid },
      { kind: "channel_key_sent", channel: CHAN, to: "bob", sid },
    ]);
    const held = epochFor(s.alice.groups, CHAN);
    expect(held?.holders).toContain(didFor("dave"));
    expect(held === undefined ? undefined : atNick(held.holderNicks, "dave")).toEqual([
      didFor("dave"),
    ]);
    expect(held?.sentTo).toEqual([]);
  });

  it("a keyreq-served peer's exit rotates the epoch", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob", "dave"] : undefined);
    const s = sides(clock, roster);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    onKeyreq(s.alice.deps, s.alice.groups, CHAN, "dave", didFor("dave"));
    const oldSid = epochFor(s.alice.groups, CHAN)?.sid;
    const res = onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "dave", ["alice", "bob"]);
    expect(res.events).toContainEqual(
      expect.objectContaining({ kind: "channel_rotated", oldSid, reason: "member-left" }),
    );
    expect(epochFor(s.alice.groups, CHAN)?.sid).not.toBe(oldSid);
  });

  it("a keyreq answer re-distributes the enlarged holder set, so the rotator learns the new member", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) =>
      channel === CHAN ? ["alice", "bob", "carol", "dave"] : undefined;
    const s = sides(clock, roster);
    // Alice mints and distributes to Bob and Carol; Bob imports.
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "carol"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob", "carol"]);
    const bobGkey = s.alice.dm.sent.find((d) => d.nick === "bob")?.inner as Record<string, unknown>;
    requestKey(s.bob.deps, s.bob.groups, CHAN);
    expect(receiveGkey(s.bob.deps, s.bob.groups, bobGkey, "alice", didFor("alice"))).toEqual([
      { kind: "channel_key_received", channel: CHAN, from: "alice", sid: bobGkey.sid as string },
    ]);
    // Dave asks; Bob — not the rotator — answers him.
    s.bob.dm.sent.length = 0;
    const answered = onKeyreq(s.bob.deps, s.bob.groups, CHAN, "dave", didFor("dave"));
    expect(answered.events).toContainEqual({
      kind: "channel_key_sent",
      channel: CHAN,
      to: "dave",
      sid: expect.any(String),
    });
    // And the enlarged key goes to Alice and Carol too, so their sets
    // converge on Dave — without it, Alice would never rotate at his exit.
    expect(answered.events).toContainEqual({
      kind: "channel_key_sent",
      channel: CHAN,
      to: "alice",
      sid: expect.any(String),
    });
    expect(answered.events).toContainEqual({
      kind: "channel_key_sent",
      channel: CHAN,
      to: "carol",
      sid: expect.any(String),
    });
    expect(s.bob.dm.sent.map((d) => d.nick).sort()).toEqual(["alice", "carol", "dave"]);
    // Alice takes the re-distributed key: a re-send of the epoch she
    // holds, so it merges Dave into her holder set.
    const redistributed = s.bob.dm.sent.find((d) => d.nick === "alice")?.inner as Record<
      string,
      unknown
    >;
    expect(receiveGkey(s.alice.deps, s.alice.groups, redistributed, "bob", didFor("bob"))).toEqual(
      [],
    );
    expect(epochFor(s.alice.groups, CHAN)?.holders).toContain(didFor("dave"));
    // Dave leaves: Alice is the designated rotator — the first
    // remaining holder did — so she rotates, and Bob and Carol get the
    // new key.
    const oldSid = epochFor(s.alice.groups, CHAN)?.sid;
    const left = onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "dave", [
      "alice",
      "bob",
      "carol",
    ]);
    expect(left.events).toContainEqual(
      expect.objectContaining({ kind: "channel_rotated", oldSid, reason: "member-left" }),
    );
    expect(epochFor(s.alice.groups, CHAN)?.sid).not.toBe(oldSid);
    expect(left.copies.map((c) => c.peer).sort()).toEqual(["bob", "carol"]);
  });

  it("answers a key request from a nick that names a prototype member, without throwing", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) =>
      channel === CHAN ? ["alice", "bob", "constructor"] : undefined;
    const s = sides(clock, roster);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    // "constructor" is not in the ring, so this cic has no list for
    // them: the sender check falls back to the nick, and the answer
    // records their did under the nick without resolving the prototype.
    const sid = epochFor(s.alice.groups, CHAN)?.sid;
    const answered = onKeyreq(s.alice.deps, s.alice.groups, CHAN, "constructor", "did-constructor");
    expect(answered.events).toContainEqual({
      kind: "channel_key_sent",
      channel: CHAN,
      to: "constructor",
      sid,
    });
    const held = epochFor(s.alice.groups, CHAN);
    expect(held?.holders).toContain("did-constructor");
    expect(held === undefined ? undefined : atNick(held.holderNicks, "constructor")).toEqual([
      "did-constructor",
    ]);
  });
});

describe("onMemberJoined", () => {
  it("our own join drops the held epoch: it predates the rotation the others did without us", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
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
      copies: [],
    });
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    expect(
      onMemberJoined(s.alice.deps, s.alice.groups, CHAN, "dave", ["alice", "bob", "dave"]),
    ).toEqual({ events: [], outbound: [], copies: [] });
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
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    const after = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "after", ["alice", "bob"]);
    const payload = channelMsg(after)?.payload ?? "";
    expect(
      await receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", didFor("alice"), payload),
    ).toEqual({
      events: [expect.objectContaining({ kind: "channel_received", body: "after" })],
      outbound: [],
      copies: [],
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
      copies: [],
    });
    expect(epochFor(s.bob.groups, CHAN)?.sid).toBe(sid);
    expect(s.bob.dm.sent).toEqual([]);
  });

  it("rotates on a holder's leave off the nick mapping, without ever having DM'd them", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await shareEpoch(s, ["alice", "bob", "carol"]);
    // Alice has forgotten Bob's device list since the epoch was made:
    // the epoch's nick mapping still names his did, so his leave rotates.
    const known = s.alice.deps.didsFor;
    s.alice.deps.didsFor = (nick) => (fold(nick) === "bob" ? undefined : known(nick));
    const oldSid = epochFor(s.alice.groups, CHAN)?.sid;
    const res = onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "bob", ["alice", "carol"]);
    expect(res.events).toContainEqual(
      expect.objectContaining({ kind: "channel_rotated", oldSid, reason: "member-left" }),
    );
    expect(epochFor(s.alice.groups, CHAN)?.sid).not.toBe(oldSid);
    // And without the mapping — an epoch from an inner that predates it —
    // the same leave rotates nothing: this cic cannot tell Bob held the key.
    const bare = sides(clock);
    requestKey(bare.alice.deps, bare.alice.groups, CHAN);
    const inner = {
      t: "gkey",
      ch: CHAN,
      sid: newEpochId(),
      key: newEpochKey(),
      holders: [didFor("alice"), didFor("bob"), didFor("carol")],
    };
    expect(
      receiveGkey(bare.alice.deps, bare.alice.groups, inner, "carol", didFor("carol")),
    ).toEqual([expect.objectContaining({ kind: "channel_key_received" })]);
    const knownBare = bare.alice.deps.didsFor;
    bare.alice.deps.didsFor = (nick) => (fold(nick) === "bob" ? undefined : knownBare(nick));
    expect(
      onMemberLeft(bare.alice.deps, bare.alice.groups, CHAN, "bob", ["alice", "carol"]),
    ).toEqual({ events: [], outbound: [], copies: [] });
  });

  it("rotates nothing when the departed member never held the key, or no epoch is held", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    expect(onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "bob", ["alice"])).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    await shareEpoch(s, ["alice", "bob"]);
    expect(onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "dave", ["alice", "bob"])).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    expect(s.alice.dm.sent).toHaveLength(1);
  });

  it("our own leave drops the whole channel, and sends nothing", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
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
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "carol"]);
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
      copies: [],
    });
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    expect(auditEpochRotation(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"])).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
  });

  it("a rename rotates nothing: the roster is per did, and the did did not change", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const oldSid = epochFor(s.alice.groups, CHAN)?.sid;
    // Bob renamed to Robert: the nick changed, the device did not. The
    // roster the audit sees names the new nick, resolved to the same did
    // — under nick holders this rotated; under did holders it is quiet.
    const known = s.alice.deps.didsFor;
    s.alice.deps.didsFor = (nick) => (fold(nick) === "robert" ? [didFor("bob")] : known(nick));
    expect(auditEpochRotation(s.alice.deps, s.alice.groups, CHAN, ["alice", "robert"])).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    expect(epochFor(s.alice.groups, CHAN)?.sid).toBe(oldSid);
  });

  it("is quiet when the mapping attributes a holder to a member this cic has not chatted with", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "carol"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob", "carol"]);
    // Carol's list has not landed on this cic: her did is not among the
    // roster dids, but the mapping attributes it to a nick still on the
    // roster — so the epoch is not stale.
    const known = s.alice.deps.didsFor;
    s.alice.deps.didsFor = (nick) => (fold(nick) === "carol" ? undefined : known(nick));
    expect(
      auditEpochRotation(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "carol"]),
    ).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
  });

  it("a rename whose new nick's list has not landed yet rotates once, fail closed", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const oldSid = epochFor(s.alice.groups, CHAN)?.sid;
    // Bob renamed to Robert; this cic has not re-pinned the new nick,
    // so his did is neither among the roster dids nor attributed to a
    // nick on the roster — the audit rotates rather than risk a leak.
    const res = auditEpochRotation(s.alice.deps, s.alice.groups, CHAN, ["alice", "robert"]);
    expect(res.events).toContainEqual(
      expect.objectContaining({ kind: "channel_rotated", oldSid, reason: "member-left" }),
    );
    expect(epochFor(s.alice.groups, CHAN)?.sid).not.toBe(oldSid);
  });

  it("reconciles a sent-to member whose list landed: no rotation, and they join the holders", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    const known = s.alice.deps.didsFor;
    s.alice.deps.didsFor = (nick) => (fold(nick) === "dave" ? undefined : known(nick));
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "dave"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob", "dave"]);
    expect(epochFor(s.alice.groups, CHAN)?.sentTo).toEqual(["dave"]);
    expect(epochFor(s.alice.groups, CHAN)?.holders).not.toContain(didFor("dave"));
    // Dave's list lands (his keys arrived): the audit moves him into
    // the holders instead of rotating on a did it cannot name yet.
    s.alice.deps.didsFor = known;
    expect(
      auditEpochRotation(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "dave"]),
    ).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    const held = epochFor(s.alice.groups, CHAN);
    expect(held?.holders).toContain(didFor("dave"));
    expect(held === undefined ? undefined : atNick(held.holderNicks, "dave")).toEqual([
      didFor("dave"),
    ]);
    expect(held?.sentTo).toEqual([]);
  });

  it("a non-designated audit waits: it rotates nothing, even on a stale epoch", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    // The epoch is stale — carol left — but Bob is not the designated
    // rotator: the first remaining holder did is Alice's. Bob's audit
    // waits for her cic; it mints nothing, and the epoch stands.
    distributeKey(s.bob.deps, s.bob.groups, CHAN, ["alice", "bob", "carol"]);
    const oldSid = epochFor(s.bob.groups, CHAN)?.sid;
    s.bob.dm.sent.length = 0;
    expect(auditEpochRotation(s.bob.deps, s.bob.groups, CHAN, ["alice", "bob"])).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    expect(epochFor(s.bob.groups, CHAN)?.sid).toBe(oldSid);
    expect(s.bob.dm.sent).toEqual([]);
  });

  it("the designated audit rotates: exactly one mints the new epoch", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "carol"]);
    const oldSid = epochFor(s.alice.groups, CHAN)?.sid;
    s.alice.dm.sent.length = 0;
    const res = auditEpochRotation(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    expect(res.events).toContainEqual(
      expect.objectContaining({ kind: "channel_rotated", oldSid, reason: "member-left" }),
    );
    expect(epochFor(s.alice.groups, CHAN)?.sid).not.toBe(oldSid);
    // The new key goes only to the members who remain.
    expect(s.alice.dm.sent.map((d) => d.nick)).toEqual(["bob"]);
  });
});

describe("sendChannel", () => {
  it("queues the row without a key: it never mints an epoch, and never sends in the clear", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    const res = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hello all", [
      "alice",
      "bob",
      "carol",
    ]);
    // No epoch was minted, no gkey DM went out, and no channel message
    // either: the row waits in queue for the key.
    expect(epochFor(s.alice.groups, CHAN)).toBeUndefined();
    expect(s.alice.dm.sent).toEqual([]);
    expect(res.outbound.filter((o) => o.target === CHAN && o.verb === "msg")).toHaveLength(1);
    expect(decodePayload(res.outbound.find((o) => o.target === CHAN)?.payload ?? "")).toEqual({
      v: 4,
      t: "keyreq",
      ch: "#grappa",
    });
    expect(res.events).toContainEqual({ kind: "channel_key_missing", channel: CHAN });
    expect(res.events).toContainEqual({ kind: "channel_key_requested", channel: CHAN });
    // The key arrives from Bob: he mints it, Alice imports it after asking.
    distributeKey(s.bob.deps, s.bob.groups, CHAN, ["alice", "bob", "carol"]);
    const gkey = s.bob.dm.sent.find((d) => d.nick === "alice")?.inner as
      | Record<string, unknown>
      | undefined;
    if (gkey === undefined) throw new Error("bob sent alice no gkey");
    expect(receiveGkey(s.alice.deps, s.alice.groups, gkey, "bob", didFor("bob"))).toEqual([
      expect.objectContaining({ kind: "channel_key_received", from: "bob" }),
    ]);
    // The next send flushes the queued row first, in order, then the new row.
    const again = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "again", [
      "alice",
      "bob",
      "carol",
    ]);
    expect(again.outbound).toHaveLength(2);
    expect(again.outbound.map((o) => o.target)).toEqual([CHAN, CHAN]);
    const first = await receiveChannel(
      s.bob.deps,
      s.bob.groups,
      CHAN,
      "alice",
      didFor("alice"),
      again.outbound[0]?.payload ?? "",
    );
    expect(first.events).toEqual([
      expect.objectContaining({ kind: "channel_received", body: "hello all" }),
    ]);
    const second = await receiveChannel(
      s.bob.deps,
      s.bob.groups,
      CHAN,
      "alice",
      didFor("alice"),
      again.outbound[1]?.payload ?? "",
    );
    expect(second.events).toEqual([
      expect.objectContaining({ kind: "channel_received", body: "again" }),
    ]);
  });

  it("audits before sending: a departed holder rotates the epoch first", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "carol"]);
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
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
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
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    const sent = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "once", ["alice", "bob"]);
    const payload = channelMsg(sent)?.payload ?? "";
    expect(
      await receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", didFor("alice"), payload),
    ).toEqual({
      events: [expect.objectContaining({ kind: "channel_received", body: "once" })],
      outbound: [],
      copies: [],
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
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
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
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
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
      copies: [],
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
      copies: [],
    });
  });

  it("carries no plaintext counter in the v4 envelope", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
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
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    const sent = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const payload = channelMsg(sent)?.payload ?? "";
    expect(
      await receiveChannel(s.alice.deps, s.alice.groups, CHAN, "alice", didFor("alice"), payload),
    ).toEqual({ events: [], outbound: [], copies: [] });
    expect(
      await receiveChannel(s.alice.deps, s.alice.groups, CHAN, "ALICE", didFor("alice"), payload),
    ).toEqual({ events: [], outbound: [], copies: [] });
  });

  it("answers a newcomer's key request with a gkey DM, and ignores a foreign channel's", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob", "dave"] : undefined);
    const s = sides(clock, roster);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
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
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const gkey = s.alice.dm.sent[0]?.inner as Record<string, unknown>;
    const sid = gkey.sid as string;
    requestKey(s.bob.deps, s.bob.groups, CHAN);
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
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const first = s.alice.dm.sent[0]?.inner as Record<string, unknown>;
    requestKey(s.bob.deps, s.bob.groups, CHAN);
    receiveGkey(s.bob.deps, s.bob.groups, first, "alice", didFor("alice"));
    const oldSid = epochFor(s.bob.groups, CHAN)?.sid;
    // A newer epoch whose holders still name Carol, who is no longer on the roster.
    const stale = {
      t: "gkey",
      ch: CHAN,
      sid: newEpochId(),
      key: newEpochKey(),
      holders: [didFor("alice"), didFor("bob"), didFor("carol")],
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
      holders: [didFor("alice"), didFor("bob"), didFor("carol")],
    };
    requestKey(s.bob.deps, s.bob.groups, CHAN);
    expect(receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice", didFor("alice"))).toEqual([
      { kind: "channel_key_received", channel: CHAN, from: "alice", sid: gkey.sid },
    ]);
  });

  it("drops a gkey from a sender off the roster, even for a first import", () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    const s = sides(clock, roster);
    const gkey = {
      t: "gkey",
      ch: CHAN,
      sid: newEpochId(),
      key: newEpochKey(),
      holders: [didFor("alice"), didFor("bob")],
    };
    requestKey(s.bob.deps, s.bob.groups, CHAN);
    expect(receiveGkey(s.bob.deps, s.bob.groups, gkey, "mallory", "did-mallory")).toEqual([
      {
        kind: "channel_dropped",
        channel: CHAN,
        reason: "sender-not-in-roster",
        detail: expect.any(String),
      },
    ]);
    expect(epochFor(s.bob.groups, CHAN)).toBeUndefined();
  });

  it("drops a first import when this device never asked for the key", () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    const s = sides(clock, roster);
    const gkey = {
      t: "gkey",
      ch: CHAN,
      sid: newEpochId(),
      key: newEpochKey(),
      holders: [didFor("alice"), didFor("bob")],
    };
    // No requestKey call: the key is dropped, and the channel stays unarmed.
    expect(receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice", didFor("alice"))).toEqual([
      {
        kind: "channel_dropped",
        channel: CHAN,
        reason: "not-requested",
        detail: expect.any(String),
      },
    ]);
    expect(epochFor(s.bob.groups, CHAN)).toBeUndefined();
    // Asking first lets the same key in.
    requestKey(s.bob.deps, s.bob.groups, CHAN);
    expect(receiveGkey(s.bob.deps, s.bob.groups, gkey, "alice", didFor("alice"))).toEqual([
      { kind: "channel_key_received", channel: CHAN, from: "alice", sid: gkey.sid },
    ]);
  });

  it("replaces an epoch already held without asking again", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    const s = sides(clock, roster);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const first = s.alice.dm.sent[0]?.inner as Record<string, unknown>;
    requestKey(s.bob.deps, s.bob.groups, CHAN);
    receiveGkey(s.bob.deps, s.bob.groups, first, "alice", didFor("alice"));
    const oldSid = epochFor(s.bob.groups, CHAN)?.sid;
    // A rotation successor (seq 1) from the same sender imports, with no
    // fresh request: the channel is already armed. A second gkey at the
    // same seq would be superseded instead — the first valid gkey wins.
    const second = {
      t: "gkey",
      ch: CHAN,
      sid: newEpochId(),
      key: newEpochKey(),
      seq: 1,
      holders: [didFor("alice"), didFor("bob")],
    };
    expect(receiveGkey(s.bob.deps, s.bob.groups, second, "alice", didFor("alice"))).toEqual([
      { kind: "channel_key_received", channel: CHAN, from: "alice", sid: second.sid },
    ]);
    expect(epochFor(s.bob.groups, CHAN)?.sid).not.toBe(oldSid);
  });

  it("drops a second gkey at the same sequence: the first valid gkey wins", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    const s = sides(clock, roster);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const first = s.alice.dm.sent[0]?.inner as Record<string, unknown>;
    requestKey(s.bob.deps, s.bob.groups, CHAN);
    receiveGkey(s.bob.deps, s.bob.groups, first, "alice", didFor("alice"));
    const heldSid = epochFor(s.bob.groups, CHAN)?.sid;
    // A concurrent first epoch: same seq, different sid — a late
    // duplicate, or a mint that lost the race. It is dropped, and the
    // epoch already taken stays.
    const rival = {
      t: "gkey",
      ch: CHAN,
      sid: newEpochId(),
      key: newEpochKey(),
      seq: 0,
      holders: [didFor("alice"), didFor("bob")],
    };
    expect(receiveGkey(s.bob.deps, s.bob.groups, rival, "alice", didFor("alice"))).toEqual([
      {
        kind: "channel_dropped",
        channel: CHAN,
        reason: "superseded-gkey",
        detail: expect.any(String),
      },
    ]);
    expect(epochFor(s.bob.groups, CHAN)?.sid).toBe(heldSid);
    // First advance the epoch, so a stale seq is below the held one.
    const successor = {
      t: "gkey",
      ch: CHAN,
      sid: newEpochId(),
      key: newEpochKey(),
      seq: 1,
      holders: [didFor("alice"), didFor("bob")],
    };
    expect(receiveGkey(s.bob.deps, s.bob.groups, successor, "alice", didFor("alice"))).toEqual([
      { kind: "channel_key_received", channel: CHAN, from: "alice", sid: successor.sid },
    ]);
    const stale = {
      t: "gkey",
      ch: CHAN,
      sid: newEpochId(),
      key: newEpochKey(),
      seq: 0,
      holders: [didFor("alice"), didFor("bob")],
    };
    expect(receiveGkey(s.bob.deps, s.bob.groups, stale, "alice", didFor("alice"))).toEqual([
      {
        kind: "channel_dropped",
        channel: CHAN,
        reason: "superseded-gkey",
        detail: expect.any(String),
      },
    ]);
    expect(epochFor(s.bob.groups, CHAN)?.sid).toBe(successor.sid);
  });

  it("drops a bad key, never stores it, never throws", () => {
    const clock = { t: NOW };
    const s = sides(clock);
    requestKey(s.bob.deps, s.bob.groups, CHAN);
    const badKey = {
      t: "gkey",
      ch: CHAN,
      sid: "sid-x",
      key: "not-a-key",
      holders: [didFor("alice")],
    };
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

  it("a gkey that would replace the held epoch waits while the roster is unknown, and imports once it seeds", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "carol"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob", "carol"]);
    const first = s.alice.dm.sent.find((d) => d.nick === "bob")?.inner as Record<string, unknown>;
    requestKey(s.bob.deps, s.bob.groups, CHAN);
    expect(receiveGkey(s.bob.deps, s.bob.groups, first, "alice", didFor("alice"))).toEqual([
      { kind: "channel_key_received", channel: CHAN, from: "alice", sid: first.sid as string },
    ]);
    const oldSid = epochFor(s.bob.groups, CHAN)?.sid;
    // Carol leaves: Alice rotates and distributes the seq 1 key to Bob.
    s.alice.dm.sent.length = 0;
    const left = onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "carol", ["alice", "bob"]);
    expect(left.events).toContainEqual(
      expect.objectContaining({ kind: "channel_rotated", reason: "member-left" }),
    );
    const successor = s.alice.dm.sent.find((d) => d.nick === "bob")?.inner as
      | Record<string, unknown>
      | undefined;
    if (successor === undefined) throw new Error("alice sent bob no rotated key");
    // Bob holds no roster yet: the new key waits instead of replacing
    // the epoch he holds — nothing is stored.
    expect(receiveGkey(s.bob.deps, s.bob.groups, successor, "alice", didFor("alice"))).toEqual([]);
    expect(epochFor(s.bob.groups, CHAN)?.sid).toBe(oldSid);
    expect(epochFor(s.bob.groups, CHAN)?.seq).toBe(0);
    // The roster seeds: the audit retries the held key, the checks run
    // for real now, and the epoch is replaced.
    s.bob.deps.rosterFor = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    expect(auditEpochRotation(s.bob.deps, s.bob.groups, CHAN, ["alice", "bob"])).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
    expect(epochFor(s.bob.groups, CHAN)?.sid).toBe(successor.sid as string);
    expect(epochFor(s.bob.groups, CHAN)?.seq).toBe(1);
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
      copies: [],
    });
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    const next = await sendChannel(s.alice.deps, s.alice.groups, CHAN, "day two", ["alice", "bob"]);
    const nextPayload = channelMsg(next)?.payload ?? "";
    expect(
      await receiveChannel(s.bob.deps, s.bob.groups, CHAN, "alice", didFor("alice"), nextPayload),
    ).toEqual({
      events: [expect.objectContaining({ kind: "channel_received", body: "day two" })],
      outbound: [],
      copies: [],
    });
  });

  it("rotates nothing when the roster is unknown, we are not the rotator, or the epoch never spoke", async () => {
    const clock = { t: NOW };
    // No roster at all: the election cannot run.
    const noRoster = sides(clock);
    distributeKey(noRoster.alice.deps, noRoster.alice.groups, CHAN, ["alice", "bob"]);
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
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "one", ["alice", "bob"]);
    distributeKey(s.alice.deps, s.alice.groups, "#other", ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, "#other", "two", ["alice", "bob"]);
    expect(channelsWithEpoch(s.alice.groups).sort()).toEqual(["#grappa", "#other"]);
    onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "alice", ["bob"]);
    expect(channelsWithEpoch(s.alice.groups)).toEqual(["#other"]);
  });
});

describe("key copies", () => {
  it("records one copy per member a gkey DM went to, with the exact gkey inner", () => {
    const clock = { t: NOW };
    const s = sides(clock);
    const res = distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob", "carol"]);
    expect(res.copies).toHaveLength(2);
    expect(res.copies.map((c) => c.peer)).toEqual(["bob", "carol"]);
    const sid = epochFor(s.alice.groups, CHAN)?.sid;
    for (const copy of res.copies) {
      expect(JSON.parse(copy.body)).toEqual({
        t: "gkey",
        ch: "#grappa",
        sid,
        key: expect.any(String),
        seq: 0,
        minter: didFor("alice"),
        holders: [didFor("alice"), didFor("bob"), didFor("carol")],
        holderNicks: {
          alice: [didFor("alice")],
          bob: [didFor("bob")],
          carol: [didFor("carol")],
        },
      });
      // The body is the exact inner the DM carried.
      const dm = s.alice.dm.sent.find((d) => d.nick === copy.peer);
      expect(JSON.stringify(dm?.inner)).toBe(copy.body);
    }
  });

  it("records a copy when answering a key request, and none when nothing is sent", async () => {
    const clock = { t: NOW };
    const roster = (channel: string) => (channel === CHAN ? ["alice", "bob"] : undefined);
    const s = sides(clock, roster);
    distributeKey(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"]);
    await sendChannel(s.alice.deps, s.alice.groups, CHAN, "hi", ["alice", "bob"]);
    const sid = epochFor(s.alice.groups, CHAN)?.sid;
    s.alice.dm.sent.length = 0;
    const answered = onKeyreq(s.alice.deps, s.alice.groups, CHAN, "bob", didFor("bob"));
    expect(answered.copies).toHaveLength(1);
    expect(answered.copies[0]?.peer).toBe("bob");
    expect(JSON.parse(answered.copies[0]?.body ?? "")).toEqual(
      expect.objectContaining({ t: "gkey", sid }),
    );
    // A request that sends nothing copies nothing.
    expect(requestKey(s.bob.deps, s.bob.groups, CHAN).copies).toEqual([]);
  });

  it("records copies on rotation, for the members who remain", async () => {
    const clock = { t: NOW };
    const s = sides(clock);
    await shareEpoch(s, ["alice", "bob", "carol"]);
    s.alice.dm.sent.length = 0;
    const left = onMemberLeft(s.alice.deps, s.alice.groups, CHAN, "carol", ["alice", "bob"]);
    expect(left.copies.map((c) => c.peer)).toEqual(["bob"]);
    expect(JSON.parse(left.copies[0]?.body ?? "")).toEqual(
      expect.objectContaining({ t: "gkey", sid: epochFor(s.alice.groups, CHAN)?.sid }),
    );
    // Bob's epoch still names Carol as a holder, but Bob is not the
    // designated rotator — Alice is — so his audit waits: it rotates
    // nothing and copies nothing. Alice already rotated on the leave,
    // so her audit is quiet too.
    const audited = auditEpochRotation(s.bob.deps, s.bob.groups, CHAN, ["alice", "bob"]);
    expect(audited).toEqual({ events: [], outbound: [], copies: [] });
    expect(auditEpochRotation(s.alice.deps, s.alice.groups, CHAN, ["alice", "bob"])).toEqual({
      events: [],
      outbound: [],
      copies: [],
    });
  });

  it("is always present, empty when no gkey DM went out", () => {
    const clock = { t: NOW };
    const s = sides(clock);
    expect(requestKey(s.bob.deps, s.bob.groups, CHAN).copies).toEqual([]);
    expect(onMemberJoined(s.bob.deps, s.bob.groups, CHAN, "dave", ["alice", "bob"]).copies).toEqual(
      [],
    );
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
