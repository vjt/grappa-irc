// issue 2430 — a QR pairing from the QR to "done" (X1-crypto): the two roles
// of `pairingSession.ts`, wired to each other through an in-memory relay (a
// side's `send` reaches the other's `onPayload`, a close the other's
// `onClosed`), over the fake grappa (one per network) and two browsers of one
// subject. The ECIES channel, the signatures and the account stores are the
// real ones. Where a test needs a side that misbehaves, it plays that side by
// hand over a real ECIES channel.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountStore } from "../lib/e2e/accountStore";
import { idBlock } from "../lib/e2e/keyBundle";
import type { CloseReason, PairingChannel } from "../lib/e2e/pairing";
import {
  decodePairMessage,
  encodePairMessage,
  PAIRING_INFO,
  type PairMessage,
  unwrapInitial,
  wrapInitial,
} from "../lib/e2e/pairingMessages";
import type { EstablishedEcies } from "../lib/e2e/vodozemac/vodozemac_binding";
import { type IdBlock, listSigText } from "../lib/e2e/wire";
import { Grappa, routeApi } from "./helpers/e2eGrappa";
import { type MemoryVault, memoryLock, memoryVault } from "./helpers/e2eVault";
import { olm } from "./helpers/olm";

vi.mock("../lib/api", async (importOriginal) => {
  const real = await importOriginal<typeof import("../lib/api")>();
  return {
    ApiError: real.ApiError,
    registerE2eDevice: vi.fn(),
    listE2eDevices: vi.fn(),
    removeE2eDevice: vi.fn(),
    getE2eList: vi.fn(),
    putE2eList: vi.fn(),
    getE2eDeviceKeys: vi.fn(),
    uploadE2eDeviceKeys: vi.fn(),
    listE2eDeviceInbox: vi.fn(),
    ackE2eDeviceInbox: vi.fn(),
    sendE2e: vi.fn(),
    clearE2eKeys: vi.fn(),
  };
});
vi.mock("../lib/auth", () => ({ token: () => null }));
vi.mock("../lib/networks", () => ({ user: () => null, networks: () => undefined }));
vi.mock("../lib/e2e/olm", () => ({ loadOlm: async () => olm() }));

const api = await import("../lib/api");
const { accountStore } = await import("../lib/e2e/accountStore");
const { accountSlot, addDevice, completeJoin, masterOf, prepareJoin, syncIdentity } = await import(
  "../lib/e2e/identity"
);
const { holderPairing, joinerPairing } = await import("../lib/e2e/pairingSession");

/** The subject: the fake grappa's bearer is its nick. */
const NICK = "alice";
const SUBJECT = { kind: "user", id: "0b5e" };
const RENDEZVOUS = "AbCdEfGhIjKlMnOpQrStUv";

type Net = { slug: string; id: number };
const A: Net = { slug: "azzurra", id: 1 };
const B: Net = { slug: "libera", id: 2 };
const A2: Net = { slug: "oftc", id: 3 };
const C: Net = { slug: "efnet", id: 4 };
const D: Net = { slug: "ircnet", id: 5 };

const slotOf = (n: Net) => accountSlot(SUBJECT, n.id);

let grappas: Map<string, Grappa>;

/** The fake grappa of a network: one per slug, made on first use. */
function grappaOf(slug: string): Grappa {
  const found = grappas.get(slug) ?? new Grappa();
  grappas.set(slug, found);
  return found;
}

beforeEach(() => {
  grappas = new Map();
  routeApi(api, grappaOf);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

type Side = "holder" | "joiner";
type End = { onPayload(payload: string): void; onClosed(reason: CloseReason): void };

/**
 * The relay between the two sides, as X1 delivers: each payload once, in
 * order, to the other side only, after the post (a doorbell, then a fetch);
 * a close to the side that did not close. `intercept` sees the nth payload a
 * side posts (from 1) and says what reaches the other side instead (null:
 * nothing does). `lost` says which of them land but answer their sender with a
 * failure (the post went through, its answer did not).
 */
class Relay {
  posted: { from: Side; payload: string }[] = [];
  closed: { by: Side | "relay"; reason: CloseReason } | null = null;
  intercept: (from: Side, n: number, payload: string) => string | null = (_f, _n, payload) =>
    payload;
  lost: (from: Side, n: number) => boolean = () => false;
  private readonly ends = new Map<Side, End>();

  link(holder: End, joiner: End): void {
    this.ends.set("holder", holder);
    this.ends.set("joiner", joiner);
  }

  private end(side: Side): End {
    const found = this.ends.get(side);
    if (found === undefined) throw new Error(`no ${side} linked`);
    return found;
  }

  channel(side: Side): PairingChannel {
    const other: Side = side === "holder" ? "joiner" : "holder";
    return {
      rendezvous: {
        id: RENDEZVOUS,
        role: side === "holder" ? "creator" : "joiner",
        expires_at: "2026-10-23T12:05:00Z",
      },
      send: async (payload) => {
        if (this.closed !== null) throw new api.ApiError(404, "not_found");
        this.posted.push({ from: side, payload });
        const n = this.posted.filter((p) => p.from === side).length;
        const arrives = this.intercept(side, n, payload);
        if (arrives !== null) {
          queueMicrotask(() => {
            if (this.closed === null) this.end(other).onPayload(arrives);
          });
        }
        if (this.lost(side, n)) throw new api.ApiError(503, "unavailable");
      },
      catchUp: async () => undefined,
      close: async () => {
        if (this.closed !== null) return;
        this.closed = { by: side, reason: "closed" };
        queueMicrotask(() => this.end(other).onClosed("closed"));
      },
    };
  }

  /** The relay ends the rendezvous itself (it expired, a newer one replaced it): both sides told. */
  finish(reason: CloseReason): void {
    this.closed = { by: "relay", reason };
    queueMicrotask(() => {
      this.end("holder").onClosed(reason);
      this.end("joiner").onClosed(reason);
    });
  }

  from(side: Side): string[] {
    return this.posted.filter((p) => p.from === side).map((p) => p.payload);
  }
}

/** A browser: its own IndexedDB and Web Locks, and the account store over them. */
function browser(): { vault: MemoryVault; store: AccountStore } {
  const vault = memoryVault();
  return { vault, store: accountStore(olm(), vault, memoryLock()) };
}

/** A browser whose sync made the identity on each of `nets`: it holds each master. */
async function holderOn(...nets: Net[]): Promise<{ vault: MemoryVault; store: AccountStore }> {
  const made = browser();
  for (const n of nets) {
    expect(await syncIdentity(made.store, NICK, slotOf(n), n.slug)).toBe("ready");
  }
  return made;
}

async function masterKey(store: AccountStore, n: Net): Promise<string> {
  const M = await masterOf(store, slotOf(n));
  if (M === null) throw new Error(`no master on ${n.slug}`);
  return M;
}

const ownOf = (store: AccountStore, n: Net) =>
  store.withAccount(slotOf(n), async ({ account, own }) => ({ E: account.ed25519_key(), own }));

const devicesOn = async (n: Net) =>
  (await grappaOf(n.slug).api.listE2eDevices(NICK, n.slug)).map((d) => d.ed25519);

const listOn = (n: Net) => grappaOf(n.slug).api.getE2eList(NICK, n.slug);

/** `count` devices of other browsers registered on `n`, each vouching for `M`: their id blocks. */
async function strangers(n: Net, M: string, count: number): Promise<IdBlock[]> {
  const ids: IdBlock[] = [];
  for (let i = 0; i < count; i++) {
    const device = new (olm().Account)();
    const id = idBlock(device, M);
    await grappaOf(n.slug).api.registerE2eDevice(NICK, n.slug, id);
    ids.push(id);
    device.free();
  }
  return ids;
}

/** `n`'s list grown to four devices, put by the master `holder` holds there over three others. */
async function fillUp(holder: AccountStore, n: Net): Promise<void> {
  const M = await masterKey(holder, n);
  const others = (await strangers(n, M, 3)).map((id) => id.ed25519);
  const devices = [(await ownOf(holder, n)).E, ...others].sort();
  const sig = await holder.withAccount(slotOf(n), async ({ master }) =>
    master?.sign(listSigText(2, devices)),
  );
  await grappaOf(n.slug).api.putE2eList(NICK, n.slug, {
    master: M,
    ver: 2,
    devices,
    sig: sig ?? "",
  });
}

/** `joiner` paired into `n` through the doors, without the channel: what an earlier pairing left. */
async function pairedBefore(holder: AccountStore, joiner: AccountStore, n: Net): Promise<void> {
  const M = await masterKey(holder, n);
  const j = await prepareJoin(joiner, NICK, slotOf(n), n.slug, M);
  if (typeof j === "string") throw new Error(`the joiner refused: ${j}`);
  const signed = await addDevice(holder, NICK, slotOf(n), n.slug, j.id);
  if (typeof signed === "string") throw new Error(`the holder refused: ${signed}`);
  expect(await completeJoin(joiner, NICK, slotOf(n), n.slug, M, signed)).toBe(true);
}

/** The two roles of one pairing, each over its browser's store, linked by a relay. */
function start(holderStore: AccountStore, joinerStore: AccountStore, nets: () => Net[]) {
  const relay = new Relay();
  const paired = vi.fn();
  const holder = holderPairing({
    e2e: { olm: olm(), accounts: holderStore },
    bearer: NICK,
    subject: SUBJECT,
    networks: nets,
  });
  const joiner = joinerPairing(
    {
      e2e: { olm: olm(), accounts: joinerStore },
      bearer: NICK,
      subject: SUBJECT,
      networks: nets,
      paired,
    },
    { id: RENDEZVOUS, curve: holder.curve },
  );
  relay.link(holder, joiner);
  holder.attach(relay.channel("holder"));
  joiner.attach(relay.channel("joiner"));
  return { relay, holder, joiner, paired };
}

type Pairing = ReturnType<typeof start>;

async function until<S extends string>(state: () => { stage: S }, stage: S): Promise<void> {
  await vi.waitFor(() => expect(state().stage).toBe(stage), { timeout: 3_000, interval: 2 });
}

/** The code the new browser shows: what its user reads out to the holder's. */
function shown(p: Pairing): string {
  const code = p.joiner.state().checkCode;
  if (code === null) throw new Error("no code shown");
  return code;
}

/** Both users confirm: the code typed right, then the joiner's tap. */
async function confirmBoth(p: Pairing): Promise<void> {
  await until(p.holder.state, "code");
  p.holder.submitCode(shown(p));
  await until(p.joiner.state, "confirm");
  p.joiner.confirm();
}

/** Both users go through with it, and it runs to done on both sides. */
async function goThrough(p: Pairing): Promise<void> {
  await confirmBoth(p);
  await until(p.joiner.state, "done");
  await until(p.holder.state, "done");
}

/** Lets anything already set off run its course. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

/** One ECIES message, bit-flipped in the middle: what no channel opens. */
function tamper(payload: string): string {
  const i = Math.floor(payload.length / 2);
  return `${payload.slice(0, i)}${payload[i] === "A" ? "B" : "A"}${payload.slice(i + 1)}`;
}

/** A channel that keeps what its side sends, for a side played by hand on the other end. */
function recording() {
  const sent: string[] = [];
  let closes = 0;
  const channel: PairingChannel = {
    rendezvous: { id: RENDEZVOUS, role: "creator", expires_at: "2026-10-23T12:05:00Z" },
    send: async (payload) => {
      sent.push(payload);
    },
    catchUp: async () => undefined,
    close: async () => {
      closes++;
    },
  };
  return { channel, sent, closes: () => closes };
}

const seal = (link: EstablishedEcies, m: PairMessage) => link.encrypt(encodePairMessage(m));
const read = (link: EstablishedEcies, payload: string) =>
  decodePairMessage(olm(), link.decrypt(payload));

/** A joiner played by hand: its side of the channel, opened to `curve` with the hello. */
function handJoiner(curve: string): { initial: string; link: EstablishedEcies; code: string } {
  const out = new (olm().Ecies)(PAIRING_INFO).establish_outbound_channel(
    curve,
    encodePairMessage({ v: 1, t: "hello" }),
  );
  const link = out.take_channel();
  if (link === undefined) throw new Error("no channel");
  return {
    initial: wrapInitial(out.message),
    link,
    code: String(link.check_code()).padStart(2, "0"),
  };
}

/** A holder played by hand: the key its QR shows, and its side once the joiner's first payload came. */
function handHolder(): { curve: string; accept(initial: string): EstablishedEcies } {
  const ecies = new (olm().Ecies)(PAIRING_INFO);
  return {
    curve: ecies.public_key(),
    accept: (payload) => {
      const inbound = ecies.establish_inbound_channel(unwrapInitial(payload) ?? "");
      expect(decodePairMessage(olm(), inbound.plaintext)).toEqual({ v: 1, t: "hello" });
      const link = inbound.take_channel();
      if (link === undefined) throw new Error("no channel");
      return link;
    },
  };
}

function holderDeps(store: AccountStore, nets: () => Net[]) {
  return { e2e: { olm: olm(), accounts: store }, bearer: NICK, subject: SUBJECT, networks: nets };
}

/** A joiner over `store` facing a holder played by hand, once its hello came: both ends. */
async function facingHand(
  store: AccountStore,
  nets: Net[],
  paired: (slug: string, slot: string) => void,
) {
  const holder = handHolder();
  const joiner = joinerPairing(
    { ...holderDeps(store, () => nets), paired },
    { id: RENDEZVOUS, curve: holder.curve },
  );
  const rec = recording();
  joiner.attach(rec.channel);
  await vi.waitFor(() => expect(rec.sent).toHaveLength(1));
  return { joiner, rec, link: holder.accept(rec.sent[0] ?? "") };
}

/** The offer of `nets`, each under the master `holder` holds there. */
async function offerOf(holder: AccountStore, nets: Net[]): Promise<PairMessage> {
  const networks = [];
  for (const n of nets) networks.push({ network: n.slug, master: await masterKey(holder, n) });
  return { v: 1, t: "offer", networks, full: [] };
}

describe("a pairing between the holder and a new browser", () => {
  it("a full pairing ends done on both sides, and the joiner is a ready device on every network the holder is master of", async () => {
    const h = await holderOn(A, C);
    const j = browser();
    const p = start(h.store, j.store, () => [A, C]);

    await goThrough(p);

    const added = [
      { network: A.slug, outcome: "added" },
      { network: C.slug, outcome: "added" },
    ];
    expect(p.holder.state()).toEqual({
      stage: "done",
      offered: [A.slug, C.slug],
      full: [],
      notMaster: [],
      results: added,
      ended: null,
    });
    expect(p.joiner.state()).toEqual({
      stage: "done",
      checkCode: shown(p),
      offered: [A.slug, C.slug],
      full: [],
      results: added,
      ended: null,
    });
    for (const n of [A, C]) {
      expect(await syncIdentity(j.store, NICK, slotOf(n), n.slug)).toBe("ready");
      const mine = await ownOf(j.store, n);
      expect(mine.own?.master).toBe(await masterKey(h.store, n));
      expect((await listOn(n))?.devices).toEqual([(await ownOf(h.store, n)).E, mine.E].sort());
      expect(await devicesOn(n)).toHaveLength(2);
    }
    expect(p.paired.mock.calls).toEqual([
      [A.slug, slotOf(A)],
      [C.slug, slotOf(C)],
    ]);
    // The holder closes the rendezvous once the joiner says it is done.
    expect(p.relay.closed).toEqual({ by: "holder", reason: "closed" });
  });

  it("a wrong typed code closes the pairing: nothing is offered, nothing is registered or signed", async () => {
    const h = await holderOn(A);
    const j = browser();
    const registered = vi.mocked(api.registerE2eDevice).mock.calls.length;
    const puts = vi.mocked(api.putE2eList).mock.calls.length;
    const p = start(h.store, j.store, () => [A]);
    await until(p.holder.state, "code");

    p.holder.submitCode(String((Number(shown(p)) + 1) % 100).padStart(2, "0"));

    await until(p.holder.state, "ended");
    expect(p.holder.state()).toMatchObject({ ended: "code-mismatch", offered: [], results: [] });
    await until(p.joiner.state, "ended");
    expect(p.joiner.state().ended).toBe("closed");
    expect(p.relay.closed).toEqual({ by: "holder", reason: "closed" });
    // Nothing after the hello: the holder sent nothing at all.
    expect(p.relay.from("holder")).toEqual([]);
    expect(p.relay.from("joiner")).toHaveLength(1);
    await settle();
    expect(vi.mocked(api.registerE2eDevice).mock.calls.length).toBe(registered);
    expect(vi.mocked(api.putE2eList).mock.calls.length).toBe(puts);
    expect(await devicesOn(A)).toHaveLength(1);
    expect(j.vault.records.size).toBe(0);
  });

  // Review Focus 5: master on A, not on B, A2 at 4 devices, the joiner already
  // listed on C. The holder cannot know the joiner's keys before `join`, so C
  // is offered and comes back skipped.
  it("the holder offers only its master networks and reports a full list", async () => {
    const h = await holderOn(A, A2, C);
    const j = browser();
    // B's identity was made by another browser: this one holds no master there.
    expect(await syncIdentity(browser().store, NICK, slotOf(B), B.slug)).toBe("ready");
    await fillUp(h.store, A2);
    await pairedBefore(h.store, j.store, C);
    const onC = await listOn(C);
    const p = start(h.store, j.store, () => [A, B, A2, C]);

    await goThrough(p);

    const results = [
      { network: A.slug, outcome: "added" },
      { network: C.slug, outcome: "paired" },
    ];
    expect(p.holder.state()).toMatchObject({
      offered: [A.slug, C.slug],
      full: [A2.slug],
      notMaster: [B.slug],
      results,
    });
    expect(p.joiner.state()).toMatchObject({
      offered: [A.slug, C.slug],
      full: [A2.slug],
      results,
    });
    expect(p.paired.mock.calls).toEqual([[A.slug, slotOf(A)]]);
    expect(await syncIdentity(j.store, NICK, slotOf(A), A.slug)).toBe("ready");
    expect(await listOn(C)).toEqual(onC);
    expect(await devicesOn(C)).toHaveLength(2);
    expect((await listOn(A2))?.ver).toBe(2);
  });

  it("a holder with nothing to offer sends no offer, ends with each network's reason, and the joiner ends closed, never done", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await holderOn(A2, D);
    // B's identity was made by another browser: this one holds no master there.
    expect(await syncIdentity(browser().store, NICK, slotOf(B), B.slug)).toBe("ready");
    await fillUp(h.store, A2);
    // D's look before the offer fails.
    const look = vi.mocked(api.getE2eList);
    const routed = look.getMockImplementation();
    look.mockImplementation(async (bearer, slug) => {
      if (slug === D.slug) throw new api.ApiError(503, "db_unavailable");
      if (routed === undefined) throw new Error("getE2eList is not routed");
      return routed(bearer, slug);
    });
    const registered = vi.mocked(api.registerE2eDevice).mock.calls.length;
    const p = start(h.store, browser().store, () => [A2, B, D]);
    await until(p.holder.state, "code");

    p.holder.submitCode(shown(p));

    await until(p.holder.state, "ended");
    expect(p.holder.state()).toEqual({
      stage: "ended",
      offered: [],
      full: [A2.slug],
      notMaster: [B.slug],
      results: [{ network: D.slug, outcome: "failed" }],
      ended: "nothing-to-offer",
    });
    expect(p.relay.from("holder")).toEqual([]);
    expect(p.relay.closed).toEqual({ by: "holder", reason: "closed" });
    await until(p.joiner.state, "ended");
    expect(p.joiner.state().ended).toBe("closed");
    await settle();
    expect(p.joiner.state().stage).toBe("ended");
    expect(vi.mocked(api.registerE2eDevice).mock.calls.length).toBe(registered);
    expect(await devicesOn(A2)).toHaveLength(4);
    expect(warn).toHaveBeenCalledWith(
      `[e2e] pairing: judging the network failed on ${D.slug}`,
      expect.any(api.ApiError),
    );
  });

  it("the joiner's confirmation is required: before confirm() nothing is registered", async () => {
    const h = await holderOn(A);
    const j = browser();
    const registered = vi.mocked(api.registerE2eDevice).mock.calls.length;
    const p = start(h.store, j.store, () => [A]);
    await until(p.holder.state, "code");
    p.holder.submitCode(shown(p));
    await until(p.joiner.state, "confirm");
    await until(p.holder.state, "offered");

    await settle();

    expect(p.joiner.state().stage).toBe("confirm");
    expect(p.holder.state().stage).toBe("offered");
    expect(vi.mocked(api.registerE2eDevice).mock.calls.length).toBe(registered);
    expect(await devicesOn(A)).toHaveLength(1);
    expect(j.vault.records.size).toBe(0);
    // The tap, and only the tap, goes on with it.
    p.joiner.confirm();
    await until(p.holder.state, "done");
    expect(await devicesOn(A)).toHaveLength(2);
  });

  // Review Focus 3: the holder opened "add a device" again while this joiner
  // was mid-flow, and X1 closed this rendezvous as replaced.
  it("the rendezvous replaced mid-flow: the joiner deletes what it registered and ends replaced", async () => {
    const h = await holderOn(A, C);
    const j = browser();
    const p = start(h.store, j.store, () => [A, C]);
    // The joiner's `join` never reaches the holder.
    p.relay.intercept = (from, n, payload) => (from === "joiner" && n === 2 ? null : payload);
    await until(p.holder.state, "code");
    p.holder.submitCode(shown(p));
    await until(p.joiner.state, "confirm");
    p.joiner.confirm();
    await vi.waitFor(() => expect(p.relay.from("joiner")).toHaveLength(2));
    expect(await devicesOn(A)).toHaveLength(2);
    expect(await devicesOn(C)).toHaveLength(2);

    p.relay.finish("replaced");

    await until(p.joiner.state, "ended");
    expect(p.joiner.state().ended).toBe("replaced");
    await until(p.holder.state, "ended");
    expect(p.holder.state().ended).toBe("replaced");
    await vi.waitFor(async () => {
      expect(await devicesOn(A)).toHaveLength(1);
      expect(await devicesOn(C)).toHaveLength(1);
    });
    expect((await listOn(A))?.ver).toBe(1);
    expect((await listOn(C))?.ver).toBe(1);
    expect(p.paired).not.toHaveBeenCalled();
  });

  it("a tampered payload ends the pairing as failed on the side that reads it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    // The joiner's first payload, read by the holder.
    {
      const holder = holderPairing(holderDeps(browser().store, () => [A]));
      const rec = recording();
      holder.attach(rec.channel);
      holder.onPayload(tamper(handJoiner(holder.curve).initial));
      expect(holder.state()).toMatchObject({ stage: "ended", ended: "failed" });
      expect(rec.closes()).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        "[e2e] pairing (holder): a first payload that is no hello to this QR's key",
      );
    }
    // The holder's offer, read by the joiner: it registered nothing yet.
    {
      grappas = new Map();
      const h = await holderOn(A);
      const p = start(h.store, browser().store, () => [A]);
      p.relay.intercept = (from, n, payload) =>
        from === "holder" && n === 1 ? tamper(payload) : payload;
      await until(p.holder.state, "code");
      p.holder.submitCode(shown(p));
      await until(p.joiner.state, "ended");
      expect(p.joiner.state().ended).toBe("failed");
      expect(p.relay.closed?.by).toBe("joiner");
      await until(p.holder.state, "ended");
      expect(p.holder.state().ended).toBe("closed");
      expect(await devicesOn(A)).toHaveLength(1);
      // What failed is said, never what the payload held.
      expect(warn).toHaveBeenCalledWith("[e2e] pairing (joiner): a payload that does not decrypt");
    }
    // The joiner's `join`, read by the holder: nothing is signed, and the
    // joiner drops the device it registered.
    {
      grappas = new Map();
      const h = await holderOn(A);
      const p = start(h.store, browser().store, () => [A]);
      p.relay.intercept = (from, n, payload) =>
        from === "joiner" && n === 2 ? tamper(payload) : payload;
      await until(p.holder.state, "code");
      p.holder.submitCode(shown(p));
      await until(p.joiner.state, "confirm");
      p.joiner.confirm();
      await until(p.holder.state, "ended");
      expect(p.holder.state().ended).toBe("failed");
      await until(p.joiner.state, "ended");
      expect(p.joiner.state().ended).toBe("closed");
      await vi.waitFor(async () => expect(await devicesOn(A)).toHaveLength(1));
      expect((await listOn(A))?.ver).toBe(1);
      expect(warn).toHaveBeenCalledWith("[e2e] pairing (holder): a payload that does not decrypt");
    }
  });

  it("the holder reads done with the reason when the joiner never confirmed", async () => {
    // The joiner's `done` is lost, and the rendezvous then expires.
    {
      const p = start((await holderOn(A)).store, browser().store, () => [A]);
      p.relay.intercept = (from, n, payload) => (from === "joiner" && n === 3 ? null : payload);
      await confirmBoth(p);
      await until(p.joiner.state, "done");
      expect(p.holder.state().stage).toBe("signing");
      p.relay.finish("expired");
      await until(p.holder.state, "done");
      expect(p.holder.state()).toMatchObject({
        ended: "expired",
        results: [{ network: A.slug, outcome: "added" }],
      });
    }
    // `signed` never reaches the joiner, whose page then closes the rendezvous.
    {
      grappas = new Map();
      const p = start((await holderOn(A)).store, browser().store, () => [A]);
      p.relay.intercept = (from, n, payload) => (from === "holder" && n === 2 ? null : payload);
      await confirmBoth(p);
      // `signed` went out (and was lost on the way).
      await vi.waitFor(() => expect(p.relay.from("holder")).toHaveLength(2));
      await p.relay.channel("joiner").close();
      await until(p.holder.state, "done");
      expect(p.holder.state()).toMatchObject({
        ended: "closed",
        results: [{ network: A.slug, outcome: "added" }],
      });
    }
  });

  it("a garbage payload after signed reads done with ended failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = start((await holderOn(A)).store, browser().store, () => [A]);
    p.relay.intercept = (from, n, payload) =>
      from === "joiner" && n === 3 ? tamper(payload) : payload;

    await confirmBoth(p);

    await until(p.holder.state, "done");
    expect(p.holder.state()).toMatchObject({
      ended: "failed",
      results: [{ network: A.slug, outcome: "added" }],
    });
    expect(warn).toHaveBeenCalledWith("[e2e] pairing (holder): a payload that does not decrypt");
    expect(p.relay.closed?.by).toBe("holder");
  });

  // The POST landed and its answer was lost: the joiner may well hold `signed`.
  it("a failed send of signed keeps the channel open, and the joiner's done still completes it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = start((await holderOn(A)).store, browser().store, () => [A]);
    p.relay.lost = (from, n) => from === "holder" && n === 2;

    await goThrough(p);

    const added = [{ network: A.slug, outcome: "added" }];
    expect(p.holder.state()).toMatchObject({ ended: null, results: added });
    expect(p.joiner.state().results).toEqual(added);
    expect(p.relay.closed).toEqual({ by: "holder", reason: "closed" });
    expect(warn).toHaveBeenCalledWith("[e2e] a pairing step failed", expect.any(api.ApiError));
  });

  it("a close while the holder adds devices shows what it already put", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = start((await holderOn(A, C)).store, browser().store, () => [A, C]);
    // The put on C hangs until the rendezvous has ended, then fails.
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    let hanging = false;
    vi.mocked(api.putE2eList).mockImplementation(async (t, s, l) => {
      if (s !== C.slug) return grappaOf(s).api.putE2eList(t, s, l);
      hanging = true;
      await held;
      throw new api.ApiError(503, "db_unavailable");
    });
    await confirmBoth(p);
    await vi.waitFor(() => expect(hanging).toBe(true));
    // Adding shows as signing: the joiner's tap came, and the holder is at work.
    expect(p.holder.state().stage).toBe("signing");

    p.relay.finish("expired");

    await until(p.holder.state, "ended");
    release();
    await settle();
    expect(p.holder.state()).toMatchObject({
      ended: "expired",
      results: [{ network: A.slug, outcome: "added" }],
    });
    expect(warn).toHaveBeenCalledWith(
      `[e2e] pairing: adding the device failed on ${C.slug}`,
      expect.any(api.ApiError),
    );
  });

  it("a paired callback that throws does not stop the other networks or the done", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const j = browser();
    const p = start((await holderOn(A, C)).store, j.store, () => [A, C]);
    const gone = new Error("the page is gone");
    p.paired.mockImplementationOnce(() => {
      throw gone;
    });

    await goThrough(p);

    expect(p.joiner.state().results).toEqual([
      { network: A.slug, outcome: "added" },
      { network: C.slug, outcome: "added" },
    ]);
    expect(p.paired.mock.calls).toEqual([
      [A.slug, slotOf(A)],
      [C.slug, slotOf(C)],
    ]);
    expect(p.holder.state()).toMatchObject({ stage: "done", ended: null });
    expect(warn).toHaveBeenCalledWith(
      `[e2e] pairing: telling the page that ${A.slug} is paired failed`,
      gone,
    );
    expect(await syncIdentity(j.store, NICK, slotOf(C), C.slug)).toBe("ready");
  });

  it("a pairing frees its channel's keys when it ends", async () => {
    const freed = vi.spyOn(olm().EstablishedEcies.prototype, "free");
    const p = start((await holderOn(A)).store, browser().store, () => [A]);
    await goThrough(p);
    expect(freed).toHaveBeenCalledTimes(2);
    // A QR nobody scanned: its key, never used, goes with it.
    const unused = vi.spyOn(olm().Ecies.prototype, "free");
    holderPairing(holderDeps(browser().store, () => [A])).cancel();
    expect(unused).toHaveBeenCalledTimes(1);
  });

  it("the check codes shown on both sides are equal and two digits", async () => {
    const h = await holderOn(A);
    const p = start(h.store, browser().store, () => [A]);
    await until(p.holder.state, "code");
    expect(shown(p)).toMatch(/^[0-9]{2}$/);
    // The holder compares what is typed with its own code: the joiner's is it.
    p.holder.submitCode(shown(p));
    await until(p.holder.state, "offered");

    // A code below 10 is shown, and compared, with its leading zero.
    vi.spyOn(olm().EstablishedEcies.prototype, "check_code").mockReturnValue(7);
    const padded = start(h.store, browser().store, () => [A]);
    await until(padded.holder.state, "code");
    expect(shown(padded)).toBe("07");
    padded.holder.submitCode("07");
    await until(padded.holder.state, "offered");
    const bare = start(h.store, browser().store, () => [A]);
    await until(bare.holder.state, "code");
    bare.holder.submitCode("7");
    await until(bare.holder.state, "ended");
    expect(bare.holder.state().ended).toBe("code-mismatch");
  });

  it("a door that throws fails that network and the pairing still ends", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await holderOn(A, C, D);
    const j = browser();
    const p = start(h.store, j.store, () => [A, C, D]);
    // Each door below throws once, on one network.
    const failOnce = (door: typeof api.getE2eList | typeof api.putE2eList, slug: string) => {
      const mock = vi.mocked(door as unknown as (...args: unknown[]) => Promise<unknown>);
      const routed = mock.getMockImplementation();
      let thrown = false;
      mock.mockImplementation((...args) => {
        if (thrown || args[1] !== slug) return routed?.(...args) ?? Promise.resolve(undefined);
        thrown = true;
        return Promise.reject(new api.ApiError(503, "db_unavailable"));
      });
    };
    // The holder's look at D, before the offer.
    failOnce(api.getE2eList, D.slug);
    await until(p.holder.state, "code");
    p.holder.submitCode(shown(p));
    await until(p.joiner.state, "confirm");
    // The joiner's registration on C, and the holder's put on A.
    failOnce(api.getE2eList, C.slug);
    failOnce(api.putE2eList, A.slug);
    p.joiner.confirm();

    await until(p.joiner.state, "done");
    await until(p.holder.state, "done");

    expect(p.holder.state()).toMatchObject({
      offered: [A.slug, C.slug],
      results: [
        { network: A.slug, outcome: "failed" },
        { network: C.slug, outcome: "failed" },
        { network: D.slug, outcome: "failed" },
      ],
    });
    expect(p.joiner.state().results).toEqual([
      { network: A.slug, outcome: "failed" },
      { network: C.slug, outcome: "failed" },
    ]);
    const warned = warn.mock.calls.map(([message]) => String(message));
    for (const n of [A, C, D]) {
      expect(warned.some((m) => m.includes(n.slug))).toBe(true);
    }
    // The device the joiner registered on A, never listed, is gone again.
    await vi.waitFor(async () => expect(await devicesOn(A)).toHaveLength(1));
    expect(p.paired).not.toHaveBeenCalled();
  });
});

describe("a side that misbehaves", () => {
  // The joiner sends what an honest joiner never would: a second device for an
  // offered network, and one for a network that was not offered (bound on this
  // browser since the offer went out).
  it("the holder signs one device per offered network and refuses a duplicate or unoffered slug", async () => {
    const h = await holderOn(A, D);
    let nets = [A];
    const holder = holderPairing(holderDeps(h.store, () => nets));
    const rec = recording();
    holder.attach(rec.channel);
    const j = handJoiner(holder.curve);
    holder.onPayload(j.initial);
    holder.submitCode(j.code);
    await vi.waitFor(() => expect(rec.sent).toHaveLength(1));
    const MA = await masterKey(h.store, A);
    expect(read(j.link, rec.sent[0] ?? "")).toEqual({
      v: 1,
      t: "offer",
      networks: [{ network: A.slug, master: MA }],
      full: [],
    });
    const [first, second] = await strangers(A, MA, 2);
    const [other] = await strangers(D, await masterKey(h.store, D), 1);
    if (first === undefined || second === undefined || other === undefined) throw new Error();
    nets = [A, D];

    holder.onPayload(
      seal(j.link, {
        v: 1,
        t: "join",
        devices: [
          { network: A.slug, id: first },
          { network: A.slug, id: second },
          { network: D.slug, id: other },
        ],
        skipped: [],
      }),
    );

    await vi.waitFor(() => expect(rec.sent).toHaveLength(2));
    const signed = read(j.link, rec.sent[1] ?? "");
    if (signed?.t !== "signed") throw new Error("not a signed");
    expect(signed.devices.map((d) => [d.network, d.list.devices.includes(first.ed25519)])).toEqual([
      [A.slug, true],
    ]);
    expect(signed.refused).toEqual(
      expect.arrayContaining([
        { network: A.slug, reason: "failed" },
        { network: D.slug, reason: "failed" },
      ]),
    );
    expect(signed.refused).toHaveLength(2);
    expect((await listOn(A))?.devices).toEqual([(await ownOf(h.store, A)).E, first.ed25519].sort());
    expect((await listOn(D))?.ver).toBe(1);
    expect(holder.state()).toMatchObject({
      stage: "signing",
      results: [{ network: A.slug, outcome: "added" }],
    });
  });

  // The holder sends a second entry for a network the joiner joined, an entry
  // for one it skipped (the earlier pairing's own, so its signatures hold),
  // one for a network it never heard of, and none for another it joined.
  it("the joiner ignores a signed entry for a network it did not join, and drops one it joined that got none", async () => {
    const h = await holderOn(A, C, D);
    const j = browser();
    await pairedBefore(h.store, j.store, C);
    const onC = await ownOf(j.store, C);
    const paired = vi.fn();
    const { joiner, rec, link } = await facingHand(j.store, [A, C, D], paired);
    joiner.onPayload(seal(link, await offerOf(h.store, [A, C, D])));
    joiner.confirm();
    await vi.waitFor(() => expect(rec.sent).toHaveLength(2));
    const join = read(link, rec.sent[1] ?? "");
    if (join?.t !== "join") throw new Error("not a join");
    expect(join.skipped).toEqual([{ network: C.slug, reason: "paired" }]);
    expect(join.devices.map((d) => d.network)).toEqual([A.slug, D.slug]);
    const onA = join.devices[0]?.id;
    if (onA === undefined) throw new Error();
    const forA = await addDevice(h.store, NICK, slotOf(A), A.slug, onA);
    if (typeof forA === "string") throw new Error(`refused: ${forA}`);
    const bogus = { cert: "bogus", list: { ver: 7, devices: [onA.ed25519], sig: "bogus" } };
    const { cert, list } = onC.own ?? { cert: "", list: bogus.list };

    joiner.onPayload(
      seal(link, {
        v: 1,
        t: "signed",
        devices: [
          { network: A.slug, ...forA },
          { network: A.slug, ...bogus },
          { network: C.slug, cert, list },
          { network: "zeta", ...bogus },
        ],
        refused: [],
      }),
    );

    await until(joiner.state, "done");
    expect(joiner.state().results).toEqual([
      { network: A.slug, outcome: "added" },
      { network: C.slug, outcome: "paired" },
      { network: D.slug, outcome: "failed" },
    ]);
    expect(paired.mock.calls).toEqual([[A.slug, slotOf(A)]]);
    expect(await ownOf(j.store, C)).toEqual(onC);
    expect(await syncIdentity(j.store, NICK, slotOf(A), A.slug)).toBe("ready");
    // D's device, registered and never listed, is dropped again.
    expect(await devicesOn(D)).toHaveLength(1);
    expect(read(link, rec.sent[2] ?? "")).toEqual({ v: 1, t: "done", paired: [A.slug] });
  });

  it("the joiner shows the holder's refusal reason", async () => {
    const h = await holderOn(A, D);
    const { joiner, rec, link } = await facingHand(browser().store, [A, D], vi.fn());
    joiner.onPayload(seal(link, await offerOf(h.store, [A, D])));
    joiner.confirm();
    await vi.waitFor(() => expect(rec.sent).toHaveLength(2));
    expect(await devicesOn(A)).toHaveLength(2);

    const refused = [{ network: A.slug, reason: "list-changed" as const }];
    joiner.onPayload(seal(link, { v: 1, t: "signed", devices: [], refused }));

    await until(joiner.state, "done");
    // D got neither an entry nor a reason.
    expect(joiner.state().results).toEqual([
      { network: A.slug, outcome: "list-changed" },
      { network: D.slug, outcome: "failed" },
    ]);
    expect(await devicesOn(A)).toHaveLength(1);
    expect(await devicesOn(D)).toHaveLength(1);
  });

  it("a message out of order, or one that is not a pairing message, ends the pairing as failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await holderOn(A);
    // A `join` before any offer went out.
    {
      const holder = holderPairing(holderDeps(h.store, () => [A]));
      const rec = recording();
      holder.attach(rec.channel);
      const j = handJoiner(holder.curve);
      holder.onPayload(j.initial);
      holder.onPayload(seal(j.link, { v: 1, t: "join", devices: [], skipped: [] }));
      expect(holder.state()).toMatchObject({ stage: "ended", ended: "failed" });
      expect(rec.closes()).toBe(1);
    }
    // Bytes the channel opens that are no pairing message, after the offer.
    {
      const holder = holderPairing(holderDeps(h.store, () => [A]));
      const rec = recording();
      holder.attach(rec.channel);
      const j = handJoiner(holder.curve);
      holder.onPayload(j.initial);
      holder.submitCode(j.code);
      await until(holder.state, "offered");
      holder.onPayload(j.link.encrypt(new TextEncoder().encode("not json")));
      expect(holder.state()).toMatchObject({ stage: "ended", ended: "failed" });
      expect(warn).toHaveBeenCalledWith(
        "[e2e] pairing (holder): a payload that is no pairing message",
      );
    }
    // A `signed` before any offer.
    const signed: PairMessage = { v: 1, t: "signed", devices: [], refused: [] };
    {
      const { joiner, rec, link } = await facingHand(browser().store, [A], vi.fn());
      joiner.onPayload(seal(link, signed));
      expect(joiner.state()).toMatchObject({ stage: "ended", ended: "failed" });
      expect(rec.closes()).toBe(1);
    }
    // An offer shown and no tap yet: a `signed`, or a second offer.
    const registered = vi.mocked(api.registerE2eDevice).mock.calls.length;
    const offer = await offerOf(h.store, [A]);
    for (const next of [signed, offer]) {
      const { joiner, link } = await facingHand(browser().store, [A], vi.fn());
      joiner.onPayload(seal(link, offer));
      expect(joiner.state().stage).toBe("confirm");
      joiner.onPayload(seal(link, next));
      expect(joiner.state()).toMatchObject({ stage: "ended", ended: "failed" });
    }
    await settle();
    expect(vi.mocked(api.registerE2eDevice).mock.calls.length).toBe(registered);
    expect(await devicesOn(A)).toHaveLength(1);
  });

  // An honest holder with nothing to offer sends none (it closes instead);
  // another client might still send one.
  it("a joiner given an offer of no network ends with nothing to pair: no tap, nothing registered, and it closes", async () => {
    const j = browser();
    const { joiner, rec, link } = await facingHand(j.store, [A], vi.fn());

    joiner.onPayload(seal(link, { v: 1, t: "offer", networks: [], full: [A.slug] }));

    expect(joiner.state()).toMatchObject({
      stage: "ended",
      ended: "nothing-to-pair",
      offered: [],
      full: [A.slug],
    });
    expect(rec.closes()).toBe(1);
    joiner.confirm();
    await settle();
    expect(joiner.state().stage).toBe("ended");
    expect(api.getE2eList).not.toHaveBeenCalled();
    expect(api.registerE2eDevice).not.toHaveBeenCalled();
    // The hello, and nothing after it.
    expect(rec.sent).toHaveLength(1);
    expect(j.vault.records.size).toBe(0);
  });

  // The joiner's done names the networks where it took its place; one the
  // holder signed in and the done leaves out is listed there, and holds no
  // browser.
  it("the holder marks failed a network it added that the joiner's done leaves out, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await holderOn(A, D);
    const holder = holderPairing(holderDeps(h.store, () => [A, D]));
    const rec = recording();
    holder.attach(rec.channel);
    const j = handJoiner(holder.curve);
    holder.onPayload(j.initial);
    holder.submitCode(j.code);
    await vi.waitFor(() => expect(rec.sent).toHaveLength(1));
    const [onA] = await strangers(A, await masterKey(h.store, A), 1);
    const [onD] = await strangers(D, await masterKey(h.store, D), 1);
    if (onA === undefined || onD === undefined) throw new Error("no strangers");
    holder.onPayload(
      seal(j.link, {
        v: 1,
        t: "join",
        devices: [
          { network: A.slug, id: onA },
          { network: D.slug, id: onD },
        ],
        skipped: [],
      }),
    );
    await vi.waitFor(() => expect(rec.sent).toHaveLength(2));
    expect(holder.state()).toMatchObject({
      stage: "signing",
      results: [
        { network: A.slug, outcome: "added" },
        { network: D.slug, outcome: "added" },
      ],
    });

    holder.onPayload(seal(j.link, { v: 1, t: "done", paired: [A.slug] }));

    expect(holder.state()).toMatchObject({
      stage: "done",
      ended: null,
      results: [
        { network: A.slug, outcome: "added" },
        { network: D.slug, outcome: "failed" },
      ],
    });
    expect(warn).toHaveBeenCalledWith(
      `[e2e] pairing (holder): the new browser did not take its place on ${D.slug}`,
    );
    expect(rec.closes()).toBe(1);
  });

  it("a QR key that opens no channel ends the joiner as failed before it says anything, and says why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const joiner = joinerPairing(
      { ...holderDeps(browser().store, () => [A]), paired: vi.fn() },
      { id: RENDEZVOUS, curve: "x".repeat(43) },
    );
    const rec = recording();

    joiner.attach(rec.channel);

    expect(joiner.state()).toMatchObject({ stage: "ended", ended: "failed" });
    expect(rec.sent).toEqual([]);
    expect(rec.closes()).toBe(1);
    expect(warn).toHaveBeenCalledWith(
      "[e2e] pairing (joiner): no channel opens to this QR's key",
      expect.anything(),
    );
  });

  it("the joiner skips an offered network this browser does not have as failed, and says why", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const h = await holderOn(A, D);
    const { joiner, rec, link } = await facingHand(browser().store, [A], vi.fn());
    joiner.onPayload(seal(link, await offerOf(h.store, [A, D])));

    joiner.confirm();

    await vi.waitFor(() => expect(rec.sent).toHaveLength(2));
    const join = read(link, rec.sent[1] ?? "");
    if (join?.t !== "join") throw new Error("not a join");
    expect(join.devices.map((d) => d.network)).toEqual([A.slug]);
    expect(join.skipped).toEqual([{ network: D.slug, reason: "failed" }]);
    expect(warn).toHaveBeenCalledWith(
      `[e2e] pairing (joiner): ${D.slug} was offered and is not among this browser's networks`,
    );
    expect(await devicesOn(D)).toHaveLength(1);
  });
});
