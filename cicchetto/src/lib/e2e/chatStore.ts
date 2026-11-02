// issue 2430 — the encrypted queries' history, kept on this device only
// (2430 "cicchetto side": decrypted messages are cached locally, encrypted at
// rest; lost storage is lost history, accepted).
//
// It is not a cache of something grappa keeps: an inbox message, once
// decrypted and acknowledged, exists nowhere else, and the session key that
// opened it is spent. So a message is written here BEFORE the account state
// that spent its key is stored, and rows from the inbox carry ids derived
// from the inbox id: an inbox message processed again (the tab died between
// the two writes) lands on the rows it already wrote, and adds nothing.
//
// Sealed like the account, under the same wrapping key, in the `chats` store
// of the same database. Its keys say nothing about who the chats are with:
// one index record per slot (which chats exist, under which nick, how many
// unread), and one record per chat under a random id. Every change runs
// under the slot's chat lock, so two tabs never write over each other.

import { type Lock, open, type Sealed, seal, type Vault } from "./accountStore";
import type { SendFailure } from "./engine";
import type { OrderVerdict } from "./orders";
import { fold } from "./wire";

/** Where an outgoing message is: waiting for keys, handed to grappa, accepted, or not. */
export type OutState = "queued" | "sending" | "sent" | "failed";
/**
 * grappa's send door refused the payload: its queue for the peer was full,
 * an order's deadline was already out of reach, the device it came from is
 * not one grappa lists for the subject (`unknown-device`: the identity was
 * replaced, or this device revoked, elsewhere), or worse.
 */
export type DoorRefusal = "rate-limited" | "too-large" | "too-late" | "unknown-device" | "refused";
/** grappa accepted the payload, then dropped it unsent (`e2e_send_dropped`). */
export type SendDropped = "late" | "send-failed" | "session-ended";
export type OutFailure = SendFailure | DoorRefusal | SendDropped;

export type ChatRow =
  /** A message read: `ed25519` is the master of the device that wrote it, the key the nick is pinned to. */
  | { kind: "in"; id: string; at: number; nick: string; ed25519: string; body: string }
  | {
      kind: "out";
      id: string;
      at: number;
      body: string;
      state: OutState;
      reason: OutFailure | null;
    }
  /** "X sent you an encrypted message that cannot be read here" (2430 "Delivery"). */
  | { kind: "undecryptable"; id: string; at: number; nick: string }
  /** A key other than the pinned one, on this nick: ignored, and shown. */
  | { kind: "key_alarm"; id: string; at: number; nick: string; presented: string }
  /** The user pinned this key to the nick by hand: it is the one written to now. */
  | { kind: "pinned"; id: string; at: number; nick: string; ed25519: string }
  /** The user took this key for the nick, unverified (the alarm's "accept"): written to now. */
  | { kind: "accepted"; id: string; at: number; nick: string; ed25519: string }
  /** A SAS began (`sas.ts`): we asked, or the peer did. */
  | { kind: "sas_asked"; id: string; at: number; nick: string; by: "you" | "peer" }
  /** A SAS ended without a match, with the reason its canceller gave. */
  | {
      kind: "sas_cancelled";
      id: string;
      at: number;
      nick: string;
      by: "you" | "peer";
      reason: string;
    }
  /** A SAS matched on both sides: this key is verified. */
  | { kind: "verified"; id: string; at: number; nick: string; ed25519: string }
  /**
   * The user asked the peer for its keys again (issue 2491), after a message
   * none of its devices could read, and what came of it: still waiting, fresh
   * sessions under the pinned key, or no answer. The chat's step card reads
   * it (`unreadableStep`); a key alarm is its own row.
   */
  | {
      kind: "rekey";
      id: string;
      at: number;
      nick: string;
      phase: "asked" | "renewed" | "unanswered";
    };

/** The rows the chat body lists: messages, and the one that stands in for a message lost. */
export type Message = Extract<ChatRow, { kind: "in" | "out" | "undecryptable" }>;

export const isMessage = (row: ChatRow): row is Message =>
  row.kind === "in" || row.kind === "out" || row.kind === "undecryptable";

/**
 * Whether the chat window shows the row (issue 2485): a message, a key alarm
 * (the step card), or the peer asking to compare emoji (the dialog). Only
 * these open a closed chat or count as unread. The rest record the key's
 * standing, which the rail shows: a row nobody will see must not badge a
 * window, nor reopen one on an empty body.
 */
export const countsAsUnread = (row: ChatRow): boolean =>
  isMessage(row) || row.kind === "key_alarm" || (row.kind === "sas_asked" && row.by === "peer");

/** Why an order challenge went unanswered: the peer's key is not verified, or the send log's verdict. */
export type CheckFailure = "unverified" | Exclude<OrderVerdict, "confirmed">;

/**
 * The last order challenge a bot sent on this chat (issue 2485): when it
 * came, the network and channel it named (its 005 `NETWORK=` and the raw
 * PRIVMSG target, the bot's own nick for a private message), and whether
 * this cic answered it. It is never a row: an answer is invisible, and only
 * this signal says the bot checked.
 */
export type IdentityCheck = {
  at: number;
  network: string;
  channel: string;
  passed: boolean;
  reason: CheckFailure | null;
};

/** `check` is absent until a bot first challenges an order here. */
export type Chat = { nick: string; open: boolean; unread: number; check?: IdentityCheck };

/**
 * `add` writes a row unless one with its id is there already; a row the
 * window shows (`countsAsUnread`) opens the chat (a new message reopens a closed one,
 * as a query window does) and counts if `unread`, the others do neither. `out`
 * moves an outgoing row along, and changes nothing if the row is not there,
 * nor once the row is sent and the change would take it back (`backwards`).
 * `check` keeps the chat's last identity check and nothing else: it neither
 * opens the chat nor counts as unread, and a nick with no chat gets a closed
 * one to keep it on.
 */
export type ChatChange =
  | { op: "add"; nick: string; row: ChatRow; unread: boolean }
  | { op: "out"; nick: string; id: string; state: OutState; reason: OutFailure | null }
  | { op: "check"; nick: string; check: IdentityCheck };

/** Rows kept per chat; the oldest go first. */
export const CHAT_ROWS_MAX = 1000;

export type ChatStore = {
  /** Folded nick → chat. */
  chats(slot: string): Promise<Record<string, Chat>>;
  rows(slot: string, nick: string): Promise<ChatRow[]>;
  /** Applies `changes` in order; answers the folded nicks of the chats they touched. */
  apply(slot: string, changes: ChatChange[]): Promise<string[]>;
  /** Opens the chat with `nick`, creating it empty if there is none. */
  open(slot: string, nick: string): Promise<void>;
  /** Hides the chat; its rows stay. */
  close(slot: string, nick: string): Promise<void>;
  /** Deletes the chat: its rows and its entry. A later row starts it over, empty. */
  remove(slot: string, nick: string): Promise<void>;
  read(slot: string, nick: string): Promise<void>;
};

type IndexEntry = {
  id: string;
  nick: string;
  open: boolean;
  unread: number;
  check?: IdentityCheck;
};
type ChatIndex = { v: 1; chats: Record<string, IndexEntry> };
type ChatRecord = { v: 1; rows: ChatRow[] };

/**
 * A sent message is never shown as waiting again: a device that could not
 * read it NACKs it, and its re-send can wait for keys (the engine reports it
 * queued). It went, and should the re-send be lost, the row turns failed.
 */
const backwards = (from: OutState, to: OutState): boolean =>
  from === "sent" && (to === "queued" || to === "sending");

const indexKey = (slot: string) => `index:${slot}`;
const chatKey = (id: string) => `chat:${id}`;

export function chatStore(vault: Vault, lock: Lock): ChatStore {
  async function load<T extends { v: 1 }>(key: string, empty: T): Promise<T> {
    const sealed: Sealed | undefined = await vault.load(key);
    if (sealed === undefined) return empty;
    try {
      const record = JSON.parse(await open(await vault.wrappingKey(), key, sealed)) as T | null;
      if (record?.v !== 1) throw new Error("not a chat record");
      return record;
    } catch (err) {
      // Sealed under a wrapping key that is gone, or damaged: it can never be
      // opened again, and the history it held is lost (2430 accepts that).
      console.warn(`[e2e] a stored chat record cannot be opened; starting it over`, err);
      return empty;
    }
  }

  async function store(key: string, record: ChatIndex | ChatRecord): Promise<void> {
    await vault.store(key, await seal(await vault.wrappingKey(), key, JSON.stringify(record)));
  }

  const loadIndex = (slot: string) => load<ChatIndex>(indexKey(slot), { v: 1, chats: {} });
  const loadRows = async (id: string) =>
    (await load<ChatRecord>(chatKey(id), { v: 1, rows: [] })).rows;

  // Runs `fn` on the slot's index under its lock, and stores the index after.
  function withIndex<T>(slot: string, fn: (index: ChatIndex) => Promise<T>): Promise<T> {
    return lock(`grappa-e2e:chats:${slot}`, async () => {
      const index = await loadIndex(slot);
      const result = await fn(index);
      await store(indexKey(slot), index);
      return result;
    });
  }

  function entry(index: ChatIndex, nick: string, open: boolean): IndexEntry {
    const key = fold(nick);
    const found = index.chats[key];
    if (found !== undefined) return found;
    const created = { id: crypto.randomUUID(), nick, open, unread: 0 };
    index.chats[key] = created;
    return created;
  }

  return {
    chats: async (slot) => {
      const index = await loadIndex(slot);
      return Object.fromEntries(
        Object.entries(index.chats).map(([key, e]) => [
          key,
          { nick: e.nick, open: e.open, unread: e.unread, check: e.check },
        ]),
      );
    },

    rows: async (slot, nick) => {
      const found = (await loadIndex(slot)).chats[fold(nick)];
      return found === undefined ? [] : loadRows(found.id);
    },

    apply: (slot, changes) =>
      withIndex(slot, async (index) => {
        const byChat = new Map<string, ChatChange[]>();
        for (const change of changes) {
          const key = fold(change.nick);
          byChat.set(key, [...(byChat.get(key) ?? []), change]);
        }
        const touched: string[] = [];
        for (const [key, own] of byChat) {
          // An `out` alone never creates a chat: its row would not be there.
          if (index.chats[key] === undefined && own.every((c) => c.op === "out")) continue;
          const first = own[0] as ChatChange;
          const chat = entry(index, first.nick, first.op === "add" && countsAsUnread(first.row));
          // A check lives on the index: the rows are not read, nor sealed again.
          const rowsChange = own.some((c) => c.op !== "check");
          let rows = rowsChange ? await loadRows(chat.id) : [];
          for (const change of own) {
            if (change.op === "add") {
              if (rows.some((r) => r.id === change.row.id)) continue;
              rows.push(change.row);
              if (!countsAsUnread(change.row)) continue;
              chat.open = true;
              if (change.unread) chat.unread += 1;
            } else if (change.op === "check") {
              chat.check = change.check;
            } else {
              rows = rows.map((r) =>
                r.kind === "out" && r.id === change.id && !backwards(r.state, change.state)
                  ? { ...r, state: change.state, reason: change.reason }
                  : r,
              );
            }
          }
          if (rowsChange) {
            await store(chatKey(chat.id), {
              v: 1,
              rows: rows.slice(Math.max(0, rows.length - CHAT_ROWS_MAX)),
            });
          }
          touched.push(key);
        }
        return touched;
      }),

    open: (slot, nick) =>
      withIndex(slot, async (index) => {
        const chat = entry(index, nick, true);
        chat.open = true;
        chat.nick = nick;
      }),

    close: (slot, nick) =>
      withIndex(slot, async (index) => {
        const chat = index.chats[fold(nick)];
        if (chat !== undefined) chat.open = false;
      }),

    // The record goes before the index that names it: a tab dying in between
    // leaves an entry whose rows read as none (deleting again finishes it),
    // never sealed rows that no index names and nothing would delete.
    remove: (slot, nick) =>
      withIndex(slot, async (index) => {
        const key = fold(nick);
        const chat = index.chats[key];
        if (chat === undefined) return;
        await vault.remove(chatKey(chat.id));
        delete index.chats[key];
      }),

    read: (slot, nick) =>
      withIndex(slot, async (index) => {
        const chat = index.chats[fold(nick)];
        if (chat !== undefined) chat.unread = 0;
      }),
  };
}
