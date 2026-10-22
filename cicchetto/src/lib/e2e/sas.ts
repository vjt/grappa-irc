// issue 2430 — SAS: two people compare 7 emoji over their Olm session, and a
// match verifies each one's master on the other side (2430 "Identity"; between
// humans only, ruling 6253162964: a bot's master is pinned by hand). The steps
// are w2's agreed proposal (comment 6252857813, encodings 6252978193), on
// Matrix's m.sas.v1, as inner messages: grappa sees MSG lines and nothing
// else. A is who starts, B who accepts.
//
//   A → sas.start  {tx}                    to every device of B's master
//   B → sas.accept {tx, commitment: sha256(B_key + "|" + tx)}
//   A → sas.key    {tx, key: A_key}
//   B → sas.key    {tx, key: B_key}       A checks the commitment
//   both show the emoji of "irc-e2e:v1:sas:" + A_curve|A_key|B_curve|B_key|tx
//   each, once its own human says they match → sas.mac {tx, mac, mmac}
//   verified = our human confirmed AND the peer's `mac` (over its device key)
//   and `mmac` (over its master) are the ones expected, from a device that
//   master vouches for
//   either side, at any time → sas.cancel {tx, reason}
//
// Wire v2 (W "Inner messages", "SAS"): it runs between one device on each
// side, and `verified` is recorded on the master, so it covers every device
// the master vouches for, now and later. The peer device is the one whose
// step first names the tx: for B, A's device the start came from; for A, the
// first of B's devices to accept. Every later step goes to that device alone,
// and a step of the tx from another device of the master is ignored. `mmac`
// is what binds the master: a wrong one fails the SAS as a wrong `mac` does,
// and is no key alarm.
//
// irc-olm drops sas.* (a bot never answers), so only cics run it, and the
// rules no wire fixes are cic's: both asking at once, the smaller tx wins
// on both sides; 600 s from the start, then a cancel.
//
// Where it lives (2430 comment 6339695571, fork 1). vodozemac keeps a SAS's
// secret in types that cannot be pickled, so the secret lives in ONE page,
// the one that started or accepted it (`SasHost.secrets`, by our SAS public
// key). The rest is public, and sealed with the account in `E2eState.sas`,
// one record per peer master, so every tab shows the same state and
// whichever tab drains the inbox answers the steps that need no secret (our
// key, the commitment check). The owner works out the emoji, and at its
// human's "they match" computes the MACs: it sends ours and stores the ones
// the peer must send, so any tab can finish when the peer's MACs come. A page
// that goes away before that takes the secret with it; the other tabs find
// it gone (it no longer holds its Web Lock) and cancel.

import type { ChatChange } from "./chatStore";
import {
  type E2eState,
  type Engine,
  type PeerDevice,
  type Result,
  refusedByVodozemac,
} from "./engine";
import type { Olm } from "./olm";
import type { EstablishedSas, Sas } from "./vodozemac/vodozemac_binding";
import { base64Unpadded, fold } from "./wire";

export const SAS_TIMEOUT_MS = 600_000;
const SAS_INFO = "irc-e2e:v1:sas:";
const MAC_INFO = "irc-e2e:v1:sas-mac:";
const MMAC_INFO = "irc-e2e:v2:sas-mmac:";
/** The tag of every SAS step the engine sends: none has a row to move. */
export const SAS_TAG = "sas";

/** Where a SAS stands on one side. */
export type SasPhase =
  /** A: asked, waiting for the accept. */
  | "started"
  /** A: our key sent, waiting for theirs. */
  | "keyed"
  /** B: asked, waiting for our human. */
  | "asked"
  /** B: accepted, waiting for their key. */
  | "accepted"
  /** Both keys known: the humans compare. */
  | "compare";

/** The public half of a SAS, stored with the account. */
export type SasRecord = {
  tx: string;
  /** Where its steps go and its rows are written: the nick it began on. */
  nick: string;
  role: "a" | "b";
  phase: SasPhase;
  /** When it began; cancelled SAS_TIMEOUT_MS after. */
  at: number;
  /**
   * The peer's device it runs with (its Ed25519 key), fixed by the first step
   * of the peer's that names this tx; null until then (A, waiting for an
   * accept, its start sent to every device of the master).
   */
  device: string | null;
  /** The page holding the secret; null until B accepts. */
  page: string | null;
  ourKey: string | null;
  theirKey: string | null;
  /** A: what B committed to. */
  commitment: string | null;
  /**
   * The MACs the peer must send, once our human confirmed (and ours went
   * out): over its device key, and over the master pinned to the nick.
   */
  expected: string | null;
  expectedMmac: string | null;
  /** The peer's MACs, kept until our human confirms. */
  theirMac: string | null;
  theirMmac: string | null;
};

/** This page's part in the SASes of every tab. */
export type SasHost = {
  page: string;
  /** Our SAS public key → its secret half, for the SASes this page owns. */
  secrets: Map<string, Sas | EstablishedSas>;
  /** The pages alive now. */
  alive(): Promise<ReadonlySet<string>>;
};

/** What the user can do. */
export type SasStep = "start" | "accept" | "match" | "mismatch" | "cancel";

export type SasCancelReason =
  | "user"
  | "mismatch"
  | "timeout"
  | "unexpected-message"
  | "commitment-mismatch"
  | "mac-mismatch"
  | "key-changed"
  | "page-gone"
  | "bad-key";

/** A SAS as the window shows it. `emoji` only where the secret is, while comparing. */
export type SasView = {
  role: "a" | "b";
  phase: SasPhase;
  confirmed: boolean;
  here: boolean;
  emoji: number[] | null;
};

type SasMessage =
  | { t: "sas.start"; tx: string }
  | { t: "sas.accept"; tx: string; commitment: string }
  | { t: "sas.key"; tx: string; key: string }
  | { t: "sas.mac"; tx: string; mac: string; mmac: string }
  | { t: "sas.cancel"; tx: string; reason: string };

const TX = /^[A-Za-z0-9+/]{11}$/;
const KEY = /^[A-Za-z0-9+/]{43}$/;
/** A peer's cancel reason is shown; it is cut to this. */
const REASON_MAX = 64;

export const isSas = (inner: Record<string, unknown>): boolean =>
  typeof inner.t === "string" && inner.t.startsWith("sas.");

function parse(inner: Record<string, unknown>): SasMessage | null {
  const { t, tx } = inner;
  if (typeof tx !== "string" || !TX.test(tx)) return null;
  const field = (name: string) => {
    const value = inner[name];
    return typeof value === "string" && KEY.test(value) ? value : null;
  };
  switch (t) {
    case "sas.start":
      return { t, tx };
    case "sas.accept": {
      const commitment = field("commitment");
      return commitment === null ? null : { t, tx, commitment };
    }
    case "sas.key": {
      const key = field("key");
      return key === null ? null : { t, tx, key };
    }
    case "sas.mac": {
      const mac = field("mac");
      const mmac = field("mmac");
      return mac === null || mmac === null ? null : { t, tx, mac, mmac };
    }
    case "sas.cancel":
      return typeof inner.reason === "string"
        ? { t, tx, reason: inner.reason.slice(0, REASON_MAX) }
        : null;
    default:
      return null;
  }
}

const encoder = new TextEncoder();

/** B's commitment to its key, as A checks it. */
async function commitment(key: string, tx: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${key}|${tx}`));
  return base64Unpadded(new Uint8Array(digest));
}

type RowSpec =
  | { kind: "sas_asked"; by: "you" | "peer" }
  | { kind: "sas_cancelled"; by: "you" | "peer"; reason: string }
  | { kind: "verified"; ed25519: string };

/**
 * The SASes of one account, for one locked operation, like `Engine`: it
 * changes `state` in place, sends each step through the engine, and collects
 * what the engine answered and what to write, which the caller takes
 * (`take`), hands to grappa and stores.
 */
export class Verifier {
  private res: Result = { events: [], outbound: [] };
  private changes: ChatChange[] = [];
  private chats = new Set<string>();

  constructor(
    private readonly olm: Olm,
    private readonly engine: Engine,
    private readonly state: E2eState,
    private readonly host: SasHost,
    private readonly now: () => number,
  ) {
    // A SAS this page held may have ended in another tab (a cancel it
    // drained, its tick): no stored SAS names the secret any more.
    const held = new Set(
      Object.values(state.sas).flatMap((rec) =>
        rec.page === host.page && rec.ourKey !== null ? [rec.ourKey] : [],
      ),
    );
    for (const [key, secret] of host.secrets) {
      if (held.has(key)) continue;
      secret.free();
      host.secrets.delete(key);
    }
  }

  /**
   * What the calls so far produced, handed over once: everything the engine
   * answered to them (the steps' payloads and events, and what a verified
   * master asks for), and the chat changes.
   */
  take(): Result & { changes: ChatChange[]; chats: string[] } {
    const taken = { ...this.res, changes: this.changes, chats: [...this.chats] };
    this.res = { events: [], outbound: [] };
    this.changes = [];
    this.chats = new Set();
    return taken;
  }

  // --- the user ------------------------------------------------------------

  async step(nick: string, step: SasStep): Promise<void> {
    if (step === "start") {
      this.start(nick);
      return;
    }
    const found = this.recordOf(nick);
    if (found === undefined) return;
    const [master, rec] = found;
    switch (step) {
      case "accept":
        await this.accept(rec);
        break;
      case "match":
        this.confirm(master, rec);
        break;
      case "mismatch":
      case "cancel":
        this.end(master, rec, step === "cancel" ? "user" : "mismatch", null);
        break;
    }
  }

  // One SAS per master: a nick with none pinned, or with a SAS under way, starts none.
  private start(nick: string): void {
    const peer = this.engine.pinned(nick);
    if (peer === undefined || this.state.sas[peer.master] !== undefined) return;
    const rec: SasRecord = {
      tx: base64Unpadded(crypto.getRandomValues(new Uint8Array(8))),
      nick,
      role: "a",
      phase: "started",
      at: this.now(),
      device: null,
      page: this.host.page,
      ourKey: this.newSecret(),
      theirKey: null,
      commitment: null,
      expected: null,
      expectedMmac: null,
      theirMac: null,
      theirMmac: null,
    };
    this.state.sas[peer.master] = rec;
    this.send(rec, { t: "sas.start", tx: rec.tx });
    this.row(nick, false, { kind: "sas_asked", by: "you" }, null);
  }

  private async accept(rec: SasRecord): Promise<void> {
    if (rec.phase !== "asked") return;
    const ourKey = this.newSecret();
    rec.page = this.host.page;
    rec.ourKey = ourKey;
    rec.phase = "accepted";
    this.send(rec, { t: "sas.accept", tx: rec.tx, commitment: await commitment(ourKey, rec.tx) });
    this.touch(rec.nick);
  }

  private confirm(master: string, rec: SasRecord): void {
    if (rec.phase !== "compare" || rec.expected !== null || rec.page !== this.host.page) return;
    const established = this.establish(master, rec);
    if (established === undefined) return;
    const { sas, peer } = established;
    // Each side's MACs bind its own curve first: ours, then the ones we expect.
    const own = this.engine.curve();
    const ours = `${own}|${peer.curve25519}|${rec.tx}`;
    const theirs = `${peer.curve25519}|${own}|${rec.tx}`;
    const mac = sas.calculate_mac(this.engine.deviceKey(), `${MAC_INFO}${ours}`);
    const mmac = sas.calculate_mac(this.engine.fingerprint(), `${MMAC_INFO}${ours}`);
    rec.expected = sas.calculate_mac(peer.ed25519, `${MAC_INFO}${theirs}`);
    rec.expectedMmac = sas.calculate_mac(master, `${MMAC_INFO}${theirs}`);
    this.forget(rec);
    this.send(rec, { t: "sas.mac", tx: rec.tx, mac, mmac });
    this.touch(rec.nick);
    this.settle(master, rec, null);
  }

  /**
   * `nick` was pinned by hand: a SAS that ran on it with another master ends
   * here. Nothing goes on the wire: its steps went to a device of the master
   * the nick left, which no step to the nick reaches now. That side times out.
   */
  repinned(nick: string): void {
    const pinned = this.engine.pinned(nick)?.master;
    for (const [master, rec] of Object.entries(this.state.sas)) {
      if (master === pinned || fold(rec.nick) !== fold(nick)) continue;
      delete this.state.sas[master];
      this.forget(rec);
      this.row(rec.nick, false, { kind: "sas_cancelled", by: "you", reason: "key-changed" }, null);
    }
  }

  // --- the peer ------------------------------------------------------------

  /**
   * A sas.* inner message from the device `device` of `master`, the master
   * pinned to `nick` (the engine attributes nothing else). Its rows take
   * `rowId`, derived from the inbox message, so a message processed again
   * writes nothing twice. One that does not parse, names another tx, or comes
   * from another device of the master than the one the SAS runs with, is
   * ignored: only that device's own SAS answers to it.
   */
  async receive(
    nick: string,
    master: string,
    device: string,
    inner: Record<string, unknown>,
    rowId: string,
  ): Promise<void> {
    const msg = parse(inner);
    if (msg === null) {
      console.debug(`[e2e] ignored a malformed ${String(inner.t)} from ${nick}`);
      return;
    }
    const rec = this.state.sas[master];
    if (msg.t === "sas.start") {
      await this.onStart(nick, master, device, rec, msg.tx, rowId);
      return;
    }
    if (rec === undefined || rec.tx !== msg.tx) {
      console.debug(`[e2e] ignored a ${msg.t} from ${nick} for no SAS of ours`);
      return;
    }
    rec.device ??= device;
    if (rec.device !== device) {
      console.debug(`[e2e] ignored a ${msg.t} from a device of ${nick} the SAS does not run with`);
      return;
    }
    switch (msg.t) {
      case "sas.accept":
        if (rec.phase !== "started") break;
        rec.commitment = msg.commitment;
        rec.phase = "keyed";
        this.send(rec, { t: "sas.key", tx: rec.tx, key: rec.ourKey });
        this.touch(rec.nick);
        return;
      case "sas.key":
        if (rec.phase === "keyed") {
          if ((await commitment(msg.key, rec.tx)) !== rec.commitment) {
            this.end(master, rec, "commitment-mismatch", rowId);
            return;
          }
          this.compare(rec, msg.key);
          return;
        }
        if (rec.phase === "accepted") {
          this.send(rec, { t: "sas.key", tx: rec.tx, key: rec.ourKey });
          this.compare(rec, msg.key);
          return;
        }
        break;
      case "sas.mac":
        if (rec.phase !== "compare" || rec.theirMac !== null) break;
        rec.theirMac = msg.mac;
        rec.theirMmac = msg.mmac;
        this.settle(master, rec, rowId);
        return;
      case "sas.cancel":
        delete this.state.sas[master];
        this.forget(rec);
        this.row(rec.nick, true, { kind: "sas_cancelled", by: "peer", reason: msg.reason }, rowId);
        return;
    }
    this.end(master, rec, "unexpected-message", rowId);
  }

  private async onStart(
    nick: string,
    master: string,
    device: string,
    rec: SasRecord | undefined,
    tx: string,
    rowId: string,
  ): Promise<void> {
    if (rec?.tx === tx) return;
    if (rec?.phase === "started" && rec.ourKey !== null) {
      // Both asked at once. Both sides keep the smaller tx: if it is ours,
      // the peer turns its start into our B; if theirs, ours becomes their B,
      // with the device that sent it, and our key, not sent yet, is the one
      // we commit to.
      if (tx > rec.tx) return;
      rec.tx = tx;
      rec.role = "b";
      rec.phase = "accepted";
      rec.at = this.now();
      rec.device = device;
      this.send(rec, { t: "sas.accept", tx, commitment: await commitment(rec.ourKey, tx) });
      this.touch(rec.nick);
      return;
    }
    // A new start replaces whatever ran with this master. It may come from
    // another device of the master, under a new tx: the device the old SAS
    // ran with is not told, and its steps, naming the old tx, are ignored.
    if (rec !== undefined) this.forget(rec);
    this.state.sas[master] = {
      tx,
      nick,
      role: "b",
      phase: "asked",
      at: this.now(),
      device,
      page: null,
      ourKey: null,
      theirKey: null,
      commitment: null,
      expected: null,
      expectedMmac: null,
      theirMac: null,
      theirMmac: null,
    };
    this.row(nick, true, { kind: "sas_asked", by: "peer" }, rowId);
  }

  private compare(rec: SasRecord, theirKey: string): void {
    rec.theirKey = theirKey;
    rec.phase = "compare";
    this.touch(rec.nick);
  }

  /**
   * Verified, once both halves are in: our human's match, and the peer's
   * MACs, both the ones expected. The engine records it on the master, and
   * asks the nick for the master's list (O1): its answer goes to the caller.
   */
  private settle(master: string, rec: SasRecord, rowId: string | null): void {
    if (rec.expected === null || rec.theirMac === null) return;
    if (rec.theirMac !== rec.expected || rec.theirMmac !== rec.expectedMmac) {
      this.end(master, rec, "mac-mismatch", rowId);
      return;
    }
    delete this.state.sas[master];
    this.collect(this.engine.verify(rec.nick, master));
    this.row(rec.nick, false, { kind: "verified", ed25519: master }, rowId);
  }

  // --- time ----------------------------------------------------------------

  /** Cancels what ran out of time, and what lost its secret with the page that held it. */
  tick(alive: ReadonlySet<string>): void {
    for (const [master, rec] of Object.entries(this.state.sas)) {
      if (this.now() >= rec.at + SAS_TIMEOUT_MS) {
        this.end(master, rec, "timeout", null);
      } else if (rec.page !== null && rec.expected === null && !alive.has(rec.page)) {
        this.end(master, rec, "page-gone", null);
      }
    }
  }

  // --- the window ----------------------------------------------------------

  /**
   * The SAS with the master `nick` is pinned to. The page that holds the
   * secret works the emoji out here, the first time it shows them; a key that
   * makes no secret ends the SAS instead (a cancel for the caller to send).
   */
  view(nick: string): SasView | null {
    const found = this.recordOf(nick);
    if (found === undefined) return null;
    const [master, rec] = found;
    const here = rec.page === this.host.page;
    const established =
      here && rec.phase === "compare" && rec.expected === null
        ? this.establish(master, rec)
        : undefined;
    if (this.state.sas[master] === undefined) return null;
    return {
      role: rec.role,
      phase: rec.phase,
      confirmed: rec.expected !== null,
      here,
      emoji:
        established === undefined
          ? null
          : [...established.sas.emoji_indices(this.info(rec, established.peer))],
    };
  }

  /** Nothing to send, report or write. */
  idle(): boolean {
    return (
      this.res.outbound.length === 0 && this.res.events.length === 0 && this.changes.length === 0
    );
  }

  // --- helpers -------------------------------------------------------------

  private recordOf(nick: string): [string, SasRecord] | undefined {
    const master = this.engine.pinned(nick)?.master;
    const rec = master === undefined ? undefined : this.state.sas[master];
    return master === undefined || rec === undefined ? undefined : [master, rec];
  }

  private newSecret(): string {
    const sas = new this.olm.Sas();
    const key = sas.public_key();
    this.host.secrets.set(key, sas);
    return key;
  }

  /**
   * The shared secret, once, with the peer device it binds: vodozemac refuses
   * a key that makes none, and that ends it. So does a peer device the master
   * no longer vouches for (a newer list revoked it, another device proved its
   * curve): the emoji and the MACs bind its curve, and W's SAS verifies only
   * through a device its master vouches for.
   */
  private establish(
    master: string,
    rec: SasRecord,
  ): { sas: EstablishedSas; peer: PeerDevice } | undefined {
    const peer = rec.device === null ? undefined : this.engine.trusted(master, rec.device);
    if (peer === undefined) {
      this.end(master, rec, "bad-key", null);
      return undefined;
    }
    const secret = rec.ourKey === null ? undefined : this.host.secrets.get(rec.ourKey);
    if (secret instanceof this.olm.EstablishedSas) return { sas: secret, peer };
    if (secret === undefined || rec.ourKey === null || rec.theirKey === null) return undefined;
    // The exchange uses the secret up, whatever it answers.
    this.host.secrets.delete(rec.ourKey);
    try {
      const sas = secret.diffie_hellman(rec.theirKey);
      this.host.secrets.set(rec.ourKey, sas);
      return { sas, peer };
    } catch (err) {
      if (!refusedByVodozemac(err)) throw err;
      this.end(master, rec, "bad-key", null);
      return undefined;
    }
  }

  // The bytes both sides derive the emoji from: A's device curve and SAS
  // key, then B's, then the tx.
  private info(rec: SasRecord, peer: PeerDevice): string {
    const ours = `${this.engine.curve()}|${rec.ourKey}`;
    const theirs = `${peer.curve25519}|${rec.theirKey}`;
    return `${SAS_INFO}${rec.role === "a" ? `${ours}|${theirs}` : `${theirs}|${ours}`}|${rec.tx}`;
  }

  /** Ends it with a cancel on the wire, and says so in the chat. */
  private end(master: string, rec: SasRecord, reason: SasCancelReason, rowId: string | null): void {
    delete this.state.sas[master];
    this.forget(rec);
    this.send(rec, { t: "sas.cancel", tx: rec.tx, reason });
    this.row(rec.nick, false, { kind: "sas_cancelled", by: "you", reason }, rowId);
  }

  private forget(rec: SasRecord): void {
    if (rec.ourKey === null || rec.page !== this.host.page) return;
    this.host.secrets.get(rec.ourKey)?.free();
    this.host.secrets.delete(rec.ourKey);
  }

  /** A step of `rec`, through the engine: to its peer device, to every device of the master before one is known. */
  private send(rec: SasRecord, inner: Record<string, unknown>): void {
    this.collect(this.engine.send(rec.nick, inner, SAS_TAG, null, rec.device));
  }

  /** What the engine answered, for the caller to take: never dropped. */
  private collect(res: Result): void {
    this.res.events.push(...res.events);
    this.res.outbound.push(...res.outbound);
  }

  private touch(nick: string): void {
    this.chats.add(fold(nick));
  }

  private row(nick: string, byPeer: boolean, spec: RowSpec, rowId: string | null): void {
    const row = { ...spec, id: rowId ?? crypto.randomUUID(), at: this.now(), nick };
    this.changes.push({ op: "add", nick, unread: byPeer, row });
    this.touch(nick);
  }
}
