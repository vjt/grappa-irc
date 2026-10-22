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
// A message processed again (the tab died after 2) finds its rows already
// written, and one past the stored watermark (`E2eState.inbox`) is skipped:
// it is only acknowledged again. grappa's inbox ids never come back
// (AUTOINCREMENT), so the watermark is enough.

import type { AccountStore } from "./accountStore";
import type { ChatChange, ChatStore, DoorRefusal } from "./chatStore";
import { type E2eEvent, Engine, type Outbound } from "./engine";
import type { Olm } from "./olm";
import type { ReceiveVerb } from "./wire";

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

export type E2eContext = { slot: string; ownNick: string; door: Door };

/**
 * What an operation changed: the chats it wrote to (folded nicks), how many
 * pre-key messages it opened (each spent a one-time key: time to refill the
 * bundle), and whether messages still wait for keys (time to tick).
 */
export type Report = { chats: string[]; pkmsgs: number; waiting: boolean };

export type E2eClient = {
  /** Takes every message waiting in the inbox. */
  drain(ctx: E2eContext): Promise<Report>;
  /** Sends `body` to `nick`, encrypted, and writes it to their chat. */
  send(ctx: E2eContext, nick: string, body: string): Promise<Report>;
  /** Reports messages that waited too long for keys. */
  tick(ctx: E2eContext): Promise<Report>;
};

/** The chat changes `events` make; rows from the inbox message `inbox` get ids derived from it. */
function changesFor(events: E2eEvent[], at: number, inbox: number | null): ChatChange[] {
  const changes: ChatChange[] = [];
  events.forEach((e, i) => {
    const id = `in:${inbox}:${i}`;
    switch (e.kind) {
      case "received":
        // Only text is shown; a CHAL or an ACK is the authorisation slice's.
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
        changes.push({ op: "out", nick: e.nick, id: e.tag, state: "queued", reason: null });
        break;
      case "send_failed":
        for (const tag of e.tags) {
          changes.push({ op: "out", nick: e.nick, id: tag, state: "failed", reason: e.reason });
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

export function e2eClient(
  olm: Olm,
  accounts: AccountStore,
  chats: ChatStore,
  now: () => number,
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

  return {
    drain: (ctx) =>
      accounts.withAccount(ctx.slot, async ({ account, state, persist }) => {
        const engine = new Engine(olm, account, state, ctx.ownNick, now);
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
            state.inbox = m.id;
          }
          for (const key of await chats.apply(ctx.slot, changes)) touched.add(key);
          await persist();
          const sent = await flush(engine, ctx.door, outbound);
          await persist();
          for (const key of await chats.apply(ctx.slot, sent)) touched.add(key);
          await ctx.door.ack(page.map((m) => m.id));
          after = last.id;
        }
        const ticked = changesFor(engine.tick().events, now(), null);
        for (const key of await chats.apply(ctx.slot, ticked)) touched.add(key);
        return { chats: [...touched], pkmsgs, waiting: Object.keys(state.outq).length > 0 };
      }),

    send: (ctx, nick, body) =>
      accounts.withAccount(ctx.slot, async ({ account, state, persist }) => {
        const engine = new Engine(olm, account, state, ctx.ownNick, now);
        const tag = crypto.randomUUID();
        const res = engine.send(nick, { t: "text", body }, tag);
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
        return { chats: [...touched], pkmsgs: 0, waiting: Object.keys(state.outq).length > 0 };
      }),

    tick: (ctx) =>
      accounts.withAccount(ctx.slot, async ({ account, state }) => {
        const engine = new Engine(olm, account, state, ctx.ownNick, now);
        const changes = changesFor(engine.tick().events, now(), null);
        const touched = await chats.apply(ctx.slot, changes);
        return { chats: touched, pkmsgs: 0, waiting: Object.keys(state.outq).length > 0 };
      }),
  };
}
