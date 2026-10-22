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
//   * a drain opened pre-key messages: refill the key bundle.

import { createEffect, createSignal, onCleanup } from "solid-js";
import { ApiError, ackE2eInbox, listE2eInbox, sendE2e } from "./api";
import { token } from "./auth";
import { browserE2e } from "./e2e/browser";
import { accountSlot, syncKeyBundle } from "./e2e/bundleSync";
import type { Chat, ChatRow, DoorRefusal } from "./e2e/chatStore";
import {
  type Door,
  type E2eClient,
  type E2eContext,
  e2eClient,
  NoAccountError,
  type PeerTrust,
  type Report,
} from "./e2e/client";
import { fold } from "./e2e/wire";
import { identityScopedStore } from "./identityScopedStore";
import { networkBySlug, networks, user } from "./networks";

/** How often messages waiting for keys are checked (they give up after a minute). */
export const TICK_MS = 5_000;

/** What the window's trust badge says about the key behind the nick. */
export type Trust = "verified" | "unverified" | "alarm";

/**
 * The badge: an alarm since the last pin by hand is an alarm (a new key spoke
 * for the nick and was ignored); otherwise the pinned key's own standing.
 * No key yet reads as unverified.
 */
export function trustOf(rows: readonly ChatRow[], peer: PeerTrust | null): Trust {
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (row?.kind === "key_alarm") return "alarm";
    if (row?.kind === "pinned") break;
  }
  return peer?.verified === true ? "verified" : "unverified";
}

export type EncryptedChatEntry = { key: string; nick: string; unread: number };

type Ctx = { ctx: E2eContext; bearer: string; slot: string };

const refusalOf = (err: unknown): DoorRefusal => {
  if (err instanceof ApiError && err.status === 429) return "rate-limited";
  if (err instanceof ApiError && err.status === 413) return "too-large";
  return "refused";
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
  /** Chats a window showed: kept current. Others are read when shown. */
  const loaded = new Set<string>();
  /** Networks with messages waiting for keys. */
  const waiting = new Set<string>();
  const draining = new Map<string, Promise<void>>();
  const drainAgain = new Set<string>();

  onIdentityChange(() => {
    setChatsBySlug({});
    setRowsByChat({});
    setTrustByChat({});
    setOwnKeyBySlug({});
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
    return { bearer, slot, ctx: { slot, ownNick: network.nick, door: door(bearer, slug) } };
  }

  // An operation on the network's account. A slot without one is synced
  // first (only the bundle sync creates an account), then tried again.
  async function run<T>(slug: string, op: (client: E2eClient, ctx: E2eContext) => Promise<T>) {
    const c = contextFor(slug);
    const { olm, accounts, chats } = await browserE2e();
    const client = e2eClient(olm, accounts, chats, Date.now);
    try {
      return await op(client, c.ctx);
    } catch (err) {
      if (!(err instanceof NoAccountError)) throw err;
      await syncKeyBundle(accounts, c.bearer, c.slot, slug);
      return op(client, c.ctx);
    }
  }

  // Reads the network's chat index again, and the rows and trust of the
  // touched chats a window has shown.
  async function refresh(slug: string, touched: readonly string[]): Promise<void> {
    const { slot } = contextFor(slug);
    const { chats } = await browserE2e();
    const index = await chats.chats(slot);
    setChatsBySlug((prev) => ({ ...prev, [slug]: index }));
    const shown = touched.filter((key) => loaded.has(`${slug} ${key}`));
    if (shown.length === 0) return;
    const rows = await Promise.all(shown.map((key) => chats.rows(slot, key)));
    setRowsByChat((prev) => {
      const next = { ...prev };
      shown.forEach((key, i) => {
        next[`${slug} ${key}`] = rows[i] ?? [];
      });
      return next;
    });
    const { own, peers } = await run(slug, (client, ctx) => client.identity(ctx, shown));
    setOwnKeyBySlug((prev) => ({ ...prev, [slug]: own }));
    setTrustByChat((prev) => {
      const next = { ...prev };
      for (const key of shown) next[`${slug} ${key}`] = peers[key] ?? null;
      return next;
    });
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

  async function pinEncryptedKey(
    slug: string,
    nick: string,
    key: string,
  ): Promise<"pinned" | "bad-key" | "own-key"> {
    const { result, chats } = await run(slug, (client, ctx) => client.pin(ctx, nick, key));
    if (result === "pinned") await changed(slug, chats);
    return result;
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
    readEncryptedChat,
    sendEncrypted,
    pinEncryptedKey,
    encryptedChatsFor,
    encryptedChat,
    encryptedRows,
    encryptedTrust,
    ownKey,
    mountEncryptedChats,
  };
});

export const drainE2e = exports_.drainE2e;
export const drainEveryNetwork = exports_.drainEveryNetwork;
export const loadEncryptedChat = exports_.loadEncryptedChat;
export const openEncryptedChat = exports_.openEncryptedChat;
export const closeEncryptedChat = exports_.closeEncryptedChat;
export const readEncryptedChat = exports_.readEncryptedChat;
export const sendEncrypted = exports_.sendEncrypted;
export const pinEncryptedKey = exports_.pinEncryptedKey;
export const encryptedChatsFor = exports_.encryptedChatsFor;
export const encryptedChat = exports_.encryptedChat;
export const encryptedRows = exports_.encryptedRows;
export const encryptedTrust = exports_.encryptedTrust;
export const ownKey = exports_.ownKey;
export const mountEncryptedChats = exports_.mountEncryptedChats;
