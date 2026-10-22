// issue 2430 — the E2E engine, end to end between two (or three) real
// engines: real vodozemac accounts and sessions, the real key bundle cic
// uploads, and a fake grappa in between that does what the real one does
// with the send door's payloads — names each message with a msgid, answers a
// KEYREQ with a KEYS from the target's bundle (a one-time key while it holds
// one, then the fallback key), and delivers the rest whole to the target.
// Nothing is mocked inside the engine: a test that passes here passed
// through Olm.
import { describe, expect, it } from "vitest";
import {
  type E2eEvent,
  type E2eState,
  Engine,
  newState,
  OUTQ_MAX,
  OUTQ_TTL_MS,
  type Outbound,
  REKEY_INTERVAL_MS,
  type Result,
  SENT_MEMORY_MS,
} from "../lib/e2e/engine";
import { identityBlock, topUp } from "../lib/e2e/keyBundle";
import type { Account } from "../lib/e2e/vodozemac/vodozemac_binding";
import {
  base64Unpadded,
  decodePayload,
  encodePayload,
  fold,
  ID_SIG_PREFIX,
  OTK_SIG_PREFIX,
  type ReceiveVerb,
  unbase64,
} from "../lib/e2e/wire";
import { olm } from "./helpers/olm";

type Side = {
  nick: string;
  account: Account;
  state: E2eState;
  /** The KEYS payloads grappa holds for this side, as `topUp` built them. */
  keys: string[];
  fallback: string;
  events: E2eEvent[];
};

type Delivery = {
  to: Side;
  from: string;
  verb: ReceiveVerb;
  msgid: string;
  payload: string;
  priority: "control" | "text";
};

function newMsgid(): string {
  return base64Unpadded(crypto.getRandomValues(new Uint8Array(8)));
}

class World {
  now = 1_700_000_000_000;
  sides = new Map<string, Side>();
  /** Every delivery grappa made, in order. */
  wire: Delivery[] = [];
  /** Every payload an engine handed to grappa, with who handed it, in order. */
  outs: (Outbound & { by: string })[] = [];
  /** Rewrites a delivery on its way (a tampering network, a lost state). */
  before: (d: Delivery) => Delivery = (d) => d;

  /** A client on `nick` with a new account; replaces whoever held the nick. */
  join(nick: string): Side {
    const account = new (olm().Account)();
    const upload = topUp(account, { one_time_keys: 0, fallback: false });
    if (upload === null || upload.fallback === null) throw new Error("no bundle built");
    account.mark_keys_as_published();
    const side: Side = {
      nick,
      account,
      state: newState(),
      keys: [...upload.one_time_keys],
      fallback: upload.fallback,
      events: [],
    };
    this.sides.set(fold(nick), side);
    return side;
  }

  engine(side: Side): Engine {
    return new Engine(olm(), side.account, side.state, side.nick, () => this.now);
  }

  send(side: Side, nick: string, inner: Record<string, unknown>, tag: string): void {
    this.out(side, this.engine(side).send(nick, inner, tag));
  }

  /** Tagged with its body, or its length for a long one. */
  text(side: Side, nick: string, body: string): void {
    this.send(side, nick, { t: "text", body }, body.length <= 24 ? body : `len:${body.length}`);
  }

  tick(side: Side): void {
    this.out(side, this.engine(side).tick());
  }

  /** grappa takes what `side`'s engine produced. */
  out(side: Side, res: Result): void {
    side.events.push(...res.events);
    for (const o of res.outbound) {
      this.outs.push({ ...o, by: side.nick });
      const to = this.sides.get(fold(o.target));
      if (o.verb === "keyreq") {
        if (to !== undefined) {
          this.push({
            to: side,
            from: to.nick,
            verb: "keys",
            msgid: newMsgid(),
            payload: to.keys.shift() ?? to.fallback,
            priority: "control",
          });
        }
        continue;
      }
      const msgid = newMsgid();
      if (o.ref !== undefined) this.engine(side).sent(o.ref, msgid);
      if (to !== undefined) {
        this.push({
          to,
          from: side.nick,
          verb: o.verb,
          msgid,
          payload: o.payload,
          priority: o.priority,
        });
      }
    }
  }

  push(d: Delivery): void {
    const delivered = this.before(d);
    this.wire.push(delivered);
    this.deliver(delivered);
  }

  deliver(d: Delivery): void {
    this.out(d.to, this.engine(d.to).receive(d.from, d.verb, d.msgid, d.payload));
  }
}

const texts = (side: Side): unknown[] =>
  side.events.flatMap((e) => (e.kind === "received" ? [e.inner.body] : []));

const ofKind = <K extends E2eEvent["kind"]>(side: Side, kind: K) =>
  side.events.filter((e): e is Extract<E2eEvent, { kind: K }> => e.kind === kind);

const failures = (side: Side) => ofKind(side, "send_failed").map((e) => [e.reason, e.tags]);
const drops = (side: Side) => ofKind(side, "dropped").map((e) => e.reason);
const verbsTo = (w: World, side: Side) => w.wire.filter((d) => d.to === side).map((d) => d.verb);

/** A payload with `edit` applied to its decoded JSON. */
function edited(payload: string, edit: (json: Record<string, unknown>) => void): string {
  const json = decodePayload(payload);
  edit(json);
  return encodePayload(json);
}

/** The payload with one byte of its Olm body flipped (inside the MAC). */
function corrupted(payload: string): string {
  return edited(payload, (json) => {
    const body = unbase64(json.body as string);
    body[body.length - 1] = (body[body.length - 1] ?? 0) ^ 0xff;
    json.body = base64Unpadded(body);
  });
}

/** A KEYS payload claiming `curve25519`, signed by `account`, handing out `otk`. */
function keysClaiming(account: Account, curve25519: string, otk: string): string {
  return encodePayload({
    v: 1,
    id: {
      curve25519,
      ed25519: account.ed25519_key(),
      sig: account.sign(`${ID_SIG_PREFIX}${curve25519}`),
    },
    otk: { key: otk, fallback: false, sig: account.sign(`${OTK_SIG_PREFIX}${otk}`) },
  });
}

/** A base64 key of 44 characters that decodes to 33 bytes. */
const KEY_OF_33_BYTES = base64Unpadded(new Uint8Array(33).fill(7)).padEnd(44, "=");

function twoPeers(): { w: World; a: Side; b: Side } {
  const w = new World();
  return { w, a: w.join("alice"), b: w.join("Bob") };
}

describe("first contact", () => {
  it("queues the message, asks for keys, and the peer pins the sender on first use", () => {
    const { w, a, b } = twoPeers();

    w.text(a, "bob", "hello");

    expect(ofKind(a, "send_queued")).toEqual([
      { kind: "send_queued", nick: "bob", queued: 1, tag: "hello" },
    ]);
    expect(verbsTo(w, a)).toEqual(["keys"]);
    expect(verbsTo(w, b)).toEqual(["pkmsg"]);
    expect(texts(b)).toEqual(["hello"]);
    const [received] = ofKind(b, "received");
    expect(received?.nick).toBe("alice");
    expect(received?.peer).toMatchObject({
      ed25519: a.account.ed25519_key(),
      curve25519: a.account.curve25519_key(),
      proven: true,
      verified: false,
    });
    // Both sides pinned the other's key to its nick, folded.
    expect(b.state.pins).toEqual({ alice: a.account.ed25519_key() });
    expect(a.state.pins).toEqual({ bob: b.account.ed25519_key() });
    // Bob's display spelling is kept as the hint; only the pin's key folds.
    expect(a.state.peers[b.account.ed25519_key()]).toMatchObject({ proven: false, nick: "Bob" });
    expect(a.state.outq).toEqual({});
    expect(a.state.keyreqAt).toEqual({});
  });

  it("puts the agreed payloads on the wire: KEYREQ {v}, PKMSG with our signed id block", () => {
    const { w, a, b } = twoPeers();
    const first = w.engine(a).send("bob", { t: "text", body: "hello" }, "hello");

    expect(first.outbound).toEqual([
      { target: "bob", verb: "keyreq", payload: encodePayload({ v: 1 }), priority: "control" },
    ]);
    w.out(a, first);
    const pkmsg = w.wire.find((d) => d.verb === "pkmsg");
    if (pkmsg === undefined) throw new Error("no PKMSG");
    const json = decodePayload(pkmsg.payload);
    expect(json.v).toBe(1);
    expect(json.id).toEqual(identityBlock(a.account));
    expect(typeof json.body).toBe("string");
    expect(pkmsg.priority).toBe("text");
    expect(texts(b)).toEqual(["hello"]);
  });

  it("sends everything queued before the keys came, in order, each a PKMSG on the one session", () => {
    const { w, a, b } = twoPeers();
    const engine = w.engine(a);
    const one = engine.send("bob", { t: "text", body: "one" }, "one");
    const two = engine.send("bob", { t: "text", body: "two" }, "two");

    // One KEYREQ for both.
    expect(one.outbound.map((o) => o.verb)).toEqual(["keyreq"]);
    expect(two.outbound).toEqual([]);
    w.out(a, one);

    expect(verbsTo(w, b)).toEqual(["pkmsg", "pkmsg"]);
    expect(texts(b)).toEqual(["one", "two"]);
    expect(Object.values(b.state.sessions).flat()).toHaveLength(1);
  });

  it("refuses to send to our own nick, before asking anyone for keys", () => {
    const { w, a } = twoPeers();

    const res = w.engine(a).send("ALICE", { t: "text", body: "me" }, "me");

    expect(res.outbound).toEqual([]);
    expect(res.events).toEqual([
      { kind: "send_failed", nick: "ALICE", reason: "own-nick", tags: ["me"] },
    ]);
  });
});

describe("an established session", () => {
  it("answers as MSG on the session the peer opened, and the opener then sends MSG too", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");

    w.text(b, "alice", "hi back");
    w.text(a, "bob", "again");

    expect(verbsTo(w, a)).toEqual(["keys", "msg"]);
    expect(verbsTo(w, b)).toEqual(["pkmsg", "msg"]);
    expect(texts(a)).toEqual(["hi back"]);
    expect(texts(b)).toEqual(["hello", "again"]);
    // The MSG names the sender's curve, nothing else about it.
    const msg = w.wire.find((d) => d.verb === "msg" && d.to === a);
    expect(decodePayload(msg?.payload ?? "")).toEqual({
      v: 1,
      ck: b.account.curve25519_key(),
      body: expect.any(String),
    });
  });

  it("goes on decrypting after both states and accounts round-trip through JSON", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    w.text(b, "alice", "hi");

    for (const side of [a, b]) {
      side.state = JSON.parse(JSON.stringify(side.state)) as E2eState;
      const pickle = side.account.pickle();
      side.account.free();
      side.account = olm().Account.from_pickle(pickle);
    }
    w.text(a, "bob", "after");
    w.text(b, "alice", "reload");

    expect(texts(b)).toEqual(["hello", "after"]);
    expect(texts(a)).toEqual(["hi", "reload"]);
  });

  it("sends a chal or an ack ahead of text, and delivers any typed inner message", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");

    w.send(a, "bob", { t: "chal", nonce: "n" }, "chal");

    expect(w.wire.at(-1)).toMatchObject({ verb: "pkmsg", priority: "control" });
    expect(ofKind(b, "received").at(-1)?.inner).toEqual({ t: "chal", nonce: "n" });
  });

  it("refuses a message grappa would refuse for length, and the session is unharmed", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    const before = w.wire.length;

    w.text(a, "bob", "x".repeat(20_000));

    expect(failures(a)).toEqual([["too-long", ["len:20000"]]]);
    expect(w.wire.length).toBe(before);
    w.text(a, "bob", "y".repeat(5_000));
    expect(texts(b)).toEqual(["hello", "y".repeat(5_000)]);
  });
});

describe("keys", () => {
  it("drops a KEYS nobody asked for", () => {
    const { w, a, b } = twoPeers();

    w.deliver({
      to: a,
      from: "Bob",
      verb: "keys",
      msgid: newMsgid(),
      payload: b.keys[0] ?? "",
      priority: "control",
    });

    expect(drops(a)).toEqual(["unsolicited-keys"]);
    expect(a.state.peers).toEqual({});
  });

  it("drops a KEYS whose one-time key is not signed by its identity, and keeps waiting", () => {
    const { w, a, b } = twoPeers();
    const mallory = new (olm().Account)();
    w.before = (d) =>
      d.verb === "keys"
        ? {
            ...d,
            payload: edited(d.payload, (json) => {
              (json.otk as Record<string, unknown>).sig = mallory.sign("irc-e2e:v1:otk:x");
            }),
          }
        : d;

    w.text(a, "bob", "hello");

    expect(drops(a)).toEqual(["bad-otk-signature"]);
    expect(texts(b)).toEqual([]);
    expect(a.state.outq.bob).toHaveLength(1);
    // The message waits for keys that never come, and says so.
    w.now += OUTQ_TTL_MS;
    w.tick(a);
    expect(failures(a)).toEqual([["keys-timeout", ["hello"]]]);
    expect(a.state.outq).toEqual({});
  });

  it("drops a KEYS whose identity block is not signed by its key", () => {
    const { w, a } = twoPeers();
    const mallory = new (olm().Account)();
    w.before = (d) =>
      d.verb === "keys"
        ? {
            ...d,
            payload: edited(d.payload, (json) => {
              (json.id as Record<string, unknown>).sig = mallory.sign("irc-e2e:v1:id:x");
            }),
          }
        : d;

    w.text(a, "bob", "hello");

    expect(drops(a)).toEqual(["bad-identity-signature"]);
  });

  it("drops a KEYS carrying our own identity: a reflected key never opens a session", () => {
    const { w, a } = twoPeers();
    w.before = (d) => (d.verb === "keys" ? { ...d, payload: a.keys[0] ?? "" } : d);

    w.text(a, "bob", "hello");

    expect(drops(a)).toEqual(["own-identity"]);
    expect(a.state.peers).toEqual({});
  });

  it("raises the alarm for a new key on a pinned nick, and the queued message goes nowhere", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    w.text(b, "alice", "hi");
    // Bob's storage is wiped: a new account under the same nick.
    const b2 = w.join("bob");
    w.now += REKEY_INTERVAL_MS;

    w.text(a, "bob", "are you there?");

    // The new account cannot read it, and NACKs: alice's nick has no pin
    // there yet, so the NACK goes back to where it came from.
    expect(ofKind(b2, "undecryptable").map((e) => e.reason)).toEqual(["no-session"]);
    expect(verbsTo(w, a).slice(-2)).toEqual(["nack", "keys"]);
    expect(ofKind(a, "rekeying")).toHaveLength(1);
    expect(ofKind(a, "key_alarm")).toEqual([
      {
        kind: "key_alarm",
        nick: "bob",
        pinned: b.account.ed25519_key(),
        presented: b2.account.ed25519_key(),
      },
    ]);
    expect(failures(a)).toEqual([["key-mismatch", ["are you there?"]]]);
    expect(texts(b2)).toEqual([]);
    // The pin did not move.
    expect(a.state.pins.bob).toBe(b.account.ed25519_key());
  });

  it("raises the alarm when the new key on a pinned nick writes first, and reads nothing", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    const b2 = w.join("bob");

    w.text(b2, "alice", "it's me, new phone");

    expect(ofKind(a, "key_alarm")).toEqual([
      {
        kind: "key_alarm",
        nick: "bob",
        pinned: b.account.ed25519_key(),
        presented: b2.account.ed25519_key(),
      },
    ]);
    expect(drops(a)).toEqual(["unpinned-key"]);
    expect(texts(a)).toEqual([]);
  });

  it("drops keys of 33 bytes spelled in 44 characters, wherever they come, without a trap", () => {
    const { w, a, b } = twoPeers();
    // A one-time key that decodes to 33 bytes, properly signed.
    w.before = (d) =>
      d.verb === "keys"
        ? { ...d, payload: keysClaiming(b.account, b.account.curve25519_key(), KEY_OF_33_BYTES) }
        : d;
    w.text(a, "bob", "hello");
    // An identity curve of 33 bytes, properly signed.
    w.before = (d) =>
      d.verb === "keys" ? { ...d, payload: keysClaiming(b.account, KEY_OF_33_BYTES, "x") } : d;
    w.now += 30_000;
    w.tick(a);
    w.text(a, "bob", "hello again");
    // A MSG naming a curve of 33 bytes.
    w.deliver({
      to: a,
      from: "bob",
      verb: "msg",
      msgid: newMsgid(),
      payload: encodePayload({ v: 1, ck: KEY_OF_33_BYTES, body: "AAAA" }),
      priority: "text",
    });

    expect(drops(a)).toEqual(["bad-payload", "bad-payload", "bad-payload"]);
    // The binding still works: a real exchange goes through afterwards.
    w.before = (d) => d;
    w.now += 30_000;
    w.text(a, "bob", "fine");
    expect(texts(b)).toContain("fine");
  });

  it("hands each message's tag to grappa with it: after its queue, and again on its re-send", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    b.state.sessions = {};
    w.now += REKEY_INTERVAL_MS;

    w.text(a, "bob", "two");

    expect(w.outs.filter((o) => o.by === "alice").map((o) => [o.verb, o.tag])).toEqual([
      ["keyreq", undefined],
      ["pkmsg", "hello"],
      // Still a pre-key message: bob never answered on the first session.
      ["pkmsg", "two"],
      ["keyreq", undefined],
      ["pkmsg", "two"],
    ]);
    expect(texts(b)).toEqual(["hello", "two"]);
  });

  it("gives up on a queue the peer never answers, and names the messages it lost", () => {
    const { w, a } = twoPeers();

    w.text(a, "nobody", "one");
    w.text(a, "nobody", "two");
    w.now += OUTQ_TTL_MS - 1;
    w.tick(a);
    expect(failures(a)).toEqual([]);
    w.now += 1;
    w.tick(a);

    expect(failures(a)).toEqual([["keys-timeout", ["one", "two"]]]);
    expect(a.state.outq).toEqual({});
  });

  it("asks for keys again only after the retry interval", () => {
    const { w, a } = twoPeers();
    const engine = w.engine(a);

    const first = engine.send("nobody", { t: "text", body: "one" }, "one");
    const soon = engine.send("nobody", { t: "text", body: "two" }, "two");
    w.now += 30_000;
    const later = engine.send("nobody", { t: "text", body: "three" }, "three");

    expect(first.outbound.map((o) => o.verb)).toEqual(["keyreq"]);
    expect(soon.outbound).toEqual([]);
    expect(later.outbound.map((o) => o.verb)).toEqual(["keyreq"]);
  });

  it("never sends a message queued for one key to another key that answers on its nick", () => {
    const { w, a, b } = twoPeers();
    const c = w.join("carol");
    w.text(a, "bob", "hello");
    w.text(a, "carol", "hello carol");
    a.state.sessions = {};
    // Carol's KEYS answers on bob's nick (relayed, or she took the nick).
    w.before = (d) => (d.verb === "keys" ? { ...d, payload: c.keys.shift() ?? "" } : d);

    w.text(a, "bob", "for bob only");

    expect(failures(a)).toEqual([["key-mismatch", ["for bob only"]]]);
    expect(verbsTo(w, b)).toEqual(["pkmsg"]);
    expect(texts(c)).toEqual(["hello carol"]);
  });

  it("refuses a message past the queue's bound, and says so", () => {
    const { w, a } = twoPeers();

    for (let i = 0; i <= OUTQ_MAX; i++) w.text(a, "nobody", `m${i}`);

    expect(a.state.outq.nobody).toHaveLength(OUTQ_MAX);
    expect(failures(a)).toEqual([["queue-full", ["m16"]]]);
  });
});

describe("pre-key messages", () => {
  it("never delivers a replayed PKMSG twice: the held session refuses it, and it is NACKed", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    const pkmsg = w.wire.find((d) => d.verb === "pkmsg");
    if (pkmsg === undefined) throw new Error("no PKMSG");

    w.deliver(pkmsg);

    expect(texts(b)).toEqual(["hello"]);
    expect(ofKind(b, "undecryptable").map((e) => e.reason)).toEqual(["decryption-failed"]);
    expect(w.wire.at(-1)).toMatchObject({ to: a, verb: "nack" });
  });

  it("never opens a session it saw before again: a replay after the session is gone is NACKed", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    const pkmsg = w.wire.find((d) => d.verb === "pkmsg");
    if (pkmsg === undefined) throw new Error("no PKMSG");
    b.state.sessions = {};

    w.deliver(pkmsg);

    expect(texts(b)).toEqual(["hello"]);
    expect(ofKind(b, "replayed")).toHaveLength(1);
    expect(ofKind(b, "undecryptable").map((e) => e.reason)).toEqual(["replayed-session"]);
    expect(w.wire.at(-1)).toMatchObject({ to: a, verb: "nack", priority: "control" });
    expect(decodePayload(w.wire.at(-1)?.payload ?? "")).toEqual({ v: 1, ref: pkmsg.msgid });
  });

  it("does not NACK a message whose key is pinned to another nick", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    const pkmsg = w.wire.find((d) => d.verb === "pkmsg");
    if (pkmsg === undefined) throw new Error("no PKMSG");
    w.join("carol");
    w.text(b, "carol", "hi carol");
    const nacks = w.wire.filter((d) => d.verb === "nack").length;

    // Alice's PKMSG again, but from carol's nick, which is pinned to carol.
    w.deliver({ ...pkmsg, from: "carol" });

    expect(drops(b)).toEqual([]);
    expect(ofKind(b, "undecryptable")).toHaveLength(1);
    expect(w.wire.filter((d) => d.verb === "nack")).toHaveLength(nacks);
  });
});

describe("messages", () => {
  it("does not NACK a MSG it cannot read from a nick pinned to another key", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    w.text(b, "alice", "hi");
    w.text(a, "bob", "msg");
    const msg = w.wire.filter((d) => d.verb === "msg" && d.to === b).at(-1);
    if (msg === undefined) throw new Error("no MSG");
    w.join("carol");
    w.text(b, "carol", "hi carol");
    const nacks = w.wire.filter((d) => d.verb === "nack").length;

    w.deliver({ ...corruptedDelivery(msg), from: "carol" });

    expect(ofKind(b, "undecryptable").map((e) => e.reason)).toEqual(["decryption-failed"]);
    expect(w.wire.filter((d) => d.verb === "nack")).toHaveLength(nacks);
  });

  it("NACKs a MSG on a curve it has no session for, so the sender re-keys", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    w.text(b, "alice", "hi");
    b.state.sessions = {};

    w.text(a, "bob", "lost");

    expect(ofKind(b, "undecryptable").map((e) => e.reason)).toEqual(["no-session"]);
    expect(w.wire.at(-1)).toMatchObject({ to: a, verb: "nack" });
  });

  it("never delivers a replayed MSG twice: the session refuses it, and it is NACKed", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    w.text(b, "alice", "hi");
    const msg = w.wire.filter((d) => d.verb === "msg" && d.to === a).at(-1);
    if (msg === undefined) throw new Error("no MSG");

    const res = w.engine(a).receive(msg.from, msg.verb, msg.msgid, msg.payload);

    expect(res.events).toEqual([
      { kind: "undecryptable", nick: "Bob", msgid: msg.msgid, reason: "decryption-failed" },
    ]);
    expect(res.outbound.map((o) => o.verb)).toEqual(["nack"]);
  });

  it("reads a MSG on an older session, and answers on the session the peer used", () => {
    const { w, a, b } = twoPeers();
    const aCurve = a.account.curve25519_key();
    const bCurve = b.account.curve25519_key();
    w.text(a, "bob", "one");
    w.text(b, "alice", "two");
    // Bob opens a second session, then finds the first again and writes on it.
    const first = b.state.sessions[aCurve] ?? [];
    b.state.sessions = {};
    w.text(b, "alice", "three");
    b.state.sessions[aCurve] = [...first, ...(b.state.sessions[aCurve] ?? [])];
    expect(a.state.sessions[bCurve]).toHaveLength(2);

    w.text(b, "alice", "four");

    expect(texts(a)).toEqual(["two", "three", "four"]);
    expect(sessionIdOf(a.state.sessions[bCurve]?.[0])).toBe(sessionIdOf(first[0]));
  });

  it("drops a decrypted inner message that is not a typed JSON object", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    w.text(b, "alice", "hi");
    const pickles = a.state.sessions[b.account.curve25519_key()] ?? [];
    // What only a peer holding the session can send: any plaintext at all.
    const raw = (plaintext: string): string => {
      const session = olm().Session.from_pickle(pickles[0] ?? "");
      const encrypted = session.encrypt(new TextEncoder().encode(plaintext));
      pickles[0] = session.pickle();
      const body = base64Unpadded(encrypted.body);
      encrypted.free();
      session.free();
      return encodePayload({ v: 1, ck: a.account.curve25519_key(), body });
    };

    for (const plaintext of ["not json", "null", "[1,2]", '{"body":"no type"}', '{"t":5}']) {
      w.deliver({
        to: b,
        from: "alice",
        verb: "msg",
        msgid: newMsgid(),
        payload: raw(plaintext),
        priority: "text",
      });
    }

    expect(drops(b)).toEqual([
      "undecodable-inner",
      "inner-without-type",
      "inner-without-type",
      "inner-without-type",
      "inner-without-type",
    ]);
    expect(texts(b)).toEqual(["hello"]);
  });
});

function corruptedDelivery(d: Delivery): Delivery {
  return { ...d, payload: corrupted(d.payload) };
}

describe("recovery", () => {
  it("re-sends a NACKed message once, on a new session", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "one");
    b.state.sessions = {};
    w.now += REKEY_INTERVAL_MS;

    w.text(a, "bob", "two");

    expect(ofKind(b, "replayed")).toHaveLength(1);
    expect(ofKind(a, "rekeying")).toHaveLength(1);
    expect(verbsTo(w, a)).toEqual(["keys", "nack", "keys"]);
    expect(verbsTo(w, b)).toEqual(["pkmsg", "pkmsg", "pkmsg"]);
    expect(texts(b)).toEqual(["one", "two"]);
    expect(failures(a)).toEqual([]);
    // The failed session is gone; the new one is the only one.
    expect(a.state.sessions[b.account.curve25519_key()]).toHaveLength(1);
  });

  it("gives up after the re-send fails too", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "one");
    b.state.sessions = {};
    w.now += REKEY_INTERVAL_MS;
    w.before = (d) => (d.verb === "pkmsg" ? corruptedDelivery(d) : d);

    w.text(a, "bob", "two");

    expect(ofKind(b, "undecryptable").map((e) => e.reason)).toEqual([
      "replayed-session",
      "session-creation",
    ]);
    expect(failures(a)).toEqual([["resend-failed", ["two"]]]);
    expect(texts(b)).toEqual(["one"]);
  });

  it("opens at most one new session per peer per minute", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "one");
    b.state.sessions = {};

    w.text(a, "bob", "two");

    expect(failures(a)).toEqual([["rekey-throttled", ["two"]]]);
    expect(ofKind(a, "rekeying")).toEqual([]);
    expect(verbsTo(w, a)).toEqual(["keys", "nack"]);
  });

  it("re-sends on the newest session, without a new one, when the failed session is older", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "one");
    const old = w.wire.find((d) => d.verb === "pkmsg");
    if (old === undefined) throw new Error("no PKMSG");
    b.state.sessions = {};
    w.now += REKEY_INTERVAL_MS;
    w.text(a, "bob", "two");
    const keysBefore = verbsTo(w, a).filter((v) => v === "keys").length;

    // A late NACK for "one", sent on the session that is now gone.
    w.deliver({
      to: a,
      from: "bob",
      verb: "nack",
      msgid: newMsgid(),
      payload: encodePayload({ v: 1, ref: old.msgid }),
      priority: "control",
    });

    expect(verbsTo(w, a).filter((v) => v === "keys")).toHaveLength(keysBefore);
    expect(texts(b)).toEqual(["one", "two", "one"]);
  });

  it("never re-sends on the word of another nick", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "one");
    const pkmsg = w.wire.find((d) => d.verb === "pkmsg");
    if (pkmsg === undefined) throw new Error("no PKMSG");

    w.deliver({
      to: a,
      from: "carol",
      verb: "nack",
      msgid: newMsgid(),
      payload: encodePayload({ v: 1, ref: pkmsg.msgid }),
      priority: "control",
    });

    expect(failures(a)).toEqual([["nack-from-another-nick", ["one"]]]);
    // Reported against the nick it was sent to (as the KEYS spelled it).
    expect(ofKind(a, "send_failed")[0]?.nick).toBe("Bob");
    expect(texts(b)).toEqual(["one"]);
  });

  it("forgets a message grappa refused: it never left, and holds no room among the sent", () => {
    const { w, a } = twoPeers();
    w.text(a, "bob", "one");
    const engine = w.engine(a);
    const refused = engine.send("bob", { t: "text", body: "refused" }, "refused");
    const ref = refused.outbound[0]?.ref;
    if (ref === undefined) throw new Error("no ref");
    expect(a.state.sent.map((s) => s.ref)).toContain(ref);

    engine.discard(ref);

    expect(a.state.sent.map((s) => s.ref)).not.toContain(ref);
    expect(a.state.sent).toHaveLength(1);
  });

  it("knows no NACK for a message long forgotten", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "one");
    const pkmsg = w.wire.find((d) => d.verb === "pkmsg");
    if (pkmsg === undefined) throw new Error("no PKMSG");
    w.now += SENT_MEMORY_MS + 1;
    w.tick(a);

    w.deliver({
      to: a,
      from: "bob",
      verb: "nack",
      msgid: newMsgid(),
      payload: encodePayload({ v: 1, ref: pkmsg.msgid }),
      priority: "control",
    });

    expect(drops(a)).toEqual(["unknown-nack-ref"]);
    expect(a.state.sent).toEqual([]);
    expect(texts(b)).toEqual(["one"]);
  });
});

describe("a deleted chat", () => {
  it("forgets the nick's plaintext, waiting or kept for a re-send, and nobody else's", () => {
    const { w, a } = twoPeers();
    w.join("carol");
    w.text(a, "bob", "sent to bob");
    w.text(a, "carol", "sent to carol");
    w.text(a, "dave", "waits for dave");
    w.text(a, "erin", "waits for erin");
    const engine = w.engine(a);

    engine.forget("BOB");
    engine.forget("Dave");

    expect(a.state.sent.map((s) => s.nick)).toEqual(["carol"]);
    expect(Object.keys(a.state.outq)).toEqual(["erin"]);
    const kept = JSON.stringify(a.state);
    expect(kept).not.toMatch(/sent to bob|waits for dave/);
    expect(kept).toMatch(/sent to carol/);
  });

  it("never sends a message forgotten while it waited for keys", () => {
    const { w, a, b } = twoPeers();
    const engine = w.engine(a);
    const waiting = engine.send("bob", { t: "text", body: "never" }, "never");

    engine.forget("bob");
    w.out(a, waiting); // grappa answers the KEYREQ only now

    expect(texts(b)).toEqual([]);
    expect(failures(a)).toEqual([]);
    expect(a.state.outq).toEqual({});
  });

  it("has nothing to re-send for a NACK of a forgotten message", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "one");
    const pkmsg = w.wire.find((d) => d.verb === "pkmsg");
    if (pkmsg === undefined) throw new Error("no PKMSG");

    w.engine(a).forget("bob");
    w.deliver({
      to: a,
      from: "bob",
      verb: "nack",
      msgid: newMsgid(),
      payload: encodePayload({ v: 1, ref: pkmsg.msgid }),
      priority: "control",
    });

    expect(drops(a)).toEqual(["unknown-nack-ref"]);
    expect(texts(b)).toEqual(["one"]);
  });
});

describe("curves", () => {
  it("refuses a second key on a curve a pre-key message proved", () => {
    const { w, a, b } = twoPeers();
    w.text(b, "alice", "hello");
    const mallory = w.join("mallory");
    const otk = decodeOtk(b.keys[0] ?? "");
    w.before = (d) =>
      d.verb === "keys" && d.from === "mallory"
        ? { ...d, payload: keysClaiming(mallory.account, b.account.curve25519_key(), otk) }
        : d;

    w.text(a, "mallory", "hi");

    expect(drops(a)).toEqual(["curve-already-bound"]);
    expect(a.state.peers[mallory.account.ed25519_key()]).toBeUndefined();
  });

  it("drops an id block that gives a known key another curve", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    const other = new (olm().Account)();
    a.state.sessions = {};
    w.before = (d) =>
      d.verb === "keys"
        ? {
            ...d,
            payload: keysClaiming(b.account, other.curve25519_key(), decodeOtk(d.payload)),
          }
        : d;

    w.text(a, "bob", "again");

    expect(drops(a)).toEqual(["identity-curve-mismatch"]);
    expect(a.state.peers[b.account.ed25519_key()]?.curve25519).toBe(b.account.curve25519_key());
    other.free();
  });

  it("lets the curve's real holder take it back from a key that only claimed it", () => {
    const { w, a, b } = twoPeers();
    const mallory = w.join("mallory");
    // Mallory relays bob's curve and one of bob's one-time keys as its own.
    const otk = decodeOtk(b.keys.shift() ?? "");
    w.before = (d) =>
      d.verb === "keys" && d.from === "mallory"
        ? { ...d, payload: keysClaiming(mallory.account, b.account.curve25519_key(), otk) }
        : d;
    w.text(a, "mallory", "for mallory");
    expect(a.state.peers[mallory.account.ed25519_key()]?.curve25519).toBe(
      b.account.curve25519_key(),
    );
    w.before = (d) => d;

    // A KEYS from bob claims the same curve: refused while mallory holds it.
    w.text(a, "bob", "for bob");
    expect(drops(a)).toEqual(["curve-already-bound"]);

    // Bob writes first: his pre-key message proves the curve is his.
    w.text(b, "alice", "it is mine");

    expect(texts(a)).toEqual(["it is mine"]);
    expect(a.state.peers[b.account.ed25519_key()]).toMatchObject({
      curve25519: b.account.curve25519_key(),
      proven: true,
    });
    expect(a.state.peers[mallory.account.ed25519_key()]?.curve25519).toBeNull();
    // ...and mallory cannot claim it again.
    w.before = (d) =>
      d.verb === "keys" && d.from === "mallory"
        ? { ...d, payload: keysClaiming(mallory.account, b.account.curve25519_key(), otk) }
        : d;
    w.now += 30_000;
    w.text(a, "mallory", "again");
    expect(drops(a).at(-1)).toBe("curve-already-bound");
  });
});

describe("proofs", () => {
  it("keeps a curve's proof when a later session to it is opened from KEYS", () => {
    const { w, a, b } = twoPeers();
    const bCurve = b.account.curve25519_key();
    w.text(b, "alice", "hello");
    a.state.sessions = {};
    w.text(a, "bob", "a new session, from KEYS");
    expect(texts(b)).toEqual(["a new session, from KEYS"]);
    const mallory = w.join("mallory");
    // Mallory's pre-key message claims bob's curve, signed by mallory's key.
    w.before = (d) =>
      d.to === a && d.verb === "pkmsg"
        ? {
            ...d,
            payload: edited(d.payload, (json) => {
              json.id = {
                curve25519: bCurve,
                ed25519: mallory.account.ed25519_key(),
                sig: mallory.account.sign(`${ID_SIG_PREFIX}${bCurve}`),
              };
            }),
          }
        : d;

    w.text(mallory, "alice", "i am bob's curve");

    expect(drops(a)).toEqual(["curve-already-bound"]);
    expect(ofKind(a, "undecryptable")).toEqual([]);
    expect(a.state.peers[b.account.ed25519_key()]?.proven).toBe(true);
  });
});

describe("renamed peers", () => {
  it("reads a known key writing from a nick pinned to another key as itself, and moves no pin", () => {
    const { w, a, b } = twoPeers();
    const c = w.join("carol");
    w.text(a, "bob", "hello");
    w.text(a, "carol", "hello carol");
    // Bob opens a new session, from carol's nick.
    b.state.sessions = {};
    w.before = (d) => (d.to === a && d.verb === "pkmsg" ? { ...d, from: "carol" } : d);

    w.text(b, "alice", "from carol's nick");

    const last = ofKind(a, "received").at(-1);
    expect(last?.nick).toBe("carol");
    expect(last?.peer.ed25519).toBe(b.account.ed25519_key());
    expect(a.state.pins).toEqual({
      bob: b.account.ed25519_key(),
      carol: c.account.ed25519_key(),
    });
  });

  it("does not re-send to a nick now pinned to another key, and sends the old key's hint home", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    w.text(b, "alice", "hi");
    b.nick = "bobby";
    w.sides.set("bobby", b);
    w.text(b, "alice", "new nick");
    w.text(a, "bobby", "to bobby");
    const sent = w.wire.filter((d) => d.to === b && d.verb === "msg").at(-1);
    if (sent === undefined) throw new Error("no MSG");
    // Bob leaves; a new key takes the nick and writes first.
    const d = w.join("bobby");
    w.text(d, "alice", "i am bobby now");

    w.deliver({
      to: a,
      from: "bobby",
      verb: "nack",
      msgid: newMsgid(),
      payload: encodePayload({ v: 1, ref: sent.msgid }),
      priority: "control",
    });

    expect(failures(a)).toEqual([["repinned", ["to bobby"]]]);
    expect(a.state.pins.bobby).toBe(d.account.ed25519_key());
    expect(a.state.peers[b.account.ed25519_key()]?.nick).toBe("bob");
  });

  it("accepts a pinned key under a new nick, and the nick hint follows it", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    w.text(b, "alice", "hi");
    b.nick = "bobby";
    w.sides.set("bobby", b);

    w.text(b, "alice", "new nick");

    expect(texts(a)).toEqual(["hi", "new nick"]);
    expect(ofKind(a, "received").at(-1)?.nick).toBe("bobby");
    expect(w.engine(a).pinned("bobby")?.ed25519).toBe(b.account.ed25519_key());
    // The old nick stays pinned to the key.
    expect(w.engine(a).pinned("bob")?.ed25519).toBe(b.account.ed25519_key());
  });
});

describe("pins by hand", () => {
  it("verifies a key pinned before first contact, and the first contact goes to it", () => {
    const { w, a, b } = twoPeers();
    const key = b.account.ed25519_key();

    expect(w.engine(a).pin("bob", key, true)).toBe("pinned");
    expect(w.engine(a).pinned("bob")).toEqual({
      ed25519: key,
      curve25519: null,
      nick: "bob",
      proven: false,
      verified: true,
    });

    w.text(a, "bob", "hello");

    expect(texts(b)).toEqual(["hello"]);
    expect(w.engine(a).pinned("bob")).toEqual({
      ed25519: key,
      curve25519: b.account.curve25519_key(),
      nick: "bob",
      proven: false,
      verified: true,
    });
  });

  it("verifies the key trusted on first use, sessions kept", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    const sessions = a.state.sessions;

    expect(w.engine(a).pin("BOB", b.account.ed25519_key(), true)).toBe("pinned");

    expect(w.engine(a).pinned("bob")?.verified).toBe(true);
    expect(a.state.sessions).toEqual(sessions);
    w.text(a, "bob", "again");
    expect(texts(b)).toEqual(["hello", "again"]);
  });

  it("moves the nick to the key pinned by hand, and the new key is the one written to", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    // Bob's storage was wiped; he prints his new key and alice pastes it.
    const b2 = w.join("bob");
    w.now += REKEY_INTERVAL_MS;

    expect(w.engine(a).pin("bob", b2.account.ed25519_key(), true)).toBe("pinned");
    w.text(a, "bob", "welcome back");

    expect(texts(b2)).toEqual(["welcome back"]);
    expect(ofKind(a, "key_alarm")).toEqual([]);
    expect(a.state.pins.bob).toBe(b2.account.ed25519_key());
    // The old key is still a peer, no longer behind the nick.
    expect(a.state.peers[b.account.ed25519_key()]?.verified).toBe(false);
  });

  it("accepts a key unverified: the nick moves to it, and it is written to", () => {
    const { w, a } = twoPeers();
    w.text(a, "bob", "hello");
    // Bob's storage was wiped, and his new key raised the alarm: alice takes
    // it on its word (fork 7, 2430 comment 6339695571), to verify it by SAS.
    const b2 = w.join("bob");
    w.now += REKEY_INTERVAL_MS;

    expect(w.engine(a).pin("bob", b2.account.ed25519_key(), false)).toBe("pinned");
    w.text(a, "bob", "welcome back");

    expect(texts(b2)).toEqual(["welcome back"]);
    expect(w.engine(a).pinned("bob")).toEqual({
      ed25519: b2.account.ed25519_key(),
      curve25519: b2.account.curve25519_key(),
      nick: "bob",
      proven: false,
      verified: false,
    });
  });

  it("accepting by hand never takes a verification away", () => {
    const { w, a, b } = twoPeers();
    w.engine(a).pin("bob", b.account.ed25519_key(), true);

    w.engine(a).pin("bob", b.account.ed25519_key(), false);

    expect(w.engine(a).pinned("bob")?.verified).toBe(true);
  });

  it("verifies a key a SAS confirmed, and moves no pin", () => {
    const { w, a, b } = twoPeers();
    w.text(a, "bob", "hello");
    const pins = { ...a.state.pins };

    w.engine(a).verify(b.account.ed25519_key());
    w.engine(a).verify(a.account.ed25519_key());

    expect(w.engine(a).pinned("bob")?.verified).toBe(true);
    expect(a.state.pins).toEqual(pins);
    expect(Object.keys(a.state.peers)).toEqual([b.account.ed25519_key()]);
  });

  it("refuses what is not an Ed25519 key, and our own", () => {
    const { w, a } = twoPeers();
    const engine = w.engine(a);

    expect(engine.pin("bob", "not a key", true)).toBe("bad-key");
    expect(engine.pin("bob", `${"A".repeat(42)}`, true)).toBe("bad-key");
    expect(engine.pin("bob", KEY_OF_33_BYTES, true)).toBe("bad-key");
    expect(engine.pin("bob", a.account.ed25519_key(), true)).toBe("own-key");
    expect(a.state.pins).toEqual({});
  });
});

function decodeOtk(payload: string): string {
  return (decodePayload(payload).otk as { key: string }).key;
}

function sessionIdOf(pickle: string | undefined): string {
  const session = olm().Session.from_pickle(pickle ?? "");
  try {
    return session.session_id();
  } finally {
    session.free();
  }
}
