// Channel E2E (wire v4) — the decrypted channel rows, as the UI will
// read them: a module-singleton signal store, identity-scoped like
// `members.ts`, that subscribes to `onChannelE2eEvent` and keeps the
// rows a channel's drain decrypted.
//
// A row is kept, not rendered: the drain ACKs a channel message once it
// has read it, so a decrypted line that lands nowhere is gone for good.
// This store is the landing place. It is NOT scrollback: a decrypted line
// has no server id to order by, so each row carries an arrival-order
// synthetic id — a per-channel sequence — and the render decision stays
// open. No UI reads this yet; the store only keeps the rows, bounded,
// for the branch that renders them.
//
// Rows are scoped by network: the bucket is the channel key
// (`slug #channel`), so two networks' same-named channels never share
// rows. Events the drain raises without a network — held rows and
// expiry — land in the bare folded-channel bucket, and a read merges
// that bucket under the network bucket when both hold rows. Rows persist
// in localStorage, so a reload does not lose decrypted lines; the
// durable copy is best-effort (a full or unavailable store never breaks
// the row) and is cleared with the memory rows on identity change.
//
// Only `channel_received` and `channel_undecryptable` become rows. Key,
// rotation, and drop events are not rows: they are about the epoch, not
// about a line the channel showed.

import { createSignal } from "solid-js";
import { type ChannelKey, channelKey, decodeChannelKey } from "./channelKey";
import { type ChannelE2eEvent, onChannelE2eEvent } from "./e2e/channelE2e";
import { fold } from "./e2e/wire";
import { identityScopedStore } from "./identityScopedStore";

/** How many rows a channel keeps: the bound that keeps the store from growing without end. */
export const MAX_CHANNEL_E2E_ROWS = 200;

/** The durable copy: one JSON object per network-scoped channel key. */
const ROWS_STORAGE_KEY = "cicchetto.channelE2eRows.v1";

/** A decrypted channel line, or one that could not be read, as kept. */
export type ChannelE2eRow =
  | {
      id: number;
      kind: "received";
      channel: string;
      from: string;
      sid: string;
      counter: number;
      body: string;
    }
  | {
      id: number;
      kind: "undecryptable";
      channel: string;
      from: string;
      sid: string | null;
      reason: Extract<ChannelE2eEvent, { kind: "channel_undecryptable" }>["reason"];
    };

/** A stored row is believed when it has the shape a row has: the boundary parse drops the rest. */
function isStoredRow(row: unknown): row is ChannelE2eRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  if (typeof r.id !== "number" || typeof r.channel !== "string" || typeof r.from !== "string") {
    return false;
  }
  if (r.kind === "received") {
    return typeof r.sid === "string" && typeof r.counter === "number" && typeof r.body === "string";
  }
  if (r.kind === "undecryptable") {
    return (r.sid === null || typeof r.sid === "string") && typeof r.reason === "string";
  }
  return false;
}

/** The durable copy, read back: malformed entries dropped, each channel trimmed to the bound. */
function loadStoredRows(): Record<string, ChannelE2eRow[]> {
  try {
    const raw = localStorage.getItem(ROWS_STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const out: Record<string, ChannelE2eRow[]> = {};
    for (const [key, rows] of Object.entries(parsed)) {
      if (!Array.isArray(rows)) continue;
      const kept: ChannelE2eRow[] = [];
      for (const row of rows) {
        if (!isStoredRow(row)) continue;
        kept.push(row);
        if (kept.length >= MAX_CHANNEL_E2E_ROWS) break;
      }
      if (kept.length > 0) out[key] = kept;
    }
    return out;
  } catch {
    return {};
  }
}

/** Writes the durable copy: best-effort, never at the row's expense. */
function saveStoredRows(rows: Record<string, ChannelE2eRow[]>): void {
  try {
    localStorage.setItem(ROWS_STORAGE_KEY, JSON.stringify(rows));
  } catch {
    // A full or unavailable store must not break the row: the in-memory
    // rows stay, the durable copy is best-effort.
  }
}

const exports_ = identityScopedStore((onIdentityChange) => {
  const [rowsByChannel, setRowsByChannel] = createSignal<Record<string, ChannelE2eRow[]>>(
    loadStoredRows(),
  );
  /**
   * The next synthetic id per folded channel: arrival order, never a
   * server id. Buckets for one channel share the sequence, so a merged
   * read — the network bucket over the bare bucket — never repeats an id.
   * Restored rows continue the sequence from the highest id they hold.
   */
  const nextId = new Map<string, number>();
  for (const rows of Object.values(rowsByChannel())) {
    for (const row of rows) {
      const channel = fold(row.channel);
      nextId.set(channel, Math.max(nextId.get(channel) ?? 0, row.id));
    }
  }

  onIdentityChange(() => {
    setRowsByChannel({});
    nextId.clear();
    try {
      localStorage.removeItem(ROWS_STORAGE_KEY);
    } catch {
      // See saveStoredRows: the durable copy is best-effort.
    }
  });

  /**
   * The bucket an event's row lands in: the network-scoped channel key
   * when the event names its network, the bare folded channel otherwise.
   * Events the drain raises without a network — held rows and expiry —
   * land in the bare bucket, and the read merges it under the network
   * bucket when both hold rows.
   */
  const rowKey = (event: ChannelE2eEvent): string =>
    event.network === undefined ? fold(event.channel) : channelKey(event.network, event.channel);

  const append = (event: ChannelE2eEvent): void => {
    if (event.kind !== "channel_received" && event.kind !== "channel_undecryptable") return;
    const key = rowKey(event);
    const channel = fold(event.channel);
    const id = (nextId.get(channel) ?? 0) + 1;
    nextId.set(channel, id);
    const row: ChannelE2eRow =
      event.kind === "channel_received"
        ? {
            id,
            kind: "received",
            channel,
            from: event.from,
            sid: event.sid,
            counter: event.counter,
            body: event.body,
          }
        : {
            id,
            kind: "undecryptable",
            channel,
            from: event.from,
            sid: event.sid,
            reason: event.reason,
          };
    const prev = rowsByChannel();
    const kept = [...(prev[key] ?? []), row];
    if (kept.length > MAX_CHANNEL_E2E_ROWS) {
      kept.splice(0, kept.length - MAX_CHANNEL_E2E_ROWS);
    }
    const next = { ...prev, [key]: kept };
    setRowsByChannel(next);
    saveStoredRows(next);
  };

  // Subscribed once, from `encryptedChats.mountEncryptedChats`: a second
  // subscribe while one is live would keep every row twice.
  let unsubscribe: (() => void) | null = null;
  const subscribe = (): (() => void) => {
    if (unsubscribe !== null) return () => {};
    unsubscribe = onChannelE2eEvent(append);
    return () => {
      unsubscribe?.();
      unsubscribe = null;
    };
  };

  return { rowsByChannel, subscribe };
});

/**
 * The rows kept for `key`, oldest first; empty when none arrived yet. A
 * read merges the bare folded-channel bucket under the network bucket:
 * held rows the drain raised without a network arrived before the key,
 * so they read first.
 */
export const channelE2eRows = (key: ChannelKey): ChannelE2eRow[] => {
  const rows = exports_.rowsByChannel();
  const scoped = rows[key] ?? [];
  const name = decodeChannelKey(key)?.name;
  const bare = name === undefined ? [] : (rows[fold(name)] ?? []);
  return [...bare, ...scoped];
};

/** Subscribes the store to live channel E2E events; answers the unsubscribe. */
export const subscribeChannelE2eRows = exports_.subscribe;
