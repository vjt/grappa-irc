// issue 2430 — SAS: two people compare 7 emoji over their Olm session, and a
// match verifies each one's key on the other side (2430 "Identity"; between
// humans only, ruling 6253162964: a bot's key is pinned by hand). The steps
// are w2's agreed proposal (comment 6252857813, encodings 6252978193), on
// Matrix's m.sas.v1, as inner messages: grappa sees MSG lines and nothing
// else. A is who starts, B who accepts.
//
//   A → sas.start  {tx}
//   B → sas.accept {tx, commitment: sha256(B_key + "|" + tx)}
//   A → sas.key    {tx, key: A_key}
//   B → sas.key    {tx, key: B_key}       A checks the commitment
//   both show the emoji of "irc-e2e:v1:sas:" + A_curve|A_key|B_curve|B_key|tx
//   each, once its own human says they match → sas.mac {tx, mac}
//   verified = our human confirmed AND the peer's MAC is the one expected
//   either side, at any time → sas.cancel {tx, reason}
//
// irc-olm drops sas.* (a bot never answers), so only cics run it, and the
// rules no wire fixes are cic's: both asking at once, the smaller tx wins
// on both sides; 600 s from the start, then a cancel.
//
// Where it lives (2430 comment 6339695571, fork 1). vodozemac keeps a SAS's
// secret in types that cannot be pickled, so the secret lives in ONE page,
// the one that started or accepted it (`SasHost.secrets`, by our SAS public
// key). The rest is public, and sealed with the account in `E2eState.sas`,
// one record per peer key, so every tab shows the same state and whichever
// tab drains the inbox answers the steps that need no secret (our key, the
// commitment check). The owner works out the emoji, and at its human's
// "they match" computes both MACs: it sends ours and stores the one the peer
// must send, so any tab can finish when the peer's MAC comes. A page that
// goes away before that takes the secret with it; the other tabs find it
// gone (it no longer holds its Web Lock) and cancel.

import type { ChatChange } from "./chatStore";
import { type E2eState, type Engine, refusedByVodozemac } from "./engine";
import type { Olm } from "./olm";
import type { EstablishedSas, Sas } from "./vodozemac/vodozemac_binding";
import { base64Unpadded, fold } from "./wire";

export const SAS_TIMEOUT_MS = 600_000;
const SAS_INFO = "irc-e2e:v1:sas:";
const MAC_INFO = "irc-e2e:v1:sas-mac:";
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
  /** The page holding the secret; null until B accepts. */
  page: string | null;
  ourKey: string | null;
  theirKey: string | null;
  /** A: what B committed to. */
  commitment: string | null;
  /** The MAC the peer must send, once our human confirmed (and ours went out). */
  expected: string | null;
  /** The peer's MAC, kept until our human confirms. */
  theirMac: string | null;
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
  | { t: "sas.mac"; tx: string; mac: string }
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
      return mac === null ? null : { t, tx, mac };
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
 * changes `state` in place and collects what to send and write, which the
 * caller takes (`take`), sends through the engine and stores.
 */
export class Verifier {
  private sends: { nick: string; inner: Record<string, unknown> }[] = [];
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

  /** What the calls so far produced, handed over once. */
  take(): {
    sends: { nick: string; inner: Record<string, unknown> }[];
    changes: ChatChange[];
    chats: string[];
  } {
    const taken = { sends: this.sends, changes: this.changes, chats: [...this.chats] };
    this.sends = [];
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
    const [ed, rec] = found;
    switch (step) {
      case "accept":
        await this.accept(rec);
        break;
      case "match":
        this.confirm(ed, rec);
        break;
      case "mismatch":
      case "cancel":
        this.end(ed, rec, step === "cancel" ? "user" : "mismatch", null);
        break;
    }
  }

  // One SAS per key: a nick with no key, or with a SAS under way, starts none.
  private start(nick: string): void {
    const peer = this.engine.pinned(nick);
    if (peer === undefined || this.state.sas[peer.ed25519] !== undefined) return;
    const ourKey = this.newSecret();
    const tx = base64Unpadded(crypto.getRandomValues(new Uint8Array(8)));
    this.state.sas[peer.ed25519] = {
      tx,
      nick,
      role: "a",
      phase: "started",
      at: this.now(),
      page: this.host.page,
      ourKey,
      theirKey: null,
      commitment: null,
      expected: null,
      theirMac: null,
    };
    this.send(nick, { t: "sas.start", tx });
    this.row(nick, false, { kind: "sas_asked", by: "you" }, null);
  }

  private async accept(rec: SasRecord): Promise<void> {
    if (rec.phase !== "asked") return;
    const ourKey = this.newSecret();
    rec.page = this.host.page;
    rec.ourKey = ourKey;
    rec.phase = "accepted";
    this.send(rec.nick, {
      t: "sas.accept",
      tx: rec.tx,
      commitment: await commitment(ourKey, rec.tx),
    });
    this.touch(rec.nick);
  }

  private confirm(ed: string, rec: SasRecord): void {
    if (rec.phase !== "compare" || rec.expected !== null || rec.page !== this.host.page) return;
    const sas = this.establish(ed, rec);
    if (sas === undefined) return;
    const own = this.engine.curve();
    const theirs = this.curveOf(ed);
    const mac = sas.calculate_mac(
      this.engine.fingerprint(),
      `${MAC_INFO}${own}|${theirs}|${rec.tx}`,
    );
    rec.expected = sas.calculate_mac(ed, `${MAC_INFO}${theirs}|${own}|${rec.tx}`);
    this.forget(rec);
    this.send(rec.nick, { t: "sas.mac", tx: rec.tx, mac });
    this.touch(rec.nick);
    this.settle(ed, rec, null);
  }

  /** The nick was pinned to another key: its SAS with the old one ends here. */
  repinned(ed25519: string): void {
    const rec = this.state.sas[ed25519];
    if (rec === undefined) return;
    // Nothing goes on the wire: a step to the nick now reaches the new key.
    // The old key's side times out.
    delete this.state.sas[ed25519];
    this.forget(rec);
    this.row(rec.nick, false, { kind: "sas_cancelled", by: "you", reason: "key-changed" }, null);
  }

  // --- the peer ------------------------------------------------------------

  /**
   * A sas.* inner message from the key `ed25519` on `nick`. Its rows take
   * `rowId`, derived from the inbox message, so a message processed again
   * writes nothing twice. One that does not parse, or names another tx, is
   * ignored: only the sender's own SAS answers to it.
   */
  async receive(
    nick: string,
    ed25519: string,
    inner: Record<string, unknown>,
    rowId: string,
  ): Promise<void> {
    const msg = parse(inner);
    const rec = this.state.sas[ed25519];
    if (msg === null) {
      console.debug(`[e2e] ignored a malformed ${String(inner.t)} from ${nick}`);
      return;
    }
    if (msg.t === "sas.start") {
      // A SAS is with the key its nick is pinned to: the one its window shows.
      if (this.engine.pinned(nick)?.ed25519 !== ed25519) {
        console.debug(`[e2e] ignored a sas.start from ${nick} with a key it is not pinned to`);
        return;
      }
      await this.onStart(nick, ed25519, rec, msg.tx, rowId);
      return;
    }
    if (rec === undefined || rec.tx !== msg.tx) {
      console.debug(`[e2e] ignored a ${msg.t} from ${nick} for no SAS of ours`);
      return;
    }
    switch (msg.t) {
      case "sas.accept":
        if (rec.phase !== "started") break;
        rec.commitment = msg.commitment;
        rec.phase = "keyed";
        this.send(rec.nick, { t: "sas.key", tx: rec.tx, key: rec.ourKey });
        this.touch(rec.nick);
        return;
      case "sas.key":
        if (rec.phase === "keyed") {
          if ((await commitment(msg.key, rec.tx)) !== rec.commitment) {
            this.end(ed25519, rec, "commitment-mismatch", rowId);
            return;
          }
          this.compare(rec, msg.key);
          return;
        }
        if (rec.phase === "accepted") {
          this.send(rec.nick, { t: "sas.key", tx: rec.tx, key: rec.ourKey });
          this.compare(rec, msg.key);
          return;
        }
        break;
      case "sas.mac":
        if (rec.phase !== "compare" || rec.theirMac !== null) break;
        rec.theirMac = msg.mac;
        this.settle(ed25519, rec, rowId);
        return;
      case "sas.cancel":
        delete this.state.sas[ed25519];
        this.forget(rec);
        this.row(rec.nick, true, { kind: "sas_cancelled", by: "peer", reason: msg.reason }, rowId);
        return;
    }
    this.end(ed25519, rec, "unexpected-message", rowId);
  }

  private async onStart(
    nick: string,
    ed: string,
    rec: SasRecord | undefined,
    tx: string,
    rowId: string,
  ): Promise<void> {
    if (rec?.tx === tx) return;
    if (rec?.phase === "started" && rec.ourKey !== null) {
      // Both asked at once. Both sides keep the smaller tx: if it is ours,
      // the peer turns its start into our B; if theirs, ours becomes their B,
      // and our key, not sent yet, is the one we commit to.
      if (tx > rec.tx) return;
      rec.tx = tx;
      rec.role = "b";
      rec.phase = "accepted";
      rec.at = this.now();
      this.send(rec.nick, { t: "sas.accept", tx, commitment: await commitment(rec.ourKey, tx) });
      this.touch(rec.nick);
      return;
    }
    // A new start replaces whatever ran with this key: its peer gave it up.
    if (rec !== undefined) this.forget(rec);
    this.state.sas[ed] = {
      tx,
      nick,
      role: "b",
      phase: "asked",
      at: this.now(),
      page: null,
      ourKey: null,
      theirKey: null,
      commitment: null,
      expected: null,
      theirMac: null,
    };
    this.row(nick, true, { kind: "sas_asked", by: "peer" }, rowId);
  }

  private compare(rec: SasRecord, theirKey: string): void {
    rec.theirKey = theirKey;
    rec.phase = "compare";
    this.touch(rec.nick);
  }

  /** Verified, once both halves are in: our human's match, and the peer's MAC. */
  private settle(ed: string, rec: SasRecord, rowId: string | null): void {
    if (rec.expected === null || rec.theirMac === null) return;
    if (rec.theirMac !== rec.expected) {
      this.end(ed, rec, "mac-mismatch", rowId);
      return;
    }
    delete this.state.sas[ed];
    this.engine.verify(ed);
    this.row(rec.nick, false, { kind: "verified", ed25519: ed }, rowId);
  }

  // --- time ----------------------------------------------------------------

  /** Cancels what ran out of time, and what lost its secret with the page that held it. */
  tick(alive: ReadonlySet<string>): void {
    for (const [ed, rec] of Object.entries(this.state.sas)) {
      if (this.now() >= rec.at + SAS_TIMEOUT_MS) {
        this.end(ed, rec, "timeout", null);
      } else if (rec.page !== null && rec.expected === null && !alive.has(rec.page)) {
        this.end(ed, rec, "page-gone", null);
      }
    }
  }

  // --- the window ----------------------------------------------------------

  /**
   * The SAS with the key `nick` is pinned to. The page that holds the secret
   * works the emoji out here, the first time it shows them; a key that makes
   * no secret ends the SAS instead (a cancel for the caller to send).
   */
  view(nick: string): SasView | null {
    const found = this.recordOf(nick);
    if (found === undefined) return null;
    const [ed, rec] = found;
    const here = rec.page === this.host.page;
    const sas =
      here && rec.phase === "compare" && rec.expected === null
        ? this.establish(ed, rec)
        : undefined;
    if (this.state.sas[ed] === undefined) return null;
    return {
      role: rec.role,
      phase: rec.phase,
      confirmed: rec.expected !== null,
      here,
      emoji: sas === undefined ? null : [...sas.emoji_indices(this.info(ed, rec))],
    };
  }

  /** Nothing to send or write. */
  idle(): boolean {
    return this.sends.length === 0 && this.changes.length === 0;
  }

  // --- helpers -------------------------------------------------------------

  private recordOf(nick: string): [string, SasRecord] | undefined {
    const peer = this.engine.pinned(nick);
    const rec = peer === undefined ? undefined : this.state.sas[peer.ed25519];
    return peer === undefined || rec === undefined ? undefined : [peer.ed25519, rec];
  }

  private newSecret(): string {
    const sas = new this.olm.Sas();
    const key = sas.public_key();
    this.host.secrets.set(key, sas);
    return key;
  }

  /**
   * The shared secret, once: vodozemac refuses a key that makes none, and
   * that ends it. So does a peer whose curve is no longer known (another key
   * proved it): the emoji and the MACs bind it.
   */
  private establish(ed: string, rec: SasRecord): EstablishedSas | undefined {
    if (this.state.peers[ed]?.curve25519 == null) {
      this.end(ed, rec, "bad-key", null);
      return undefined;
    }
    const secret = rec.ourKey === null ? undefined : this.host.secrets.get(rec.ourKey);
    if (secret instanceof this.olm.EstablishedSas) return secret;
    if (secret === undefined || rec.ourKey === null || rec.theirKey === null) return undefined;
    // The exchange uses the secret up, whatever it answers.
    this.host.secrets.delete(rec.ourKey);
    try {
      const sas = secret.diffie_hellman(rec.theirKey);
      this.host.secrets.set(rec.ourKey, sas);
      return sas;
    } catch (err) {
      if (!refusedByVodozemac(err)) throw err;
      this.end(ed, rec, "bad-key", null);
      return undefined;
    }
  }

  // The bytes both sides derive the emoji from: A's identity curve and SAS
  // key, then B's, then the tx.
  private info(ed: string, rec: SasRecord): string {
    const ours = `${this.engine.curve()}|${rec.ourKey}`;
    const theirs = `${this.curveOf(ed)}|${rec.theirKey}`;
    return `${SAS_INFO}${rec.role === "a" ? `${ours}|${theirs}` : `${theirs}|${ours}`}|${rec.tx}`;
  }

  // `establish` checked it is known.
  private curveOf(ed: string): string {
    const curve = this.state.peers[ed]?.curve25519;
    if (curve == null) throw new Error("a SAS with a key whose curve is unknown");
    return curve;
  }

  /** Ends it with a cancel on the wire, and says so in the chat. */
  private end(ed: string, rec: SasRecord, reason: SasCancelReason, rowId: string | null): void {
    delete this.state.sas[ed];
    this.forget(rec);
    this.send(rec.nick, { t: "sas.cancel", tx: rec.tx, reason });
    this.row(rec.nick, false, { kind: "sas_cancelled", by: "you", reason }, rowId);
  }

  private forget(rec: SasRecord): void {
    if (rec.ourKey === null || rec.page !== this.host.page) return;
    this.host.secrets.get(rec.ourKey)?.free();
    this.host.secrets.delete(rec.ourKey);
  }

  private send(nick: string, inner: Record<string, unknown>): void {
    this.sends.push({ nick, inner });
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
