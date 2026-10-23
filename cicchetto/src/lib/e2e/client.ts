// issue 2430 — cic's E2E client for one (subject, network): the engine
// (`engine.ts`) between this device's doors on grappa and the chat history
// (`chatStore.ts`).
//
// Every operation runs under the account's lock, on one engine built for it,
// in the order that keeps a crash anywhere harmless:
//
//   1. the engine works on the loaded state (decrypt, encrypt, queue);
//   2. what the user must see is written to the chats: a decrypted message
//      is down before the state that spent its key;
//   3. the state is stored, before any of its ciphertext leaves: a ratchet
//      step is never sent twice from a state reloaded after a crash;
//   4. the payloads go to the send door, one at a time, in order; grappa's
//      msgid is recorded for each payload (a NACK names it), or the payload
//      is forgotten when grappa refused it; then each text grappa took is
//      copied to our siblings (S1: this account's other devices), encrypted
//      to each, the state stored first again, through the copy door, never
//      IRC (`copyOut`);
//   5. inbox messages are acknowledged last.
//
// An inbox message flagged `own` is such a copy, from one of our siblings:
// it is read on the copy path (`Engine.receiveCopy`), never the peer one, and
// shows as a sent row in the chat with the peer it went to.
//
// SAS steps (`sas.ts`) ride the same order: the verifier changes the state
// and sends its steps through the engine, like any message. So do the ACKs
// of order challenges (`orders.ts`): a CHAL is answered in the drain that
// decrypted it, only for a line this cic sent, only to the device that asked,
// and never shown.
//
// The doors are this device's (wire v2): its inbox holds only what was
// addressed to it, and every payload leaves from its did. Both come from the
// identity in the record (`identity.ts` sets it up); a slot without one runs
// nothing.
//
// A message processed again (the tab died after 2) finds its rows already
// written, and one past the stored watermark (`E2eState.inbox`) is skipped:
// it is only acknowledged again. grappa's inbox ids never come back
// (AUTOINCREMENT), so the watermark is enough.

import { ApiError } from "../api";
import type { E2eKeysWireDevice } from "../wireTypes";
import type { AccountStore } from "./accountStore";
import type { ChatChange, ChatStore, DoorRefusal, SendDropped } from "./chatStore";
import {
  type CopyResult,
  type E2eEvent,
  type E2eState,
  Engine,
  LIST_TAG,
  type Outbound,
  type PinOutcome,
  type Result,
} from "./engine";
import type { Olm } from "./olm";
import {
  type Challenge,
  ORDER_TAG,
  type OrderVerdict,
  parseChallenge,
  UNCONFIRMED,
} from "./orders";
import { isSas, SAS_TAG, type SasHost, type SasStep, type SasView, Verifier } from "./sas";
import { fold, type ReceiveVerb } from "./wire";

/** One whole message grappa holds for this device (the `e2e_message` wire shape, minus its envelope). */
export type InboxMessage = {
  id: number;
  from: string;
  /** The device of `from` that sent it (its did), `*` on a KEYS. */
  fromDid: string;
  verb: ReceiveVerb;
  msgid: string;
  payload: string;
  /** A copy of a message one of this subject's other devices sent, not one a peer wrote. */
  own: boolean;
};

/** grappa's E2E doors for one device of a subject on one network. */
export type Door = {
  /** The oldest page of the device's inbox past `after`. */
  inbox(after: number): Promise<InboxMessage[]>;
  ack(ids: number[]): Promise<void>;
  /** Never throws: a refusal, or a send that failed on the way, is an answer. */
  send(out: Outbound): Promise<{ msgid: string } | { refused: DoorRefusal }>;
  /**
   * Every device grappa holds for the subject on the network, none of them
   * taken on its word (`Engine.setSiblings`). Never throws: a refusal is an
   * answer.
   */
  devices(): Promise<E2eKeysWireDevice[] | DoorRefusal>;
  /**
   * The KEYS v2 text of a key of the sibling device `did` (consumed), for an
   * Olm session to it. Never throws: no key to give is a refusal.
   */
  claim(did: string): Promise<string | DoorRefusal>;
  /**
   * Queue a copy of a message this device sent, encrypted to the sibling
   * `toDid`: resolves to the copy's queue id. Never throws: a copy refused
   * (the sibling's share is full) is simply missing there.
   */
  copy(toDid: string, verb: "pkmsg" | "msg", payload: string): Promise<number | DoorRefusal>;
};

/**
 * The refusal a door answers for a call to grappa that threw (`Door`: never
 * throws): all the client acts on. A 5xx, a network failure and an answer
 * of the wrong shape all read `refused`, so the door logs the cause first
 * (`refusedBy`).
 */
function refusalOf(err: unknown): DoorRefusal {
  if (err instanceof ApiError && err.status === 429) return "rate-limited";
  if (err instanceof ApiError && err.status === 413) return "too-large";
  if (err instanceof ApiError && err.status === 422 && err.code === "too_late") return "too-late";
  if (err instanceof ApiError && err.status === 422 && err.code === "unknown_device") {
    return "unknown-device";
  }
  return "refused";
}

/**
 * A door's call to grappa that threw (`what` names it): its cause to the
 * console, where an operator looks, then its refusal (`refusalOf`).
 */
export function refusedBy(what: string, err: unknown): DoorRefusal {
  console.warn(`[e2e] ${what}`, err);
  return refusalOf(err);
}

/** `Door.claim`'s answer to grappa's claim of a key of our sibling `did`. */
export const claimAnswer = (
  did: string,
  call: Promise<{ keys: string }>,
): Promise<string | DoorRefusal> =>
  call.then(
    (r) => r.keys,
    (err: unknown) => refusedBy(`the claim door refused a key of our device ${did}`, err),
  );

/** `Door.copy`'s answer to grappa's queueing of a `verb` copy for our sibling `did`. */
export const copyAnswer = (
  did: string,
  verb: "pkmsg" | "msg",
  call: Promise<{ id: number }>,
): Promise<number | DoorRefusal> =>
  call.then(
    (r) => r.id,
    (err: unknown) => refusedBy(`the copy door refused a ${verb} copy to our device ${did}`, err),
  );

/** `Door.devices`'s answer to grappa's listing of the subject's devices. */
export const devicesAnswer = (
  call: Promise<E2eKeysWireDevice[]>,
): Promise<E2eKeysWireDevice[] | DoorRefusal> =>
  call.catch((err: unknown) => refusedBy("the devices door refused the list of our devices", err));

export type E2eContext = {
  slot: string;
  ownNick: string;
  /**
   * The network's `frame_budget_base` as grappa published it, null before it
   * has (no live upstream session): what the engine sizes every message by.
   */
  frameBudgetBase: number | null;
  /** The doors of this subject's device `did` on the network. */
  door: (did: string) => Door;
  /** Whether this cic sent the line `chal` from `challenger` names, there, in the 15 s before `at` (`SendLog.confirms`). */
  orders: (chal: Challenge, challenger: string, at: number) => OrderVerdict;
};

/**
 * What an operation changed: the chats it changed (folded nicks), how many
 * pre-key messages it opened (each spent a one-time key: time to refill the
 * bundle), whether something waits on the clock (time to tick, the engine's
 * own answer: `Engine.waitsOnTheClock`), and whether the send door refused a
 * payload as from a device grappa does not list (`unknown-device`: time to
 * sync, the identity moved).
 */
export type Report = { chats: string[]; pkmsgs: number; waiting: boolean; unknownDevice: boolean };

/** Who a nick is pinned to, as the user sees it: the master, and how many of its devices are trusted. */
export type PeerTrust = { master: string; verified: boolean; devices: number };

export type E2eClient = {
  /** Takes every message waiting in the device's inbox. */
  drain(ctx: E2eContext): Promise<Report>;
  /** Sends `body` to `nick`, encrypted, and writes it to their chat. */
  send(ctx: E2eContext, nick: string, body: string): Promise<Report>;
  /** Reports messages that waited too long for keys, and sends what waited on the clock. */
  tick(ctx: E2eContext): Promise<Report>;
  /** Pins `master` to `nick` by hand (`Engine.pin`); a pin is written to their chat. */
  pin(
    ctx: E2eContext,
    nick: string,
    master: string,
    verified: boolean,
  ): Promise<Report & { result: PinOutcome }>;
  /** The user's step in the SAS with the master `nick` is pinned to (`sas.ts`). */
  verify(ctx: E2eContext, nick: string, step: SasStep): Promise<Report>;
  /** grappa dropped `msgid` after accepting it (`e2e_send_dropped`): its row turns failed. */
  dropped(ctx: E2eContext, msgid: string, reason: SendDropped): Promise<Report>;
  /**
   * Deletes the chat with `nick` (`ChatStore.remove`) and what the engine
   * still holds of it in the clear (`Engine.forget`); answers the chat it
   * changed. Trust stays: the pin, the verification and the sessions.
   */
  deleteChat(ctx: E2eContext, nick: string): Promise<string[]>;
  /**
   * Our master key, and for each of `nicks` (by folded nick) the master it is
   * pinned to and the SAS under way with that master.
   */
  identity(
    ctx: E2eContext,
    nicks: string[],
  ): Promise<{
    own: string;
    peers: Record<string, PeerTrust | null>;
    sas: Record<string, SasView | null>;
  }>;
};

/**
 * The slot has no account yet. Only the identity sync makes one
 * (`identity.ts`), because an identity is never made over one grappa already
 * holds: sync, then try again.
 */
export class NoAccountError extends Error {}

/**
 * The slot's record holds no identity this device speaks for: what a replace
 * leaves when its new identity failed after grappa's old one was deleted.
 * Nothing runs on it; only the user starts a new identity, or pairs this
 * browser with a device that holds one.
 */
export class IdentityElsewhereError extends Error {}

/**
 * How long a listing of the account's devices (`Door.devices`) stands before
 * a copy lists them again, while our list stays the same: a list that moved
 * (a device paired or dropped from this one, or adopted by the identity sync)
 * is listed again at once.
 */
export const SIBLINGS_TTL_MS = 60_000;

/**
 * When this page last listed the siblings of each of its devices, by Ed25519
 * key and the version of our list it held: a page's own memory, so a new
 * page, or a new list, lists them before its first copy.
 */
const siblingsListed = new Map<string, number>();

/** Every refusal a door answers: what a claim answers when it brings no KEYS text. */
const REFUSALS: Record<DoorRefusal, true> = {
  "rate-limited": true,
  "too-large": true,
  "too-late": true,
  "unknown-device": true,
  refused: true,
};

const isRefusal = (answer: string): answer is DoorRefusal => Object.hasOwn(REFUSALS, answer);

/** A text grappa took a payload of for the first time: what our siblings get a copy of. */
type Taken = { nick: string; body: string };

/** The chat changes `events` make; rows from the inbox message `inbox` get ids derived from it. */
function changesFor(events: E2eEvent[], at: number, inbox: number | null): ChatChange[] {
  const changes: ChatChange[] = [];
  events.forEach((e, i) => {
    const id = `in:${inbox}:${i}`;
    switch (e.kind) {
      case "received":
        // Only text is shown. A CHAL is answered in the drain (`answer`),
        // never shown; an ACK means nothing here (cic challenges no one).
        // The row names the master that wrote it, the key the user pins.
        if (e.inner.t === "text" && typeof e.inner.body === "string" && inbox !== null) {
          changes.push({
            op: "add",
            nick: e.nick,
            unread: true,
            row: { kind: "in", id, at, nick: e.nick, ed25519: e.master, body: e.inner.body },
          });
        }
        break;
      case "undecryptable":
        if (inbox !== null) {
          changes.push({
            op: "add",
            nick: e.nick,
            unread: true,
            row: { kind: "undecryptable", id, at, nick: e.nick },
          });
        }
        break;
      case "key_alarm":
        if (inbox !== null) {
          changes.push({
            op: "add",
            nick: e.nick,
            unread: true,
            row: { kind: "key_alarm", id, at, nick: e.nick, presented: e.presented },
          });
        }
        break;
      case "send_queued":
        if (!rowless(e.tag)) {
          changes.push({ op: "out", nick: e.nick, id: e.tag, state: "queued", reason: null });
        }
        break;
      case "send_failed":
        for (const tag of e.tags) {
          if (rowless(tag)) {
            rowlessLost(tag, e.nick, e.reason);
          } else {
            changes.push({ op: "out", nick: e.nick, id: tag, state: "failed", reason: e.reason });
          }
        }
        break;
      case "dropped":
        if (e.reason === "sibling-gone" || e.reason === "sibling-no-keys") {
          // Not wire input: the copy of a text we sent `e.nick`, which one of
          // our other devices goes without.
          console.warn(
            `[e2e] a copy of a text to ${e.nick} was not sent to one of our devices: ${e.reason}`,
          );
        } else {
          // Wire input that is not a message (a bad signature, a replay, an
          // unsolicited KEYS): nothing for the user, but never without a trace.
          console.debug(`[e2e] dropped a ${e.verb ?? "message"} from ${e.nick}: ${e.reason}`);
        }
        break;
      case "copied":
        // A text one of our siblings sent `peer`: ours, so it reads as sent
        // here too, in the chat with `peer` (made if this device has none).
        if (inbox !== null) {
          changes.push({
            op: "add",
            nick: e.peer,
            unread: false,
            row: {
              kind: "out",
              id: `copy:${inbox}:${i}`,
              at,
              body: e.body,
              state: "sent",
              reason: null,
            },
          });
        }
        break;
      case "sibling_keys_needed":
        // `copyOut` claims a key of the sibling, and hands it to the engine.
        break;
      case "replayed":
      case "rekeying":
        // The `undecryptable` beside a replay is what the user sees; a re-key
        // shows as its message's state.
        break;
    }
  });
  return changes;
}

// A SAS step and an ACK have no row to mark: the SAS waits for its step until
// its time runs out, and the bot refuses the order once its challenge expires.
// The engine never reports its own list traffic (`LIST_TAG`), so it never
// gets here.
type RowlessTag = typeof SAS_TAG | typeof ORDER_TAG;

const rowless = (tag: string): tag is RowlessTag => tag === SAS_TAG || tag === ORDER_TAG;

function rowlessLost(tag: RowlessTag, nick: string, reason: string): void {
  if (tag === SAS_TAG) {
    console.warn(`[e2e] a SAS step to ${nick} was not sent (${reason}); the SAS will time out`);
  } else {
    console.warn(
      `[e2e] the ACK of an order to ${nick} was not sent (${reason}); it goes unconfirmed`,
    );
  }
}

// An inbox message flagged `own`: a copy one of our siblings sent, read on
// the copy path, never the peer one (which refuses our own master). Only a
// PKMSG or a MSG is one; grappa queues nothing else as own, so anything else
// is dropped, with a trace.
function copyFrom(engine: Engine, m: InboxMessage): Result {
  if (m.verb === "pkmsg" || m.verb === "msg") {
    return engine.receiveCopy(m.fromDid, m.verb, m.payload);
  }
  console.debug(`[e2e] dropped an own ${m.verb} from our device ${m.fromDid}: not a copy`);
  return { events: [], outbound: [] };
}

// A key of our sibling `did` from grappa's claim door: its KEYS text, or
// null when grappa refused it (logged, never claimed again for those copies:
// the engine drops what waited for it).
async function claim(door: Door, did: string): Promise<string | null> {
  const keys = await door.claim(did);
  if (!isRefusal(keys)) return keys;
  console.warn(
    `[e2e] grappa refused a key of our device ${did} (${keys}); the copies waiting for it are dropped`,
  );
  return null;
}

export function e2eClient(
  olm: Olm,
  accounts: AccountStore,
  chats: ChatStore,
  now: () => number,
  host: SasHost,
): E2eClient {
  // Step 4 for `outbound`: what the send door answered, as chat changes, and
  // whether it refused a payload as from a device it does not list. A
  // refused payload is forgotten (`discard`); its message is lost only once
  // nothing else of it is on its way or waiting, which the engine answers.
  // Then each text grappa took a payload of for the first time is copied to
  // our siblings (`copyOut`), once: its row is not sent yet (a re-send after
  // a NACK, or a payload for a device whose keys came later, finds it sent).
  async function flush(
    ctx: E2eContext,
    engine: Engine,
    persist: () => Promise<void>,
    door: Door,
    outbound: Outbound[],
  ): Promise<{ changes: ChatChange[]; unknownDevice: boolean }> {
    const changes: ChatChange[] = [];
    // Tag → nick, of the texts grappa took a payload of.
    const taken = new Map<string, string>();
    let unknownDevice = false;
    for (const out of outbound) {
      const answer = await door.send(out);
      if ("refused" in answer && answer.refused === "unknown-device") unknownDevice = true;
      if (out.ref === undefined || out.tag === undefined) {
        if ("refused" in answer) {
          console.warn(`[e2e] grappa refused a ${out.verb} to ${out.target}: ${answer.refused}`);
        }
        continue;
      }
      if (!("refused" in answer)) {
        engine.sent(out.ref, answer.msgid);
        if (out.tag !== LIST_TAG && !rowless(out.tag)) {
          changes.push({ op: "out", nick: out.target, id: out.tag, state: "sent", reason: null });
          taken.set(out.tag, out.target);
        }
        continue;
      }
      const lost = engine.discard(out.ref);
      if (lost === undefined) {
        // The engine's own list traffic, or a message another copy of which
        // is still on its way: no row moves, but the refusal leaves a trace.
        console.warn(
          `[e2e] grappa refused a ${out.verb} to ${out.target} (${answer.refused}); ${
            out.tag === LIST_TAG ? "the list traffic is dropped" : "another copy is on its way"
          }`,
        );
      } else if (rowless(lost.tag)) {
        rowlessLost(lost.tag, lost.nick, answer.refused);
      } else {
        changes.push({
          op: "out",
          nick: lost.nick,
          id: lost.tag,
          state: "failed",
          reason: answer.refused,
        });
      }
    }
    const texts: Taken[] = [];
    for (const [tag, nick] of taken) {
      const row = (await chats.rows(ctx.slot, nick)).find((r) => r.id === tag);
      if (row?.kind === "out" && row.state !== "sent") texts.push({ nick, body: row.body });
    }
    return {
      changes: [...changes, ...(await copyOut(engine, persist, door, texts))],
      unknownDevice,
    };
  }

  // Our siblings as grappa lists the account's devices (`Engine.setSiblings`),
  // when this page has not listed them for the device, under the list it
  // holds now, in `SIBLINGS_TTL_MS`.
  // A listing grappa refuses is logged and keeps the siblings known; the next
  // copy lists them again.
  async function listSiblings(engine: Engine, door: Door): Promise<Result> {
    const key = `${engine.deviceKey()} ${engine.listVersion()}`;
    const at = siblingsListed.get(key);
    if (at !== undefined && now() - at <= SIBLINGS_TTL_MS) return { events: [], outbound: [] };
    const devices = await door.devices();
    if (!Array.isArray(devices)) {
      console.warn(
        `[e2e] grappa refused the list of our devices (${devices}); copies go to the known ones`,
      );
      return { events: [], outbound: [] };
    }
    siblingsListed.set(key, now());
    return engine.setSiblings(devices);
  }

  // The texts grappa just took (`flush`), copied to our siblings (S1). A
  // sibling with a session gets its copies at once. For one without, the
  // engine asks once (`sibling_keys_needed`): a key of it is claimed, and
  // what came, or null when grappa refused, goes to `siblingKeys`, which
  // encrypts what waited or drops it (it asks for nothing more). Then the
  // state is stored, once, before any copy leaves, as before any payload: a
  // tab that dies before it stored nothing, so its next copy asks again. A
  // copy or a claim grappa refuses is logged, never tried again: no NACK
  // ever names a copy, so a lost one is lost. Answers what its events change
  // in the chats.
  async function copyOut(
    engine: Engine,
    persist: () => Promise<void>,
    door: Door,
    texts: Taken[],
  ): Promise<ChatChange[]> {
    if (texts.length === 0) return [];
    const listed = await listSiblings(engine, door);
    const copied: CopyResult[] = texts.map(({ nick, body }) => engine.copy(nick, body));
    for (const e of copied.flatMap((r) => r.events)) {
      if (e.kind === "sibling_keys_needed") {
        copied.push(engine.siblingKeys(e.did, await claim(door, e.did)));
      }
    }
    await persist();
    for (const copy of copied.flatMap((r) => r.copies)) {
      const id = await door.copy(copy.to, copy.verb, copy.payload);
      if (typeof id !== "number") {
        console.warn(`[e2e] grappa refused a ${copy.verb} copy to our device ${copy.to}: ${id}`);
      }
    }
    return changesFor([...listed.events, ...copied.flatMap((r) => r.events)], now(), null);
  }

  // An operation on the slot's identity, which must exist already: its
  // engine and verifier, and this device's doors.
  function withEngine<T>(
    ctx: E2eContext,
    fn: (
      engine: Engine,
      persist: () => Promise<void>,
      verifier: Verifier,
      door: Door,
      state: E2eState,
    ) => Promise<T>,
  ): Promise<T> {
    return accounts.withAccount(ctx.slot, async ({ account, own, state, created, persist }) => {
      // Throwing stores nothing: the account just made is dropped again.
      if (created) throw new NoAccountError(`no E2E account for ${ctx.slot} yet`);
      if (own === null) throw new IdentityElsewhereError(`no E2E identity in ${ctx.slot}`);
      const engine = new Engine(olm, account, own, state, ctx.ownNick, ctx.frameBudgetBase, now);
      const verifier = new Verifier(olm, engine, state, host, now);
      return fn(engine, persist, verifier, ctx.door(own.did), state);
    });
  }

  // What the verifier made (its rows, and what the engine answered to its
  // steps), as chat changes and payloads.
  function sasOutput(verifier: Verifier): {
    changes: ChatChange[];
    outbound: Outbound[];
    chats: string[];
  } {
    const { changes, events, outbound, chats: touched } = verifier.take();
    return { changes: [...changes, ...changesFor(events, now(), null)], outbound, chats: touched };
  }

  // The answer to an order challenge from `nick`'s device `device`: an ACK to
  // that device alone, with the CHAL's own deadline (grappa drops it unsent
  // past that), when the master is verified and this cic sent the line the
  // CHAL names; otherwise nothing, and nothing shown. Until a master is
  // verified (pinned by hand, or a SAS) its devices do not authorise orders
  // (issue 2430, "Identity"). A bot only sends a CHAL to the master pinned to
  // the nick that spoke, so a CHAL for a line this cic never sent is someone
  // giving orders in the user's name, or one of the fail-closed cases
  // (`orders.ts`); either way the bot refuses the order.
  function answer(
    ctx: E2eContext,
    engine: Engine,
    received: Extract<E2eEvent, { kind: "received" }>,
  ): Result {
    const { nick } = received;
    const chal = parseChallenge(received.inner);
    if (chal === null) {
      console.debug(`[e2e] dropped a malformed order challenge from ${nick}`);
      return { events: [], outbound: [] };
    }
    if (!received.verified) {
      console.warn(`[e2e] order challenge from ${nick} not confirmed: their key is not verified`);
      return { events: [], outbound: [] };
    }
    const verdict = ctx.orders(chal, nick, now());
    if (verdict !== "confirmed") {
      console.warn(`[e2e] order challenge from ${nick} not confirmed: ${UNCONFIRMED[verdict]}`);
      return { events: [], outbound: [] };
    }
    return engine.send(
      nick,
      { t: "ack", nonce: chal.nonce },
      ORDER_TAG,
      chal.expiresAt,
      received.device,
    );
  }

  // Steps 2–4 for what an operation made: `changes` and what the verifier
  // made, then `outbound` and the verifier's payloads.
  async function finish(
    ctx: E2eContext,
    engine: Engine,
    verifier: Verifier,
    persist: () => Promise<void>,
    door: Door,
    changes: ChatChange[],
    outbound: Outbound[],
  ): Promise<Report> {
    const sas = sasOutput(verifier);
    const touched = new Set(sas.chats);
    for (const key of await chats.apply(ctx.slot, [...sas.changes, ...changes])) touched.add(key);
    await persist();
    const sent = await flush(ctx, engine, persist, door, [...outbound, ...sas.outbound]);
    for (const key of await chats.apply(ctx.slot, sent.changes)) touched.add(key);
    return {
      chats: [...touched],
      pkmsgs: 0,
      waiting: engine.waitsOnTheClock(),
      unknownDevice: sent.unknownDevice,
    };
  }

  return {
    drain: (ctx) =>
      withEngine(ctx, async (engine, persist, verifier, door, state) => {
        const touched = new Set<string>();
        let pkmsgs = 0;
        let unknownDevice = false;
        let after = 0;
        for (;;) {
          const page = await door.inbox(after);
          const last = page.at(-1);
          if (last === undefined) break;
          const changes: ChatChange[] = [];
          const outbound: Outbound[] = [];
          for (const m of page) {
            if (m.id <= state.inbox) continue;
            const res = m.own
              ? copyFrom(engine, m)
              : engine.receive(m.from, m.verb, m.msgid, m.fromDid, m.payload);
            if (m.verb === "pkmsg") pkmsgs += 1;
            changes.push(...changesFor(res.events, now(), m.id));
            outbound.push(...res.outbound);
            for (const [i, e] of res.events.entries()) {
              if (e.kind !== "received") continue;
              if (isSas(e.inner)) {
                await verifier.receive(e.nick, e.master, e.device, e.inner, `in:${m.id}:${i}`);
              } else if (e.inner.t === "chal") {
                const acked = answer(ctx, engine, e);
                changes.push(...changesFor(acked.events, now(), null));
                outbound.push(...acked.outbound);
              }
            }
            state.inbox = m.id;
          }
          const sas = sasOutput(verifier);
          changes.push(...sas.changes);
          outbound.push(...sas.outbound);
          for (const key of sas.chats) touched.add(key);
          for (const key of await chats.apply(ctx.slot, changes)) touched.add(key);
          await persist();
          const sent = await flush(ctx, engine, persist, door, outbound);
          unknownDevice ||= sent.unknownDevice;
          await persist();
          for (const key of await chats.apply(ctx.slot, sent.changes)) touched.add(key);
          await door.ack(page.map((m) => m.id));
          after = last.id;
        }
        const ticked = engine.tick();
        const end = await finish(
          ctx,
          engine,
          verifier,
          persist,
          door,
          changesFor(ticked.events, now(), null),
          ticked.outbound,
        );
        for (const key of end.chats) touched.add(key);
        return {
          chats: [...touched],
          pkmsgs,
          waiting: end.waiting,
          unknownDevice: unknownDevice || end.unknownDevice,
        };
      }),

    send: (ctx, nick, body) =>
      withEngine(ctx, async (engine, persist, _verifier, door) => {
        const tag = crypto.randomUUID();
        const res = engine.send(nick, { t: "text", body }, tag, null, null);
        const touched = new Set(
          await chats.apply(ctx.slot, [
            {
              op: "add",
              nick,
              unread: false,
              row: { kind: "out", id: tag, at: now(), body, state: "sending", reason: null },
            },
            ...changesFor(res.events, now(), null),
          ]),
        );
        await persist();
        const sent = await flush(ctx, engine, persist, door, res.outbound);
        for (const key of await chats.apply(ctx.slot, sent.changes)) touched.add(key);
        return {
          chats: [...touched],
          pkmsgs: 0,
          waiting: engine.waitsOnTheClock(),
          unknownDevice: sent.unknownDevice,
        };
      }),

    tick: (ctx) =>
      withEngine(ctx, async (engine, persist, verifier, door) => {
        const ticked = engine.tick();
        verifier.tick(await host.alive());
        return finish(
          ctx,
          engine,
          verifier,
          persist,
          door,
          changesFor(ticked.events, now(), null),
          ticked.outbound,
        );
      }),

    pin: (ctx, nick, master, verified) =>
      withEngine(ctx, async (engine, persist, verifier, door) => {
        const res = engine.pin(nick, master, verified);
        if (res.outcome !== "pinned") {
          return {
            result: res.outcome,
            chats: [],
            pkmsgs: 0,
            waiting: engine.waitsOnTheClock(),
            unknownDevice: false,
          };
        }
        // A SAS never runs on a master the nick no longer has: one that ran
        // with the master the pin replaced ends here.
        verifier.repinned(nick);
        const peer = engine.pinned(nick);
        if (peer === undefined) throw new Error("a pin just set is not there");
        // Taking a master someone already verified pins a verified master.
        const row = {
          kind: peer.verified ? ("pinned" as const) : ("accepted" as const),
          id: crypto.randomUUID(),
          at: now(),
          nick,
          ed25519: peer.master,
        };
        const report = await finish(
          ctx,
          engine,
          verifier,
          persist,
          door,
          [{ op: "add", nick, unread: false, row }, ...changesFor(res.events, now(), null)],
          res.outbound,
        );
        return { ...report, result: res.outcome };
      }),

    verify: (ctx, nick, step) =>
      withEngine(ctx, async (engine, persist, verifier, door) => {
        await verifier.step(nick, step);
        return finish(ctx, engine, verifier, persist, door, [], []);
      }),

    deleteChat: (ctx, nick) =>
      withEngine(ctx, async (engine, persist) => {
        engine.forget(nick);
        // Stored before the rows go: a delete that fails half way has dropped
        // the plaintext and left rows to delete again, never the other way.
        await persist();
        await chats.remove(ctx.slot, nick);
        return [fold(nick)];
      }),

    dropped: (ctx, msgid, reason) =>
      withEngine(ctx, async (engine, persist, verifier, door) => {
        const lost = engine.dropped(msgid);
        const changes: ChatChange[] = [];
        if (lost !== undefined && rowless(lost.tag)) {
          rowlessLost(lost.tag, lost.nick, reason);
        } else if (lost !== undefined) {
          changes.push({ op: "out", nick: lost.nick, id: lost.tag, state: "failed", reason });
        }
        return finish(ctx, engine, verifier, persist, door, changes, []);
      }),

    identity: (ctx, nicks) =>
      withEngine(ctx, async (engine, persist, verifier, door) => {
        const peers: Record<string, PeerTrust | null> = {};
        const sas: Record<string, SasView | null> = {};
        for (const nick of nicks) {
          const peer = engine.pinned(nick);
          peers[fold(nick)] = peer ?? null;
          sas[fold(nick)] = verifier.view(nick);
        }
        if (!verifier.idle()) await finish(ctx, engine, verifier, persist, door, [], []);
        return { own: engine.fingerprint(), peers, sas };
      }),
  };
}
