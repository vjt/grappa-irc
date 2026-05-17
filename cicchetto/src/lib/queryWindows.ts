import { createRoot, createSignal, untrack } from "solid-js";
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
//   * `closeQueryWindowState` — pushes `close_query_window` to the
//     server. Server deletes the row and broadcasts the updated
//     `query_windows_list` back; cicchetto's dispatcher populates
//     state. No optimistic local mutation (no-silent-drops B6.10
//     HIGH-10 — mirrors CP17 :pending pattern; cic NEVER originates
//     state).
//   * `openQueryWindowState` — pushes `open_query_window` to the
//     server (idempotent server-side via unique idx). Server upserts
//     the row and broadcasts the updated `query_windows_list`; cic's
//     dispatcher populates state. No optimistic local mutation.
//     Called from the user-action path (/msg, /query, nick click).

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
   * Pushes `close_query_window` to the server. The server deletes the
   * row and broadcasts the updated `query_windows_list`; the
   * dispatcher (`userTopic.ts`) replaces local state from that
   * authoritative push. No optimistic local mutation (cic NEVER
   * originates state).
   */
  const closeQueryWindowState = (networkId: number, targetNick: string): void => {
    pushCloseQueryWindow(networkId, targetNick);
  };

  /**
   * Opens a DM window for `targetNick` on `networkId`.
   *
   * Pushes `open_query_window` to the server (idempotent server-side
   * via unique idx). Server upserts the row and broadcasts the
   * updated `query_windows_list`; the dispatcher (`userTopic.ts`)
   * replaces local state from that authoritative push. No optimistic
   * local mutation (cic NEVER originates state).
   *
   * Skips the server round-trip when the window is already open
   * (case-insensitive dedup) — server-side upsert is a no-op in that
   * case anyway and would broadcast a redundant identical list.
   *
   * `openedAt` is unused now that state is server-derived; kept in
   * the signature for caller compatibility (UserContextMenu /
   * ScrollbackPane / compose pass `new Date().toISOString()`). The
   * authoritative `opened_at` comes from the server's broadcast.
   *
   * Focus shift is the caller's responsibility — this verb only
   * pushes; it does NOT call setSelectedChannel (user-action focus
   * rule).
   */
  const openQueryWindowState = (networkId: number, targetNick: string, _openedAt: string): void => {
    const lowerNick = targetNick.toLowerCase();
    const existing = untrack(queryWindowsByNetwork)[networkId] ?? [];
    const alreadyOpen = existing.some((w) => w.targetNick.toLowerCase() === lowerNick);
    if (alreadyOpen) return;
    pushOpenQueryWindow(networkId, targetNick);
  };

  /**
   * Returns the canonical casing for `nick` if a query window for it is
   * already open on `networkId`, otherwise returns `nick` unchanged.
   *
   * IRC nicks are case-insensitive (RFC 2812 §2.2); the server-side
   * `Grappa.QueryWindows` row is unique on `(subject, network_id,
   * lower(target_nick))` and the stored `target_nick` preserves the
   * first-opened casing. cic mirrors that: the row's `targetNick`
   * value is the canonical casing for sidebar/scrollback ChannelKey
   * derivation.
   *
   * Without this helper, typing `/q GRAPPA` when a `grappa` window
   * already exists would `setSelectedChannel({channelName: "GRAPPA"})`,
   * producing the ChannelKey `"slug GRAPPA"` that no sidebar row,
   * scrollback store, or members map knows about — a fully dead
   * duplicate window. Resolving to the canonical casing keeps the
   * focus on the existing row.
   *
   * Lookup is `O(n)` over the network's open windows; the operator's
   * open-window count is tiny (handful at most), so a linear scan
   * costs nothing measurable.
   */
  const canonicalQueryNick = (networkId: number, nick: string): string => {
    const lower = nick.toLowerCase();
    const existing = untrack(queryWindowsByNetwork)[networkId] ?? [];
    const match = existing.find((w) => w.targetNick.toLowerCase() === lower);
    return match ? match.targetNick : nick;
  };

  return {
    queryWindowsByNetwork,
    setQueryWindowsByNetwork,
    closeQueryWindowState,
    openQueryWindowState,
    canonicalQueryNick,
  };
});

export const queryWindowsByNetwork = exports.queryWindowsByNetwork;
export const setQueryWindowsByNetwork = exports.setQueryWindowsByNetwork;
export const closeQueryWindowState = exports.closeQueryWindowState;
export const openQueryWindowState = exports.openQueryWindowState;
export const canonicalQueryNick = exports.canonicalQueryNick;
