// issue 2430 — the encrypted queries as the UI sees them: one window per
// (network, peer nick), its rows, and who the nick is pinned to.
//
// The window lives in cic only (2430 comment 6333417572): grappa learns
// nothing about it beyond the E2E lines it already relays, its rows are the
// device's own (`e2e/chatStore.ts`), and so is its unread count. This module
// is the glue between those stores, the E2E client (`e2e/client.ts`) and
// grappa's doors (`api.ts`), and it keeps a reactive copy of what the open
// windows show. IndexedDB stays the truth: every tab drains the same inbox,
// so a tab that changes a chat says so on a BroadcastChannel, and the others
// read it again.
//
// When things happen:
//   * a network shows up in the list after login, and the user topic joins
//     (every reconnect): drain its inbox;
//   * an `e2e_message` arrives: drain that network's (the push only says
//     there is something; the drain takes it in id order, with the rest);
//   * messages wait for keys: a tick every few seconds reports the ones
//     that waited too long;
//   * a drain opened pre-key messages: refill the key bundle;
//   * a SAS is under way: the same tick ends it when its time runs out, or
//     when the page that held its secret went away (`e2e/sas.ts`);
//   * grappa drops a message it had accepted (`e2e_send_dropped`): its row
//     turns failed.
//
// An order challenge is answered inside the drain (`e2e/client.ts`), against
// the device's send log (`e2e/orders.ts`) and the network's 005 `NETWORK=`.

import { createEffect, createSignal, onCleanup } from "solid-js";
import { ApiError, ackE2eInbox, listE2eInbox, sendE2e } from "./api";
import { token } from "./auth";
import { browserE2e } from "./e2e/browser";
import { accountSlot, syncKeyBundle } from "./e2e/bundleSync";
import type { Chat, ChatRow, DoorRefusal, SendDropped } from "./e2e/chatStore";
import {
  type Door,
  type E2eClient,
  type E2eContext,
  e2eClient,
  NoAccountError,
  type PeerTrust,
  type Report,
} from "./e2e/client";
import { sendLog } from "./e2e/orders";
import type { SasStep, SasView } from "./e2e/sas";
import { fold } from "./e2e/wire";
import { identityScopedStore } from "./identityScopedStore";
import { casemappingForNetwork, isupportForNetwork } from "./isupport";
import { networkBySlug, networks, user } from "./networks";
import type { SessionWireE2eDropReason } from "./wireTypes";

/** How often what waits on the clock is checked: messages waiting for keys (a minute), SASes (10). */
export const TICK_MS = 5_000;

/** What the window's trust badge says about the key behind the nick. */
export type Trust = "verified" | "unverified" | "alarm";

/** The rows after which an earlier alarm is answered: the user chose or checked the key. */
const ANSWERS_ALARM = new Set<ChatRow["kind"]>(["pinned", "accepted", "verified"]);

/**
 * The badge: an alarm since the user last chose or checked the key (pinned
 * it, took it, verified it by SAS) is an alarm: a new key spoke for the nick
 * and was ignored. Otherwise the pinned key's own standing. No key yet reads
 * as unverified.
 */
export function trustOf(rows: readonly ChatRow[], peer: PeerTrust | null): Trust {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.kind === "key_alarm") return "alarm";
    if (row !== undefined && ANSWERS_ALARM.has(row.kind)) break;
  }
  return peer?.verified === true ? "verified" : "unverified";
}

export type EncryptedChatEntry = { key: string; nick: string; unread: number };

type Ctx = { ctx: E2eContext; bearer: string; slot: string };

const refusalOf = (err: unknown): DoorRefusal => {
  if (err instanceof ApiError && err.status === 429) return "rate-limited";
  if (err instanceof ApiError && err.status === 413) return "too-large";
  if (err instanceof ApiError && err.status === 422 && err.code === "too_late") return "too-late";
  return "refused";
};

/** The `e2e_send_dropped` reasons, as a row's failure. */
const DROPPED: Record<SessionWireE2eDropReason, SendDropped> = {
  late: "late",
  send_failed: "send-failed",
  session_ended: "session-ended",
};

function door(bearer: string, slug: string): Door {
  return {
    inbox: async (after) =>
      (await listE2eInbox(bearer, slug, after)).messages.map((m) => ({
        id: m.id,
        from: m.from,
        verb: m.verb,
        msgid: m.msgid,
        payload: m.payload,
      })),
    ack: (ids) => ackE2eInbox(bearer, slug, ids),
    send: async (out) => {
      try {
        return await sendE2e(bearer, slug, {
          target: out.target,
          verb: out.verb,
          payload: out.payload,
          priority: out.priority,
          ...(out.expiresAt === undefined ? {} : { expires_at: out.expiresAt }),
        });
      } catch (err) {
        // The client marks the message failed with the reason; the cause
        // goes to the console, where an operator looks.
        console.warn(`[e2e] the send door refused a ${out.verb} to ${out.target}`, err);
        return { refused: refusalOf(err) };
      }
    },
  };
}

type Changed = { slug: string; slot: string; chats: string[] };

const exports_ = identityScopedStore((onIdentityChange) => {
  const [chatsBySlug, setChatsBySlug] = createSignal<Record<string, Record<string, Chat>>>({});
  const [rowsByChat, setRowsByChat] = createSignal<Record<string, ChatRow[]>>({});
  const [trustByChat, setTrustByChat] = createSignal<Record<string, PeerTrust | null>>({});
  const [ownKeyBySlug, setOwnKeyBySlug] = createSignal<Record<string, string>>({});
  const [sasByChat, setSasByChat] = createSignal<Record<string, SasView | null>>({});
  /** Chats a window showed: kept current. Others are read when shown. */
  const loaded = new Set<string>();
  /** Networks with something waiting on the clock: messages waiting for keys, a SAS. */
  const waiting = new Set<string>();
  const draining = new Map<string, Promise<void>>();
  const drainAgain = new Set<string>();

  onIdentityChange(() => {
    setChatsBySlug({});
    setRowsByChat({});
    setTrustByChat({});
    setOwnKeyBySlug({});
    setSasByChat({});
    loaded.clear();
    waiting.clear();
    drainAgain.clear();
  });

  const chatId = (slug: string, nick: string) => `${slug} ${fold(nick)}`;

  const channel =
    typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel("grappa-e2e-chats");

  function contextFor(slug: string): Ctx {
    const bearer = token();
    const me = user();
    const network = networkBySlug(slug);
    if (!bearer || !me || network === undefined) throw new Error(`no network ${slug} to use`);
    const slot = accountSlot(me, network.id);
    const scope = {
      slug,
      network: isupportForNetwork(network.id).network,
      casemapping: casemappingForNetwork(network.id),
    };
    return {
      bearer,
      slot,
      ctx: {
        slot,
        ownNick: network.nick,
        door: door(bearer, slug),
        orders: (chal, at) => sendLog.confirms(chal, scope, at),
      },
    };
  }

  // An operation on the network's account. A slot without one is synced
  // first (only the bundle sync creates an account), then tried again.
  async function run<T>(slug: string, op: (client: E2eClient, ctx: E2eContext) => Promise<T>) {
    const c = contextFor(slug);
    const { olm, accounts, chats, sas } = await browserE2e();
    const client = e2eClient(olm, accounts, chats, Date.now, sas);
    try {
      return await op(client, c.ctx);
    } catch (err) {
      if (!(err instanceof NoAccountError)) throw err;
      await syncKeyBundle(accounts, c.bearer, c.slot, slug);
      return op(client, c.ctx);
    }
  }

  // Reads the network's chat index again, and the trust, SAS and rows of
  // the touched chats a window has shown. Identity first: working out a
  // SAS's emoji may end it (a key that makes no secret), and write that down.
  async function refresh(slug: string, touched: readonly string[]): Promise<void> {
    const { slot } = contextFor(slug);
    const { chats } = await browserE2e();
    const shown = touched.filter((key) => loaded.has(`${slug} ${key}`));
    const identity =
      shown.length === 0
        ? undefined
        : await run(slug, (client, ctx) => client.identity(ctx, shown));
    const index = await chats.chats(slot);
    setChatsBySlug((prev) => ({ ...prev, [slug]: index }));
    if (identity === undefined) return;
    const rows = await Promise.all(shown.map((key) => chats.rows(slot, key)));
    const ids = shown.map((key) => `${slug} ${key}`);
    const each =
      <T>(of: (key: string, i: number) => T) =>
      (prev: Record<string, T>) => {
        const next = { ...prev };
        shown.forEach((key, i) => {
          next[ids[i] as string] = of(key, i);
        });
        return next;
      };
    setRowsByChat(each((_key, i) => rows[i] ?? []));
    setOwnKeyBySlug((prev) => ({ ...prev, [slug]: identity.own }));
    setTrustByChat(each((key) => identity.peers[key] ?? null));
    setSasByChat(each((key) => identity.sas[key] ?? null));
    // A SAS another tab runs waits on this tab's clock too: that tab may go.
    if (Object.values(identity.sas).some((view) => view !== null)) waiting.add(slug);
  }

  async function changed(slug: string, touched: readonly string[]): Promise<void> {
    await refresh(slug, touched);
    const message: Changed = { slug, slot: contextFor(slug).slot, chats: [...touched] };
    channel?.postMessage(message);
  }

  async function afterReport(slug: string, report: Report): Promise<void> {
    if (report.waiting) waiting.add(slug);
    else waiting.delete(slug);
    await changed(slug, report.chats);
    if (report.pkmsgs > 0) {
      const c = contextFor(slug);
      const { accounts } = await browserE2e();
      await syncKeyBundle(accounts, c.bearer, c.slot, slug);
    }
  }

  channel?.addEventListener("message", (event: MessageEvent<Changed>) => {
    const { slug, slot, chats } = event.data;
    // Another identity's tab (a different login in the same browser) is not ours.
    if (networkBySlug(slug) === undefined || contextFor(slug).slot !== slot) return;
    void refresh(slug, chats).catch((err: unknown) => {
      console.warn(`[e2e] could not read the chats another tab changed on ${slug}`, err);
    });
  });

  /** Takes what waits in the network's inbox; a drain asked for while one runs runs once more after it. */
  function drainE2e(slug: string): Promise<void> {
    const running = draining.get(slug);
    if (running !== undefined) {
      drainAgain.add(slug);
      return running;
    }
    const drain = (async () => {
      do {
        drainAgain.delete(slug);
        const report = await run(slug, (client, ctx) => client.drain(ctx));
        await afterReport(slug, report);
      } while (drainAgain.has(slug));
    })().finally(() => draining.delete(slug));
    draining.set(slug, drain);
    return drain;
  }

  function drainEveryNetwork(): void {
    for (const network of networks() ?? []) {
      void drainE2e(network.slug).catch((err: unknown) => {
        console.warn(`[e2e] could not drain the encrypted inbox on ${network.slug}`, err);
      });
    }
  }

  async function tickWaiting(): Promise<void> {
    for (const slug of [...waiting]) {
      const report = await run(slug, (client, ctx) => client.tick(ctx));
      await afterReport(slug, report);
    }
  }

  /** Shows the chat with `nick`: reads its rows and trust, and keeps them current. */
  async function loadEncryptedChat(slug: string, nick: string): Promise<void> {
    loaded.add(chatId(slug, nick));
    await refresh(slug, [fold(nick)]);
  }

  async function openEncryptedChat(slug: string, nick: string): Promise<void> {
    const { chats } = await browserE2e();
    await chats.open(contextFor(slug).slot, nick);
    await changed(slug, [fold(nick)]);
  }

  async function closeEncryptedChat(slug: string, nick: string): Promise<void> {
    const { chats } = await browserE2e();
    await chats.close(contextFor(slug).slot, nick);
    await changed(slug, [fold(nick)]);
  }

  /**
   * Deletes the chat with `nick` on this device, in every tab, and what the
   * engine still holds of it in the clear; the pin and the sessions stay.
   * A later message, or `/equery`, opens it again empty.
   */
  async function deleteEncryptedChat(slug: string, nick: string): Promise<void> {
    await changed(slug, await run(slug, (client, ctx) => client.deleteChat(ctx, nick)));
  }

  /** Whether the chat with `nick` keeps any row on this device: what its close asks about. */
  async function encryptedChatHasRows(slug: string, nick: string): Promise<boolean> {
    const { chats } = await browserE2e();
    return (await chats.rows(contextFor(slug).slot, nick)).length > 0;
  }

  async function readEncryptedChat(slug: string, nick: string): Promise<void> {
    if ((chatsBySlug()[slug]?.[fold(nick)]?.unread ?? 0) === 0) return;
    const { chats } = await browserE2e();
    await chats.read(contextFor(slug).slot, nick);
    await changed(slug, [fold(nick)]);
  }

  async function sendEncrypted(slug: string, nick: string, body: string): Promise<void> {
    const report = await run(slug, (client, ctx) => client.send(ctx, nick, body));
    await afterReport(slug, report);
  }

  /** Pins `key` to `nick`: `verified` when pasted, not when taken off the alarm. */
  async function pinEncryptedKey(
    slug: string,
    nick: string,
    key: string,
    verified: boolean,
  ): Promise<"pinned" | "bad-key" | "own-key"> {
    const { result, chats } = await run(slug, (client, ctx) =>
      client.pin(ctx, nick, key, verified),
    );
    if (result === "pinned") await changed(slug, chats);
    return result;
  }

  /** The user's step in the emoji comparison with `nick`. */
  async function verifyEncrypted(slug: string, nick: string, step: SasStep): Promise<void> {
    const report = await run(slug, (client, ctx) => client.verify(ctx, nick, step));
    await afterReport(slug, report);
  }

  /** grappa dropped `msgid` after accepting it (`e2e_send_dropped`). */
  async function encryptedSendDropped(
    slug: string,
    msgid: string,
    reason: SessionWireE2eDropReason,
  ): Promise<void> {
    const report = await run(slug, (client, ctx) => client.dropped(ctx, msgid, DROPPED[reason]));
    await afterReport(slug, report);
  }

  /** The open encrypted chats of a network, in the order they were first opened. */
  const encryptedChatsFor = (slug: string): EncryptedChatEntry[] =>
    Object.entries(chatsBySlug()[slug] ?? {})
      .filter(([, chat]) => chat.open)
      .map(([key, chat]) => ({ key, nick: chat.nick, unread: chat.unread }));

  const encryptedChat = (slug: string, nick: string): Chat | undefined =>
    chatsBySlug()[slug]?.[fold(nick)];

  const encryptedRows = (slug: string, nick: string): ChatRow[] | undefined =>
    rowsByChat()[chatId(slug, nick)];

  const encryptedTrust = (slug: string, nick: string): PeerTrust | null =>
    trustByChat()[chatId(slug, nick)] ?? null;

  const ownKey = (slug: string): string | undefined => ownKeyBySlug()[slug];

  const encryptedSas = (slug: string, nick: string): SasView | null =>
    sasByChat()[chatId(slug, nick)] ?? null;

  /**
   * Drains each network's inbox once per login, as the network list brings
   * it (the user topic's join may come before the list does), and ticks
   * waiting messages. Registered by main.tsx.
   */
  function mountEncryptedChats(): void {
    const drained = new Set<string>();
    const tick = setInterval(() => {
      void tickWaiting().catch((err: unknown) => {
        console.warn("[e2e] could not check the messages waiting for keys", err);
      });
    }, TICK_MS);
    onCleanup(() => clearInterval(tick));
    onIdentityChange(() => drained.clear());
    createEffect(() => {
      if (!token() || !user()) return;
      for (const network of networks() ?? []) {
        if (drained.has(network.slug)) continue;
        drained.add(network.slug);
        void drainE2e(network.slug).catch((err: unknown) => {
          drained.delete(network.slug);
          console.warn(`[e2e] could not drain the encrypted inbox on ${network.slug}`, err);
        });
      }
    });
  }

  return {
    drainE2e,
    drainEveryNetwork,
    loadEncryptedChat,
    openEncryptedChat,
    closeEncryptedChat,
    deleteEncryptedChat,
    encryptedChatHasRows,
    readEncryptedChat,
    sendEncrypted,
    pinEncryptedKey,
    verifyEncrypted,
    encryptedSendDropped,
    encryptedChatsFor,
    encryptedChat,
    encryptedRows,
    encryptedTrust,
    encryptedSas,
    ownKey,
    mountEncryptedChats,
  };
});

export const drainE2e = exports_.drainE2e;
export const drainEveryNetwork = exports_.drainEveryNetwork;
export const loadEncryptedChat = exports_.loadEncryptedChat;
export const openEncryptedChat = exports_.openEncryptedChat;
export const closeEncryptedChat = exports_.closeEncryptedChat;
export const deleteEncryptedChat = exports_.deleteEncryptedChat;
export const encryptedChatHasRows = exports_.encryptedChatHasRows;
export const readEncryptedChat = exports_.readEncryptedChat;
export const sendEncrypted = exports_.sendEncrypted;
export const pinEncryptedKey = exports_.pinEncryptedKey;
export const verifyEncrypted = exports_.verifyEncrypted;
export const encryptedSendDropped = exports_.encryptedSendDropped;
export const encryptedChatsFor = exports_.encryptedChatsFor;
export const encryptedChat = exports_.encryptedChat;
export const encryptedRows = exports_.encryptedRows;
export const encryptedTrust = exports_.encryptedTrust;
export const encryptedSas = exports_.encryptedSas;
export const ownKey = exports_.ownKey;
export const mountEncryptedChats = exports_.mountEncryptedChats;
