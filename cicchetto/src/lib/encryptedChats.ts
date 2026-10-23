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
//     (every reconnect): drain this device's inbox there;
//   * an `e2e_message` arrives: drain that network's (the push only says
//     there is something, and reaches every device of the user; the drain
//     takes what is this device's, in id order, with the rest);
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
//
// An identity is never replaced silently (`e2e/identity.ts`): when grappa
// holds one this browser cannot speak for, the network reads "elsewhere"
// (`identityElsewhere`), nothing runs on it, and the window offers the two
// ways out: pairing this browser with a device that holds the identity, or,
// confirmed, starting a new one here (`replaceEncryptedIdentity`).

import { createEffect, createSignal, onCleanup } from "solid-js";
import { ApiError, ackE2eDeviceInbox, listE2eDeviceInbox, sendE2e } from "./api";
import { token } from "./auth";
import { browserE2e } from "./e2e/browser";
import type { Chat, ChatRow, DoorRefusal, SendDropped } from "./e2e/chatStore";
import {
  type Door,
  type E2eClient,
  type E2eContext,
  e2eClient,
  IdentityElsewhereError,
  NoAccountError,
  type PeerTrust,
  type Report,
} from "./e2e/client";
import type { PinOutcome } from "./e2e/engine";
import { accountSlot, type IdentityState, replaceIdentity, syncIdentity } from "./e2e/identity";
import { type OrderScope, sendLog, subjectKey } from "./e2e/orders";
import type { SasStep, SasView } from "./e2e/sas";
import { fold } from "./e2e/wire";
import { identityScopedStore } from "./identityScopedStore";
import {
  casemappingForNetwork,
  chantypesForNetwork,
  frameBudgetBaseForNetwork,
  isupportForNetwork,
} from "./isupport";
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
  if (err instanceof ApiError && err.status === 422 && err.code === "unknown_device") {
    return "unknown-device";
  }
  return "refused";
};

/** The `e2e_send_dropped` reasons, as a row's failure. */
const DROPPED: Record<SessionWireE2eDropReason, SendDropped> = {
  late: "late",
  send_failed: "send-failed",
  session_ended: "session-ended",
};

/** grappa's doors for the subject's device `did` on the network: its own inbox, and the send door. */
const doors =
  (bearer: string, slug: string) =>
  (did: string): Door => ({
    inbox: async (after) =>
      (await listE2eDeviceInbox(bearer, slug, did, after)).messages.map((m) => ({
        id: m.id,
        from: m.from,
        fromDid: m.from_did,
        verb: m.verb,
        msgid: m.msgid,
        payload: m.payload,
      })),
    ack: (ids) => ackE2eDeviceInbox(bearer, slug, did, ids),
    send: async (out) => {
      try {
        return await sendE2e(bearer, slug, {
          target: out.target,
          verb: out.verb,
          from: out.from,
          to: out.to,
          payload: out.payload,
          priority: out.priority,
          expiresAt: out.expiresAt ?? null,
        });
      } catch (err) {
        // The client marks the message failed with the reason; the cause
        // goes to the console, where an operator looks.
        console.warn(`[e2e] the send door refused a ${out.verb} to ${out.target}`, err);
        return { refused: refusalOf(err) };
      }
    },
  });

// The window says it: an identity held elsewhere is where the network stands,
// not a failure to log every time something tries to run on it.
function unlessElsewhere(err: unknown): undefined {
  if (!(err instanceof IdentityElsewhereError)) throw err;
  return undefined;
}

type Changed = { slug: string; slot: string; chats: string[] };

const exports_ = identityScopedStore((onIdentityChange) => {
  const [chatsBySlug, setChatsBySlug] = createSignal<Record<string, Record<string, Chat>>>({});
  const [rowsByChat, setRowsByChat] = createSignal<Record<string, ChatRow[]>>({});
  const [trustByChat, setTrustByChat] = createSignal<Record<string, PeerTrust | null>>({});
  const [ownKeyBySlug, setOwnKeyBySlug] = createSignal<Record<string, string>>({});
  const [sasByChat, setSasByChat] = createSignal<Record<string, SasView | null>>({});
  /** Networks whose identity grappa holds and this browser cannot speak for. */
  const [elsewhereBySlug, setElsewhereBySlug] = createSignal<Record<string, true>>({});
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
    setElsewhereBySlug({});
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
    const scope: OrderScope = {
      subject: subjectKey(me),
      slug,
      network: isupportForNetwork(network.id).network,
      casemapping: casemappingForNetwork(network.id),
      chantypes: chantypesForNetwork(network.id),
    };
    return {
      bearer,
      slot,
      ctx: {
        slot,
        ownNick: network.nick,
        frameBudgetBase: frameBudgetBaseForNetwork(network.id),
        door: doors(bearer, slug),
        orders: (chal, challenger, at) => sendLog.confirms(chal, challenger, scope, at),
      },
    };
  }

  /** Where a sync, or an operation, found the network's identity: what the window shows. */
  function identitySynced(slug: string, state: IdentityState): void {
    setElsewhereBySlug((prev) => {
      if ((prev[slug] === true) === (state === "elsewhere")) return prev;
      const next = { ...prev };
      if (state === "elsewhere") next[slug] = true;
      else delete next[slug];
      return next;
    });
  }

  const identityElsewhere = (slug: string): boolean => elsewhereBySlug()[slug] === true;

  async function sync(slug: string): Promise<IdentityState> {
    const c = contextFor(slug);
    const { accounts } = await browserE2e();
    const state = await syncIdentity(accounts, c.bearer, c.slot, slug);
    identitySynced(slug, state);
    return state;
  }

  // An operation on the network's identity. A slot without an account is
  // synced first (only the identity sync makes one), then tried again, once.
  // An identity held elsewhere runs nothing, and is not tried again: only the
  // user moves it (pairing, or a new identity). A 404 from this device's
  // doors says grappa holds the device no more (another device replaced the
  // identity, or revoked this one): the sync works out where it stands.
  async function run<T>(slug: string, op: (client: E2eClient, ctx: E2eContext) => Promise<T>) {
    if (identityElsewhere(slug)) throw new IdentityElsewhereError(`identity elsewhere on ${slug}`);
    const c = contextFor(slug);
    const { olm, accounts, chats, sas } = await browserE2e();
    const client = e2eClient(olm, accounts, chats, Date.now, sas);
    try {
      return await op(client, c.ctx);
    } catch (err) {
      if (err instanceof IdentityElsewhereError) identitySynced(slug, "elsewhere");
      if (err instanceof ApiError && err.status === 404 && (await sync(slug)) === "elsewhere") {
        throw new IdentityElsewhereError(`identity elsewhere on ${slug}`);
      }
      if (!(err instanceof NoAccountError)) throw err;
      if ((await sync(slug)) === "elsewhere") {
        throw new IdentityElsewhereError(`identity elsewhere on ${slug}`);
      }
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
        : await run(slug, (client, ctx) => client.identity(ctx, shown)).catch(unlessElsewhere);
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

  // Tells this browser's other tabs that the network changed: its chats
  // `touched`, or its identity.
  function tellTabs(slug: string, slot: string, touched: readonly string[]): void {
    const message: Changed = { slug, slot, chats: [...touched] };
    channel?.postMessage(message);
  }

  async function changed(slug: string, touched: readonly string[]): Promise<void> {
    await refresh(slug, touched);
    tellTabs(slug, contextFor(slug).slot, touched);
  }

  /**
   * A pairing just made this browser a device of the network's identity
   * (`completeJoin`): the network is ready here, and every other tab of this
   * browser that holds it elsewhere syncs it again.
   */
  function pairedHere(slug: string, slot: string): void {
    identitySynced(slug, "ready");
    tellTabs(slug, slot, []);
  }

  // Pre-key messages spent one-time keys: the sync refills the bundle. A
  // payload refused as from a device grappa does not list: the sync works out
  // where the identity stands.
  async function afterReport(slug: string, report: Report): Promise<void> {
    if (report.waiting) waiting.add(slug);
    else waiting.delete(slug);
    await changed(slug, report.chats);
    if (report.pkmsgs > 0 || report.unknownDevice) await sync(slug);
  }

  channel?.addEventListener("message", (event: MessageEvent<Changed>) => {
    const { slug, slot, chats } = event.data;
    // Another identity's tab (a different login in the same browser) is not ours.
    if (networkBySlug(slug) === undefined || contextFor(slug).slot !== slot) return;
    void (async () => {
      // That tab may have started a new identity here, or paired this
      // browser: a network this tab holds elsewhere is synced again first.
      if (identityElsewhere(slug)) await sync(slug);
      await refresh(slug, chats);
    })().catch((err: unknown) => {
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
    })()
      .catch(unlessElsewhere)
      .finally(() => draining.delete(slug));
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

  // Each network on its own: one that fails is logged and tried again on the
  // next tick, and never holds up the ones after it.
  async function tickWaiting(): Promise<void> {
    for (const slug of [...waiting]) {
      // A network that left the list (detached) has nothing left to tick here.
      if (networkBySlug(slug) === undefined) {
        waiting.delete(slug);
        continue;
      }
      try {
        await afterReport(slug, await run(slug, (client, ctx) => client.tick(ctx)));
      } catch (err) {
        if (err instanceof IdentityElsewhereError) waiting.delete(slug);
        else console.warn(`[e2e] could not check what waits on ${slug}`, err);
      }
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

  /** Pins the master `key` to `nick`: `verified` when pasted, not when taken off the alarm. */
  async function pinEncryptedKey(
    slug: string,
    nick: string,
    key: string,
    verified: boolean,
  ): Promise<PinOutcome> {
    const { result, ...report } = await run(slug, (client, ctx) =>
      client.pin(ctx, nick, key, verified),
    );
    // A pin asks the nick for its list, which may wait on the clock.
    if (result === "pinned") await afterReport(slug, report);
    return result;
  }

  /**
   * DESTRUCTIVE, and only for the user's confirmed choice: deletes this
   * account's identity for the network on grappa and starts a new one here
   * (`replaceIdentity`). Then the network runs as any other: its inbox is
   * drained, and the windows it shows read the new identity. The flag the
   * choice was made on may be stale (another tab started a new identity, or
   * paired this browser): a sync first, and an identity this browser speaks
   * for after all is kept, never deleted.
   */
  async function replaceEncryptedIdentity(slug: string): Promise<void> {
    if ((await sync(slug)) === "elsewhere") {
      const c = contextFor(slug);
      const { accounts } = await browserE2e();
      await replaceIdentity(accounts, c.bearer, c.slot, slug);
      identitySynced(slug, "ready");
    }
    const shown = [...loaded].flatMap((id) =>
      id.startsWith(`${slug} `) ? [id.slice(slug.length + 1)] : [],
    );
    await refresh(slug, shown);
    await drainE2e(slug);
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
    // Every device of the user hears it: on a network held elsewhere it is
    // another device's, and nothing of it is this browser's.
    try {
      const report = await run(slug, (client, ctx) => client.dropped(ctx, msgid, DROPPED[reason]));
      await afterReport(slug, report);
    } catch (err) {
      unlessElsewhere(err);
    }
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
    // `tickWaiting` logs each network's failure itself, and goes on.
    const tick = setInterval(() => void tickWaiting(), TICK_MS);
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
    replaceEncryptedIdentity,
    identitySynced,
    identityElsewhere,
    pairedHere,
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
export const replaceEncryptedIdentity = exports_.replaceEncryptedIdentity;
export const identitySynced = exports_.identitySynced;
export const identityElsewhere = exports_.identityElsewhere;
export const pairedHere = exports_.pairedHere;
export const verifyEncrypted = exports_.verifyEncrypted;
export const encryptedSendDropped = exports_.encryptedSendDropped;
export const encryptedChatsFor = exports_.encryptedChatsFor;
export const encryptedChat = exports_.encryptedChat;
export const encryptedRows = exports_.encryptedRows;
export const encryptedTrust = exports_.encryptedTrust;
export const encryptedSas = exports_.encryptedSas;
export const ownKey = exports_.ownKey;
export const mountEncryptedChats = exports_.mountEncryptedChats;
