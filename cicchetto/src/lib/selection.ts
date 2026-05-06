import { createEffect, createRoot, createSignal, on, untrack } from "solid-js";
import { token } from "./auth";
import { type ChannelKey, channelKey } from "./channelKey";
import { isDocumentVisible } from "./documentVisibility";
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

  // Shared cursor-advance helper used by both the cicchetto-leave arm
  // (selectedChannel transitions away from a window) and the browser-blur
  // arm (the focused window's browser tab loses focus). Both arms have
  // identical semantics: "user has demonstrably moved on from this window;
  // mark its current scrollback tail as read." Same guards: empty
  // scrollback → no-op (nothing to mark).
  const advanceCursorForWindow = (networkSlug: string, channelName: string): void => {
    const k = channelKey(networkSlug, channelName);
    const msgs = scrollbackByChannel()[k];
    if (!msgs || msgs.length === 0) return;
    const last = msgs[msgs.length - 1];
    if (last === undefined) return;
    setReadCursor(networkSlug, channelName, last.server_time);
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
      //     advanceCursorForWindow handles this internally.
      if (prev !== undefined && prev !== null) {
        const prevKey = channelKey(prev.networkSlug, prev.channelName);
        const selKey = sel ? channelKey(sel.networkSlug, sel.channelName) : null;
        if (prevKey !== selKey) {
          advanceCursorForWindow(prev.networkSlug, prev.channelName);
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

  // Browser-blur arm. When the operator's browser tab loses focus
  // (Cmd-Tab, minimize, Page Visibility hidden, PWA backgrounded), advance
  // the currently-selected window's cursor — same semantic as a cicchetto-
  // leave. Without this, returning to the browser would show no marker for
  // msgs that landed in the focused window while the user was demonstrably
  // away (subscribe.ts now skips the live-cursor-advance on hidden tabs,
  // so those msgs accumulate above the stale cursor — but the cursor
  // itself must be marked-as-read at the moment of leave so the marker
  // appears at the right boundary).
  //
  // Guards:
  //   * `prev === undefined` → initial run on module load; not a transition.
  //   * `visible === true` → focus regain (or initial true): no-op. Cursor
  //     advance only happens at the LEAVE moment (true → false).
  //   * No selected window → nothing to advance.
  //   * Empty scrollback → advanceCursorForWindow no-ops internally.
  createEffect(
    on(isDocumentVisible, (visible, prev) => {
      if (prev === undefined) return;
      if (!(prev === true && visible === false)) return;
      const sel = untrack(selectedChannel);
      if (!sel) return;
      advanceCursorForWindow(sel.networkSlug, sel.channelName);
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
