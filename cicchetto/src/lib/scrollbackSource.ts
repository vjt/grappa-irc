import type { JSX } from "solid-js";
import type { ScrollbackMessage } from "./api";
import type { ChannelKey } from "./channelKey";
import { getReadCursor } from "./readCursor";
import {
  dismissFarBehind,
  farBehindByChannel,
  isLoadingOlder,
  jumpToMessage,
  jumpToUnread,
  lastOwnSend,
  loadMore,
  loadNewer,
  measuredUnreadByChannel,
  ownSendSubmitted,
  refreshScrollback,
  scrollbackByChannel,
} from "./scrollback";
import { setCursorIfAdvances } from "./selection";

// issue 2512 — where a ScrollbackPane's lines come from. One pane draws two
// kinds of window: grappa's scrollback (every channel, query and `$server`
// window) and an encrypted query, whose messages live on this device and
// never in grappa (`EncryptedChatPane`). What the pane does with the lines is
// the same for both: the scroll and where a window opens, the unread marker,
// the floating buttons, the line menus. What differs is here: where the lines
// and the read state come from, whether the server holds more history to page
// in, and what an encrypted line adds beside its time and after its body.
//
// The members keep the names of grappa's own verbs, so the pane reads the same
// with either source behind it.

/**
 * issue 2577 — a message on its way to the window, not yet a line: who sends
 * it, when it began to arrive, and an id unique among the window's arrivals.
 */
export type ArrivingLine = { id: string; nick: string; at: number };

const NONE_ARRIVING: readonly ArrivingLine[] = Object.freeze([]);

export type ScrollbackSource = {
  /** The window's lines, oldest first; undefined until any are known. */
  messages: (key: ChannelKey) => ScrollbackMessage[] | undefined;
  /** The id of the last line read in the window, or null while none is. */
  getReadCursor: (networkSlug: string, channelName: string) => number | null;
  /** The reader has seen the window up to `id`. Forward-only. */
  setCursorIfAdvances: (networkSlug: string, channelName: string, id: number) => void;
  /** The window an own send was submitted from, at Enter, before it lands. */
  ownSendSubmitted: () => ChannelKey | null;
  /** The window whose read cursor an own send has just moved past. */
  lastOwnSend: () => ChannelKey | null;
  /** The lines the server holds beyond the loaded ones; null when the source holds them all. */
  history: typeof grappaHistory | null;
  /** What a line carries beside its time and after its body (`ScrollbackLine`'s slots). */
  slots: (msg: ScrollbackMessage) => LineSlots;
  /**
   * issue 2577 — messages on their way to the window, in the order they began
   * to arrive: drawn after every line until each lands. Only an encrypted
   * window has any (a peer's message grappa announced line by line).
   */
  arriving: (key: ChannelKey) => readonly ArrivingLine[];
};

type LineSlots = { marker: JSX.Element; trailer: JSX.Element };

// grappa's paging and the far-behind region: `lib/scrollback.ts` says what
// each verb does.
const grappaHistory = {
  loadMore,
  loadNewer,
  refreshScrollback,
  isLoadingOlder,
  farBehind: (key: ChannelKey) => farBehindByChannel()[key],
  dismissFarBehind,
  measuredUnread: (key: ChannelKey) => measuredUnreadByChannel()[key],
  jumpToUnread,
  jumpToMessage,
};

const NO_SLOTS: LineSlots = { marker: null, trailer: null };

export const grappaScrollback: ScrollbackSource = {
  messages: (key) => scrollbackByChannel()[key],
  getReadCursor,
  setCursorIfAdvances,
  ownSendSubmitted,
  lastOwnSend,
  history: grappaHistory,
  slots: () => NO_SLOTS,
  arriving: () => NONE_ARRIVING,
};
