// issue 2430 — the E2E engine for one (subject, network): peers, sessions,
// and what each wire verb does to them.
//
// A port of irc-olm's `engine.py` (vjt/irc-olm @ 77688e5, w2), the reference
// both implementations of the 2430 wire follow; where this one differs, the
// comment says why. Pure in the IRC sense: it never touches the network.
// `receive()` takes a whole message grappa delivered, `send()` an inner
// message for a peer; both return the events for the application and the
// payloads to hand to grappa's send door.
//
// Two things irc-olm does are grappa's job here: answering KEYREQ (grappa
// does it from the bundle cic uploads, `bundleSync.ts`, so KEYREQ never
// reaches cic) and framing (grappa cuts a payload into lines and joins them
// back, and names each message with its msgid).
//
// Trust: the pin is on the KEY, never on the nick (2430 "Identity"). A bot
// pins only keys its operator pasted; a person in cic has no configuration
// to paste into, so the first key a nick presents is pinned (trust on first
// use) and is "unverified" until the user pastes it by hand or compares a SAS
// (`sas.ts`). A different key on a pinned nick is an alarm, ignored,
// never a silent replace; only the user re-pinning moves a pin.
//
// State: ALL of it is `E2eState`, plain JSON the caller seals and stores with
// the account, in one record, under the slot's lock — irc-olm's in-memory
// parts too (messages waiting for keys, when keys were last asked for, the
// plaintexts kept for a re-send after a NACK). Every cic tab drains the same
// inbox, and the tab that takes a KEYS or a NACK off it must see what
// another tab asked for or sent; queued messages also survive a reload. The
// engine changes the state in place: build one per locked operation.

import { identityBlock } from "./keyBundle";
import type { Olm } from "./olm";
import type { SasRecord } from "./sas";
import type { Account } from "./vodozemac/vodozemac_binding";
import {
  base64Unpadded,
  decodePayload,
  encodePayload,
  fold,
  ID_SIG_PREFIX,
  type IdBlock,
  linesNeeded,
  MAX_FRAGMENTS,
  OTK_SIG_PREFIX,
  PayloadError,
  parseKeys,
  parseMsg,
  parseNack,
  parsePkmsg,
  type ReceiveVerb,
  type SendVerb,
  unbase64,
  WIRE_VERSION,
} from "./wire";

/** Re-ask for keys when still waiting after this long (ms). */
export const KEYREQ_RETRY_MS = 30_000;
/** Queued plaintext waiting for keys is dropped (reported) after this long. */
export const OUTQ_TTL_MS = 60_000;
export const OUTQ_MAX = 16;
/** At most one new outbound session per peer per minute (2430 "Recovery"). */
export const REKEY_INTERVAL_MS = 60_000;
/** Plaintexts kept for a re-send after a NACK. */
export const SENT_MEMORY_MS = 1_800_000;
export const SENT_MAX = 1200;
/** A message goes out at most twice: once, and once more after a NACK. */
export const MAX_SENDS = 2;
export const MAX_SESSIONS_PER_PEER = 5;
export const SEEN_SESSIONS_MAX = 10_000;
/** Inner types that go ahead of text (grappa's `control` priority). */
const URGENT_INNER = new Set(["chal", "ack"]);

/** A pinned identity. `curve25519` is learned from its first signed id block. */
export type Peer = {
  ed25519: string;
  curve25519: string | null;
  /** The last nick seen with this key: a routing hint only. */
  nick: string;
  /** A pre-key message built to us on that curve decrypted (see `identify`). */
  proven: boolean;
  /** Pinned by the user, or confirmed by a SAS; else trusted on first use. */
  verified: boolean;
};

/**
 * A message on its way: the inner message, as the JSON Olm encrypts, and the
 * caller's tag for it, which every event and payload about it carries back.
 */
type Outgoing = { plaintext: string; urgent: boolean; sends: number; tag: string };
/** Waiting for keys. `ed25519` is the key it is meant for; "" is whatever key answers. */
type Queued = { nick: string; ed25519: string; msg: Outgoing; at: number };
/** Handed to grappa; `msgid` once grappa named it (`sent()`), as a NACK refers to it. */
type Sent = {
  ref: string;
  msgid: string | null;
  nick: string;
  ed25519: string;
  sessionId: string;
  msg: Outgoing;
  at: number;
};

export type E2eState = {
  v: 1;
  /** Ed25519 → the peer. */
  peers: Record<string, Peer>;
  /** Folded nick → the Ed25519 key pinned to it. */
  pins: Record<string, string>;
  /** Curve25519 → session pickles, newest first. */
  sessions: Record<string, string[]>;
  /** Session ids already opened from a pre-key message, oldest first. */
  seen: string[];
  /** Folded nick → messages waiting for keys, oldest first. */
  outq: Record<string, Queued[]>;
  /** Folded nick → when keys were last asked for, while waiting for them. */
  keyreqAt: Record<string, number>;
  /** Ed25519 → when the last outbound session to it was opened. */
  rekeyAt: Record<string, number>;
  /** Oldest first. */
  sent: Sent[];
  nextRef: number;
  /**
   * The last inbox id processed (`client.ts`). Not the engine's: kept here so
   * it is stored with what processing that message changed, in one record.
   */
  inbox: number;
  /** Ed25519 → the SAS running with that key (`sas.ts`): its public half. */
  sas: Record<string, SasRecord>;
};

export function newState(): E2eState {
  return {
    v: 1,
    peers: {},
    pins: {},
    sessions: {},
    seen: [],
    outq: {},
    keyreqAt: {},
    rekeyAt: {},
    sent: [],
    nextRef: 1,
    inbox: 0,
    sas: {},
  };
}

export type DropReason =
  | "undecodable-payload"
  | "bad-payload"
  | "unsolicited-keys"
  | "bad-otk-signature"
  | "bad-identity-signature"
  | "own-identity"
  | "unpinned-key"
  | "identity-curve-mismatch"
  | "curve-already-bound"
  | "undecodable-inner"
  | "inner-without-type"
  | "unknown-nack-ref";

export type SendFailure =
  | "own-nick"
  | "unencodable"
  | "queue-full"
  | "keys-timeout"
  | "too-long"
  | "key-mismatch"
  | "nack-from-another-nick"
  | "unpinned-key"
  | "repinned"
  | "resend-failed"
  | "rekey-throttled";

export type UndecryptableReason =
  | "replayed-session"
  | "session-creation"
  | "no-session"
  | "decryption-failed";

/** What happened. `inner` is plaintext: never log it. */
export type E2eEvent =
  | { kind: "received"; nick: string; peer: Peer; inner: Record<string, unknown> }
  | { kind: "key_alarm"; nick: string; pinned: string; presented: string }
  | { kind: "undecryptable"; nick: string; msgid: string; reason: UndecryptableReason }
  | { kind: "replayed"; nick: string; sessionId: string }
  | { kind: "dropped"; nick: string; reason: DropReason; verb?: ReceiveVerb; detail?: string }
  | { kind: "send_queued"; nick: string; queued: number; tag: string }
  | { kind: "send_failed"; nick: string; reason: SendFailure; tags: string[] }
  | { kind: "rekeying"; nick: string; peer: Peer };

/**
 * A payload for grappa's send door. `ref` and `tag` are set on a PKMSG/MSG
 * that carries a message: report grappa's msgid for it with `sent()` (a NACK
 * names it), or `discard()` it when grappa refused the send.
 */
export type Outbound = {
  target: string;
  verb: SendVerb;
  payload: string;
  priority: "control" | "text";
  ref?: string;
  tag?: string;
};

export type Result = { events: E2eEvent[]; outbound: Outbound[] };

function emptyResult(): Result {
  return { events: [], outbound: [] };
}

/** A peer whose curve is known: what `identify` and `bind` hand back. */
type Bound = Peer & { curve25519: string };

/** vodozemac refused something that came off the wire. */
class Rejected extends Error {}

/**
 * Whether `err` is vodozemac refusing its input: wasm-bindgen's JsError, a
 * plain Error. Anything else, a trap above all, is a bug here or in the
 * binding, and must be thrown on.
 */
export function refusedByVodozemac(err: unknown): err is Error {
  return err instanceof Error && err.constructor === Error;
}

// A vodozemac call on wire input: its refusals become `Rejected`.
function rejecting<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (refusedByVodozemac(err)) throw new Rejected(err.message);
    throw err;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class Engine {
  constructor(
    private readonly olm: Olm,
    private readonly account: Account,
    private readonly state: E2eState,
    /** Our nick on the network now: bounds how long a payload may be. */
    private readonly ownNick: string,
    private readonly now: () => number,
  ) {}

  // --- pins --------------------------------------------------------------

  /** Our Ed25519 identity key, as a peer pins it. */
  fingerprint(): string {
    return this.account.ed25519_key();
  }

  /**
   * The identity to talk to as `nick`: the key pinned to that nick, else a
   * pinned key last seen under it (a renamed peer).
   */
  pinned(nick: string): Peer | undefined {
    const ed = this.state.pins[fold(nick)];
    if (ed !== undefined) return this.state.peers[ed];
    return Object.values(this.state.peers).find((p) => fold(p.nick) === fold(nick));
  }

  /**
   * Pins `ed25519` to `nick` by hand: the one way a pin moves to another key
   * (`identify` never does it). `verified` when the user pasted the key the
   * peer printed (a bot: 2430 ruling 6253162964); not when the user only
   * took a key the alarm showed, which a SAS then verifies (fork 7, 2430
   * comment 6339695571). Taking a key never unverifies it. The key's
   * sessions stay; a key never seen learns its curve from its first signed
   * id block. The key is the spelling vodozemac prints: 43 characters of
   * unpadded standard base64.
   */
  pin(nick: string, ed25519: string, verified: boolean): "pinned" | "bad-key" | "own-key" {
    if (!/^[A-Za-z0-9+/]{43}$/.test(ed25519)) return "bad-key";
    let ed: string;
    try {
      ed = rejecting(() => this.olm.canonical_ed25519(ed25519));
    } catch (err) {
      if (!(err instanceof Rejected)) throw err;
      return "bad-key";
    }
    if (ed === this.account.ed25519_key()) return "own-key";
    const known = this.state.peers[ed];
    this.state.peers[ed] =
      known === undefined
        ? { ed25519: ed, curve25519: null, nick, proven: false, verified }
        : { ...known, verified: known.verified || verified };
    this.state.pins[fold(nick)] = ed;
    return "pinned";
  }

  /** A SAS confirmed `ed25519` (`sas.ts`): verified, wherever it is pinned. */
  verify(ed25519: string): void {
    const peer = this.state.peers[ed25519];
    if (peer !== undefined) this.state.peers[ed25519] = { ...peer, verified: true };
  }

  /** Our Curve25519 identity key: what a SAS binds besides the Ed25519 one. */
  curve(): string {
    return this.account.curve25519_key();
  }

  // --- sending -----------------------------------------------------------

  /**
   * Encrypt `inner` for the identity pinned to `nick`; with no session yet
   * (or keys already asked for), queue it and ask for keys. A nick with no
   * pin is asked for keys too: whatever key answers is pinned on first use.
   * `tag` is the caller's name for the message: whatever happens to it later,
   * in this call or another, names it by its tag.
   */
  send(nick: string, inner: Record<string, unknown>, tag: string): Result {
    const res = emptyResult();
    if (fold(nick) === fold(this.ownNick)) {
      // grappa would answer our own KEYREQ with our own bundle, which
      // `identify` refuses: say so now rather than after a minute.
      res.events.push({ kind: "send_failed", nick, reason: "own-nick", tags: [tag] });
      return res;
    }
    let plaintext: string;
    try {
      // Encoded once, here: past this point nothing can fail on it, in a
      // queue flush or a re-send least of all.
      plaintext = JSON.stringify(inner);
    } catch {
      res.events.push({ kind: "send_failed", nick, reason: "unencodable", tags: [tag] });
      return res;
    }
    const urgent = typeof inner.t === "string" && URGENT_INNER.has(inner.t);
    const msg: Outgoing = { plaintext, urgent, sends: 1, tag };
    const peer = this.pinned(nick);
    if (peer === undefined) this.enqueue(nick, "", msg, res);
    else this.sendTo(nick, peer, msg, res);
    return res;
  }

  /** grappa accepted the send of `ref` as `msgid`: a NACK may name it. */
  sent(ref: string, msgid: string): void {
    const record = this.state.sent.find((s) => s.ref === ref && s.msgid === null);
    if (record !== undefined) record.msgid = msgid;
  }

  /** grappa refused the send of `ref`: it never left, so no NACK will name it. */
  discard(ref: string): void {
    this.state.sent = this.state.sent.filter((s) => s.ref !== ref);
  }

  private sendTo(nick: string, peer: Peer, msg: Outgoing, res: Result): void {
    // While keys are asked for (first contact, or a re-key after a NACK) the
    // sessions we still hold are the ones that failed: wait.
    const curve = peer.curve25519;
    if (
      curve !== null &&
      this.sessionsOf(curve).length > 0 &&
      this.state.keyreqAt[fold(nick)] === undefined
    ) {
      this.encrypt(nick, peer.ed25519, curve, msg, res);
    } else {
      this.enqueue(nick, peer.ed25519, msg, res);
    }
  }

  private enqueue(nick: string, ed25519: string, msg: Outgoing, res: Result): void {
    const key = fold(nick);
    const q = this.liveQueue(key, res);
    if (q.length >= OUTQ_MAX) {
      res.events.push({ kind: "send_failed", nick, reason: "queue-full", tags: [msg.tag] });
      return;
    }
    q.push({ nick, ed25519, msg, at: this.now() });
    this.state.outq[key] = q;
    res.events.push({ kind: "send_queued", nick, queued: q.length, tag: msg.tag });
    this.maybeKeyreq(nick, res);
  }

  /** The queue for a folded nick, minus what waited too long (reported). */
  private liveQueue(key: string, res: Result): Queued[] {
    const q = this.state.outq[key] ?? [];
    delete this.state.outq[key];
    const live = q.filter((x) => x.at > this.now() - OUTQ_TTL_MS);
    const first = q[0];
    if (first !== undefined && live.length < q.length) {
      res.events.push({
        kind: "send_failed",
        nick: first.nick,
        reason: "keys-timeout",
        tags: q.filter((x) => !live.includes(x)).map((x) => x.msg.tag),
      });
    }
    if (live.length > 0) this.state.outq[key] = live;
    return live;
  }

  private maybeKeyreq(nick: string, res: Result): void {
    const key = fold(nick);
    const last = this.state.keyreqAt[key];
    if (last !== undefined && this.now() - last < KEYREQ_RETRY_MS) return;
    this.state.keyreqAt[key] = this.now();
    res.outbound.push({
      target: nick,
      verb: "keyreq",
      payload: encodePayload({ v: WIRE_VERSION }),
      priority: "control",
    });
  }

  // On the newest session to `curve`, which the caller checked exists.
  private encrypt(nick: string, ed25519: string, curve: string, msg: Outgoing, res: Result): void {
    const pickles = this.sessionsOf(curve);
    const newest = pickles[0];
    if (newest === undefined) throw new Error(`no session to encrypt on for ${nick}`);
    const session = this.olm.Session.from_pickle(newest);
    try {
      const encrypted = session.encrypt(encoder.encode(msg.plaintext));
      const preKey = encrypted.message_type === 0;
      const body = base64Unpadded(encrypted.body);
      encrypted.free();
      const verb: SendVerb = preKey ? "pkmsg" : "msg";
      const payload = encodePayload(
        preKey
          ? { v: WIRE_VERSION, id: identityBlock(this.account), body }
          : { v: WIRE_VERSION, ck: this.account.curve25519_key(), body },
      );
      if (linesNeeded(verb, payload, this.ownNick, nick) > MAX_FRAGMENTS) {
        // grappa would refuse it (413). The session stays where it was:
        // nothing is stored, so the peer has no message key to skip.
        res.events.push({ kind: "send_failed", nick, reason: "too-long", tags: [msg.tag] });
        return;
      }
      pickles[0] = session.pickle();
      const ref = String(this.state.nextRef++);
      this.state.sent.push({
        ref,
        msgid: null,
        nick,
        ed25519,
        sessionId: session.session_id(),
        msg,
        at: this.now(),
      });
      this.trimSent();
      res.outbound.push({
        target: nick,
        verb,
        payload,
        priority: msg.urgent ? "control" : "text",
        ref,
        tag: msg.tag,
      });
    } finally {
      session.free();
    }
  }

  // --- receiving ---------------------------------------------------------

  /** A whole message grappa delivered from `nick`. Never throws on wire input. */
  receive(nick: string, verb: ReceiveVerb, msgid: string, payload: string): Result {
    const res = emptyResult();
    let decoded: Record<string, unknown>;
    try {
      decoded = decodePayload(payload);
    } catch (err) {
      if (!(err instanceof PayloadError)) throw err;
      res.events.push({ kind: "dropped", nick, reason: "undecodable-payload", verb });
      return res;
    }
    try {
      switch (verb) {
        case "keys":
          this.onKeys(nick, decoded, res);
          break;
        case "pkmsg":
          this.onPkmsg(nick, msgid, decoded, res);
          break;
        case "msg":
          this.onMsg(nick, msgid, decoded, res);
          break;
        case "nack":
          this.onNack(nick, decoded, res);
          break;
      }
    } catch (err) {
      // A payload missing a field, or a key or body vodozemac refuses:
      // malformed input from the wire, never a reason to crash. Nothing
      // else is caught.
      if (!(err instanceof PayloadError || err instanceof Rejected)) throw err;
      res.events.push({ kind: "dropped", nick, reason: "bad-payload", verb, detail: err.message });
    }
    return res;
  }

  private onKeys(nick: string, payload: Record<string, unknown>, res: Result): void {
    const keys = parseKeys(payload);
    const key = fold(nick);
    if (this.state.keyreqAt[key] === undefined) {
      res.events.push({ kind: "dropped", nick, reason: "unsolicited-keys", verb: "keys" });
      return;
    }
    if (!this.sigOk(keys.id.ed25519, `${OTK_SIG_PREFIX}${keys.otk.key}`, keys.otk.sig)) {
      res.events.push({ kind: "dropped", nick, reason: "bad-otk-signature", verb: "keys" });
      return;
    }
    const peer = this.identify(nick, keys.id, res, false);
    // First, so that a one-time key vodozemac refuses (a drop) leaves the
    // queue waiting, to be reported if it expires.
    const session =
      peer === undefined
        ? undefined
        : rejecting(() => this.account.create_outbound_session(peer.curve25519, keys.otk.key));
    try {
      delete this.state.keyreqAt[key];
      const queue = this.liveQueue(key, res);
      delete this.state.outq[key];
      // Each queued message goes to the key it was meant for, or nowhere:
      // the nick may have been re-pinned since. A message queued before the
      // nick had any pin goes to the key that answered.
      const mine =
        peer === undefined
          ? []
          : queue.filter((q) => q.ed25519 === peer.ed25519 || q.ed25519 === "");
      if (mine.length < queue.length) {
        res.events.push({
          kind: "send_failed",
          nick,
          reason: "key-mismatch",
          tags: queue.filter((q) => !mine.includes(q)).map((q) => q.msg.tag),
        });
      }
      if (peer === undefined || session === undefined || mine.length === 0) return;
      this.bind(peer, nick, false);
      this.addSession(peer.curve25519, session.pickle());
      this.state.rekeyAt[peer.ed25519] = this.now();
      for (const q of mine) this.encrypt(nick, peer.ed25519, peer.curve25519, q.msg, res);
    } finally {
      session?.free();
    }
  }

  private onPkmsg(
    nick: string,
    msgid: string,
    payload: Record<string, unknown>,
    res: Result,
  ): void {
    const pkmsg = parsePkmsg(payload);
    const peer = this.identify(nick, pkmsg.id, res, true);
    if (peer === undefined) return;
    const body = unbase64(pkmsg.body);
    const sessionId = rejecting(() => this.olm.pre_key_session_id(body));
    for (const pickle of this.sessionsOf(peer.curve25519)) {
      if (this.sessionId(pickle) === sessionId) {
        this.decryptOn(nick, msgid, peer, pickle, 0, body, res);
        return;
      }
    }
    if (this.state.seen.includes(sessionId)) {
      // Either a replay (a fallback-key PKMSG opens the same session again
      // and would re-deliver an old plaintext), or a peer still sending on a
      // session we lost. Never decrypt; NACK, so the second case recovers.
      res.events.push({ kind: "replayed", nick, sessionId });
      this.undecryptable(nick, msgid, "replayed-session", peer.ed25519, res);
      return;
    }
    let created: ReturnType<Account["create_inbound_session"]>;
    try {
      created = rejecting(() => this.account.create_inbound_session(peer.curve25519, body));
    } catch (err) {
      if (!(err instanceof Rejected)) throw err;
      this.undecryptable(nick, msgid, "session-creation", peer.ed25519, res);
      return;
    }
    const session = created.take_session();
    const plaintext = created.plaintext();
    created.free();
    if (session === undefined) throw new Error("an inbound session is taken once, here");
    try {
      this.state.seen.push(sessionId);
      if (this.state.seen.length > SEEN_SESSIONS_MAX) {
        this.state.seen.splice(0, this.state.seen.length - SEEN_SESSIONS_MAX);
      }
      this.bind(peer, nick, true);
      this.addSession(peer.curve25519, session.pickle());
      this.touch(peer.ed25519, nick);
      this.deliver(nick, peer.ed25519, plaintext, res);
    } finally {
      session.free();
    }
  }

  private onMsg(nick: string, msgid: string, payload: Record<string, unknown>, res: Result): void {
    const msg = parseMsg(payload);
    const curve = rejecting(() => this.olm.canonical_curve25519(msg.ck));
    const owner = this.curveOwner(curve);
    if (owner === undefined) {
      // A key we never saw a session for: our state was lost, or this is a
      // new account on a nick that had a pin. A NACK makes the sender open
      // a fresh session with its id block, which the pin, or trust on first
      // use, then judges.
      this.undecryptable(nick, msgid, "no-session", undefined, res);
      return;
    }
    const pickles = this.sessionsOf(curve);
    if (pickles.length === 0) {
      this.undecryptable(nick, msgid, "no-session", owner, res);
      return;
    }
    // Nothing about the peer moves before a decrypt succeeds: `ck` is
    // public, and anyone can put it on a line.
    const body = unbase64(msg.body);
    const peer = this.state.peers[owner] as Bound;
    for (const pickle of [...pickles]) {
      if (this.decryptOn(nick, msgid, peer, pickle, 1, body, res)) return;
    }
    this.undecryptable(nick, msgid, "decryption-failed", owner, res);
  }

  // True once the session `pickle` decrypted `body`. A pre-key message that
  // matched its session but does not decrypt is undecryptable here and now;
  // a normal one lets the caller try the next session.
  private decryptOn(
    nick: string,
    msgid: string,
    peer: Bound,
    pickle: string,
    messageType: 0 | 1,
    body: Uint8Array,
    res: Result,
  ): boolean {
    const session = this.olm.Session.from_pickle(pickle);
    try {
      let plaintext: Uint8Array;
      try {
        plaintext = rejecting(() => session.decrypt(messageType, body));
      } catch (err) {
        if (!(err instanceof Rejected)) throw err;
        if (messageType === 0) {
          this.undecryptable(nick, msgid, "decryption-failed", peer.ed25519, res);
        }
        return messageType === 0;
      }
      // The session the peer just used is the one to answer on.
      const rest = this.sessionsOf(peer.curve25519).filter((p) => p !== pickle);
      this.state.sessions[peer.curve25519] = [session.pickle(), ...rest];
      this.touch(peer.ed25519, nick);
      this.deliver(nick, peer.ed25519, plaintext, res);
      return true;
    } finally {
      session.free();
    }
  }

  private deliver(nick: string, ed25519: string, plaintext: Uint8Array, res: Result): void {
    let inner: unknown;
    try {
      inner = JSON.parse(decoder.decode(plaintext));
    } catch {
      res.events.push({ kind: "dropped", nick, reason: "undecodable-inner" });
      return;
    }
    if (
      typeof inner !== "object" ||
      inner === null ||
      Array.isArray(inner) ||
      typeof (inner as Record<string, unknown>).t !== "string"
    ) {
      res.events.push({ kind: "dropped", nick, reason: "inner-without-type" });
      return;
    }
    const peer = { ...(this.state.peers[ed25519] as Peer) };
    res.events.push({ kind: "received", nick, peer, inner: inner as Record<string, unknown> });
  }

  private onNack(nick: string, payload: Record<string, unknown>, res: Result): void {
    const nack = parseNack(payload);
    this.trimSent();
    const sent = this.state.sent.find((s) => s.msgid === nack.ref);
    if (sent === undefined) {
      res.events.push({ kind: "dropped", nick, reason: "unknown-nack-ref", verb: "nack" });
      return;
    }
    this.state.sent = this.state.sent.filter((s) => s !== sent);
    if (fold(sent.nick) !== fold(nick)) {
      // NACKs are not authenticated: never re-send on the word of a nick we
      // did not send to. The recipient renamed, most likely.
      res.events.push({
        kind: "send_failed",
        nick: sent.nick,
        reason: "nack-from-another-nick",
        tags: [sent.msg.tag],
      });
      return;
    }
    const peer = this.state.peers[sent.ed25519];
    if (peer === undefined) {
      res.events.push({ kind: "send_failed", nick, reason: "unpinned-key", tags: [sent.msg.tag] });
      return;
    }
    if (!this.reachedAt(nick, peer.ed25519)) {
      res.events.push({ kind: "send_failed", nick, reason: "repinned", tags: [sent.msg.tag] });
      return;
    }
    if (sent.msg.sends >= MAX_SENDS) {
      res.events.push({ kind: "send_failed", nick, reason: "resend-failed", tags: [sent.msg.tag] });
      return;
    }
    const again: Outgoing = { ...sent.msg, sends: sent.msg.sends + 1 };
    const newest = this.sessionsOf(peer.curve25519)[0];
    if (
      (newest !== undefined && this.sessionId(newest) !== sent.sessionId) ||
      this.state.keyreqAt[fold(nick)] !== undefined
    ) {
      // The failed session is not our newest, or keys are already asked for
      // (a re-key for an earlier NACK of the same burst): re-send on the
      // newest, or queue behind the keys. No new session.
      this.dropSession(peer.curve25519, sent.sessionId);
      this.sendTo(nick, peer, again, res);
      return;
    }
    // The failed session is our newest: only a new one helps, and the spec
    // allows one per peer per minute.
    const last = this.state.rekeyAt[peer.ed25519];
    if (last !== undefined && this.now() - last < REKEY_INTERVAL_MS) {
      res.events.push({
        kind: "send_failed",
        nick,
        reason: "rekey-throttled",
        tags: [sent.msg.tag],
      });
      return;
    }
    this.dropSession(peer.curve25519, sent.sessionId);
    res.events.push({ kind: "rekeying", nick, peer: this.state.peers[peer.ed25519] as Peer });
    // Re-send the lost message on the new session (the spec's MAY).
    this.enqueue(nick, peer.ed25519, again, res);
  }

  /**
   * Report it, and NACK unless `nick` is pinned to a key other than
   * `ed25519`, the one the message claims (undefined: a key we never saw).
   * A pinned key's curve and id block are public, and anyone can put them
   * on a line; but a NACK goes back to the nick the message came from, and
   * only a sender that holds the key acts on it. Every such message gets its
   * own NACK: the sender re-sends what is NACKed, and a message without one
   * is lost without a word.
   *
   * irc-olm NACKs only where the claimed key is pinned, since a bot talks to
   * nothing else. Here a nick with no pin is where trust on first use would
   * pin the key, so it is answered too: without that, a peer whose storage
   * was wiped never makes the sender re-key, and the sender never sees the
   * new key it must raise the alarm for (2430 "Session recovery").
   */
  private undecryptable(
    nick: string,
    msgid: string,
    reason: UndecryptableReason,
    ed25519: string | undefined,
    res: Result,
  ): void {
    res.events.push({ kind: "undecryptable", nick, msgid, reason });
    const mapped = this.pinned(nick);
    if (mapped === undefined || ed25519 === undefined || mapped.ed25519 === ed25519) {
      res.outbound.push({
        target: nick,
        verb: "nack",
        payload: encodePayload({ v: WIRE_VERSION, ref: msgid }),
        priority: "control",
      });
    }
  }

  /** Whether sending to `nick` reaches the key `ed25519`. */
  private reachedAt(nick: string, ed25519: string): boolean {
    return this.pinned(nick)?.ed25519 === ed25519;
  }

  // --- time --------------------------------------------------------------

  /** Reports queued messages that waited too long for keys; forgets old plaintexts. */
  tick(): Result {
    const res = emptyResult();
    for (const key of Object.keys(this.state.outq)) this.liveQueue(key, res);
    this.trimSent();
    return res;
  }

  // --- identities and pins -----------------------------------------------

  /**
   * The peer behind a presented id block, with the presented curve filled
   * in but NOT stored, or undefined: a bad signature, our own identity, a
   * key other than the one pinned to this nick (the alarm), or a curve that
   * belongs to another key. A key no one pinned yet comes back as a new,
   * unverified peer; it is stored only once a session exists (`bind`).
   *
   * An id block is public and replayable, and its signature only says the
   * Ed25519 key CLAIMS that curve, not that it holds it. Only a pre-key
   * message the curve's holder built to us proves it: `proving` may take
   * the curve from a key that only claimed it.
   */
  private identify(nick: string, id: IdBlock, res: Result, proving: boolean): Bound | undefined {
    if (!this.sigOk(id.ed25519, `${ID_SIG_PREFIX}${id.curve25519}`, id.sig)) {
      res.events.push({ kind: "dropped", nick, reason: "bad-identity-signature" });
      return undefined;
    }
    const ed = rejecting(() => this.olm.canonical_ed25519(id.ed25519));
    const curve = rejecting(() => this.olm.canonical_curve25519(id.curve25519));
    if (curve === this.account.curve25519_key()) {
      // Else a key could claim our curve, hand us our own fallback key as
      // its one-time key, and reflect our own messages back as its own.
      res.events.push({ kind: "dropped", nick, reason: "own-identity" });
      return undefined;
    }
    const known = this.state.peers[ed];
    const pinnedEd = this.state.pins[fold(nick)];
    if (known === undefined && pinnedEd !== undefined) {
      // A key we never saw, on a nick pinned to another: never a silent
      // replace. (A KNOWN key on another nick is a renamed peer, and fine.)
      res.events.push({ kind: "key_alarm", nick, pinned: pinnedEd, presented: ed });
      res.events.push({ kind: "dropped", nick, reason: "unpinned-key" });
      return undefined;
    }
    if (known?.curve25519 != null && known.curve25519 !== curve) {
      res.events.push({ kind: "dropped", nick, reason: "identity-curve-mismatch" });
      return undefined;
    }
    const owner = this.curveOwner(curve);
    if (
      owner !== undefined &&
      owner !== ed &&
      (this.state.peers[owner]?.proven === true || !proving)
    ) {
      // One curve under two keys would let one peer's messages be read as
      // the other's (sessions and MSG lookups go by curve).
      res.events.push({ kind: "dropped", nick, reason: "curve-already-bound" });
      return undefined;
    }
    const peer = known ?? { ed25519: ed, nick, proven: false, verified: false };
    return { ...peer, curve25519: curve };
  }

  private curveOwner(curve: string): string | undefined {
    return Object.values(this.state.peers).find((p) => p.curve25519 === curve)?.ed25519;
  }

  /**
   * Store the peer and the curve a session was opened on, pinning a new key
   * to `nick` (trust on first use); `proven` when a pre-key message
   * decrypted on it. A proof evicts another key's claim on that curve,
   * sessions included (`identify` let it through only if unproven).
   */
  private bind(peer: Bound, nick: string, proven: boolean): void {
    const owner = this.curveOwner(peer.curve25519);
    if (owner !== undefined && owner !== peer.ed25519) {
      const other = this.state.peers[owner] as Peer;
      this.state.peers[owner] = { ...other, curve25519: null };
      delete this.state.sessions[peer.curve25519];
    }
    const current = this.state.peers[peer.ed25519];
    this.state.peers[peer.ed25519] = {
      ed25519: peer.ed25519,
      curve25519: current?.curve25519 ?? peer.curve25519,
      nick: current?.nick ?? nick,
      proven: (current?.proven ?? false) || proven,
      verified: current?.verified ?? false,
    };
    this.state.pins[fold(nick)] ??= peer.ed25519;
  }

  /**
   * The nick hint follows the key that just spoke. A hint names one key: any
   * other key last seen there goes back to a nick pinned to it.
   */
  private touch(ed25519: string, nick: string): void {
    for (const other of Object.values(this.state.peers)) {
      if (other.ed25519 === ed25519 || fold(other.nick) !== fold(nick)) continue;
      const home = Object.keys(this.state.pins).find((n) => this.state.pins[n] === other.ed25519);
      if (home !== undefined) this.state.peers[other.ed25519] = { ...other, nick: home };
    }
    const current = this.state.peers[ed25519];
    if (current !== undefined) this.state.peers[ed25519] = { ...current, nick };
  }

  // --- helpers -----------------------------------------------------------

  private sigOk(ed25519: string, text: string, sig: string): boolean {
    return this.olm.verify_ed25519(ed25519, text, sig);
  }

  private sessionsOf(curve: string | null): string[] {
    return curve === null ? [] : (this.state.sessions[curve] ?? []);
  }

  private sessionId(pickle: string): string {
    const session = this.olm.Session.from_pickle(pickle);
    try {
      return session.session_id();
    } finally {
      session.free();
    }
  }

  private dropSession(curve: string | null, sessionId: string): void {
    if (curve === null) return;
    const rest = this.sessionsOf(curve).filter((p) => this.sessionId(p) !== sessionId);
    if (rest.length > 0) this.state.sessions[curve] = rest;
    else delete this.state.sessions[curve];
  }

  private addSession(curve: string, pickle: string): void {
    this.state.sessions[curve] = [pickle, ...this.sessionsOf(curve)].slice(
      0,
      MAX_SESSIONS_PER_PEER,
    );
  }

  private trimSent(): void {
    const cutoff = this.now() - SENT_MEMORY_MS;
    const fresh = this.state.sent.filter((s) => s.at >= cutoff);
    this.state.sent = fresh.slice(Math.max(0, fresh.length - SENT_MAX));
  }
}
