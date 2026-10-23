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
// does it from the bundles cic uploads, `identity.ts`, so KEYREQ never
// reaches cic) and framing (grappa cuts a payload into lines and joins them
// back, and names each message with its msgid).
//
// Trust (wire v2 "Trust", rules 1-6): the pin is `nick → master`, on the
// peer's MASTER key, never on one of its devices. A bot pins only masters its
// operator pasted; a person in cic has no configuration to paste into, so the
// first valid master a nick presents is pinned (trust on first use) and is
// "unverified" until the user pastes it by hand or compares a SAS (`sas.ts`).
// A different master on a pinned nick is an alarm, ignored, never a silent
// replace; only the user re-pinning moves a pin. Each master keeps the highest
// list of its devices that it signed and we accepted, and a device is trusted
// only through the master pinned to the nick it writes from: listed there, or
// certified by it for a list version above the stored one; not revoked; and
// its own signature (S1) covering that very master.
//
// Our own other devices (siblings, issue 2430 S1) get a copy of each text
// this device sends, on a path of their own: they come from our master's
// list, never from a pin, their curves are never bound to a nick, and their
// keys come from grappa's claim door, never from a KEYREQ (`setSiblings`,
// `copy`, `siblingKeys`). What they copy to us is read on that path too
// (`receiveCopy`), never on the peer path, which keeps refusing our own
// master.
//
// State: ALL of it is `E2eState`, plain JSON the caller seals and stores with
// the account, in one record, under the slot's lock — irc-olm's in-memory
// parts too (messages waiting for keys, when keys were last asked for, the
// plaintexts kept for a re-send after a NACK). Every cic tab drains the same
// inbox, and the tab that takes a KEYS or a NACK off it must see what
// another tab asked for or sent; queued messages also survive a reload. The
// engine changes the state in place: build one per locked operation.

import { frameBudgetForTarget } from "../frameBudget";
import type { E2eKeysWireDevice } from "../wireTypes";
import type { OwnIdentity } from "./accountStore";
import { idBlock } from "./keyBundle";
import type { Olm } from "./olm";
import type { SasRecord } from "./sas";
import type { Account, Session } from "./vodozemac/vodozemac_binding";
import {
  base64Unpadded,
  type CopyInner,
  certSigText,
  decodePayload,
  did,
  encodePayload,
  fb,
  fold,
  type IdBlock,
  idSigText,
  type KeysEntry,
  type KeysPayload,
  linesNeeded,
  MAX_DEVICES,
  MAX_FRAGMENTS,
  type MasterList,
  type MessageVerb,
  OTK_SIG_PREFIX,
  PayloadError,
  type PkmsgPayload,
  parseKeys,
  parseMasterList,
  parseMsg,
  parseNack,
  parsePkmsg,
  type ReceiveVerb,
  type SendVerb,
  unbase64,
  validMasterList,
  validVer,
  WIRE_VERSION,
} from "./wire";

/** At most one KEYREQ per nick in this long (ms), whatever a KEYS does in between. */
export const KEYREQ_RETRY_MS = 30_000;
/**
 * Queued plaintext waiting for keys is dropped (reported) after this long: a
 * re-asked KEYREQ may wait out the budget (30 s), and its KEYS then takes as
 * long as 38 s for four devices (2430 amendment O2(c)).
 */
export const OUTQ_TTL_MS = 90_000;
export const OUTQ_MAX = 16;
/** At most one re-key after NACKs per nick per minute, however many of its devices NACK (W "Sending"). */
export const REKEY_INTERVAL_MS = 60_000;
/** At most one `listreq` per nick per minute, and one answer per (nick, device) per minute (W). */
export const LISTREQ_INTERVAL_MS = 60_000;
/** Plaintexts kept for a re-send after a NACK. */
export const SENT_MEMORY_MS = 1_800_000;
export const SENT_MAX = 1200;
/** A message goes out at most twice: once, and once more after a NACK. */
export const MAX_SENDS = 2;
export const MAX_SESSIONS_PER_PEER = 5;
export const SEEN_SESSIONS_MAX = 10_000;
/** Inner types that go ahead of text (grappa's `control` priority): an order and its answer. */
const CONTROL_INNER = new Set(["chal", "ack"]);
/** The list traffic, on grappa's `reactive` lane (2430 amendment O4). */
const REACTIVE_INNER = new Set(["list", "listreq"]);
/**
 * The tag of the engine's own list traffic (`t:list`, `t:listreq`): its
 * payloads carry it for `sent()` and `discard()`, and nothing is ever
 * reported about it, since no caller wrote it. `send` refuses it to a caller.
 */
export const LIST_TAG = "list";

/** The lane of grappa's send door a payload takes (CLIENT_PROTOCOL §4f). */
type Priority = "control" | "reactive" | "text";

/**
 * A message on its way: the inner message, as the JSON Olm encrypts (our
 * `lv` in it; a pre-key body adds `fb`), and the caller's tag for it, which
 * every event and payload about it carries back. `id` names the message
 * itself, which every copy and re-send of it shares, whatever its tag.
 * `expiresAt` is an order's answer deadline (unix seconds): an ACK carries
 * its CHAL's, everything else none.
 */
type Outgoing = {
  id: string;
  plaintext: string;
  priority: Priority;
  sends: number;
  tag: string;
  expiresAt: number | null;
};
/** A device of a peer, as a master's list names it: its keys, its master, its did. */
export type PeerDevice = {
  ed25519: string;
  curve25519: string;
  master: string;
  did: string;
  /**
   * A pre-key message built to us on that curve decrypted, so the device holds
   * the curve; an id block alone only claims it.
   */
  proven: boolean;
  /**
   * The list version its master's certificate for it names, as the pre-key
   * message that bound it presented it, its signature verified then; null
   * when none was seen (bound from a KEYS).
   */
  certVer: number | null;
};

/** A peer's master: the trust placed in it, and the highest list accepted from it. */
export type Master = {
  /** The nick it was first pinned to: a hint for a human, never used to attribute anything. */
  nick: string;
  /** Pinned by the user, or confirmed by a SAS; else trusted on first use. */
  verified: boolean;
  /** The stored list's version; 0 before one is accepted. */
  ver: number;
  /** The stored list: Ed25519 keys of the devices it vouches for. */
  devices: string[];
  /**
   * Keys an accepted list named and the stored one no longer does (rule 5), and the
   * curves of those bound under this master.
   */
  revoked: string[];
  revokedCurves: string[];
};

/** A peer's master before any list of its was accepted: `ver` 0 is below every list. */
function newMaster(nick: string, verified: boolean): Master {
  return { nick, verified, ver: 0, devices: [], revoked: [], revokedCurves: [] };
}

/**
 * Waiting for keys. `master` is the master it is meant for, "" whatever master
 * answers; `only` the one device (Ed25519 key) of it it is for, null all;
 * `done` the devices (Ed25519 keys) it already went to, which it never goes
 * to again. Whether the message is lost is never read off `done`: it is
 * asked across every copy of it (`pending`).
 */
type Queued = {
  nick: string;
  master: string;
  only: string | null;
  done: string[];
  msg: Outgoing;
  at: number;
};
/**
 * Handed to grappa; `msgid` once grappa named it (`sent()`), as a NACK refers
 * to it. `devices` are the devices it was encrypted to, by did, each with the
 * session it went out on.
 */
type Sent = {
  ref: string;
  msgid: string | null;
  nick: string;
  master: string;
  devices: Record<string, { ed25519: string; sessionId: string }>;
  msg: Outgoing;
  at: number;
};
/**
 * A sibling: another device on our own master's list, its did and its curve
 * (`setSiblings`, or the first copy it sent us: `receiveCopy`).
 */
type Sibling = { did: string; curve25519: string };
/** The copy of a text this device sent `peer`, waiting since `at` for a sibling's keys. */
type WaitingCopy = { peer: string; body: string; at: number };

export type E2eState = {
  v: 2;
  /** Master Ed25519 key → its stored list and the trust placed in it. */
  masters: Record<string, Master>;
  /** Device Ed25519 key → the device. */
  devices: Record<string, PeerDevice>;
  /** Folded nick → the master pinned to it. */
  pins: Record<string, string>;
  /** Curve25519 → session pickles, newest first. */
  sessions: Record<string, string[]>;
  /** Session ids already opened from a pre-key message, oldest first. */
  seen: string[];
  /** Folded nick → messages waiting for keys, oldest first. */
  outq: Record<string, Queued[]>;
  /** Folded nick → when a KEYREQ last went to it: the budget, which a KEYS never resets. */
  keyreqSentAt: Record<string, number>;
  /** Folded nicks a KEYS is due from: a KEYREQ went and no KEYS answered it yet. */
  keysAwaited: Record<string, true>;
  /** Folded nick → when it was last re-keyed after a NACK. */
  rekeyAt: Record<string, number>;
  /**
   * Device Ed25519 keys that NACKed their newest session: none of their
   * sessions is sent on until a KEYS opens a fresh one (W: "no working
   * session"), whatever older ones they hold.
   */
  rekeying: Record<string, true>;
  /** Folded nick → when a `listreq` last went to it, and for which `lv`s. */
  listreqAt: Record<string, { at: number; lv: number[] }>;
  /**
   * Folded nick → nick: the `listreq` a pin or a SAS asked of it (O1) that
   * has not gone yet, the per-nick minute or a missing line budget holding it
   * back; `tick` sends it.
   */
  listreqHeld: Record<string, string>;
  /** `${folded nick} ${did}` → when a `listreq` from that device was last answered. */
  listAnsweredAt: Record<string, number>;
  /** Oldest first. */
  sent: Sent[];
  /** The next name the engine gives out: a message's id, a payload's ref. */
  nextRef: number;
  /**
   * The last inbox id processed (`client.ts`). Not the engine's: kept here so
   * it is stored with what processing that message changed, in one record.
   */
  inbox: number;
  /** Master Ed25519 key → the SAS running with it (`sas.ts`): its public half. */
  sas: Record<string, SasRecord>;
  /**
   * Device Ed25519 key → our sibling of that key. Its sessions are in
   * `sessions` with every other; a sibling is never in `devices`, and so
   * never bound to a nick.
   */
  siblings: Record<string, Sibling>;
  /** Sibling Ed25519 key → the copies waiting for its keys, oldest first. */
  copyq: Record<string, WaitingCopy[]>;
};

export function newState(): E2eState {
  return {
    v: 2,
    masters: {},
    devices: {},
    pins: {},
    sessions: {},
    seen: [],
    outq: {},
    keyreqSentAt: {},
    keysAwaited: {},
    rekeyAt: {},
    rekeying: {},
    listreqAt: {},
    listreqHeld: {},
    listAnsweredAt: {},
    sent: [],
    nextRef: 1,
    inbox: 0,
    sas: {},
    siblings: {},
    copyq: {},
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
  | "non-canonical-key"
  | "undecodable-inner"
  | "inner-without-type"
  | "unknown-nack-ref"
  | "bad-list"
  | "listreq-rate-limited"
  | "revoked-device"
  | "unlisted-device"
  | "stale-certificate"
  | "bad-cert"
  | "not-for-us"
  | "inner-key-mismatch"
  | "bad-from"
  | "sibling-gone"
  | "sibling-no-keys"
  | "sibling-not-ours"
  | "sibling-bad-signature"
  | "sibling-unknown"
  | "sibling-undecryptable"
  | "sibling-not-a-copy";

export type SendFailure =
  | "own-nick"
  | "unencodable"
  | "queue-full"
  | "keys-timeout"
  | "too-long"
  | "no-budget"
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

/**
 * What happened. `inner` is plaintext: never log it. A `received` names the
 * master pinned to the nick and the device of it that wrote; a `key_alarm`
 * names the master pinned to the nick and the other one presented. A
 * `dropped` names the nick what it dropped came from: our own nick for
 * something of our own account's, and the nick of the chat for a copy to a
 * sibling that goes unsent. A `sibling_keys_needed` asks the caller to claim
 * a key of our sibling `did` (grappa's claim door) and hand what came, or
 * null, to `siblingKeys`. A `copied` is the text `body` our sibling `device`
 * (its Ed25519 key) sent `peer`: plaintext too, never log it.
 */
export type E2eEvent =
  | {
      kind: "received";
      nick: string;
      master: string;
      device: string;
      verified: boolean;
      inner: Record<string, unknown>;
    }
  | { kind: "key_alarm"; nick: string; pinned: string; presented: string }
  | { kind: "undecryptable"; nick: string; msgid: string; reason: UndecryptableReason }
  | { kind: "replayed"; nick: string; sessionId: string }
  | { kind: "dropped"; nick: string; reason: DropReason; verb?: ReceiveVerb; detail?: string }
  | { kind: "send_queued"; nick: string; queued: number; tag: string }
  | { kind: "send_failed"; nick: string; reason: SendFailure; tags: string[] }
  | { kind: "rekeying"; nick: string; master: string; device: string }
  | { kind: "sibling_keys_needed"; did: string }
  | { kind: "copied"; peer: string; body: string; device: string };

/**
 * A payload for grappa's send door, `from` this device's did `to` a did or
 * `*` (CLIENT_PROTOCOL §4f). `ref` and `tag` are set on a PKMSG/MSG that
 * carries a message: report grappa's msgid for it with `sent()` (a NACK
 * names it), or `discard()` it when grappa refused the send. `expiresAt` is
 * set on the one that answers an order: the door's `expires_at`, past which
 * grappa drops it unsent.
 */
export type Outbound = {
  target: string;
  verb: SendVerb;
  from: string;
  to: string;
  payload: string;
  priority: Priority;
  ref?: string;
  tag?: string;
  expiresAt?: number;
};

export type Result = { events: E2eEvent[]; outbound: Outbound[] };

/**
 * A copy for grappa's copy door (`Door.copy`, CLIENT_PROTOCOL §4f): a PKMSG
 * or MSG payload whose one body is for the sibling `to` (its did). No NACK
 * ever names a copy, so nothing of it is kept to send again.
 */
export type SiblingCopy = { to: string; verb: MessageVerb; payload: string };

/** What a step that can encrypt copies answers: a `Result`, and the copies, one per sibling and text. */
export type CopyResult = Result & { copies: SiblingCopy[] };

/** What `pin` made of a key: pinned, not a key in vodozemac's spelling, or our own master. */
export type PinOutcome = "pinned" | "bad-key" | "own-key";

function emptyResult(): Result {
  return { events: [], outbound: [] };
}

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

/** The lane an inner message takes: an order and its answer ahead of text, the list traffic its own. */
function priorityOf(inner: Record<string, unknown>): Priority {
  if (typeof inner.t !== "string") return "text";
  if (CONTROL_INNER.has(inner.t)) return "control";
  return REACTIVE_INNER.has(inner.t) ? "reactive" : "text";
}

/** An inner message's JSON with the binding `fb` added, as a pre-key body carries it (rev 2). */
function withBinding(plaintext: string, binding: string): string {
  return JSON.stringify({ ...(JSON.parse(plaintext) as Record<string, unknown>), fb: binding });
}

/** `items` in order, cut into runs of at most `size`. */
function chunked<T>(items: T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let i = 0; i < items.length; i += size) runs.push(items.slice(i, i + size));
  return runs;
}

/** A body encrypted on a session, advanced in memory only; a pre-key one when `preKey`. */
type Encrypted = { session: Session; preKey: boolean; body: string };
/** One device's body of a message, on its newest session. */
type Body = Encrypted & { device: PeerDevice };

/** A message a step could not send for `reason`, to be judged once the step is done (`end`). */
type Loss = { nick: string; reason: SendFailure; msg: Outgoing };

export class Engine {
  /** What this step could not send, each message once, under the first reason it met. */
  private losses: Loss[] = [];

  constructor(
    private readonly olm: Olm,
    /** This device's Olm account. */
    private readonly account: Account,
    /** This device's place in the identity: the master peers pin, its certificate, its list. */
    private readonly own: OwnIdentity,
    private readonly state: E2eState,
    /** Our nick on the network now: never a peer (`send` refuses it). */
    private readonly ownNick: string,
    /**
     * The network's `frame_budget_base` as grappa published it (#1108), null
     * before it has (no live upstream session). Less the target's length
     * (`frameBudgetForTarget`), it is what one line leaves for a payload: it
     * sizes every message before a session moves.
     */
    private readonly frameBudgetBase: number | null,
    private readonly now: () => number,
  ) {}

  // --- our identity ------------------------------------------------------

  /** Our master Ed25519 key: what a peer pins, and what the user is shown as our key. */
  fingerprint(): string {
    return this.own.master;
  }

  /** This device's Ed25519 key: what its id block names, and a SAS binds. */
  deviceKey(): string {
    return this.account.ed25519_key();
  }

  /** The version of our master's list this device holds (`own.list`): it moves when a device joins or goes. */
  listVersion(): number {
    return this.own.list.ver;
  }

  /** This device's Curve25519 key: what a SAS binds besides the Ed25519 one. */
  curve(): string {
    return this.account.curve25519_key();
  }

  // --- pins --------------------------------------------------------------

  /**
   * The master pinned to `nick`, whether it is verified, and how many of its
   * devices are trusted. Only the nick's own pin counts (rule 2): a master
   * last seen under another nick is not reached here.
   */
  pinned(nick: string): { master: string; verified: boolean; devices: number } | undefined {
    const master = this.state.pins[fold(nick)];
    const record = master === undefined ? undefined : this.state.masters[master];
    if (master === undefined || record === undefined) return undefined;
    return { master, verified: record.verified, devices: this.trustedDevices(master).length };
  }

  /**
   * The device `ed25519` bound under `master` if that master vouches for it
   * now (rule 4: listed, or certified past the stored list, and not revoked).
   * A SAS verifies a master only through such a device (W "SAS").
   */
  trusted(master: string, ed25519: string): PeerDevice | undefined {
    return this.trustedDevices(master).find((device) => device.ed25519 === ed25519);
  }

  /**
   * Pins the master `master` to `nick` by hand: the one way a pin moves to
   * another master (`checkMaster` never does it). `verified` when the user
   * pasted the key the peer printed (a bot prints its master: 2430 ruling
   * 6253162964); not when the user only took a master the alarm showed, which
   * a SAS then verifies (fork 7, 2430 comment 6339695571). Taking a master
   * never unverifies it. A master never seen has no list until its first
   * valid block; one seen before keeps its list (rule 3). The master the nick
   * leaves loses its devices' sessions (rule 6) once no nick is pinned to it
   * any more, as irc-olm's `set_pins` does: another nick still reaches it. The
   * key is the one spelling vodozemac prints: 43 characters of unpadded
   * standard base64. A pin also asks the nick for its master's list (2430
   * amendment O1, `requestList`): a bot challenges an order only on a session
   * our device has written to, and this message is what gives it one; its
   * answer comes back on it.
   */
  pin(nick: string, master: string, verified: boolean): Result & { outcome: PinOutcome } {
    const res = emptyResult();
    let canonical: string;
    try {
      canonical = rejecting(() => this.olm.canonical_ed25519(master));
    } catch (err) {
      if (!(err instanceof Rejected)) throw err;
      return { ...res, outcome: "bad-key" };
    }
    if (canonical !== master) return { ...res, outcome: "bad-key" };
    if (master === this.own.master) return { ...res, outcome: "own-key" };
    const key = fold(nick);
    const before = this.state.pins[key];
    const known = this.state.masters[master];
    if (known === undefined) this.state.masters[master] = newMaster(nick, verified);
    else known.verified ||= verified;
    this.state.pins[key] = master;
    if (before !== undefined && !Object.values(this.state.pins).includes(before)) {
      for (const device of Object.values(this.state.devices)) {
        if (device.master === before) this.dropSessions(device);
      }
    }
    this.askList(nick, res);
    return { ...this.end(res), outcome: "pinned" };
  }

  /**
   * A SAS with `nick` confirmed `master` (`sas.ts`): verified, under every
   * nick pinned to it. `nick` is asked for the master's list too, as a pin
   * asks (O1), if it is still pinned to that master (rule 2).
   */
  verify(nick: string, master: string): Result {
    const res = emptyResult();
    const record = this.state.masters[master];
    if (record === undefined) return res;
    record.verified = true;
    if (this.state.pins[fold(nick)] === master) this.askList(nick, res);
    return this.end(res);
  }

  // --- sending -----------------------------------------------------------

  /**
   * Encrypt `inner` now for every trusted device of the master pinned to
   * `nick` that holds a working session, and queue it, asking for keys, for
   * every trusted device that has none (all of them on first contact). A nick
   * with no pin, or a master with no list yet, is asked for keys too: whatever
   * master answers is pinned on first use. `only` is the one device (its
   * Ed25519 key) the message is for, null every device: a SAS step after the
   * start, an ACK to the device its CHAL came from. `tag` is the caller's
   * name for the message: whatever happens to it later, in this call or
   * another, names it by its tag. `expiresAt` is the answer deadline of the
   * order an ACK answers (unix seconds), null for anything else. The inner
   * message goes out with our list's version as its `lv`, and without any
   * `lv` or `fb` the caller put in it: both are the engine's to write.
   */
  send(
    nick: string,
    inner: Record<string, unknown>,
    tag: string,
    expiresAt: number | null,
    only: string | null,
  ): Result {
    // A caller's message under it would go unreported, and pass for ours.
    if (tag === LIST_TAG) throw new Error(`the tag ${LIST_TAG} is the engine's own`);
    const res = emptyResult();
    this.dispatch(nick, inner, tag, expiresAt, only, res);
    return this.end(res);
  }

  /** `send`'s work: true when the message went to a device or waits for keys, false when refused (reported). */
  private dispatch(
    nick: string,
    inner: Record<string, unknown>,
    tag: string,
    expiresAt: number | null,
    only: string | null,
    res: Result,
  ): boolean {
    const refuse = (reason: SendFailure): false => {
      this.failed(nick, reason, [tag], res);
      return false;
    };
    if (frameBudgetForTarget(this.frameBudgetBase, nick) === null) {
      // No line budget yet (no live upstream session): nothing could be
      // sized, so nothing is queued and no KEYREQ goes to a dead door.
      return refuse("no-budget");
    }
    if (fold(nick) === fold(this.ownNick)) {
      // grappa would answer our own KEYREQ with our own identity, which
      // `checkMaster` refuses: say so now rather than after a minute.
      return refuse("own-nick");
    }
    let plaintext: string;
    try {
      // Encoded once, here: past this point nothing can fail on it, in a
      // queue flush or a re-send least of all.
      const { lv: _lv, fb: _fb, ...theirs } = inner;
      plaintext = JSON.stringify({ ...theirs, lv: this.own.list.ver });
    } catch {
      return refuse("unencodable");
    }
    const msg: Outgoing = {
      id: String(this.state.nextRef++),
      plaintext,
      priority: priorityOf(inner),
      sends: 1,
      tag,
      expiresAt,
    };
    const master = this.state.pins[fold(nick)];
    return master === undefined
      ? this.enqueue(nick, "", only, [], msg, res)
      : this.sendTo(nick, master, only, [], msg, res);
  }

  /** grappa accepted the send of `ref` as `msgid`: a NACK may name it. */
  sent(ref: string, msgid: string): void {
    const record = this.state.sent.find((s) => s.ref === ref && s.msgid === null);
    if (record !== undefined) record.msgid = msgid;
  }

  /**
   * grappa refused the send of `ref`: it never left, so no NACK will name it.
   * One message can be several payloads (a MSG and a PKMSG, more than
   * `MAX_DEVICES` devices), and a copy of it can still wait for keys: answers
   * who it was for and the caller's tag once nothing of it is on its way or
   * waiting (`pending`), so it reached no device; undefined while something
   * is, for a ref it does not know, and for the engine's own list traffic.
   */
  discard(ref: string): { nick: string; tag: string } | undefined {
    const record = this.state.sent.find((s) => s.ref === ref);
    if (record === undefined) return undefined;
    this.state.sent = this.state.sent.filter((s) => s !== record);
    const { id, tag } = record.msg;
    return this.pending(id) || tag === LIST_TAG ? undefined : { nick: record.nick, tag };
  }

  /**
   * The user deleted the chat with `nick`: what the engine still holds of it
   * in the clear goes too. A message waiting for keys is never sent, nor is a
   * copy of one waiting for a sibling's keys, and a NACK for a sent one finds
   * nothing to re-send (`unknown-nack-ref`). Trust stays: the pin, the
   * verification and the sessions.
   */
  forget(nick: string): void {
    const key = fold(nick);
    delete this.state.outq[key];
    this.state.sent = this.state.sent.filter((s) => fold(s.nick) !== key);
    for (const [ed25519, waiting] of Object.entries(this.state.copyq)) {
      const rest = waiting.filter((c) => fold(c.peer) !== key);
      if (rest.length > 0) this.state.copyq[ed25519] = rest;
      else delete this.state.copyq[ed25519];
    }
  }

  /**
   * grappa dropped `msgid` after accepting it (`e2e_send_dropped`): it never
   * left whole, so no NACK will name it. As `discard`: who the message was for
   * and the caller's tag once nothing of it is left on its way or waiting;
   * undefined while something is, and for a msgid this device did not send
   * (the push reaches every client of the user) or no longer remembers.
   */
  dropped(msgid: string): { nick: string; tag: string } | undefined {
    const record = this.state.sent.find((s) => s.msgid === msgid);
    return record === undefined ? undefined : this.discard(record.ref);
  }

  /**
   * `msg` now to the devices of `master` ready for it, past those in `done`
   * (it went to them already), and queued for the ones that are not, keys
   * asked for. True when it went to a device or waits; what cannot go is
   * reported (`lost`), and the answer is false.
   */
  private sendTo(
    nick: string,
    master: string,
    only: string | null,
    done: string[],
    msg: Outgoing,
    res: Result,
  ): boolean {
    const { ready, lacking } = this.split(master, only, done);
    // A message grappa would refuse is refused for every device.
    const refused = ready.length > 0 ? this.encrypt(nick, master, ready, msg, res) : undefined;
    if (refused !== undefined) {
      this.lost(nick, refused, [msg]);
      return false;
    }
    const reached = [...done, ...ready.map((d) => d.ed25519)];
    // Without a list, a KEYS brings it: a message for every device waits for
    // it, one for a single device only if it reached nothing.
    if (lacking.length > 0 || (!this.listHeld(master) && (only === null || ready.length === 0))) {
      return this.enqueue(nick, master, only, reached, msg, res) || ready.length > 0;
    }
    if (ready.length > 0) return true;
    // `only` names a device this master does not vouch for: no KEYS brings it.
    this.lost(nick, "unpinned-key", [msg]);
    return false;
  }

  /**
   * The devices of `master` a message for `only` (null: every one) is still
   * for, past those in `done`: the trusted ones with a working session
   * (`ready`, it goes to them now), and the rest of those it vouches for
   * (`lacking`, Ed25519 keys: a KEYS may bring them a session): its listed
   * keys, bound or not, and the devices bound under it that a certificate
   * admits, as irc-olm's `wanted()`.
   */
  private split(
    master: string,
    only: string | null,
    done: string[],
  ): { ready: PeerDevice[]; lacking: string[] } {
    const due = (key: string): boolean => (only === null || key === only) && !done.includes(key);
    const trusted = this.trustedDevices(master);
    const ready = trusted.filter((device) => due(device.ed25519) && this.working(device));
    const wanted = new Set([
      ...(this.state.masters[master]?.devices ?? []),
      ...trusted.map((device) => device.ed25519),
    ]);
    const lacking = [...wanted].filter(
      (key) => due(key) && !ready.some((device) => device.ed25519 === key),
    );
    return { ready, lacking };
  }

  /** Whether `device` holds a session we may write on: none while it is re-keyed after a NACK. */
  private working(device: PeerDevice): boolean {
    return (
      this.state.rekeying[device.ed25519] !== true && this.sessionsOf(device.curve25519).length > 0
    );
  }

  /** Whether a list of `master`'s devices was accepted: without one, a KEYS brings it. */
  private listHeld(master: string): boolean {
    return (this.state.masters[master]?.ver ?? 0) > 0;
  }

  /**
   * Queues `msg` for the devices it has not gone to (`done`), and asks for
   * keys under the budget; false when the queue is full. A message a payload
   * of which went out is not reported as queued, nor as lost when the queue
   * is full (`lost`): it went, and the devices still without a session miss
   * it. The engine's own list traffic is never reported.
   */
  private enqueue(
    nick: string,
    master: string,
    only: string | null,
    done: string[],
    msg: Outgoing,
    res: Result,
  ): boolean {
    const key = fold(nick);
    const q = this.liveQueue(key);
    if (q.length >= OUTQ_MAX) {
      this.lost(nick, "queue-full", [msg]);
      return false;
    }
    q.push({ nick, master, only, done, msg, at: this.now() });
    this.state.outq[key] = q;
    if (msg.tag !== LIST_TAG && !this.wentOut(msg.id)) {
      res.events.push({ kind: "send_queued", nick, queued: q.length, tag: msg.tag });
    }
    this.maybeKeyreq(nick, res);
    return true;
  }

  /** The queue for a folded nick, minus what waited too long (`lost`: judged at the end of the step). */
  private liveQueue(key: string): Queued[] {
    const q = this.state.outq[key] ?? [];
    const live = q.filter((x) => x.at > this.now() - OUTQ_TTL_MS);
    if (live.length > 0) this.state.outq[key] = live;
    else delete this.state.outq[key];
    const first = q[0];
    if (first !== undefined) {
      this.lost(
        first.nick,
        "keys-timeout",
        q.filter((x) => !live.includes(x)).map((x) => x.msg),
      );
    }
    return live;
  }

  /** A KEYREQ to `nick`, unless one went less than `KEYREQ_RETRY_MS` ago. */
  private maybeKeyreq(nick: string, res: Result): void {
    const key = fold(nick);
    const last = this.state.keyreqSentAt[key];
    if (last !== undefined && this.now() - last < KEYREQ_RETRY_MS) return;
    this.state.keyreqSentAt[key] = this.now();
    this.state.keysAwaited[key] = true;
    res.outbound.push({
      target: nick,
      verb: "keyreq",
      from: this.own.did,
      to: "*",
      payload: encodePayload({ v: WIRE_VERSION }),
      priority: "control",
    });
  }

  /**
   * A `listreq` to `nick`, for `only` (null: every device of its master): at
   * most once per nick a minute (W "After any decrypt"), however it is asked
   * for. `lv` is the list version a device announced (null: a pin or a SAS
   * asks), asked for at most once until a list that new is stored: never a
   * high-water mark, or one device announcing a huge `lv` would silence every
   * other (irc-olm `_maybe_listreq`). It goes the way any message goes, so it
   * waits behind the keys it asks for when there is no session (O1). True
   * when it went or waits: only then are the minute and the `lv` spent.
   */
  private requestList(nick: string, only: string | null, lv: number | null, res: Result): boolean {
    const key = fold(nick);
    const master = this.state.pins[key];
    const ver = master === undefined ? 0 : (this.state.masters[master]?.ver ?? 0);
    const last = this.state.listreqAt[key];
    const asked = (last?.lv ?? []).filter((v) => v > ver);
    if (last !== undefined) last.lv = asked;
    if (lv !== null && asked.includes(lv)) return false;
    if (last !== undefined && this.now() - last.at < LISTREQ_INTERVAL_MS) return false;
    if (!this.dispatch(nick, { t: "listreq" }, LIST_TAG, null, only, res)) return false;
    this.state.listreqAt[key] = { at: this.now(), lv: lv === null ? asked : [...asked, lv] };
    return true;
  }

  /**
   * A pin or a SAS asks `nick` for its list (O1): to every device of the
   * master pinned to it when it goes. The minute another listreq spent (one
   * to a single device, or one for a master the alarm replaced), or a missing
   * line budget, holds it back, never away: `tick` asks again until it goes.
   * Our own nick is never asked (`dispatch` refuses it), so its ask, a pin's
   * or one held for a nick we took since, goes: held, it would wait on the
   * clock for good.
   */
  private askList(nick: string, res: Result): void {
    const key = fold(nick);
    if (key === fold(this.ownNick)) {
      delete this.state.listreqHeld[key];
      return;
    }
    if (this.requestList(nick, null, null, res)) delete this.state.listreqHeld[key];
    else this.state.listreqHeld[key] = nick;
  }

  /**
   * `msg` to each of `devices` (trusted, each with a working session) on its
   * newest session: one body per device, the normal ones in MSGs and the
   * pre-key ones in PKMSGs (rev 2: never both kinds in one message), at most
   * `MAX_DEVICES` bodies each, each `to` its device's did when it holds one
   * body, else `*`; every one of them gets its own msgid. A pre-key body names
   * both devices (`fb`). Sized before anything is stored: a message grappa
   * would refuse (413), or one it cannot be sized for yet, leaves every
   * session where it was, so no peer has a message key to skip; the answer is
   * why (the caller reports it), else undefined.
   */
  private encrypt(
    nick: string,
    master: string,
    devices: PeerDevice[],
    msg: Outgoing,
    res: Result,
  ): "no-budget" | "too-long" | undefined {
    const lineBudget = frameBudgetForTarget(this.frameBudgetBase, nick);
    if (lineBudget === null) return "no-budget";
    const sessions: Session[] = [];
    try {
      const bodies = devices.map((device): Body => {
        const encrypted = this.encryptOn(device.curve25519, device.ed25519, msg.plaintext);
        sessions.push(encrypted.session);
        return { ...encrypted, device };
      });
      // The MSG first: a device that answered on its session is one in use.
      // A message holds `MAX_DEVICES` bodies, and a master's trusted devices
      // can be more: a full list, and the devices certificates admit past
      // it. Each kind goes in as many messages as it fills.
      const messages = [false, true].flatMap((preKey) =>
        chunked(
          bodies.filter((b) => b.preKey === preKey),
          MAX_DEVICES,
        ).flatMap((group) => {
          const [first] = group;
          if (first === undefined) return [];
          const wire = Object.fromEntries(group.map((b) => [b.device.did, b.body]));
          return [
            {
              ...this.wireOf(preKey, wire),
              to: group.length === 1 ? first.device.did : "*",
              group,
            },
          ];
        }),
      );
      if (
        messages.some(
          (m) => linesNeeded(m.verb, m.payload, lineBudget, this.own.did, m.to) > MAX_FRAGMENTS,
        )
      ) {
        return "too-long";
      }
      for (const b of bodies) this.sessionsOf(b.device.curve25519)[0] = b.session.pickle();
      for (const { verb, to, payload, group } of messages) {
        const ref = String(this.state.nextRef++);
        this.state.sent.push({
          ref,
          msgid: null,
          nick,
          master,
          devices: Object.fromEntries(
            group.map((b) => [
              b.device.did,
              { ed25519: b.device.ed25519, sessionId: b.session.session_id() },
            ]),
          ),
          msg,
          at: this.now(),
        });
        res.outbound.push({
          target: nick,
          verb,
          from: this.own.did,
          to,
          payload,
          priority: msg.priority,
          ref,
          tag: msg.tag,
          ...(typeof msg.expiresAt === "number" ? { expiresAt: msg.expiresAt } : {}),
        });
      }
      return undefined;
    } finally {
      for (const session of sessions) session.free();
    }
  }

  /**
   * `plaintext`, an inner message's JSON, encrypted to the device `ed25519`
   * on the newest session to its curve `curve`. The session is advanced in
   * memory only: the caller stores its pickle if the body goes, and frees it
   * either way. Until the device has answered on it, the session writes
   * pre-key messages, and the inner message of one names both devices (`fb`).
   */
  private encryptOn(curve: string, ed25519: string, plaintext: string): Encrypted {
    const newest = this.sessionsOf(curve)[0];
    if (newest === undefined) throw new Error(`no session to encrypt on for ${ed25519}`);
    const session = this.olm.Session.from_pickle(newest);
    try {
      const preKey = !session.has_received_message();
      const inner = preKey
        ? withBinding(plaintext, fb(this.olm, this.account.ed25519_key(), ed25519))
        : plaintext;
      const encrypted = session.encrypt(encoder.encode(inner));
      const kind = encrypted.message_type;
      const body = base64Unpadded(encrypted.body);
      encrypted.free();
      if ((kind === 0) !== preKey) throw new Error("a session wrote another kind of message");
      return { session, preKey, body };
    } catch (err) {
      session.free();
      throw err;
    }
  }

  /**
   * The payload of `bodies` (did → body) from this device: all of them
   * pre-key bodies, in a PKMSG presenting our master's certificate and our id
   * block, or all normal ones, in a MSG (rev 2: never both kinds in one).
   */
  private wireOf(
    preKey: boolean,
    bodies: Record<string, string>,
  ): { verb: MessageVerb; payload: string } {
    if (!preKey) {
      return {
        verb: "msg",
        payload: encodePayload({ v: WIRE_VERSION, ck: this.account.curve25519_key(), bodies }),
      };
    }
    return {
      verb: "pkmsg",
      payload: encodePayload({
        v: WIRE_VERSION,
        id: idBlock(this.account, this.own.master),
        master: { ed25519: this.own.master, cert: this.own.cert, ver: this.own.certVer },
        bodies,
      }),
    };
  }

  // --- siblings (S1: a copy of each text sent, to our own other devices) ---

  /**
   * Our siblings, from what grappa lists of our account's devices (`GET
   * …/e2e/devices`), none of which is taken on grappa's word. A device is one
   * only if our master's list (`own.list`) names its key, it is not this
   * device, and its id block is signed under our master (S1); its did is the
   * one its key gives, whatever grappa printed beside it. A device the list
   * names whose block fails its signature is reported: only a lie makes one.
   * Each is admitted (`admit`). A sibling no longer present is forgotten
   * (`forgetSibling`). Our list can move without this being called again (a
   * relist, a list adopted from another device), so every step that reaches a
   * sibling asks it again (`listedSiblings`).
   */
  setSiblings(blocks: E2eKeysWireDevice[]): Result {
    const res = emptyResult();
    const siblings: Record<string, Sibling> = {};
    for (const block of blocks) {
      // Registered and not on our list (yet: a device being paired).
      if (!this.ourListNames(block.ed25519)) continue;
      const siblingDid = did(this.olm, block.ed25519);
      if (siblingDid === this.own.did) continue;
      if (!this.idSigned(block, this.own.master)) {
        res.events.push({ kind: "dropped", nick: this.ownNick, reason: "sibling-bad-signature" });
        continue;
      }
      siblings[block.ed25519] = this.admit(block.ed25519, block.curve25519, siblingDid);
    }
    for (const [ed25519, known] of Object.entries(this.state.siblings)) {
      if (siblings[ed25519]?.curve25519 !== known.curve25519)
        this.forgetSibling(ed25519, known, res);
    }
    this.state.siblings = siblings;
    return this.end(res);
  }

  /**
   * The sibling of key `ed25519` on the curve `curve25519`, its did
   * `siblingDid`. A peer's device bound to that curve (a claim from before
   * the sibling was known: `curveRefusal` refuses one since) is unbound with
   * its sessions, as a proof evicts a claim: our master's word on the curve
   * is stronger still. Without that, a peer's session to the curve would sit
   * among the sibling's, and a copy on it read as that peer's.
   */
  private admit(ed25519: string, curve25519: string, siblingDid: string): Sibling {
    this.evictClaimant(curve25519, ed25519);
    return { did: siblingDid, curve25519 };
  }

  /** Whether our master's list (`own.list`) names `ed25519`: the one word on who our siblings are. */
  private ourListNames(ed25519: string): boolean {
    return this.own.list.devices.includes(ed25519);
  }

  /** Our siblings that our list still names; one it no longer names is forgotten (`forgetSibling`). */
  private listedSiblings(res: Result): [string, Sibling][] {
    return Object.entries(this.state.siblings).filter(([ed25519, sibling]) => {
      if (this.ourListNames(ed25519)) return true;
      this.forgetSibling(ed25519, sibling, res);
      return false;
    });
  }

  /** Our sibling `ed25519` is no more: its sessions go, and the copies waiting for its keys go unsent (`sibling-gone`). */
  private forgetSibling(ed25519: string, sibling: Sibling, res: Result): void {
    delete this.state.siblings[ed25519];
    delete this.state.sessions[sibling.curve25519];
    this.dropCopies(ed25519, "sibling-gone", res);
  }

  /**
   * A copy of the text `body` this device sent `peer`, for each sibling:
   * `{t:"copy", peer, body}` encrypted to it on its newest session, `fb`
   * added on a pre-key body as for a peer. A sibling with no session gets it
   * once its keys come (`siblingKeys`): it waits, at most `OUTQ_TTL_MS`, and
   * its keys are asked for (`sibling_keys_needed`) when nothing waited for
   * it yet, so once while anything does. Call it only once grappa took the
   * text: one it refused reaches no device.
   */
  copy(peer: string, body: string): CopyResult {
    const res: CopyResult = { ...emptyResult(), copies: [] };
    for (const [ed25519, sibling] of this.listedSiblings(res)) {
      const pending = [...this.liveCopies(ed25519, res), { peer, body, at: this.now() }];
      if (this.sessionsOf(sibling.curve25519).length > 0) {
        this.sendCopies(ed25519, sibling, pending, res);
        continue;
      }
      if (pending.length === 1) res.events.push({ kind: "sibling_keys_needed", did: sibling.did });
      this.state.copyq[ed25519] = pending;
    }
    return this.end(res);
  }

  /**
   * What claiming a key of our sibling `siblingDid` brought (grappa's claim
   * door): its KEYS text, or null when none came. Only a sibling our own list
   * still names is one (`listedSiblings`): a list in the KEYS, however
   * validly signed, never brings back one ours left out. The KEYS opens a
   * session to the sibling, unless it holds one, only if its master is ours,
   * its list our master's own word (`validMasterList`) and naming the
   * sibling, and its entry the very sibling `setSiblings` admitted, its id
   * block signed under our master (S1) and its one-time key by the sibling
   * (S2). Anything else is reported, from our own nick, and opens nothing.
   * Then what waits for the sibling goes, in order, if it holds a session;
   * else it goes unsent (`sibling-no-keys`): nothing would bring keys for it
   * now. A did that names no sibling opens nothing either. Never throws on
   * wire input.
   */
  siblingKeys(siblingDid: string, keys: string | null): CopyResult {
    const res: CopyResult = { ...emptyResult(), copies: [] };
    const found = this.listedSiblings(res).find(([, s]) => s.did === siblingDid);
    if (found === undefined) {
      if (keys !== null) {
        res.events.push({
          kind: "dropped",
          nick: this.ownNick,
          reason: "sibling-unknown",
          verb: "keys",
        });
      }
      return this.end(res);
    }
    const [ed25519, sibling] = found;
    const pending = this.liveCopies(ed25519, res);
    if (keys !== null) this.openToSibling(ed25519, sibling, keys, res);
    if (this.sessionsOf(sibling.curve25519).length > 0) {
      this.sendCopies(ed25519, sibling, pending, res);
    } else {
      this.dropCopies(ed25519, "sibling-no-keys", res);
    }
    return this.end(res);
  }

  /** A session to our sibling `ed25519` on the KEYS text `keys`, unless it holds one; a refusal is reported. */
  private openToSibling(ed25519: string, sibling: Sibling, keys: string, res: Result): void {
    let payload: KeysPayload;
    try {
      payload = parseKeys(decodePayload(keys));
    } catch (err) {
      if (!(err instanceof PayloadError)) throw err;
      res.events.push({
        kind: "dropped",
        nick: this.ownNick,
        reason: "bad-payload",
        verb: "keys",
        detail: err.message,
      });
      return;
    }
    const entry = this.siblingEntry(ed25519, sibling, payload);
    if (typeof entry === "string") {
      res.events.push({ kind: "dropped", nick: this.ownNick, reason: entry, verb: "keys" });
    } else if (this.sessionsOf(sibling.curve25519).length === 0) {
      this.outboundSession(this.ownNick, entry, res);
    }
  }

  /**
   * The entry of a claim's KEYS that opens a session to our sibling
   * `ed25519`, one our own list names (`listedSiblings`), or why none does: a
   * master not ours, a list our master did not sign, no entry with the very
   * keys `setSiblings` admitted, a signature that fails (S1, S2). The KEYS's
   * list must name the sibling too: our master's word, a newer one than ours
   * maybe, can only take a sibling away here, never add one.
   */
  private siblingEntry(
    ed25519: string,
    sibling: Sibling,
    { master, devices }: KeysPayload,
  ): KeysEntry | DropReason {
    if (master.ed25519 !== this.own.master) return "sibling-not-ours";
    if (!validMasterList(this.olm, master)) return "sibling-bad-signature";
    const entry = devices.find((e) => e.id.ed25519 === ed25519);
    if (
      entry === undefined ||
      entry.id.curve25519 !== sibling.curve25519 ||
      !master.list.devices.includes(ed25519)
    ) {
      return "sibling-unknown";
    }
    if (!this.idSigned(entry.id, this.own.master) || !this.otkSigned(entry)) {
      return "sibling-bad-signature";
    }
    return entry;
  }

  /** `pending`, in order, to our sibling `ed25519`, which holds a session: nothing of it waits on. */
  private sendCopies(
    ed25519: string,
    sibling: Sibling,
    pending: WaitingCopy[],
    res: CopyResult,
  ): void {
    delete this.state.copyq[ed25519];
    for (const { peer, body } of pending) {
      const inner: CopyInner = { t: "copy", peer, body };
      const encrypted = this.encryptOn(sibling.curve25519, ed25519, JSON.stringify(inner));
      try {
        this.sessionsOf(sibling.curve25519)[0] = encrypted.session.pickle();
      } finally {
        encrypted.session.free();
      }
      res.copies.push({
        to: sibling.did,
        ...this.wireOf(encrypted.preKey, { [sibling.did]: encrypted.body }),
      });
    }
  }

  /** The copies waiting for our sibling `ed25519`'s keys, minus those that waited `OUTQ_TTL_MS` (`sibling-no-keys`). */
  private liveCopies(ed25519: string, res: Result): WaitingCopy[] {
    const waiting = this.state.copyq[ed25519] ?? [];
    const live = waiting.filter((c) => c.at > this.now() - OUTQ_TTL_MS);
    for (const { peer } of waiting.filter((c) => !live.includes(c))) {
      res.events.push({ kind: "dropped", nick: peer, reason: "sibling-no-keys" });
    }
    if (live.length > 0) this.state.copyq[ed25519] = live;
    else delete this.state.copyq[ed25519];
    return live;
  }

  /** The copies waiting for our sibling `ed25519`'s keys go unsent, each reported for `reason`. */
  private dropCopies(ed25519: string, reason: DropReason, res: Result): void {
    for (const { peer } of this.state.copyq[ed25519] ?? []) {
      res.events.push({ kind: "dropped", nick: peer, reason });
    }
    delete this.state.copyq[ed25519];
  }

  /**
   * A copy one of our siblings sent us, from its device `fromDid` (an item
   * of grappa's inbox flagged `own`): a PKMSG or a MSG whose body for this
   * device holds `{t:"copy", peer, body}`, the text that sibling sent `peer`.
   * grappa can fill our inbox only on our own account's behalf, and is
   * trusted with no content all the same: a copy is read only from a sibling
   * our own list names now (`listedSiblings`, which forgets one it no longer
   * names, whatever grappa lists). A PKMSG must present our master, pass the
   * checks a peer's passes (`presented`: its certificate under our master,
   * its device's S1 over its curve and our master, the frame's `from` that
   * device's did), and come from a device our list names; only then is a
   * session opened, its `fb` checked, and the sibling known by the curve the
   * session proved. A MSG must come on the curve of such a sibling, from its
   * did. Every refusal is reported, from our own nick, and leaves no new
   * session; none is ever NACKed: a copy has no way back. Never throws on
   * wire input.
   */
  receiveCopy(fromDid: string, verb: MessageVerb, payload: string): Result {
    const res = emptyResult();
    const siblings = this.listedSiblings(res);
    const drop = (reason: DropReason): void => {
      res.events.push({ kind: "dropped", nick: this.ownNick, reason, verb });
    };
    this.guarded(this.ownNick, verb, payload, res, (decoded) => {
      if (verb === "pkmsg") this.onCopyPkmsg(fromDid, decoded, drop, res);
      else this.onCopyMsg(fromDid, decoded, siblings, drop, res);
    });
    return this.end(res);
  }

  /**
   * `receiveCopy`'s PKMSG: a sibling's first copy on a session it opens to
   * us, or another one before it heard back on it, read on that session. The
   * new session is kept, and the sibling known (`admit`), only once its copy
   * is read: a body built for another pair of devices, or one that is no
   * copy, leaves neither behind, its session's id only seen, as a peer's
   * (`openInbound`). Every check before the session opens leaves nothing.
   */
  private onCopyPkmsg(
    fromDid: string,
    payload: Record<string, unknown>,
    drop: (reason: DropReason) => void,
    res: Result,
  ): void {
    const pkmsg = parsePkmsg(payload);
    const { id } = pkmsg;
    if (pkmsg.master.ed25519 !== this.own.master) {
      drop("sibling-not-ours");
      return;
    }
    const body = this.presented(fromDid, pkmsg);
    if (typeof body === "string") {
      drop(
        body === "bad-cert" || body === "bad-identity-signature" ? "sibling-bad-signature" : body,
      );
      return;
    }
    if (!this.ourListNames(id.ed25519)) {
      drop("sibling-unknown");
      return;
    }
    const sessionId = rejecting(() => this.olm.pre_key_session_id(body));
    const held = this.heldSession(id.curve25519, sessionId);
    if (held !== undefined) {
      const plaintext = this.decryptWith(id.curve25519, held, 0, body);
      if (plaintext === undefined) drop("sibling-undecryptable");
      else this.readCopy(id.ed25519, plaintext, true, res);
      return;
    }
    const opened = this.openInbound(id.curve25519, body, sessionId);
    if (typeof opened === "string") {
      drop("sibling-undecryptable");
      return;
    }
    const { session, plaintext } = opened;
    try {
      if (!this.readCopy(id.ed25519, plaintext, true, res)) return;
      // Admitted first: it evicts a peer's claim on the curve with every
      // session on it, which the new one must not be among.
      this.state.siblings[id.ed25519] = this.admit(id.ed25519, id.curve25519, fromDid);
      this.addSession(id.curve25519, session.pickle());
    } finally {
      session.free();
    }
  }

  /** `receiveCopy`'s MSG: a copy on a session both ends used, on the curve of one of `siblings`. */
  private onCopyMsg(
    fromDid: string,
    payload: Record<string, unknown>,
    siblings: [string, Sibling][],
    drop: (reason: DropReason) => void,
    res: Result,
  ): void {
    const msg = parseMsg(payload);
    const curve = rejecting(() => this.olm.canonical_curve25519(msg.ck));
    const found = siblings.find(([, sibling]) => sibling.curve25519 === curve);
    if (found === undefined) {
      drop("sibling-unknown");
      return;
    }
    const [ed25519, sibling] = found;
    if (sibling.did !== fromDid) {
      drop("bad-from");
      return;
    }
    const mine = msg.bodies[this.own.did];
    if (mine === undefined) {
      drop("not-for-us");
      return;
    }
    const plaintext = this.decryptAny(curve, unbase64(mine));
    if (plaintext === undefined) drop("sibling-undecryptable");
    else this.readCopy(ed25519, plaintext, false, res);
  }

  /**
   * The copy in a body our sibling `device` encrypted to us, handed on as
   * `copied`: its inner message (`inner`, which checks that a pre-key body's
   * `fb` binds the sibling to this device) must be `{t:"copy", peer, body}`,
   * with a non-empty `peer` and a string `body`. Anything else is reported,
   * and the answer is false.
   */
  private readCopy(device: string, plaintext: Uint8Array, preKey: boolean, res: Result): boolean {
    const inner = this.inner(this.ownNick, plaintext, preKey ? device : null, res);
    if (inner === undefined) return false;
    const { t, peer, body } = inner;
    if (t !== "copy" || typeof peer !== "string" || peer === "" || typeof body !== "string") {
      res.events.push({ kind: "dropped", nick: this.ownNick, reason: "sibling-not-a-copy" });
      return false;
    }
    res.events.push({ kind: "copied", peer, body, device });
    return true;
  }

  // --- receiving ---------------------------------------------------------

  /**
   * A whole message grappa delivered from `nick`'s device `fromDid` (the
   * frame's `from`: a did, `*` on a KEYS). Never throws on wire input.
   */
  receive(
    nick: string,
    verb: ReceiveVerb,
    msgid: string,
    fromDid: string,
    payload: string,
  ): Result {
    const res = emptyResult();
    const read = this.guarded(nick, verb, payload, res, (decoded) => {
      switch (verb) {
        case "keys":
          this.onKeys(nick, decoded, res);
          break;
        case "pkmsg":
          this.onPkmsg(nick, msgid, fromDid, decoded, res);
          break;
        case "msg":
          this.onMsg(nick, msgid, fromDid, decoded, res);
          break;
        case "nack":
          this.onNack(nick, fromDid, decoded, res);
          break;
      }
    });
    return read ? this.end(res) : res;
  }

  /**
   * `step` on `payload`, a whole message grappa delivered, decoded; false
   * when it does not decode (reported, from `nick`). A payload missing a
   * field, or a key or body vodozemac refuses, is malformed input from the
   * wire, never a reason to crash: reported too. Nothing else is caught.
   */
  private guarded(
    nick: string,
    verb: ReceiveVerb,
    payload: string,
    res: Result,
    step: (decoded: Record<string, unknown>) => void,
  ): boolean {
    let decoded: Record<string, unknown>;
    try {
      decoded = decodePayload(payload);
    } catch (err) {
      if (!(err instanceof PayloadError)) throw err;
      res.events.push({ kind: "dropped", nick, reason: "undecodable-payload", verb });
      return false;
    }
    try {
      step(decoded);
    } catch (err) {
      if (!(err instanceof PayloadError || err instanceof Rejected)) throw err;
      res.events.push({ kind: "dropped", nick, reason: "bad-payload", verb, detail: err.message });
    }
    return true;
  }

  /**
   * W "Receiver checks / KEYS", in order. One we did not ask for is dropped
   * unread (1). A malformed one (2), or one whose master block is invalid
   * (3), is dropped too, and what waits for keys waits on. Its master must be
   * the one pinned to the nick, or is pinned now (4); else nothing is opened,
   * and what waited for keys goes nowhere. Its list is applied (5), then each
   * device's first entry is judged (6), and a session opened to each usable
   * one that has none: the other one-time keys stay unused. What waited goes
   * to every device it has not reached yet and is ready for it now; what is
   * still for a device without a session waits on, and keys are asked for
   * again when the budget allows (`tick`).
   */
  private onKeys(nick: string, payload: Record<string, unknown>, res: Result): void {
    const key = fold(nick);
    if (this.state.keysAwaited[key] !== true) {
      res.events.push({ kind: "dropped", nick, reason: "unsolicited-keys", verb: "keys" });
      return;
    }
    const keys = parseKeys(payload);
    if (!validMasterList(this.olm, keys.master)) {
      res.events.push({ kind: "dropped", nick, reason: "bad-list", verb: "keys" });
      return;
    }
    const master = keys.master.ed25519;
    // The KEYREQ is answered; its budget stands (`maybeKeyreq`).
    delete this.state.keysAwaited[key];
    if (this.checkMaster(nick, master, res) === "alarm") {
      const queue = this.liveQueue(key);
      delete this.state.outq[key];
      this.lost(
        nick,
        "key-mismatch",
        queue.map((q) => q.msg),
      );
      return;
    }
    this.applyList(master, keys.master.list);
    const judged = new Set<string>();
    for (const entry of keys.devices) {
      if (judged.has(entry.id.ed25519)) continue;
      judged.add(entry.id.ed25519);
      this.openSession(nick, master, entry, res);
    }
    this.flush(nick, master, res);
  }

  /**
   * What waits for keys from `nick`, to every device of `master` it has not
   * reached and that is ready for it now: one more holds a session, which a
   * KEYS opened or the device's own pre-key message did. Each queued message
   * goes to the master it was meant for, or nowhere: the nick may have been
   * re-pinned since. One queued before the nick had any pin goes to
   * `master`. What is still for a device without a session waits on; what
   * cannot go is `lost`.
   */
  private flush(nick: string, master: string, res: Result): void {
    const key = fold(nick);
    const queue = this.liveQueue(key);
    delete this.state.outq[key];
    const waiting: Queued[] = [];
    for (const q of queue) {
      if (q.master !== master && q.master !== "") {
        this.lost(nick, "key-mismatch", [q.msg]);
        continue;
      }
      const { ready, lacking } = this.split(master, q.only, q.done);
      const refused = ready.length > 0 ? this.encrypt(nick, master, ready, q.msg, res) : undefined;
      if (refused !== undefined) {
        // Too long for its devices now (a pre-key body is longer), or unsized.
        this.lost(nick, refused, [q.msg]);
        continue;
      }
      const done = [...q.done, ...ready.map((d) => d.ed25519)];
      if (lacking.length > 0) waiting.push({ ...q, master, done });
      // Gone to every device it was for; or, reaching none, it was for a
      // device this master's list does not name.
      else this.lost(nick, "unpinned-key", [q.msg]);
    }
    if (waiting.length > 0) this.state.outq[key] = waiting;
  }

  /**
   * KEYS check 6 for the first entry of one device: usable if the device is
   * trusted (rule 4: `refusal`, then the curve rules) and signed its one-time
   * key (S2). A usable device with no working session gets one: none, or only
   * ones it NACKed the newest of (W "Sending"; irc-olm's `_ready`). It is
   * bound only once it has it (an id block only claims its curve). A skipped
   * entry is reported.
   */
  private openSession(nick: string, master: string, entry: KeysEntry, res: Result): void {
    const { id } = entry;
    const reason =
      this.refusal(master, id) ??
      this.curveRefusal(id, false) ??
      (this.otkSigned(entry) ? undefined : "bad-otk-signature");
    if (reason !== undefined) {
      res.events.push({ kind: "dropped", nick, reason, verb: "keys" });
      return;
    }
    if (this.state.rekeying[id.ed25519] !== true && this.sessionsOf(id.curve25519).length > 0) {
      return;
    }
    if (!this.outboundSession(nick, entry, res)) return;
    delete this.state.rekeying[id.ed25519];
    const known = this.state.devices[id.ed25519];
    this.state.devices[id.ed25519] = {
      ed25519: id.ed25519,
      curve25519: id.curve25519,
      master,
      did: did(this.olm, id.ed25519),
      proven: known?.proven ?? false,
      certVer: known?.certVer ?? null,
    };
  }

  /**
   * A new session to the device of a KEYS entry, on its one-time key, stored
   * as the newest to its curve; false when vodozemac refuses the keys,
   * reported as a malformed KEYS from `nick`.
   */
  private outboundSession(nick: string, { id, otk }: KeysEntry, res: Result): boolean {
    let session: Session;
    try {
      session = rejecting(() => this.account.create_outbound_session(id.curve25519, otk.key));
    } catch (err) {
      if (!(err instanceof Rejected)) throw err;
      res.events.push({
        kind: "dropped",
        nick,
        reason: "bad-payload",
        verb: "keys",
        detail: err.message,
      });
      return false;
    }
    try {
      this.addSession(id.curve25519, session.pickle());
    } finally {
      session.free();
    }
    return true;
  }

  /**
   * Notes that a copy of each message of `msgs` could not go, for `reason`.
   * Whether the message is lost is judged once the whole step is done
   * (`end`), when every copy it queued and every payload it dropped is where
   * it stays: a message is noted once per step, under the first reason the
   * step met for it.
   */
  private lost(nick: string, reason: SendFailure, msgs: Outgoing[]): void {
    for (const msg of msgs) {
      if (this.losses.some((loss) => loss.msg.id === msg.id)) continue;
      this.losses.push({ nick, reason, msg });
    }
  }

  /**
   * The end of a step (each public call that answers a `Result`): reports
   * every message it noted (`lost`) that nothing of is pending any more: no
   * payload of it held (a device has it) and no copy of it waiting for keys.
   * One `send_failed` per nick and reason, in the order they were met. Old
   * plaintexts are forgotten (`trimSent`) only then: a record trimmed first
   * would read as no device holding its message.
   */
  private end<R extends Result>(res: R): R {
    const losses = this.losses;
    this.losses = [];
    const reports = new Map<string, { nick: string; reason: SendFailure; tags: string[] }>();
    for (const { nick, reason, msg } of losses) {
      if (this.pending(msg.id)) continue;
      const key = `${reason} ${nick}`;
      const report = reports.get(key) ?? { nick, reason, tags: [] };
      report.tags.push(msg.tag);
      reports.set(key, report);
    }
    for (const { nick, reason, tags } of reports.values()) this.failed(nick, reason, tags, res);
    this.trimSent();
    return res;
  }

  /** `tags` lost for `reason`; the engine's own list traffic is nobody's to hear about. */
  private failed(nick: string, reason: SendFailure, tags: string[], res: Result): void {
    const theirs = tags.filter((tag) => tag !== LIST_TAG);
    if (theirs.length > 0) res.events.push({ kind: "send_failed", nick, reason, tags: theirs });
  }

  /** Whether something of the message `id` is on its way (`wentOut`) or waits for keys. */
  private pending(id: string): boolean {
    return (
      this.wentOut(id) ||
      Object.values(this.state.outq).some((queue) => queue.some((q) => q.msg.id === id))
    );
  }

  /** Whether a payload of the message `id` is held: it went to a device that has not NACKed it. */
  private wentOut(id: string): boolean {
    return this.state.sent.some((s) => s.msg.id === id);
  }

  /**
   * W "Receiver checks / PKMSG" as revision 2 amends it, in order: the first
   * check that fails decides.
   * 1-4. `presented`, which a sibling's copy passes too. Both signatures come
   *    before 5, `checkMaster`: no pin and no alarm ever comes from a block
   *    that fails its own signature.
   * 6. A revoked device, or one the stored list leaves out whose certificate
   *    names a version that list has reached (`standing`, its S1 good by
   *    now): dropped with no NACK and no alarm (rule 5).
   * 7. The curve rules, as a pre-key message, which proves its curve.
   * A pre-key message on a session it opened before goes to that session.
   * 8. One whose session was opened before and is gone is a replay, or a peer
   *    still writing on a session we lost: NACKed, never opened again.
   * 9. A session it cannot open is NACKed.
   * 10. Its inner `fb` must bind its device to this one: else the new session
   *    goes, and its id stays seen.
   * The device of a session it opened is bound, proven, and is sent at once
   * what waited for it (`flush`), so nothing newer overtakes it.
   */
  private onPkmsg(
    nick: string,
    msgid: string,
    fromDid: string,
    payload: Record<string, unknown>,
    res: Result,
  ): void {
    const pkmsg = parsePkmsg(payload);
    const { id, master: block } = pkmsg;
    const master = block.ed25519;
    const drop = (reason: DropReason): void => {
      res.events.push({ kind: "dropped", nick, reason, verb: "pkmsg" });
    };
    const body = this.presented(fromDid, pkmsg);
    if (typeof body === "string") {
      drop(body);
      return;
    }
    if (this.checkMaster(nick, master, res) === "alarm") return;
    const reason = this.standing(master, id.ed25519, block.ver) ?? this.curveRefusal(id, true);
    if (reason !== undefined) {
      drop(reason);
      return;
    }
    const sessionId = rejecting(() => this.olm.pre_key_session_id(body));
    // Bound, it is bound to this very curve (`curveRefusal`).
    const bound = this.state.devices[id.ed25519];
    const held = bound === undefined ? undefined : this.heldSession(id.curve25519, sessionId);
    if (bound !== undefined && held !== undefined) {
      const plaintext = this.decryptWith(id.curve25519, held, 0, body);
      if (plaintext === undefined) {
        this.undecryptable(nick, msgid, fromDid, "decryption-failed", res);
        return;
      }
      const inner = this.inner(nick, plaintext, id.ed25519, res);
      if (inner !== undefined) this.deliver(nick, master, bound, inner, res);
      return;
    }
    const opened = this.openInbound(id.curve25519, body, sessionId);
    if (typeof opened === "string") {
      // A NACK lets a peer that lost the session recover, and gives a
      // replayer only a NACK for a msgid not its own.
      if (opened === "replayed-session") res.events.push({ kind: "replayed", nick, sessionId });
      this.undecryptable(nick, msgid, fromDid, opened, res);
      return;
    }
    const { session, plaintext } = opened;
    try {
      const inner = this.inner(nick, plaintext, id.ed25519, res);
      // Built for another pair of devices, or unreadable: the session goes.
      if (inner === undefined) return;
      const device = this.bindProven(master, id, block.ver);
      this.addSession(id.curve25519, session.pickle());
      this.deliver(nick, master, device, inner, res);
    } finally {
      session.free();
    }
    this.flush(nick, master, res);
  }

  /**
   * W "Receiver checks / MSG", after the body for this device (none: a `*`
   * message to our other devices, never NACKed). 2. A curve the master pinned
   * to the nick revoked: dropped with no NACK. 3. The curve of a trusted
   * device of that master: the frame's `from` must be its did, and what its
   * sessions cannot read is NACKed. 4. A curve bound under another master:
   * dropped. 5. A curve never seen: NACKed. Our state was lost, or a new
   * identity writes from a nick that had a pin; the NACK makes the sender
   * open a fresh session with its id block, which the pin, or trust on first
   * use, then judges.
   */
  private onMsg(
    nick: string,
    msgid: string,
    fromDid: string,
    payload: Record<string, unknown>,
    res: Result,
  ): void {
    const msg = parseMsg(payload);
    const curve = rejecting(() => this.olm.canonical_curve25519(msg.ck));
    const drop = (reason: DropReason): void => {
      res.events.push({ kind: "dropped", nick, reason, verb: "msg" });
    };
    const mine = msg.bodies[this.own.did];
    if (mine === undefined) {
      drop("not-for-us");
      return;
    }
    const body = unbase64(mine);
    const master = this.state.pins[fold(nick)];
    const record = master === undefined ? undefined : this.state.masters[master];
    if (record?.revokedCurves.includes(curve)) {
      drop("revoked-device");
      return;
    }
    const device =
      master === undefined
        ? undefined
        : this.trustedDevices(master).find((d) => d.curve25519 === curve);
    if (master !== undefined && device !== undefined) {
      if (device.did !== fromDid) {
        drop("bad-from");
        return;
      }
      // Nothing about the device moves before a decrypt succeeds: `ck` is
      // public, and anyone can put it on a line.
      const plaintext = this.decryptAny(curve, body);
      if (plaintext === undefined) {
        const reason = this.sessionsOf(curve).length === 0 ? "no-session" : "decryption-failed";
        this.undecryptable(nick, msgid, fromDid, reason, res);
        return;
      }
      const inner = this.inner(nick, plaintext, null, res);
      if (inner !== undefined) this.deliver(nick, master, device, inner, res);
      return;
    }
    if (Object.values(this.state.devices).some((d) => d.curve25519 === curve)) {
      drop("unpinned-key");
      return;
    }
    this.undecryptable(nick, msgid, fromDid, "no-session", res);
  }

  /**
   * The checks a PKMSG passes whoever wrote it, a peer or a sibling (W
   * "Receiver checks / PKMSG" 1-4, in order): 1. both keys in vodozemac's one
   * spelling, and the frame's `from` the did of the device the id block
   * names; 2. a body for this device (none: a `*` message to our other
   * devices, never ours, so it gets no NACK); 3. the certificate, under the
   * master presented, over the list version it names; 4. the device's S1
   * over its curve and that master. The body for this device, or the first
   * check that fails.
   */
  private presented(
    fromDid: string,
    { id, master, bodies }: PkmsgPayload,
  ):
    | Uint8Array
    | "non-canonical-key"
    | "bad-from"
    | "not-for-us"
    | "bad-cert"
    | "bad-identity-signature" {
    if (!this.canonical(id) || !this.ed25519Canonical(master.ed25519)) return "non-canonical-key";
    if (did(this.olm, id.ed25519) !== fromDid) return "bad-from";
    const mine = bodies[this.own.did];
    if (mine === undefined) return "not-for-us";
    const body = unbase64(mine);
    if (!this.sigOk(master.ed25519, certSigText(master.ver, id.ed25519), master.cert)) {
      return "bad-cert";
    }
    if (!this.idSigned(id, master.ed25519)) return "bad-identity-signature";
    return body;
  }

  /** The session to `curve` that a pre-key message of the session `sessionId` was written on, if one is held. */
  private heldSession(curve: string, sessionId: string): string | undefined {
    return this.sessionsOf(curve).find((p) => this.sessionId(p) === sessionId);
  }

  /**
   * A new session from the pre-key message `body` (of the session
   * `sessionId`) of the device of `curve`, and the plaintext it carried; or
   * why none: its session was opened before (a fallback-key PKMSG opens the
   * same session again, and would deliver an old plaintext again), or
   * vodozemac cannot open it. Its id is seen from then on, whatever becomes
   * of the session: the caller stores it, or not, and frees it.
   */
  private openInbound(
    curve: string,
    body: Uint8Array,
    sessionId: string,
  ): { session: Session; plaintext: Uint8Array } | "replayed-session" | "session-creation" {
    if (this.state.seen.includes(sessionId)) return "replayed-session";
    let created: ReturnType<Account["create_inbound_session"]>;
    try {
      created = rejecting(() => this.account.create_inbound_session(curve, body));
    } catch (err) {
      if (!(err instanceof Rejected)) throw err;
      return "session-creation";
    }
    const session = created.take_session();
    const plaintext = created.plaintext();
    created.free();
    if (session === undefined) throw new Error("an inbound session is taken once, here");
    this.state.seen.push(sessionId);
    if (this.state.seen.length > SEEN_SESSIONS_MAX) {
      this.state.seen.splice(0, this.state.seen.length - SEEN_SESSIONS_MAX);
    }
    return { session, plaintext };
  }

  /**
   * `body`, a message of `messageType`, decrypted on the session `pickle` to
   * `curve`, which becomes the newest to it: the session the device just
   * used is the one to answer on. Undefined when that session cannot, and
   * then nothing moves.
   */
  private decryptWith(
    curve: string,
    pickle: string,
    messageType: 0 | 1,
    body: Uint8Array,
  ): Uint8Array | undefined {
    const session = this.olm.Session.from_pickle(pickle);
    try {
      let plaintext: Uint8Array;
      try {
        plaintext = rejecting(() => session.decrypt(messageType, body));
      } catch (err) {
        if (!(err instanceof Rejected)) throw err;
        return undefined;
      }
      const rest = this.sessionsOf(curve).filter((p) => p !== pickle);
      this.state.sessions[curve] = [session.pickle(), ...rest];
      return plaintext;
    } finally {
      session.free();
    }
  }

  /** A normal message `body` decrypted on the first session to `curve`, newest first, that can (`decryptWith`). */
  private decryptAny(curve: string, body: Uint8Array): Uint8Array | undefined {
    for (const pickle of [...this.sessionsOf(curve)]) {
      const plaintext = this.decryptWith(curve, pickle, 1, body);
      if (plaintext !== undefined) return plaintext;
    }
    return undefined;
  }

  /**
   * The inner message of a decrypted body, its `fb` taken off; undefined
   * (reported) when it is not a typed JSON object, or when a pre-key body's
   * `fb` does not bind `sender`, its device, to this one: a message built for
   * another device, or claimed by another one (rev 2).
   */
  private inner(
    nick: string,
    plaintext: Uint8Array,
    sender: string | null,
    res: Result,
  ): Record<string, unknown> | undefined {
    let inner: unknown;
    try {
      inner = JSON.parse(decoder.decode(plaintext));
    } catch {
      res.events.push({ kind: "dropped", nick, reason: "undecodable-inner" });
      return undefined;
    }
    if (
      typeof inner !== "object" ||
      inner === null ||
      Array.isArray(inner) ||
      typeof (inner as Record<string, unknown>).t !== "string"
    ) {
      res.events.push({ kind: "dropped", nick, reason: "inner-without-type" });
      return undefined;
    }
    const { fb: binding, ...rest } = inner as Record<string, unknown>;
    if (sender !== null && binding !== fb(this.olm, sender, this.account.ed25519_key())) {
      res.events.push({ kind: "dropped", nick, reason: "inner-key-mismatch" });
      return undefined;
    }
    return rest;
  }

  /**
   * A decrypted inner message from `device` of `master`, the master pinned to
   * `nick`: a `t:list` or a `t:listreq` is the engine's own and never handed
   * on; anything else is, without its `lv`. W "After any decrypt": an `lv`
   * above the version of the list stored for the master, read once a `t:list`
   * in the very message is applied, asks that device for its list.
   */
  private deliver(
    nick: string,
    master: string,
    device: PeerDevice,
    inner: Record<string, unknown>,
    res: Result,
  ): void {
    const { lv, ...rest } = inner;
    if (rest.t === "list") {
      this.onList(nick, rest, res);
    } else if (rest.t === "listreq") {
      this.onListreq(nick, device, res);
    } else {
      const verified = this.state.masters[master]?.verified === true;
      res.events.push({
        kind: "received",
        nick,
        master,
        device: device.ed25519,
        verified,
        inner: rest,
      });
    }
    if (validVer(lv) && lv > (this.state.masters[master]?.ver ?? 0)) {
      this.requestList(nick, device.ed25519, lv, res);
    }
  }

  /**
   * A `t:list`: the KEYS steps 3-5 (W "After any decrypt"). An invalid list
   * is dropped; one of another master than the one pinned to `nick`, which
   * the device writing it was bound under, is the alarm; else rule 3.
   */
  private onList(nick: string, inner: Record<string, unknown>, res: Result): void {
    const block = inner.master;
    let list: MasterList | undefined;
    try {
      if (typeof block === "object" && block !== null && !Array.isArray(block)) {
        list = parseMasterList(block as Record<string, unknown>);
      }
    } catch (err) {
      if (!(err instanceof PayloadError)) throw err;
    }
    if (list === undefined || !validMasterList(this.olm, list)) {
      res.events.push({ kind: "dropped", nick, reason: "bad-list" });
      return;
    }
    if (this.checkMaster(nick, list.ed25519, res) === "alarm") return;
    this.applyList(list.ed25519, list.list);
  }

  /**
   * A `t:listreq` from `device`: our list, to that device alone, at most once
   * per (nick, device) a minute; another ask within that minute is dropped.
   */
  private onListreq(nick: string, device: PeerDevice, res: Result): void {
    const now = this.now();
    for (const [asker, at] of Object.entries(this.state.listAnsweredAt)) {
      if (now - at >= LISTREQ_INTERVAL_MS) delete this.state.listAnsweredAt[asker];
    }
    const asker = `${fold(nick)} ${device.did}`;
    if (this.state.listAnsweredAt[asker] !== undefined) {
      res.events.push({ kind: "dropped", nick, reason: "listreq-rate-limited" });
      return;
    }
    this.state.listAnsweredAt[asker] = now;
    const { ver, devices, sig } = this.own.list;
    const master = { ed25519: this.own.master, list: { ver, devices }, sig };
    this.dispatch(nick, { t: "list", master }, LIST_TAG, null, device.ed25519, res);
  }

  /**
   * Binds the device of `id` under `master`, proven: a pre-key message built
   * to us on its curve decrypted, under the certificate at `certVer` it
   * carried. The proof evicts another device's claim on that curve, with the
   * sessions opened on the claim (`curveRefusal` let it through only if that
   * one is unproven).
   */
  private bindProven(master: string, id: IdBlock, certVer: number): PeerDevice {
    this.evictClaimant(id.curve25519, id.ed25519);
    const device: PeerDevice = {
      ed25519: id.ed25519,
      curve25519: id.curve25519,
      master,
      did: did(this.olm, id.ed25519),
      proven: true,
      certVer,
    };
    this.state.devices[id.ed25519] = device;
    return device;
  }

  /** Unbinds the device of another key than `ed25519` bound to `curve`, with the sessions opened on its claim. */
  private evictClaimant(curve: string, ed25519: string): void {
    const claimant = Object.values(this.state.devices).find(
      (d) => d.curve25519 === curve && d.ed25519 !== ed25519,
    );
    if (claimant === undefined) return;
    delete this.state.devices[claimant.ed25519];
    this.dropSessions(claimant);
  }

  /**
   * W "Receiver checks / NACK" as revision 2 has it: the device `fromDid`
   * could not decrypt its body of our message `ref`. Acted on only if that
   * message went to that very device, NACKs being unauthenticated, and each
   * device's NACK of it once. Never on the word of another nick, nor for a
   * nick pinned to another master since, nor for a device its master no
   * longer vouches for (no re-key, no re-send: dropped). A copy goes out at
   * most `MAX_SENDS` times. The session it failed on goes. If that was the
   * device's newest, only a fresh one helps: the device is re-keyed, which
   * takes a KEYREQ (under its own budget, `maybeKeyreq`); a NACK while keys
   * are already asked for joins them, and otherwise at most one re-key per
   * nick a minute starts, however many devices NACK. The copy then goes again
   * to that device alone, on its newest session or once the keys come. A copy
   * that cannot go again, a disowned device's included, is `lost`: the
   * message is reported only if nothing else of it is pending.
   */
  private onNack(
    nick: string,
    fromDid: string,
    payload: Record<string, unknown>,
    res: Result,
  ): void {
    const drop = (reason: DropReason): void => {
      res.events.push({ kind: "dropped", nick, reason, verb: "nack" });
    };
    const { ref } = parseNack(payload);
    this.trimSent();
    const sent = this.state.sent.find((s) => s.msgid === ref);
    const body = sent?.devices[fromDid];
    if (sent === undefined || body === undefined) {
      drop("unknown-nack-ref");
      return;
    }
    delete sent.devices[fromDid];
    if (Object.keys(sent.devices).length === 0) {
      this.state.sent = this.state.sent.filter((s) => s !== sent);
    }
    const lose = (reason: SendFailure, to: string): void => this.lost(to, reason, [sent.msg]);
    if (fold(sent.nick) !== fold(nick)) {
      // Never re-sent on the word of a nick it did not go to. The recipient
      // renamed, most likely.
      lose("nack-from-another-nick", sent.nick);
      return;
    }
    if (this.state.pins[fold(nick)] !== sent.master) {
      lose("repinned", nick);
      return;
    }
    // It was bound under the master when the message went to it: unbound
    // since, or bound under another one, it is gone as a revoked one is.
    // Nothing goes to it again, so its copy is lost: the message too, if
    // nothing else of it is pending, for a device its master does not vouch
    // for (`unpinned-key`).
    const disowned = (reason: DropReason): void => {
      drop(reason);
      lose("unpinned-key", nick);
    };
    const device = this.state.devices[body.ed25519];
    if (device?.master !== sent.master) {
      disowned("revoked-device");
      return;
    }
    const untrusted = this.standing(sent.master, device.ed25519, device.certVer);
    if (untrusted !== undefined) {
      disowned(untrusted);
      return;
    }
    if (sent.msg.sends >= MAX_SENDS) {
      lose("resend-failed", nick);
      return;
    }
    const newest = this.sessionsOf(device.curve25519)[0];
    if (newest === undefined || this.sessionId(newest) === body.sessionId) {
      const key = fold(nick);
      if (!this.keysUnderWay(key)) {
        const last = this.state.rekeyAt[key];
        if (last !== undefined && this.now() - last < REKEY_INTERVAL_MS) {
          lose("rekey-throttled", nick);
          return;
        }
        this.state.rekeyAt[key] = this.now();
        res.events.push({ kind: "rekeying", nick, master: sent.master, device: device.ed25519 });
      }
      this.state.rekeying[device.ed25519] = true;
    }
    this.dropSession(device.curve25519, body.sessionId);
    // Re-sent to that device alone (the spec's MAY).
    this.sendTo(
      nick,
      sent.master,
      device.ed25519,
      [],
      { ...sent.msg, sends: sent.msg.sends + 1 },
      res,
    );
  }

  /**
   * Whether keys are being asked of the folded nick `key`: a KEYREQ went
   * within the retry and no KEYS answered it, or a re-key started since the
   * last KEYREQ, whose own waits out the budget (`rekeyDue`). A NACK then
   * joins it: the KEYS brings every device's keys.
   */
  private keysUnderWay(key: string): boolean {
    const asked = this.state.keyreqSentAt[key];
    const awaited =
      this.state.keysAwaited[key] === true &&
      asked !== undefined &&
      this.now() - asked < KEYREQ_RETRY_MS;
    return awaited || this.rekeyDue(key);
  }

  /** Whether a re-key of the folded nick `key` started after its last KEYREQ: its own is still to go. */
  private rekeyDue(key: string): boolean {
    const rekeyed = this.state.rekeyAt[key];
    const asked = this.state.keyreqSentAt[key];
    return rekeyed !== undefined && (asked === undefined || rekeyed > asked);
  }

  /**
   * Reports it, and NACKs it from this device to the one it came from: every
   * such message gets its own NACK, since the sender re-sends what is NACKed
   * and a message without one is lost without a word. Only a message of the
   * master pinned to the nick, or on a curve never seen, gets here: one
   * presenting another master is the alarm (PKMSG check 5), one on a curve
   * bound under another master is dropped (MSG check 4). A device's curve and
   * id block are public, and anyone can put them on a line, but the NACK goes
   * back to the nick it came from, and only a sender that holds the keys acts
   * on it.
   *
   * irc-olm NACKs only a message of a pinned master, since a bot talks to
   * nothing else. Here a nick with no pin is where trust on first use would
   * pin one, so a curve never seen is answered too: without that, a peer whose
   * storage was wiped never makes the sender re-key, and the sender never sees
   * the new identity it must raise the alarm for (2430 "Session recovery").
   */
  private undecryptable(
    nick: string,
    msgid: string,
    fromDid: string,
    reason: UndecryptableReason,
    res: Result,
  ): void {
    res.events.push({ kind: "undecryptable", nick, msgid, reason });
    res.outbound.push({
      target: nick,
      verb: "nack",
      from: this.own.did,
      to: fromDid,
      payload: encodePayload({ v: WIRE_VERSION, ref: msgid }),
      priority: "control",
    });
  }

  // --- time --------------------------------------------------------------

  /**
   * Reports queued messages that waited too long for keys, and copies that
   * waited too long for a sibling's (`liveCopies`), asks again for keys
   * (`KEYREQ_RETRY_MS`) where something waits that reached no device or a
   * re-key's KEYREQ is due, sends the list asks held back (`askList`), and
   * forgets old plaintexts.
   */
  tick(): Result {
    const res = emptyResult();
    for (const key of Object.keys(this.state.outq)) {
      // grappa answers a nick's KEYREQ at most so often and drops the rest
      // without a word (`E2eKeyAnswers`). What reached no device asks again,
      // as does a re-key whose KEYREQ waited out the budget; a message a
      // device has waits for the next KEYS without asking.
      const live = this.liveQueue(key);
      const asking =
        live.find((q) => !this.wentOut(q.msg.id)) ?? (this.rekeyDue(key) ? live[0] : undefined);
      if (asking !== undefined) this.maybeKeyreq(asking.nick, res);
    }
    for (const ed25519 of Object.keys(this.state.copyq)) this.liveCopies(ed25519, res);
    for (const nick of Object.values(this.state.listreqHeld)) this.askList(nick, res);
    return this.end(res);
  }

  /**
   * Whether `tick` has something to do, so the caller must come back: a
   * message waiting for keys (a re-key whose KEYREQ is due among them, since
   * its re-send waits in the queue too), a copy waiting for a sibling's, a
   * list ask held back, or a SAS (`sas.ts`), whose time runs out. Forgetting
   * old plaintexts waits for the next call of any kind.
   */
  waitsOnTheClock(): boolean {
    return (
      Object.keys(this.state.outq).length > 0 ||
      Object.keys(this.state.copyq).length > 0 ||
      Object.keys(this.state.listreqHeld).length > 0 ||
      Object.keys(this.state.sas).length > 0
    );
  }

  // --- trust (wire v2 "Trust", rules 1-6) --------------------------------

  /**
   * Rules 1 and 6 for a master a block presented under `nick`; call it only
   * once that block's own signature verified, since no pin and no alarm ever
   * comes from one that does not. "ok" when it is the master pinned to the
   * nick, or when the nick has no pin and it is pinned now, unverified (trust
   * on first use), keeping the list and the verification it had under another
   * nick (rule 3). Otherwise "alarm", and nothing is stored: with a
   * `key_alarm` naming both masters when it is another master (only the user
   * re-pinning moves a pin), with an `own-identity` drop when it is ours.
   * Our master on a peer's nick would make our own other devices that peer's,
   * and our own words, encrypted to them, could come back as its; `pin`
   * refuses it too.
   */
  private checkMaster(nick: string, master: string, res: Result): "ok" | "alarm" {
    if (master === this.own.master) {
      res.events.push({ kind: "dropped", nick, reason: "own-identity" });
      return "alarm";
    }
    const key = fold(nick);
    const pinned = this.state.pins[key];
    if (pinned === master) return "ok";
    if (pinned !== undefined) {
      res.events.push({ kind: "key_alarm", nick, pinned, presented: master });
      return "alarm";
    }
    this.state.masters[master] ??= newMaster(nick, false);
    this.state.pins[key] = master;
    return "ok";
  }

  /**
   * Rule 3 for a valid list of `master`, a master `checkMaster` let through:
   * a higher `ver` replaces the stored list; an equal one changes nothing, as
   * the same keys or as other keys only the master could have signed; a lower
   * one is stale. Rule 5 for what a replacement revokes: a key the stored list
   * named and the new one does not, with its curve when its device is bound
   * under this master. Revoked means listed once and not now, so a key a
   * newer list names again is no longer revoked. Every device bound under
   * this master that it no longer vouches for (`standing`) loses its
   * sessions: a revoked one, and one its certificate admitted once the new
   * list reaches the certificate's version without naming it. Nothing records
   * that verdict: it is read off the versions.
   */
  private applyList(master: string, list: MasterList["list"]): void {
    const record = this.state.masters[master];
    if (record === undefined) throw new Error("a list for a master no pin names");
    if (list.ver <= record.ver) return;
    const leaving = record.devices.filter((key) => !list.devices.includes(key));
    const back = record.revoked.filter((key) => list.devices.includes(key));
    // A list names keys, any keys; only a device's S1 says whose it is, so a
    // device bound under another master keeps its sessions whatever this
    // list does with its key.
    const curves = (keys: string[]): string[] =>
      keys.flatMap((key) => {
        const device = this.state.devices[key];
        return device?.master === master ? [device.curve25519] : [];
      });
    const leavingCurves = curves(leaving);
    const backCurves = curves(back);
    record.revoked = [...record.revoked.filter((key) => !back.includes(key)), ...leaving];
    record.revokedCurves = [
      ...record.revokedCurves.filter((curve) => !backCurves.includes(curve)),
      ...leavingCurves,
    ];
    record.ver = list.ver;
    record.devices = [...list.devices];
    for (const device of Object.values(this.state.devices)) {
      if (
        device.master === master &&
        this.standing(master, device.ed25519, device.certVer) !== undefined
      ) {
        this.dropSessions(device);
      }
    }
  }

  /**
   * Rule 4 for the devices already bound: those bound under `master` that it
   * still vouches for (`standing`), listed or certified. Each one's S1 was
   * checked against this master when it was bound, which is why a device
   * bound under another master is never one of them, whatever this master
   * lists.
   */
  private trustedDevices(master: string): PeerDevice[] {
    if (this.state.masters[master] === undefined) return [];
    return Object.values(this.state.devices).filter(
      (device) =>
        device.master === master &&
        this.standing(master, device.ed25519, device.certVer) === undefined,
    );
  }

  /**
   * Rule 4 for the device of a KEYS entry under `master`, a master
   * `checkMaster` let through, before anything of it is bound: why it is not
   * trusted, or undefined. Its S1 must cover its curve and this very master,
   * so no other master can list it; then `standing`, with no certificate: a
   * KEYS carries none. The curve rules are `curveRefusal`'s, which the caller
   * runs next. A PKMSG verifies S1 before `checkMaster` and asks `standing`
   * itself.
   */
  private refusal(
    master: string,
    id: IdBlock,
  ):
    | "bad-identity-signature"
    | "revoked-device"
    | "unlisted-device"
    | "stale-certificate"
    | undefined {
    if (!this.idSigned(id, master)) return "bad-identity-signature";
    return this.standing(master, id.ed25519, null);
  }

  /** Whether `id`'s device signed its curve and `master` (S1): then no other master can list it. */
  private idSigned(id: IdBlock, master: string): boolean {
    return this.sigOk(id.ed25519, idSigText(id.curve25519, master), id.sig);
  }

  /** Whether the device of a KEYS entry signed the entry's one-time key (S2). */
  private otkSigned({ id, otk }: KeysEntry): boolean {
    return this.sigOk(id.ed25519, `${OTK_SIG_PREFIX}${otk.key}`, otk.sig);
  }

  /**
   * Why `master`, a master with a record, does not vouch for the device
   * `ed25519` now (rules 4, 5), if not: its stored list names it, or its
   * certificate admits it (`admitsUnlisted`). `certVer` is the version a
   * certificate for the device names, its signature verified: a PKMSG's, or
   * the one stored when the device was bound; null when there is none.
   */
  private standing(
    master: string,
    ed25519: string,
    certVer: number | null,
  ): "revoked-device" | "unlisted-device" | "stale-certificate" | undefined {
    const record = this.state.masters[master];
    if (record === undefined) throw new Error("a device presented under a master no pin names");
    if (record.devices.includes(ed25519) || this.admitsUnlisted(record, ed25519, certVer)) {
      return undefined;
    }
    if (record.revoked.includes(ed25519)) return "revoked-device";
    return certVer === null ? "unlisted-device" : "stale-certificate";
  }

  /**
   * Whether `record`'s master vouches for a device its stored list leaves out
   * on its certificate alone: one whose signature verified names a list
   * version `certVer` above the stored list's (a list at or past that version
   * is the master's own word on the device), and the device was never revoked
   * here. Read off the versions each time, never stored: a list that reaches
   * `certVer` without naming the device ends it.
   */
  private admitsUnlisted(record: Master, ed25519: string, certVer: number | null): boolean {
    return certVer !== null && certVer > record.ver && !record.revoked.includes(ed25519);
  }

  /**
   * The rest of rule 4, v1's curve rules, for a device an id block presents:
   * why its curve may not be bound to it, or undefined. Both keys only in
   * vodozemac's one spelling (W "Encodings"): every rule here compares
   * strings, and another spelling of a key would slip past each compare. Not
   * our own curve: else a device could claim it, hand us our own fallback key
   * as its one-time key, and reflect our own messages back as its own. Nor a
   * sibling's (`setSiblings`): a peer's session to it would sit among the
   * sibling's, which copies go out on. Not another curve for a device already
   * bound. Not a curve bound to another
   * device: one curve under two would let one's messages be read as the
   * other's (sessions and MSG lookups go by curve). An id block only claims
   * its curve, and a pre-key message its holder built to us proves it: so
   * `proving` (a PKMSG) may take a curve another device only claimed, never
   * one a pre-key message proved.
   */
  private curveRefusal(
    id: IdBlock,
    proving: boolean,
  ):
    | "non-canonical-key"
    | "own-identity"
    | "identity-curve-mismatch"
    | "curve-already-bound"
    | undefined {
    if (!this.canonical(id)) return "non-canonical-key";
    if (
      id.curve25519 === this.account.curve25519_key() ||
      Object.values(this.state.siblings).some((s) => s.curve25519 === id.curve25519)
    ) {
      return "own-identity";
    }
    const known = this.state.devices[id.ed25519];
    if (known !== undefined && known.curve25519 !== id.curve25519) return "identity-curve-mismatch";
    const owner = Object.values(this.state.devices).find((d) => d.curve25519 === id.curve25519);
    if (owner !== undefined && owner.ed25519 !== id.ed25519 && (owner.proven || !proving)) {
      return "curve-already-bound";
    }
    return undefined;
  }

  /** Whether both keys of `id` are in vodozemac's one spelling; a key it cannot read is not. */
  private canonical(id: IdBlock): boolean {
    return (
      this.ed25519Canonical(id.ed25519) &&
      this.inSpelling(() => this.olm.canonical_curve25519(id.curve25519), id.curve25519)
    );
  }

  /** Whether `key` is an Ed25519 key in vodozemac's one spelling. */
  private ed25519Canonical(key: string): boolean {
    return this.inSpelling(() => this.olm.canonical_ed25519(key), key);
  }

  // Whether `key` is what `canon` spells it; a key vodozemac cannot read is not.
  private inSpelling(canon: () => string, key: string): boolean {
    try {
      return rejecting(canon) === key;
    } catch (err) {
      if (!(err instanceof Rejected)) throw err;
      return false;
    }
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

  /** Every session of `device`, and its re-key with them: nothing is sent to it on them again. */
  private dropSessions(device: PeerDevice): void {
    delete this.state.sessions[device.curve25519];
    delete this.state.rekeying[device.ed25519];
  }

  private addSession(curve: string, pickle: string): void {
    this.state.sessions[curve] = [pickle, ...this.sessionsOf(curve)].slice(
      0,
      MAX_SESSIONS_PER_PEER,
    );
  }

  /**
   * Forgets old plaintexts: older than `SENT_MEMORY_MS`, then the oldest past
   * `SENT_MAX`. A record whose message still has a copy waiting for keys is
   * kept, whatever its age and however many there are: when that copy
   * lapses, the record is what says a device has the message (`pending`).
   */
  private trimSent(): void {
    const cutoff = this.now() - SENT_MEMORY_MS;
    const queued = new Set(Object.values(this.state.outq).flatMap((q) => q.map((x) => x.msg.id)));
    const waiting = (s: Sent): boolean => queued.has(s.msg.id);
    const fresh = this.state.sent.filter((s) => s.at >= cutoff || waiting(s));
    let excess = fresh.length - SENT_MAX;
    this.state.sent = fresh.filter((s) => {
      if (excess <= 0 || waiting(s)) return true;
      excess--;
      return false;
    });
  }
}
