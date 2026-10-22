// issue 2430 — SAS between two people in cic, wire v2: the vodozemac
// binding's SAS, then the protocol between real cic devices on the fake
// grappa (`helpers/e2eGrappa.ts`). Each operation of a device is what
// `client.ts` runs under the slot's lock: an engine and a verifier over its
// state, and what they hand over through grappa's send door. Every step goes
// through Olm; a peer that misbehaves is played by sending its inner message
// by hand on its real session (`inject`).
import { describe, expect, it, vi } from "vitest";
import type { OwnIdentity } from "../lib/e2e/accountStore";
import type { ChatChange } from "../lib/e2e/chatStore";
import {
  type E2eEvent,
  type E2eState,
  Engine,
  LIST_TAG,
  newState,
  type Outbound,
  type Result,
} from "../lib/e2e/engine";
import {
  isSas,
  SAS_TIMEOUT_MS,
  type SasHost,
  type SasRecord,
  type SasStep,
  type SasView,
  Verifier,
} from "../lib/e2e/sas";
import type { Account } from "../lib/e2e/vodozemac/vodozemac_binding";
import { base64Unpadded, certSigText, did, fold } from "../lib/e2e/wire";
import {
  enlist,
  FRAME_BUDGET_BASE,
  signedList,
  throughDoor,
  uploadKeys,
} from "./helpers/e2eDevices";
import { Grappa } from "./helpers/e2eGrappa";
import { olm } from "./helpers/olm";

const NOW = 1_700_000_000_000;
const MAC_INFO = "irc-e2e:v1:sas-mac:";
const MMAC_INFO = "irc-e2e:v2:sas-mmac:";

/** The fake grappa, the clock every engine reads, and the pages alive. */
type World = { g: Grappa; now: number; pages: Set<string>; nextPage: number };

const world = (): World => ({ g: new Grappa(), now: NOW, pages: new Set(), nextPage: 1 });

/**
 * One cic device of a subject, as `identity.ts` leaves it: its account under
 * its master, its state, and the page of the tab it runs in. A tab of it
 * (`tab`) shares all of it but the page.
 */
type Cic = {
  nick: string;
  account: Account;
  master: Account;
  own: OwnIdentity;
  state: E2eState;
  host: SasHost;
  /** What its engine reported, in order. */
  events: E2eEvent[];
  /** What its verifier handed over: chat changes, and payloads. */
  changes: ChatChange[];
  sasOut: Outbound[];
};

function pageOf(w: World): SasHost {
  const page = `page-${w.nextPage++}`;
  w.pages.add(page);
  return { page, secrets: new Map(), alive: async () => new Set(w.pages) };
}

const keyOf = (c: Cic): string => c.account.ed25519_key();
const curveOf = (c: Cic): string => c.account.curve25519_key();

function cic(w: World, nick: string, master: Account, account: Account, certVer: number): Cic {
  const ed25519 = account.ed25519_key();
  return {
    nick,
    account,
    master,
    own: {
      master: master.ed25519_key(),
      cert: master.sign(certSigText(certVer, ed25519)),
      certVer,
      list: signedList(master, certVer, [account]),
      did: did(olm(), ed25519),
    },
    state: newState(),
    host: pageOf(w),
    events: [],
    changes: [],
    sasOut: [],
  };
}

/**
 * `all`, every device of one master, under the list `list` on grappa;
 * `fresh` upload their key bundle (`uploadKeys`).
 */
async function enrol(w: World, all: Cic[], fresh: Cic[], list: OwnIdentity["list"]): Promise<void> {
  const [first] = all;
  if (first === undefined) throw new Error("a subject with no device");
  await enlist(
    w.g,
    first.nick,
    first.master,
    all.map((c) => c.account),
    list,
  );
  for (const c of all) c.own.list = list;
  for (const c of fresh) await uploadKeys(w.g, c.nick, c.account);
}

/** A subject on `nick`: `count` devices under one new master, listed at version 1. */
async function subject(w: World, nick: string, count: number): Promise<Cic[]> {
  const master = new (olm().Account)();
  const accounts = Array.from({ length: count }, () => new (olm().Account)());
  const devices = accounts.map((account) => cic(w, nick, master, account, 1));
  await enrol(w, devices, devices, signedList(master, 1, accounts));
  return devices;
}

/** A new device of the subject `devices` make up, certified for the next list, which names them all. */
async function addDevice(w: World, devices: Cic[]): Promise<Cic> {
  const [first] = devices;
  if (first === undefined) throw new Error("a subject with no device");
  const ver = first.own.list.ver + 1;
  const added = cic(w, first.nick, first.master, new (olm().Account)(), ver);
  const all = [...devices, added];
  await enrol(
    w,
    all,
    [added],
    signedList(
      first.master,
      ver,
      all.map((c) => c.account),
    ),
  );
  return added;
}

/** Another tab of `c`'s cic: the same device and state, another page. */
const tab = (w: World, c: Cic): Cic => ({ ...c, host: pageOf(w) });

/** The tab goes away: its page, and the SAS secrets it held, with it. */
const close = (w: World, c: Cic): void => {
  w.pages.delete(c.host.page);
};

const engineOf = (w: World, c: Cic): Engine =>
  new Engine(olm(), c.account, c.own, c.state, c.nick, FRAME_BUDGET_BASE, () => w.now);

/** What an engine produced goes through `c`'s send door, each msgid back to the engine. */
async function toDoor(w: World, c: Cic, res: Result): Promise<void> {
  c.events.push(...res.events);
  await throughDoor(w.g, c.nick, c.own.did, res.outbound, (ref, msgid) =>
    engineOf(w, c).sent(ref, msgid),
  );
}

/**
 * One locked operation of `c`: an engine and a verifier over its state, then
 * what the verifier hands over, its chat changes kept and its payloads sent.
 */
async function op<T>(
  w: World,
  c: Cic,
  fn: (engine: Engine, verifier: Verifier) => T | Promise<T>,
): Promise<T> {
  const engine = engineOf(w, c);
  const verifier = new Verifier(olm(), engine, c.state, c.host, () => w.now);
  const answer = await fn(engine, verifier);
  const { changes, events, outbound } = verifier.take();
  c.changes.push(...changes);
  c.sasOut.push(...outbound);
  await toDoor(w, c, { events, outbound });
  return answer;
}

/** `c` takes what grappa holds for its device: each SAS step it reads goes to its verifier. */
async function drain(w: World, c: Cic): Promise<void> {
  const door = w.g.door(c.nick, c.own.did);
  const messages = await door.inbox(0);
  if (messages.length === 0) return;
  await door.ack(messages.map((m) => m.id));
  await op(w, c, async (engine, verifier) => {
    for (const m of messages) {
      const res = engine.receive(m.from, m.verb, m.msgid, m.fromDid, m.payload);
      await toDoor(w, c, res);
      for (const [i, e] of res.events.entries()) {
        if (e.kind === "received" && isSas(e.inner)) {
          await verifier.receive(e.nick, e.master, e.device, e.inner, `in:${m.id}:${i}`);
        }
      }
    }
  });
}

const tick = (w: World, c: Cic) =>
  op(w, c, async (engine, verifier) => {
    await toDoor(w, c, engine.tick());
    verifier.tick(await c.host.alive());
  });

const step = (w: World, c: Cic, nick: string, s: SasStep) =>
  op(w, c, (_engine, verifier) => verifier.step(nick, s));

const view = (w: World, c: Cic, nick: string): Promise<SasView | null> =>
  op(w, c, (_engine, verifier) => verifier.view(nick));

const verified = (w: World, c: Cic, nick: string) => engineOf(w, c).pinned(nick)?.verified;

/** `c` sends `inner` to `nick` on its session, outside anything its verifier would send. */
const inject = (
  w: World,
  c: Cic,
  nick: string,
  inner: Record<string, unknown>,
  only: string | null,
): Promise<void> => toDoor(w, c, engineOf(w, c).send(nick, inner, "injected", null, only));

/** `c` says `body` to `nick`, and takes the KEYS a KEYREQ brings. */
async function say(w: World, c: Cic, nick: string, body: string): Promise<void> {
  await toDoor(w, c, engineOf(w, c).send(nick, { t: "text", body }, body, null, null));
  await drain(w, c);
}

/**
 * A message from `a` to the subject `bs` are, which every device of it
 * reads, and an answer from its first device: each holds sessions with the
 * other, its master pinned and its list.
 */
async function chat(w: World, a: Cic, bs: Cic[]): Promise<void> {
  const [b] = bs;
  if (b === undefined) throw new Error("a subject with no device");
  await say(w, a, b.nick, "hello");
  for (const c of bs) await drain(w, c);
  await say(w, b, a.nick, "hi");
  await drain(w, a);
  for (const c of bs) await drain(w, c);
}

/** alice and Bob, one device each, who wrote to each other. */
async function pair(): Promise<{ w: World; a: Cic; b: Cic }> {
  const w = world();
  const [a] = await subject(w, "alice", 1);
  const [b] = await subject(w, "Bob", 1);
  if (a === undefined || b === undefined) throw new Error("no device");
  await chat(w, a, [b]);
  return { w, a, b };
}

/** alice asks, Bob accepts, and the keys go both ways: both compare. */
async function toCompare(w: World, a: Cic, b: Cic): Promise<void> {
  await step(w, a, "bob", "start");
  await drain(w, b);
  await step(w, b, "alice", "accept");
  await drain(w, a);
  await drain(w, b);
  await drain(w, a);
}

/** The SAS rows `c` wrote in its chat with `nick`, as [kind, by, reason] ([kind, key] once verified). */
const sasRows = (c: Cic, nick: string) =>
  c.changes.flatMap((change) => {
    if (change.op !== "add" || fold(change.nick) !== fold(nick)) return [];
    const r = change.row;
    switch (r.kind) {
      case "sas_asked":
        return [[r.kind, r.by]];
      case "sas_cancelled":
        return [[r.kind, r.by, r.reason]];
      case "verified":
        return [[r.kind, r.ed25519]];
      default:
        return [];
    }
  });

/** The SAS steps `c` read, in order. */
const stepsRead = (c: Cic) =>
  c.events.flatMap((e) => (e.kind === "received" && isSas(e.inner) ? [e.inner.t] : []));

/** What `fn` logged at debug level (a step ignored), kept off the test's output. */
async function debugged(fn: () => Promise<void>): Promise<string[]> {
  const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
  try {
    await fn();
    return debug.mock.calls.map((call) => String(call[0]));
  } finally {
    debug.mockRestore();
  }
}

const failedOf = (c: Cic) =>
  c.events.flatMap((e) => (e.kind === "send_failed" ? [[e.reason, e.tags]] : []));

/** The secret `c`'s page holds for its SAS with `peer`, worked out (its emoji shown). */
async function secretOf(w: World, c: Cic, nick: string, peer: Cic) {
  await view(w, c, nick);
  const rec = c.state.sas[peer.own.master];
  const secret = c.host.secrets.get(rec?.ourKey ?? "");
  if (rec === undefined || !(secret instanceof olm().EstablishedSas)) {
    throw new Error("no secret on that page");
  }
  return { rec, secret };
}

/** A list version past `peer`'s, applied on `c`'s engine as a KEYS or a `t:list` applies it. */
type ListSteps = { applyList(master: string, list: { ver: number; devices: string[] }): void };
const lists = (engine: Engine): ListSteps => engine as unknown as ListSteps;

describe("the binding's SAS", () => {
  it("gives both ends the same 7 emoji and the same MACs, from each other's public half", () => {
    const { Sas } = olm();
    const alice = new Sas();
    const bob = new Sas();
    const aliceKey = alice.public_key();
    const bobKey = bob.public_key();

    const a = alice.diffie_hellman(bobKey);
    const b = bob.diffie_hellman(aliceKey);

    const emoji = [...a.emoji_indices("info")];
    expect(emoji).toHaveLength(7);
    expect(emoji.every((i) => i >= 0 && i < 64)).toBe(true);
    expect([...b.emoji_indices("info")]).toEqual(emoji);
    expect([...b.emoji_indices("other info")]).not.toEqual(emoji);
    expect(b.calculate_mac("input", "info")).toBe(a.calculate_mac("input", "info"));
    expect(b.calculate_mac("input", "info")).toMatch(/^[A-Za-z0-9+/]{43}$/);
    a.free();
    b.free();
  });

  it("refuses what is not a Curve25519 key, and a SAS is used up by its exchange", () => {
    const { Sas } = olm();
    expect(() => new Sas().diffie_hellman("not a key")).toThrow();
    const sas = new Sas();
    sas.diffie_hellman(new Sas().public_key()).free();
    expect(() => sas.diffie_hellman(new Sas().public_key())).toThrow();
  });
});

describe("SAS between two people, one device each", () => {
  it("both see the same 7 emoji, and a match on both sides verifies each one's master on the other", async () => {
    const { w, a, b } = await pair();

    await step(w, a, "bob", "start");
    expect(await view(w, a, "bob")).toEqual({
      role: "a",
      phase: "started",
      confirmed: false,
      here: true,
      emoji: null,
    });

    await drain(w, b);
    expect(await view(w, b, "alice")).toEqual({
      role: "b",
      phase: "asked",
      confirmed: false,
      here: false,
      emoji: null,
    });
    expect(b.changes.filter((c) => c.op === "add" && c.unread)).toHaveLength(1);

    await step(w, b, "alice", "accept");
    await drain(w, a);
    await drain(w, b);
    await drain(w, a);

    const seenByAlice = await view(w, a, "bob");
    const seenByBob = await view(w, b, "alice");
    expect(seenByAlice).toEqual(expect.objectContaining({ phase: "compare", here: true }));
    expect(seenByAlice?.emoji).toHaveLength(7);
    expect(seenByBob?.emoji).toEqual(seenByAlice?.emoji);

    await step(w, a, "bob", "match");
    await drain(w, b);
    // alice's MACs are in, but Bob's own human has not confirmed yet.
    expect(verified(w, b, "alice")).toBe(false);
    expect(await view(w, b, "alice")).toEqual(
      expect.objectContaining({ phase: "compare", confirmed: false }),
    );
    expect(await view(w, a, "bob")).toEqual(
      expect.objectContaining({ phase: "compare", confirmed: true, emoji: null }),
    );

    await step(w, b, "alice", "match");
    expect(verified(w, b, "alice")).toBe(true);
    await drain(w, a);
    expect(verified(w, a, "bob")).toBe(true);

    expect(await view(w, a, "bob")).toBeNull();
    expect(await view(w, b, "alice")).toBeNull();
    expect(a.host.secrets.size).toBe(0);
    expect(b.host.secrets.size).toBe(0);
    // The master is what is verified: the row names it.
    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["verified", b.own.master],
    ]);
    expect(sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["verified", a.own.master],
    ]);
    expect(stepsRead(a)).toEqual(["sas.accept", "sas.key", "sas.mac"]);
    expect(stepsRead(b)).toEqual(["sas.start", "sas.key", "sas.mac"]);
    expect(failedOf(a)).toEqual([]);
    expect(failedOf(b)).toEqual([]);
  });

  it("hands the caller the list ask the engine makes once the SAS verifies the master", async () => {
    const { w, a, b } = await pair();
    await toCompare(w, a, b);
    await step(w, a, "bob", "match");
    await drain(w, b);
    await step(w, b, "alice", "match");
    expect(a.sasOut.filter((o) => o.tag === LIST_TAG)).toEqual([]);

    // Bob's MACs: alice verifies Bob's master, and asks Bob for its list (O1).
    await drain(w, a);

    expect(verified(w, a, "bob")).toBe(true);
    expect(
      a.sasOut.filter((o) => o.tag === LIST_TAG).map((o) => [o.verb, o.to, o.priority]),
    ).toEqual([["msg", b.own.did, "reactive"]]);
    // Bob asked alice for her list a moment ago, on her first message: his
    // ask waits out the minute in the engine.
    expect(b.state.listreqHeld).toEqual({ alice: "alice" });
  });

  it("a wrong mmac fails the SAS: mac-mismatch on both sides, and nobody is verified", async () => {
    const { w, a, b } = await pair();
    await toCompare(w, a, b);
    const { rec, secret } = await secretOf(w, b, "alice", a);
    const mac = secret.calculate_mac(keyOf(b), `${MAC_INFO}${curveOf(b)}|${curveOf(a)}|${rec.tx}`);

    await inject(w, b, "alice", { t: "sas.mac", tx: rec.tx, mac, mmac: "A".repeat(43) }, keyOf(a));
    await drain(w, a);
    expect(verified(w, a, "bob")).toBe(false);
    await step(w, a, "bob", "match");
    await drain(w, b);

    expect(verified(w, a, "bob")).toBe(false);
    expect(verified(w, b, "alice")).toBe(false);
    expect(a.events.filter((e) => e.kind === "key_alarm")).toEqual([]);
    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "mac-mismatch"],
    ]);
    expect(sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["sas_cancelled", "peer", "mac-mismatch"],
    ]);
  });

  it("a wrong mac fails the SAS though the mmac is right: mac-mismatch", async () => {
    const { w, a, b } = await pair();
    await toCompare(w, a, b);
    const { rec, secret } = await secretOf(w, b, "alice", a);
    const mmac = secret.calculate_mac(
      b.own.master,
      `${MMAC_INFO}${curveOf(b)}|${curveOf(a)}|${rec.tx}`,
    );

    await inject(w, b, "alice", { t: "sas.mac", tx: rec.tx, mac: "A".repeat(43), mmac }, keyOf(a));
    await drain(w, a);
    await step(w, a, "bob", "match");

    expect(verified(w, a, "bob")).toBe(false);
    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "mac-mismatch"],
    ]);
  });

  it("derives the emoji and both MACs from the bytes the wire names: mac over the device, mmac over the master", async () => {
    const { w, a, b } = await pair();
    await toCompare(w, a, b);
    const ours = a.state.sas[b.own.master] as SasRecord;
    const theirs = b.state.sas[a.own.master] as SasRecord;
    const emoji = (await view(w, a, "bob"))?.emoji;
    const { secret } = await secretOf(w, a, "bob", b);

    // A (alice) first: her device's curve and SAS key, then Bob's, then the tx.
    const info = `irc-e2e:v1:sas:${curveOf(a)}|${ours.ourKey}|${curveOf(b)}|${theirs.ourKey}|${ours.tx}`;
    expect([...secret.emoji_indices(info)]).toEqual(emoji);
    // Each side's MACs: `mac` over its device key, `mmac` over its master,
    // both binding its curve first. Worked out before the match uses the
    // secret up.
    const bobs = `${curveOf(b)}|${curveOf(a)}|${ours.tx}`;
    const alices = `${curveOf(a)}|${curveOf(b)}|${ours.tx}`;
    const expected = {
      expected: secret.calculate_mac(keyOf(b), `irc-e2e:v1:sas-mac:${bobs}`),
      expectedMmac: secret.calculate_mac(b.own.master, `irc-e2e:v2:sas-mmac:${bobs}`),
    };
    const mac = {
      t: "sas.mac",
      tx: ours.tx,
      mac: secret.calculate_mac(keyOf(a), `irc-e2e:v1:sas-mac:${alices}`),
      mmac: secret.calculate_mac(a.own.master, `irc-e2e:v2:sas-mmac:${alices}`),
    };

    await step(w, a, "bob", "match");
    expect(a.state.sas[b.own.master]).toEqual(expect.objectContaining(expected));
    await drain(w, b);
    expect(
      b.events.flatMap((e) => (e.kind === "received" && e.inner.t === "sas.mac" ? [e.inner] : [])),
    ).toEqual([mac]);
  });

  it("a mismatch on either side cancels it on both, and verifies nobody", async () => {
    const { w, a, b } = await pair();
    await toCompare(w, a, b);

    await step(w, b, "alice", "mismatch");
    await drain(w, a);

    expect(await view(w, a, "bob")).toBeNull();
    expect(await view(w, b, "alice")).toBeNull();
    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "peer", "mismatch"],
    ]);
    expect(sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["sas_cancelled", "you", "mismatch"],
    ]);
    expect(verified(w, a, "bob")).toBe(false);
    expect(verified(w, b, "alice")).toBe(false);
  });

  it("declining the request cancels it on the side that asked", async () => {
    const { w, a, b } = await pair();
    await step(w, a, "bob", "start");
    await drain(w, b);

    await step(w, b, "alice", "cancel");
    await drain(w, a);

    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "peer", "user"],
    ]);
    expect(await view(w, a, "bob")).toBeNull();
  });

  it("a key that is not the one committed to cancels it: commitment-mismatch", async () => {
    const { w, a, b } = await pair();
    await step(w, a, "bob", "start");
    await drain(w, b);
    await step(w, b, "alice", "accept");
    await drain(w, a);
    const { tx } = a.state.sas[b.own.master] as SasRecord;

    await inject(
      w,
      b,
      "alice",
      { t: "sas.key", tx, key: new (olm().Sas)().public_key() },
      keyOf(a),
    );
    await drain(w, a);

    expect(await view(w, a, "bob")).toBeNull();
    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "commitment-mismatch"],
    ]);
  });

  it("a step out of order cancels it: unexpected-message", async () => {
    const { w, a, b } = await pair();
    await step(w, a, "bob", "start");
    const { tx } = a.state.sas[b.own.master] as SasRecord;

    await inject(
      w,
      b,
      "alice",
      { t: "sas.mac", tx, mac: "A".repeat(43), mmac: "A".repeat(43) },
      null,
    );
    await drain(w, a);

    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "unexpected-message"],
    ]);
  });

  it("a second MAC for the same SAS is out of order: unexpected-message", async () => {
    const { w, a, b } = await pair();
    await toCompare(w, a, b);
    await step(w, a, "bob", "match");
    await drain(w, b);
    const { tx } = b.state.sas[a.own.master] as SasRecord;

    await inject(
      w,
      a,
      "Bob",
      { t: "sas.mac", tx, mac: "A".repeat(43), mmac: "A".repeat(43) },
      null,
    );
    await drain(w, b);

    expect(await view(w, b, "alice")).toBeNull();
    expect(sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["sas_cancelled", "you", "unexpected-message"],
    ]);
    expect(verified(w, b, "alice")).toBe(false);
  });

  it("an accept once the keys are on their way is out of order", async () => {
    const { w, a, b } = await pair();
    await step(w, a, "bob", "start");
    await drain(w, b);
    await step(w, b, "alice", "accept");
    await drain(w, a);
    const { tx } = a.state.sas[b.own.master] as SasRecord;

    await inject(w, b, "alice", { t: "sas.accept", tx, commitment: "A".repeat(43) }, null);
    await drain(w, a);

    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "unexpected-message"],
    ]);
  });

  it("a new start from the peer replaces the SAS that ran with its master, and its secret", async () => {
    const { w, a, b } = await pair();
    await step(w, a, "bob", "start");
    await drain(w, b);
    await step(w, b, "alice", "accept");
    expect(b.host.secrets.size).toBe(1);

    await inject(w, a, "Bob", { t: "sas.start", tx: "BBBBBBBBBBB" }, null);
    await drain(w, b);

    expect(b.state.sas[a.own.master]).toEqual(
      expect.objectContaining({
        tx: "BBBBBBBBBBB",
        phase: "asked",
        device: keyOf(a),
        page: null,
        ourKey: null,
      }),
    );
    expect(b.host.secrets.size).toBe(0);
    expect(sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["sas_asked", "peer"],
    ]);
  });

  it("a start repeated changes nothing", async () => {
    const { w, a, b } = await pair();
    await step(w, b, "alice", "start");
    await drain(w, a);
    const asked = { ...(a.state.sas[b.own.master] as SasRecord) };

    await inject(w, b, "alice", { t: "sas.start", tx: asked.tx }, null);
    await drain(w, a);

    expect(a.state.sas[b.own.master]).toEqual(asked);
    expect(sasRows(a, "bob")).toEqual([["sas_asked", "peer"]]);
  });

  it("ignores a step for another tx, and a step that does not parse", async () => {
    const { w, a, b } = await pair();
    await step(w, a, "bob", "start");
    const before = { ...(a.state.sas[b.own.master] as SasRecord) };
    const other = before.tx.startsWith("A") ? `B${before.tx.slice(1)}` : `A${before.tx.slice(1)}`;

    await inject(w, b, "alice", { t: "sas.accept", tx: other, commitment: "A".repeat(43) }, null);
    await inject(w, b, "alice", { t: "sas.accept", tx: before.tx, commitment: "short" }, null);
    await inject(w, b, "alice", { t: "sas.accept", tx: "short", commitment: "A".repeat(43) }, null);
    await inject(w, b, "alice", { t: "sas.mac", tx: before.tx, mac: "A".repeat(43) }, null);
    await inject(w, b, "alice", { t: "sas.start", tx: "short" }, null);
    expect(await debugged(() => drain(w, a))).toEqual([
      "[e2e] ignored a sas.accept from Bob for no SAS of ours",
      "[e2e] ignored a malformed sas.accept from Bob",
      "[e2e] ignored a malformed sas.accept from Bob",
      "[e2e] ignored a malformed sas.mac from Bob",
      "[e2e] ignored a malformed sas.start from Bob",
    ]);

    expect(a.state.sas[b.own.master]).toEqual(before);
    expect(sasRows(a, "bob")).toEqual([["sas_asked", "you"]]);
  });

  it("ignores a step from another master for the tx of a SAS with this one", async () => {
    const { w, a, b } = await pair();
    const [carol] = await subject(w, "carol", 1);
    if (carol === undefined) throw new Error("no device");
    await chat(w, a, [carol]);
    await step(w, a, "bob", "start");
    const before = { ...(a.state.sas[b.own.master] as SasRecord) };

    await inject(
      w,
      carol,
      "alice",
      { t: "sas.accept", tx: before.tx, commitment: "A".repeat(43) },
      null,
    );
    expect(await debugged(() => drain(w, a))).toEqual([
      "[e2e] ignored a sas.accept from carol for no SAS of ours",
    ]);

    expect(a.state.sas[b.own.master]).toEqual(before);
    expect(a.state.sas[carol.own.master]).toBeUndefined();
    expect(sasRows(a, "carol")).toEqual([]);
  });

  it("commits to B's key as w2's encoding says: sha256 of key|tx, unpadded base64", async () => {
    const { w, a, b } = await pair();
    await step(w, a, "bob", "start");
    await drain(w, b);
    await step(w, b, "alice", "accept");
    await drain(w, a);

    const theirs = b.state.sas[a.own.master] as SasRecord;
    const ours = a.state.sas[b.own.master] as SasRecord;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${theirs.ourKey}|${theirs.tx}`),
    );
    expect(ours.commitment).toBe(base64Unpadded(new Uint8Array(digest)));
  });

  it("a SAS key that makes no secret ends it: bad-key", async () => {
    const { w, a, b } = await pair();
    await step(w, b, "alice", "start");
    await drain(w, a);
    await step(w, a, "bob", "accept");
    const { tx } = a.state.sas[b.own.master] as SasRecord;

    // 32 zero bytes: a point every exchange with gives the same, zero, secret.
    await inject(w, b, "alice", { t: "sas.key", tx, key: "A".repeat(43) }, keyOf(a));
    await drain(w, a);

    // Only looking at the window ends it: the verifier is not idle, its
    // cancel is for the caller to send.
    expect(await op(w, a, (_engine, verifier) => verifier.idle())).toBe(true);
    expect(await op(w, a, (_engine, verifier) => [verifier.view("bob"), verifier.idle()])).toEqual([
      null,
      false,
    ]);
    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "peer"],
      ["sas_cancelled", "you", "bad-key"],
    ]);
    await drain(w, b);
    expect(sasRows(b, "alice")).toContainEqual(["sas_cancelled", "peer", "bad-key"]);
  });

  it("a peer device its master no longer vouches for ends the SAS: bad-key, and the engine's word on the cancel that cannot reach it goes to the caller", async () => {
    const { w, a, b } = await pair();
    await toCompare(w, a, b);
    // A newer list of Bob's master that leaves his device out: it is revoked.
    lists(engineOf(w, a)).applyList(b.own.master, {
      ver: 2,
      devices: [new (olm().Account)().ed25519_key()],
    });

    expect(await view(w, a, "bob")).toBeNull();

    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "bad-key"],
    ]);
    expect(failedOf(a)).toEqual([["unpinned-key", ["sas"]]]);
    expect(a.sasOut.filter((o) => o.to === b.own.did)).toHaveLength(2);
  });

  it("both asking at once: the smaller tx wins on both sides, and the comparison goes on", async () => {
    const { w, a, b } = await pair();

    await step(w, a, "bob", "start");
    await step(w, b, "alice", "start");
    const aliceTx = a.state.sas[b.own.master]?.tx as string;
    const bobTx = b.state.sas[a.own.master]?.tx as string;
    for (let i = 0; i < 3; i++) {
      await drain(w, a);
      await drain(w, b);
    }

    const smaller = aliceTx < bobTx ? aliceTx : bobTx;
    expect(a.state.sas[b.own.master]?.tx).toBe(smaller);
    expect(b.state.sas[a.own.master]?.tx).toBe(smaller);
    expect(a.state.sas[b.own.master]?.device).toBe(keyOf(b));
    expect(b.state.sas[a.own.master]?.device).toBe(keyOf(a));
    const seenByAlice = await view(w, a, "bob");
    const seenByBob = await view(w, b, "alice");
    expect(seenByAlice?.phase).toBe("compare");
    expect(seenByBob?.phase).toBe("compare");
    // Whose start lost is B for the winner.
    expect(seenByAlice?.role).toBe(aliceTx === smaller ? "a" : "b");
    expect(seenByBob?.role).toBe(bobTx === smaller ? "a" : "b");
    expect(seenByBob?.emoji).toHaveLength(7);
    expect(seenByBob?.emoji).toEqual(seenByAlice?.emoji);
  });

  it("times out after 10 minutes on a tick, and the peer is told", async () => {
    const { w, a, b } = await pair();
    await step(w, a, "bob", "start");

    w.now += SAS_TIMEOUT_MS - 1;
    await tick(w, a);
    expect(await view(w, a, "bob")).not.toBeNull();
    w.now += 1;
    await tick(w, a);
    await drain(w, b);

    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "timeout"],
    ]);
    expect(sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["sas_cancelled", "peer", "timeout"],
    ]);
  });

  it("offers nothing to a nick with no master, and starts one SAS per master", async () => {
    const { w, a, b } = await pair();

    await step(w, a, "nobody", "start");
    await step(w, a, "bob", "start");
    const first = { ...(a.state.sas[b.own.master] as SasRecord) };
    await step(w, a, "bob", "start");

    expect(await view(w, a, "nobody")).toBeNull();
    expect(Object.keys(a.state.sas)).toEqual([b.own.master]);
    expect(a.state.sas[b.own.master]).toEqual(first);
    expect(a.sasOut).toHaveLength(1);
    expect(w.g.sends.filter((s) => s.by === "alice" && s.target === "nobody")).toEqual([]);
  });

  it("a re-pin of the nick to another master ends it: key-changed, and nothing goes on the wire", async () => {
    const { w, a, b } = await pair();
    const [carol] = await subject(w, "carol", 1);
    if (carol === undefined) throw new Error("no device");
    await step(w, a, "bob", "start");
    const sent = a.sasOut.length;

    // Taking the master it runs with again, or pinning another nick, ends nothing.
    await op(w, a, async (engine, verifier) => {
      await toDoor(w, a, engine.pin("bob", b.own.master, true));
      verifier.repinned("bob");
      await toDoor(w, a, engine.pin("carol", carol.own.master, false));
      verifier.repinned("carol");
    });
    expect(a.state.sas[b.own.master]).toEqual(expect.objectContaining({ phase: "started" }));
    expect(a.host.secrets.size).toBe(1);

    await op(w, a, async (engine, verifier) => {
      await toDoor(w, a, engine.pin("bob", carol.own.master, true));
      verifier.repinned("bob");
    });

    expect(a.state.sas[b.own.master]).toBeUndefined();
    expect(a.host.secrets.size).toBe(0);
    expect(a.sasOut).toHaveLength(sent);
    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "key-changed"],
    ]);
  });
});

describe("SAS with a peer of several devices", () => {
  /** alice, one device, and Bob, two under one master, who wrote to each other. */
  async function trio(): Promise<{ w: World; a: Cic; b1: Cic; b2: Cic }> {
    const w = world();
    const [a] = await subject(w, "alice", 1);
    const [b1, b2] = await subject(w, "bob", 2);
    if (a === undefined || b1 === undefined || b2 === undefined) throw new Error("no device");
    await chat(w, a, [b1, b2]);
    return { w, a, b1, b2 };
  }

  it("asks every device; the first to accept is the one it runs with, an accept from another device of the master is ignored, and the master is verified", async () => {
    const { w, a, b1, b2 } = await trio();
    await step(w, a, "bob", "start");
    expect(a.sasOut.map((o) => o.to)).toEqual(["*"]);
    await drain(w, b1);
    await drain(w, b2);
    expect(b1.state.sas[a.own.master]?.phase).toBe("asked");
    expect(b2.state.sas[a.own.master]?.phase).toBe("asked");

    await step(w, b1, "alice", "accept");
    await drain(w, a);
    const fixed = { ...(a.state.sas[b1.own.master] as SasRecord) };
    expect(fixed).toEqual(expect.objectContaining({ device: keyOf(b1), phase: "keyed" }));
    const sent = a.sasOut.length;

    await step(w, b2, "alice", "accept");
    // A debug line, no alarm: the same person, on another of its devices.
    expect(await debugged(() => drain(w, a))).toEqual([
      "[e2e] ignored a sas.accept from a device of bob the SAS does not run with",
    ]);

    expect(a.state.sas[b1.own.master]).toEqual(fixed);
    expect(a.sasOut).toHaveLength(sent);
    expect(sasRows(a, "bob")).toEqual([["sas_asked", "you"]]);

    // It goes on with b1 alone.
    await drain(w, b1);
    await drain(w, a);
    await view(w, a, "bob");
    await view(w, b1, "alice");
    await step(w, a, "bob", "match");
    await drain(w, b1);
    await step(w, b1, "alice", "match");
    await drain(w, a);

    expect(verified(w, a, "bob")).toBe(true);
    expect(engineOf(w, a).pinned("bob")).toEqual({
      master: b1.own.master,
      verified: true,
      devices: 2,
    });
    expect(verified(w, b1, "alice")).toBe(true);
    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "you"],
      ["verified", b1.own.master],
    ]);
    // Every step after the start went to b1's device; b2 read the start alone.
    expect(
      a.sasOut
        .slice(1)
        .filter((o) => o.tag !== LIST_TAG)
        .map((o) => o.to),
    ).toEqual([b1.own.did, b1.own.did]);
    await drain(w, b2);
    expect(stepsRead(b2)).toEqual(["sas.start"]);
    expect(failedOf(a)).toEqual([]);
  });

  it("ignores every step of its tx from another device of the master: a start, a key, a cancel", async () => {
    const { w, a, b1, b2 } = await trio();
    await step(w, b1, "alice", "start");
    await drain(w, a);
    const asked = { ...(a.state.sas[b1.own.master] as SasRecord) };
    expect(asked.device).toBe(keyOf(b1));
    const { tx } = asked;

    await inject(w, b2, "alice", { t: "sas.start", tx }, null);
    await inject(w, b2, "alice", { t: "sas.key", tx, key: new (olm().Sas)().public_key() }, null);
    await inject(w, b2, "alice", { t: "sas.cancel", tx, reason: "user" }, null);
    expect(await debugged(() => drain(w, a))).toEqual([
      "[e2e] ignored a sas.key from a device of bob the SAS does not run with",
      "[e2e] ignored a sas.cancel from a device of bob the SAS does not run with",
    ]);

    expect(a.state.sas[b1.own.master]).toEqual(asked);
    expect(sasRows(a, "bob")).toEqual([["sas_asked", "peer"]]);
    expect(a.sasOut).toEqual([]);
  });

  it("a cancel before any device accepted goes to every device it asked", async () => {
    const { w, a, b1, b2 } = await trio();
    await step(w, a, "bob", "start");
    await drain(w, b1);
    await drain(w, b2);

    await step(w, a, "bob", "cancel");
    await drain(w, b1);
    await drain(w, b2);

    expect(a.sasOut.map((o) => o.to)).toEqual(["*", "*"]);
    for (const b of [b1, b2]) {
      expect(sasRows(b, "alice")).toEqual([
        ["sas_asked", "peer"],
        ["sas_cancelled", "peer", "user"],
      ]);
    }
  });

  it("both asking at once: the side whose start lost answers the device whose start won, alone", async () => {
    const { w, a, b1 } = await trio();
    await step(w, a, "bob", "start");
    // b1's start, under the smallest tx there is: it wins over alice's.
    await inject(w, b1, "alice", { t: "sas.start", tx: "+++++++++++" }, null);

    await drain(w, a);

    expect(a.state.sas[b1.own.master]).toEqual(
      expect.objectContaining({ tx: "+++++++++++", role: "b", device: keyOf(b1) }),
    );
    expect(a.sasOut.map((o) => o.to)).toEqual(["*", b1.own.did]);
  });

  it("runs with a device its master's certificate admits before any list names it", async () => {
    const w = world();
    const [a] = await subject(w, "alice", 1);
    const [b1] = await subject(w, "bob", 1);
    if (a === undefined || b1 === undefined) throw new Error("no device");
    await chat(w, a, [b1]);
    // Bob adds a device: grappa has the list naming it, alice the older one.
    const b2 = await addDevice(w, [b1]);
    await say(w, b2, "alice", "a new device");
    await drain(w, a);
    await step(w, b2, "alice", "start");
    await drain(w, a);
    expect(a.state.masters[b2.own.master]?.devices).toEqual([keyOf(b1)]);
    expect(a.state.sas[b2.own.master]?.device).toBe(keyOf(b2));

    await step(w, a, "bob", "accept");

    expect(a.state.masters[b2.own.master]?.devices).toEqual([keyOf(b1)]);
    expect(a.sasOut.map((o) => [o.verb, o.to, o.tag])).toEqual([["msg", b2.own.did, "sas"]]);
    expect(failedOf(a)).toEqual([]);

    // The list comes (b2 answers alice's listreq), and the SAS ends verified.
    await drain(w, b2);
    await drain(w, a);
    await drain(w, b2);
    await view(w, a, "bob");
    await view(w, b2, "alice");
    await step(w, a, "bob", "match");
    await drain(w, b2);
    await step(w, b2, "alice", "match");
    await drain(w, a);

    expect(verified(w, a, "bob")).toBe(true);
    expect(verified(w, b2, "alice")).toBe(true);
    expect(sasRows(a, "bob")).toEqual([
      ["sas_asked", "peer"],
      ["verified", b2.own.master],
    ]);
  });
});

describe("SAS across the tabs of one device", () => {
  it("a request not yet accepted is no page's: no page going away cancels it", async () => {
    const { w, a, b } = await pair();
    await step(w, a, "bob", "start");
    await drain(w, b);

    close(w, b);
    await tick(w, b);

    expect(await view(w, b, "alice")).toEqual(expect.objectContaining({ phase: "asked" }));
  });

  it("an accept from a second tab, once the first accepted, changes nothing", async () => {
    const { w, a, b } = await pair();
    await step(w, a, "bob", "start");
    await drain(w, b);
    await step(w, b, "alice", "accept");
    const accepted = { ...(b.state.sas[a.own.master] as SasRecord) };
    const sends = w.g.sends.length;

    await step(w, tab(w, b), "alice", "accept");

    expect(b.state.sas[a.own.master]).toEqual(accepted);
    expect(w.g.sends).toHaveLength(sends);
  });

  it("another tab cancels a SAS whose page went away before it was confirmed", async () => {
    const { w, a, b } = await pair();
    const other = tab(w, a);
    await step(w, a, "bob", "start");

    await tick(w, other);
    expect(await view(w, other, "bob")).toEqual(expect.objectContaining({ here: false }));
    close(w, a);
    await tick(w, other);
    await drain(w, b);

    expect(await view(w, other, "bob")).toBeNull();
    expect(sasRows(other, "bob")).toEqual([
      ["sas_asked", "you"],
      ["sas_cancelled", "you", "page-gone"],
    ]);
    expect(sasRows(b, "alice")).toEqual([
      ["sas_asked", "peer"],
      ["sas_cancelled", "peer", "page-gone"],
    ]);
  });

  it("a SAS that ends in another tab takes its secret out of the page that held it", async () => {
    const { w, a, b } = await pair();
    const other = tab(w, a);
    await step(w, a, "bob", "start");
    expect(a.host.secrets.size).toBe(1);
    await drain(w, b);
    await step(w, b, "alice", "cancel");

    await drain(w, other);
    expect(await view(w, other, "bob")).toBeNull();
    expect(a.host.secrets.size).toBe(1);
    await view(w, a, "bob");

    expect(a.host.secrets.size).toBe(0);
  });

  it("another tab drains the steps; only the page that started it shows the emoji, and any tab finishes it", async () => {
    const { w, a, b } = await pair();
    const other = tab(w, a);
    await step(w, a, "bob", "start");
    await drain(w, b);
    await step(w, b, "alice", "accept");
    await drain(w, other);
    await drain(w, b);
    await drain(w, other);

    expect(await view(w, other, "bob")).toEqual(
      expect.objectContaining({ phase: "compare", here: false, emoji: null }),
    );
    // The page that holds the secret works the emoji out as it shows them.
    const emoji = (await view(w, a, "bob"))?.emoji;
    expect(emoji).toHaveLength(7);
    expect((await view(w, b, "alice"))?.emoji).toEqual(emoji);

    await step(w, a, "bob", "match");
    // Confirmed: the page that held the secret may go, the SAS goes on.
    close(w, a);
    await tick(w, other);
    await step(w, b, "alice", "match");
    await drain(w, other);

    expect(verified(w, other, "bob")).toBe(true);
    expect(sasRows(other, "bob")).toEqual([
      ["sas_asked", "you"],
      ["verified", b.own.master],
    ]);
  });
});
