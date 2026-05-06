import { createEffect, createRoot, createSignal, on } from "solid-js";
import { token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import { setReadCursor } from "./readCursor";
import { loadInitialScrollback, scrollbackByChannel } from "./scrollback";
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
//
// C7.5: msg-vs-events badge split. Per-window unread state is split into
// two independent counters:
//   * `messagesUnread` — bumped only on PRIVMSG / NOTICE / ACTION
//     (content kinds). Bold/prominent badge in Sidebar + BottomBar.
//   * `eventsUnread` — bumped only on JOIN / PART / QUIT / MODE / NICK /
//     TOPIC (presence kinds). Dimmer indicator.
// Both reset to zero when the window is focused (same as unreadCounts).
// `bumpUnread` is kept for the mention-count side-effect path in
// subscribe.ts that still needs the aggregate count for bumpMention.
// `bumpMessageUnread` and `bumpEventUnread` are the new routed verbs.

export type SelectedChannel = {
  networkSlug: string;
  channelName: string;
  kind: WindowKind;
} | null;

const exports = createRoot(() => {
  const [unreadCounts, setUnreadCounts] = createSignal<Record<ChannelKey, number>>({});
  const [messagesUnread, setMessagesUnread] = createSignal<Record<ChannelKey, number>>({});
  const [eventsUnread, setEventsUnread] = createSignal<Record<ChannelKey, number>>({});
  const [selectedChannel, setSelectedChannel] = createSignal<SelectedChannel>(null);

  createEffect(
    on(token, (t, prev) => {
      if (prev != null && t !== prev) {
        setUnreadCounts({});
        setMessagesUnread({});
        setEventsUnread({});
        setSelectedChannel(null);
      }
    }),
  );

  const bumpUnread = (key: ChannelKey) => {
    setUnreadCounts((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  };

  // C7.5: content kinds bump messagesUnread.
  const bumpMessageUnread = (key: ChannelKey) => {
    setMessagesUnread((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  };

  // C7.5: presence kinds bump eventsUnread.
  const bumpEventUnread = (key: ChannelKey) => {
    setEventsUnread((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));
  };

  createEffect(
    on(selectedChannel, (sel, prev) => {
      // Read-cursor advance on focus-leave. When the user moves focus
      // AWAY from a window (or to null), advance THAT window's cursor
      // to the server_time of its last visible message. Next visit
      // shows no marker (everything seen). Subsequent inbound msgs
      // bump server_time past cursor → marker reappears on next visit.
      //
      // Why on leave rather than on focus or on every WS append:
      //   * On focus: would hide the marker before the user could
      //     read past it (the bug fix this implements).
      //   * On WS append while focused: same problem one tick later.
      //   * On leave: the user has demonstrably moved on; "I've seen
      //     what was here" is the right semantic.
      //
      // Guards:
      //   * `prev === undefined` → initial run on mount; nothing to
      //     leave from.
      //   * `prev === null` → previous selection was already null;
      //     nothing to leave from (cold start, post-logout).
      //   * `prev.key === sel?.key` → re-selecting the same window
      //     (e.g. component re-render fires the effect with identical
      //     value); not a leave.
      //   * No msgs in prev's scrollback → nothing to mark as read;
      //     skip the localStorage write to avoid pinning a stale 0.
      if (prev !== undefined && prev !== null) {
        const prevKey = channelKey(prev.networkSlug, prev.channelName);
        const selKey = sel ? channelKey(sel.networkSlug, sel.channelName) : null;
        if (prevKey !== selKey) {
          const msgs = scrollbackByChannel()[prevKey];
          if (msgs && msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            if (last !== undefined) {
              setReadCursor(prev.networkSlug, prev.channelName, last.server_time);
            }
          }
        }
      }

      if (!sel) return;
      const key = channelKey(sel.networkSlug, sel.channelName);
      setUnreadCounts((prev) => {
        if (!(key in prev) || prev[key] === 0) return prev;
        const { [key]: _drop, ...rest } = prev;
        return rest;
      });
      // C7.5: clear both split counters on focus.
      setMessagesUnread((prev) => {
        if (!(key in prev)) return prev;
        const { [key]: _drop, ...rest } = prev;
        return rest;
      });
      setEventsUnread((prev) => {
        if (!(key in prev)) return prev;
        const { [key]: _drop, ...rest } = prev;
        return rest;
      });
      // Fire-and-forget: the verb guards itself via scrollback's
      // loadedChannels Set.
      void loadInitialScrollback(sel.networkSlug, sel.channelName);
    }),
  );

  return {
    unreadCounts,
    messagesUnread,
    eventsUnread,
    selectedChannel,
    setSelectedChannel,
    bumpUnread,
    bumpMessageUnread,
    bumpEventUnread,
  };
});

export const unreadCounts = exports.unreadCounts;
export const messagesUnread = exports.messagesUnread;
export const eventsUnread = exports.eventsUnread;
export const selectedChannel = exports.selectedChannel;
export const setSelectedChannel = exports.setSelectedChannel;
export const bumpUnread = exports.bumpUnread;
export const bumpMessageUnread = exports.bumpMessageUnread;
export const bumpEventUnread = exports.bumpEventUnread;
