// issue 2430 — cic's E2E client for one (subject, network): the engine
// (`engine.ts`) between grappa's doors and the chat history (`chatStore.ts`).
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
//      msgid is recorded for each message (a NACK names it), or the send is
//      forgotten when grappa refused it;
//   5. inbox messages are acknowledged last.
//
// SAS steps (`sas.ts`) ride the same order: the verifier changes the state
// and queues its steps, which go through the engine like any message. So do
// the ACKs of order challenges (`orders.ts`): a CHAL is answered in the drain
// that decrypted it, only for a line this cic sent, and never shown.
//
// A message processed again (the tab died after 2) finds its rows already
// written, and one past the stored watermark (`E2eState.inbox`) is skipped:
// it is only acknowledged again. grappa's inbox ids never come back
// (AUTOINCREMENT), so the watermark is enough.

import type { AccountStore } from "./accountStore";
import type { ChatChange, ChatStore, DoorRefusal, SendDropped } from "./chatStore";
import { type E2eEvent, type E2eState, Engine, type Outbound } from "./engine";
import type { Olm } from "./olm";
import { type Challenge, ORDER_TAG, parseChallenge } from "./orders";
import { isSas, SAS_TAG, type SasHost, type SasStep, type SasView, Verifier } from "./sas";
import { fold, type ReceiveVerb } from "./wire";

/** One whole message grappa holds for us (the `e2e_message` wire shape, minus its envelope). */
export type InboxMessage = {
  id: number;
  from: string;
  verb: ReceiveVerb;
  msgid: string;
  payload: string;
};

/** grappa's E2E doors for one subject on one network. */
export type Door = {
  /** The oldest page of the inbox past `after`. */
  inbox(after: number): Promise<InboxMessage[]>;
  ack(ids: number[]): Promise<void>;
  /** Never throws: a refusal, or a send that failed on the way, is an answer. */
  send(out: Outbound): Promise<{ msgid: string } | { refused: DoorRefusal }>;
};

export type E2eContext = {
  slot: string;
  ownNick: string;
  door: Door;
  /** Whether this cic sent the line `chal` names, there, in the 15 s before `at` (`SendLog.confirms`). */
  orders: (chal: Challenge, at: number) => Promise<boolean>;
};

/**
 * What an operation changed: the chats it changed (folded nicks), how many
 * pre-key messages it opened (each spent a one-time key: time to refill the
 * bundle), and whether something waits on the clock (time to tick):
 * messages waiting for keys, or a SAS.
 */
export type Report = { chats: string[]; pkmsgs: number; waiting: boolean };

/** Who a nick is pinned to, as the user sees it. */
export type PeerTrust = { ed25519: string; verified: boolean };

export type E2eClient = {
  /** Takes every message waiting in the inbox. */
  drain(ctx: E2eContext): Promise<Report>;
  /** Sends `body` to `nick`, encrypted, and writes it to their chat. */
  send(ctx: E2eContext, nick: string, body: string): Promise<Report>;
  /** Reports messages that waited too long for keys. */
  tick(ctx: E2eContext): Promise<Report>;
  /** Pins `key` to `nick` by hand (`Engine.pin`); a pin is written to their chat. */
  pin(
    ctx: E2eContext,
    nick: string,
    key: string,
    verified: boolean,
  ): Promise<{ result: ReturnType<Engine["pin"]>; chats: string[] }>;
  /** The user's step in the SAS with the key `nick` is pinned to (`sas.ts`). */
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
   * Our Ed25519 key, and for each of `nicks` (by folded nick) the key it is
   * pinned to and the SAS under way with that key.
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
 * The slot has no account yet. Only the bundle sync creates one, because a
 * new account must first clear whatever bundle grappa still holds for the
 * slot (keys of an account that is gone): sync, then try again.
 */
export class NoAccountError extends Error {}

/** The chat changes `events` make; rows from the inbox message `inbox` get ids derived from it. */
function changesFor(events: E2eEvent[], at: number, inbox: number | null): ChatChange[] {
  const changes: ChatChange[] = [];
  events.forEach((e, i) => {
    const id = `in:${inbox}:${i}`;
    switch (e.kind) {
      case "received":
        // Only text is shown. A CHAL is answered in the drain (`answer`),
        // never shown; an ACK means nothing here (cic challenges no one).
        if (e.inner.t === "text" && typeof e.inner.body === "string" && inbox !== null) {
          changes.push({
            op: "add",
            nick: e.nick,
            unread: true,
            row: {
              kind: "in",
              id,
              at,
              nick: e.nick,
              ed25519: e.peer.ed25519,
              body: e.inner.body,
            },
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
        // Wire input that is not a message (a bad signature, a replay, an
        // unsolicited KEYS): nothing for the user, but never without a trace.
        console.debug(`[e2e] dropped a ${e.verb ?? "message"} from ${e.nick}: ${e.reason}`);
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
const rowless = (tag: string): boolean => tag === SAS_TAG || tag === ORDER_TAG;

function rowlessLost(tag: string, nick: string, reason: string): void {
  if (tag === SAS_TAG) {
    console.warn(`[e2e] a SAS step to ${nick} was not sent (${reason}); the SAS will time out`);
  } else {
    console.warn(
      `[e2e] the ACK of an order to ${nick} was not sent (${reason}); it goes unconfirmed`,
    );
  }
}

const waitsOnTheClock = (state: E2eState): boolean =>
  Object.keys(state.outq).length > 0 || Object.keys(state.sas).length > 0;

export function e2eClient(
  olm: Olm,
  accounts: AccountStore,
  chats: ChatStore,
  now: () => number,
  host: SasHost,
): E2eClient {
  // Steps 4 for `outbound`: what the send door answered, as chat changes.
  async function flush(engine: Engine, door: Door, outbound: Outbound[]): Promise<ChatChange[]> {
    const changes: ChatChange[] = [];
    for (const out of outbound) {
      const answer = await door.send(out);
      if (out.ref === undefined || out.tag === undefined) {
        if ("refused" in answer) {
          console.warn(`[e2e] grappa refused a ${out.verb} to ${out.target}: ${answer.refused}`);
        }
        continue;
      }
      if (rowless(out.tag)) {
        if ("refused" in answer) {
          engine.discard(out.ref);
          rowlessLost(out.tag, out.target, answer.refused);
        } else {
          engine.sent(out.ref, answer.msgid);
        }
        continue;
      }
      if ("refused" in answer) {
        engine.discard(out.ref);
        changes.push({
          op: "out",
          nick: out.target,
          id: out.tag,
          state: "failed",
          reason: answer.refused,
        });
      } else {
        engine.sent(out.ref, answer.msgid);
        changes.push({ op: "out", nick: out.target, id: out.tag, state: "sent", reason: null });
      }
    }
    return changes;
  }

  // An operation on the slot's account, which must exist already.
  function withEngine<T>(
    ctx: E2eContext,
    fn: (
      engine: Engine,
      state: E2eState,
      persist: () => Promise<void>,
      verifier: Verifier,
    ) => Promise<T>,
  ): Promise<T> {
    return accounts.withAccount(ctx.slot, async ({ account, state, created, persist }) => {
      // Throwing stores nothing: the account just made is dropped again.
      if (created) throw new NoAccountError(`no E2E account for ${ctx.slot} yet`);
      const engine = new Engine(olm, account, state, ctx.ownNick, now);
      return fn(engine, state, persist, new Verifier(olm, engine, state, host, now));
    });
  }

  // The steps the verifier queued, through the engine: their payloads, and
  // the chat changes the verifier made.
  function sasOutput(
    engine: Engine,
    verifier: Verifier,
  ): { changes: ChatChange[]; outbound: Outbound[]; chats: string[] } {
    const { sends, changes, chats: touched } = verifier.take();
    const outbound: Outbound[] = [];
    for (const { nick, inner } of sends) {
      const res = engine.send(nick, inner, SAS_TAG, null);
      changes.push(...changesFor(res.events, now(), null));
      outbound.push(...res.outbound);
    }
    return { changes, outbound, chats: touched };
  }

  // The answer to an order challenge from `nick`: an ACK, with the CHAL's own
  // deadline (grappa drops it unsent past that), when this cic sent the line
  // the CHAL names; otherwise nothing, and nothing shown. A bot only sends a
  // CHAL to the key pinned to the nick that spoke, so a CHAL for a line this
  // cic never sent is someone giving orders in the user's name, or one of the
  // fail-closed cases (`orders.ts`); either way the bot refuses the order.
  async function answer(
    ctx: E2eContext,
    engine: Engine,
    nick: string,
    inner: Record<string, unknown>,
  ): Promise<{ changes: ChatChange[]; outbound: Outbound[] }> {
    const chal = parseChallenge(inner);
    if (chal === null) {
      console.debug(`[e2e] dropped a malformed order challenge from ${nick}`);
      return { changes: [], outbound: [] };
    }
    if (!(await ctx.orders(chal, now()))) {
      console.warn(`[e2e] ${nick} asked to confirm an order this cic did not send; not confirmed`);
      return { changes: [], outbound: [] };
    }
    const res = engine.send(nick, { t: "ack", nonce: chal.nonce }, ORDER_TAG, chal.expiresAt);
    return { changes: changesFor(res.events, now(), null), outbound: res.outbound };
  }

  // Steps 2–4 for what an operation made: `changes` and what the verifier
  // made, then `outbound` and the verifier's steps.
  async function finish(
    ctx: E2eContext,
    engine: Engine,
    verifier: Verifier,
    state: E2eState,
    persist: () => Promise<void>,
    changes: ChatChange[],
    outbound: Outbound[],
  ): Promise<Report> {
    const sas = sasOutput(engine, verifier);
    const touched = new Set(sas.chats);
    for (const key of await chats.apply(ctx.slot, [...sas.changes, ...changes])) touched.add(key);
    await persist();
    const sent = await flush(engine, ctx.door, [...outbound, ...sas.outbound]);
    for (const key of await chats.apply(ctx.slot, sent)) touched.add(key);
    return { chats: [...touched], pkmsgs: 0, waiting: waitsOnTheClock(state) };
  }

  return {
    drain: (ctx) =>
      withEngine(ctx, async (engine, state, persist, verifier) => {
        const touched = new Set<string>();
        let pkmsgs = 0;
        let after = 0;
        for (;;) {
          const page = await ctx.door.inbox(after);
          const last = page.at(-1);
          if (last === undefined) break;
          const changes: ChatChange[] = [];
          const outbound: Outbound[] = [];
          for (const m of page) {
            if (m.id <= state.inbox) continue;
            const res = engine.receive(m.from, m.verb, m.msgid, m.payload);
            if (m.verb === "pkmsg") pkmsgs += 1;
            changes.push(...changesFor(res.events, now(), m.id));
            outbound.push(...res.outbound);
            for (const [i, e] of res.events.entries()) {
              if (e.kind !== "received") continue;
              if (isSas(e.inner)) {
                await verifier.receive(e.nick, e.peer.ed25519, e.inner, `in:${m.id}:${i}`);
              } else if (e.inner.t === "chal") {
                const acked = await answer(ctx, engine, e.nick, e.inner);
                changes.push(...acked.changes);
                outbound.push(...acked.outbound);
              }
            }
            state.inbox = m.id;
          }
          const sas = sasOutput(engine, verifier);
          changes.push(...sas.changes);
          outbound.push(...sas.outbound);
          for (const key of sas.chats) touched.add(key);
          for (const key of await chats.apply(ctx.slot, changes)) touched.add(key);
          await persist();
          const sent = await flush(engine, ctx.door, outbound);
          await persist();
          for (const key of await chats.apply(ctx.slot, sent)) touched.add(key);
          await ctx.door.ack(page.map((m) => m.id));
          after = last.id;
        }
        const ticked = engine.tick();
        const end = await finish(
          ctx,
          engine,
          verifier,
          state,
          persist,
          changesFor(ticked.events, now(), null),
          ticked.outbound,
        );
        for (const key of end.chats) touched.add(key);
        return { chats: [...touched], pkmsgs, waiting: end.waiting };
      }),

    send: (ctx, nick, body) =>
      withEngine(ctx, async (engine, state, persist) => {
        const tag = crypto.randomUUID();
        const res = engine.send(nick, { t: "text", body }, tag, null);
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
        for (const key of await chats.apply(
          ctx.slot,
          await flush(engine, ctx.door, res.outbound),
        )) {
          touched.add(key);
        }
        return { chats: [...touched], pkmsgs: 0, waiting: waitsOnTheClock(state) };
      }),

    tick: (ctx) =>
      withEngine(ctx, async (engine, state, persist, verifier) => {
        const ticked = engine.tick();
        verifier.tick(await host.alive());
        return finish(
          ctx,
          engine,
          verifier,
          state,
          persist,
          changesFor(ticked.events, now(), null),
          ticked.outbound,
        );
      }),

    pin: (ctx, nick, key, verified) =>
      withEngine(ctx, async (engine, state, persist, verifier) => {
        const before = engine.pinned(nick)?.ed25519;
        const result = engine.pin(nick, key, verified);
        if (result !== "pinned") return { result, chats: [] };
        // The key as the engine spells it: a paste may carry non-zero padding bits.
        const peer = engine.pinned(nick);
        if (peer === undefined) throw new Error("a pin just set is not there");
        if (before !== undefined && before !== peer.ed25519) verifier.repinned(before);
        // Taking a key someone already verified pins a verified key.
        const row = {
          kind: peer.verified ? ("pinned" as const) : ("accepted" as const),
          id: crypto.randomUUID(),
          at: now(),
          nick,
          ed25519: peer.ed25519,
        };
        const report = await finish(
          ctx,
          engine,
          verifier,
          state,
          persist,
          [{ op: "add", nick, unread: false, row }],
          [],
        );
        return { result, chats: report.chats };
      }),

    verify: (ctx, nick, step) =>
      withEngine(ctx, async (engine, state, persist, verifier) => {
        await verifier.step(nick, step);
        return finish(ctx, engine, verifier, state, persist, [], []);
      }),

    deleteChat: (ctx, nick) =>
      withEngine(ctx, async (engine, _state, persist) => {
        engine.forget(nick);
        // Stored before the rows go: a delete that fails half way has dropped
        // the plaintext and left rows to delete again, never the other way.
        await persist();
        await chats.remove(ctx.slot, nick);
        return [fold(nick)];
      }),

    dropped: (ctx, msgid, reason) =>
      withEngine(ctx, async (engine, state, persist, verifier) => {
        const lost = engine.dropped(msgid);
        const changes: ChatChange[] = [];
        if (lost !== undefined && rowless(lost.tag)) {
          rowlessLost(lost.tag, lost.nick, reason);
        } else if (lost !== undefined) {
          changes.push({ op: "out", nick: lost.nick, id: lost.tag, state: "failed", reason });
        }
        return finish(ctx, engine, verifier, state, persist, changes, []);
      }),

    identity: (ctx, nicks) =>
      withEngine(ctx, async (engine, state, persist, verifier) => {
        const peers: Record<string, PeerTrust | null> = {};
        const sas: Record<string, SasView | null> = {};
        for (const nick of nicks) {
          const peer = engine.pinned(nick);
          peers[fold(nick)] =
            peer === undefined ? null : { ed25519: peer.ed25519, verified: peer.verified };
          sas[fold(nick)] = verifier.view(nick);
        }
        if (!verifier.idle()) await finish(ctx, engine, verifier, state, persist, [], []);
        return { own: engine.fingerprint(), peers, sas };
      }),
  };
}
