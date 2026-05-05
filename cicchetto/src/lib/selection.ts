import { createEffect, createRoot, createSignal, on } from "solid-js";
import { token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import { loadInitialScrollback } from "./scrollback";
import type { WindowKind } from "./windowKinds";

// Per-channel selection store: which channel is currently focused +
// per-channel unread counters. Module-singleton signal store mirroring
// `auth.ts` / `socket.ts` / `scrollback.ts`.
//
// Lifted out of the original `networks.ts` god-module per A4. Owns:
//   * `selectedChannel` — the (slug, name, kind) tuple of the focused pane.
//   * `unreadCounts` — per-ChannelKey count of WS-received messages
//     while that channel was NOT selected. Cleared when a channel
//     becomes selected.
//   * `bumpUnread(key)` — cross-module ingestion verb consumed by
//     `subscribe.ts`'s WS event handler when a message arrives on a
//     non-selected channel.
//   * Selection-change effect: clears unread for the newly-selected
//     channel AND fires `scrollback.loadInitialScrollback` to backfill
//     history (the load-once gate lives in scrollback.ts).
//
// Identity-scoped cleanup mirrors `scrollback.ts`'s on(token) arm:
// logout/rotation clears `selectedChannel` + `unreadCounts`. The
// `prev != null && t !== prev` guard filters the initial run AND
// cold-start login as no-ops.
//
// C4.0: `SelectedChannel` gains a `kind: WindowKind` discriminator,
// replacing the band-aid `channelName !== ":server"` literal used in
// Shell.tsx's TopicBar guard (Hotfix #2, 50a3d88). The TopicBar guard
// now reads `sel().kind === "channel"` — directly asserts spec #20.
// Every setSelectedChannel call site passes `kind` explicitly; no
// defaults.

export type SelectedChannel = {
  networkSlug: string;
  channelName: string;
  kind: WindowKind;
} | null;

const exports = createRoot(() => {
  const [unreadCounts, setUnreadCounts] = createSignal<Record<ChannelKey, number>>({});
  const [selectedChannel, setSelectedChannel] = createSignal<SelectedChannel>(null);

  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        setUnreadCounts({});
        setSelectedChannel(null);
      }
    }),
  );

  const bumpUnread = (key: ChannelKey) => {
    setUnreadCounts((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  };

  createEffect(
    on(selectedChannel, (sel) => {
      if (!sel) return;
      const key = channelKey(sel.networkSlug, sel.channelName);
      setUnreadCounts((prev) => {
        if (!(key in prev) || prev[key] === 0) return prev;
        const { [key]: _drop, ...rest } = prev;
        return rest;
      });
      // Fire-and-forget: the verb guards itself via scrollback's
      // loadedChannels Set.
      void loadInitialScrollback(sel.networkSlug, sel.channelName);
    }),
  );

  return { unreadCounts, selectedChannel, setSelectedChannel, bumpUnread };
});

export const unreadCounts = exports.unreadCounts;
export const selectedChannel = exports.selectedChannel;
export const setSelectedChannel = exports.setSelectedChannel;
export const bumpUnread = exports.bumpUnread;
