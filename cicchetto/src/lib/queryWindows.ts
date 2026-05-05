import { createRoot, createSignal } from "solid-js";
import { pushCloseQueryWindow, pushOpenQueryWindow } from "./socket";

// Query-window state — which DM (query) windows are currently open.
//
// Server is the source of truth: `query_windows_list` is pushed on
// WS join (from after_join snapshot) and after every open/close
// operation (PubSub broadcast from QueryWindows.open/3 and close/4).
// cicchetto replaces its full state on each event rather than
// tracking individual deltas — this keeps restore-on-reconnect and
// incremental-change paths identical.
//
// State is keyed by integer network_id (matching the server-side FK).
// Each entry carries `targetNick` and `openedAt` for display ordering
// (opened-oldest-first, matching the server-side
// QueryWindows.list_for_user sort order).
//
// Mutations:
//   * `setQueryWindowsByNetwork` — full replace (used by the
//     `query_windows_list` event handler in userTopic.ts).
//   * `closeQueryWindowState` — removes the nick from client state
//     AND pushes `close_query_window` to the server so the row is
//     deleted and other connected tabs get the updated list via
//     PubSub. Case-insensitive (matches IRC nick-comparison rules).
//   * `openQueryWindowState` — adds the nick to client state
//     AND pushes `open_query_window` to the server (idempotent
//     server-side via unique idx). Called from the user-action path
//     (C1.4 / C4 will wire this from /msg, /query, nick click).

export type QueryWindow = {
  targetNick: string;
  openedAt: string;
};

const exports = createRoot(() => {
  const [queryWindowsByNetwork, setQueryWindowsByNetwork] = createSignal<
    Record<number, QueryWindow[]>
  >({});

  /**
   * Closes the DM window for `targetNick` on `networkId`.
   *
   * Removes it from local state (case-insensitive) and pushes
   * `close_query_window` to the server. The server deletes the row and
   * broadcasts `query_windows_list` back; cicchetto replaces state
   * again on that event, so the final state is authoritative.
   */
  const closeQueryWindowState = (networkId: number, targetNick: string): void => {
    const lowerNick = targetNick.toLowerCase();
    setQueryWindowsByNetwork((prev) => {
      const existing = prev[networkId] ?? [];
      const filtered = existing.filter((w) => w.targetNick.toLowerCase() !== lowerNick);
      return { ...prev, [networkId]: filtered };
    });
    pushCloseQueryWindow(networkId, targetNick);
  };

  /**
   * Opens a DM window for `targetNick` on `networkId`.
   *
   * Optimistically adds it to local state (deduplicated case-
   * insensitively) and pushes `open_query_window` to the server. The
   * server upserts the row and broadcasts `query_windows_list` back,
   * which replaces client state with the authoritative list.
   *
   * Focus shift is the caller's responsibility — this verb only mutates
   * state; it does NOT call setSelectedChannel (user-action focus rule).
   */
  const openQueryWindowState = (networkId: number, targetNick: string, openedAt: string): void => {
    const lowerNick = targetNick.toLowerCase();
    setQueryWindowsByNetwork((prev) => {
      const existing = prev[networkId] ?? [];
      const alreadyOpen = existing.some((w) => w.targetNick.toLowerCase() === lowerNick);
      if (alreadyOpen) return prev;
      return {
        ...prev,
        [networkId]: [...existing, { targetNick, openedAt }],
      };
    });
    pushOpenQueryWindow(networkId, targetNick);
  };

  return {
    queryWindowsByNetwork,
    setQueryWindowsByNetwork,
    closeQueryWindowState,
    openQueryWindowState,
  };
});

export const queryWindowsByNetwork = exports.queryWindowsByNetwork;
export const setQueryWindowsByNetwork = exports.setQueryWindowsByNetwork;
export const closeQueryWindowState = exports.closeQueryWindowState;
export const openQueryWindowState = exports.openQueryWindowState;
