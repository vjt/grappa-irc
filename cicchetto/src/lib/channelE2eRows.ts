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
// Only `channel_received` and `channel_undecryptable` become rows. Key,
// rotation, and drop events are not rows: they are about the epoch, not
// about a line the channel showed.

import { createSignal } from "solid-js";
import { type ChannelE2eEvent, onChannelE2eEvent } from "./e2e/channelE2e";
import { fold } from "./e2e/wire";
import { identityScopedStore } from "./identityScopedStore";

/** How many rows a channel keeps: the bound that keeps the store from growing without end. */
export const MAX_CHANNEL_E2E_ROWS = 200;

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

const exports_ = identityScopedStore((onIdentityChange) => {
  const [rowsByChannel, setRowsByChannel] = createSignal<Record<string, ChannelE2eRow[]>>({});
  /** The next synthetic id per folded channel: arrival order, never a server id. */
  const nextId = new Map<string, number>();

  onIdentityChange(() => {
    setRowsByChannel({});
    nextId.clear();
  });

  const append = (event: ChannelE2eEvent): void => {
    if (event.kind !== "channel_received" && event.kind !== "channel_undecryptable") return;
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
    setRowsByChannel((prev) => {
      const kept = [...(prev[channel] ?? []), row];
      if (kept.length > MAX_CHANNEL_E2E_ROWS) {
        kept.splice(0, kept.length - MAX_CHANNEL_E2E_ROWS);
      }
      return { ...prev, [channel]: kept };
    });
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

/** The rows kept for `channel`, oldest first; empty when none arrived yet. */
export const channelE2eRows = (channel: string): ChannelE2eRow[] =>
  exports_.rowsByChannel()[fold(channel)] ?? [];

/** Subscribes the store to live channel E2E events; answers the unsubscribe. */
export const subscribeChannelE2eRows = exports_.subscribe;
