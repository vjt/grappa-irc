import { createSignal, untrack } from "solid-js";
import { isChannelName } from "./chantypes";
import { casemappingForNetwork, chantypesForNetwork } from "./isupport";
import { moduleRoot } from "./moduleRoot";
import { networkBySlug } from "./networks";
import { nickEquals } from "./nickEquals";
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

const exports = moduleRoot(() => {
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
   * (case-insensitive dedup, per this network's CASEMAPPING) —
   * server-side upsert is a no-op in that case anyway and would
   * broadcast a redundant identical list.
   *
   * #1861 — the dedup folds the way THIS network folds. On `:ascii`
   * (bahamut/Azzurra) that is unchanged: `Foo[1]` and `foo{1}` stay two
   * windows because the ircd keeps them two people. On `:rfc1459`
   * (solanum, Rizon) `[EWG]-L0VE` and `{ewg}-l0ve` are ONE person and now
   * resolve onto one row instead of pushing a second `open`.
   *
   * ⚠️ The SERVER's uniqueness is still ASCII: the partial unique indexes
   * are on `(subject, network_id, lower(target_nick))`, and SQLite's
   * `lower()` cannot express the bracket fold. So this gate is what keeps
   * the duplicate from being created through the cic door; a second row
   * arriving from anywhere else (an older client, a direct API call, rows
   * already in the table) is still possible until that index question is
   * decided — see the issue 1861 discussion of the storage shape.
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
    if (untrack(() => queryWindowOpen(networkId, targetNick))) return;
    pushOpenQueryWindow(networkId, targetNick);
  };

  /**
   * Whether the server holds a query window for `nick` on `networkId`, matched
   * the way THIS network folds nicks (#1861). Tracked: an effect that asks
   * re-runs when the list changes; an imperative caller wraps it in `untrack`.
   */
  const queryWindowOpen = (networkId: number, nick: string): boolean =>
    (queryWindowsByNetwork()[networkId] ?? []).some((w) =>
      nickEquals(w.targetNick, nick, casemappingForNetwork(networkId)),
    );

  /**
   * issue 2201 — whether `name` on network `slug` is a DM window the server no
   * longer holds (or never did), and so has no read cursor to advance.
   *
   * Closing a query deletes its cursor on the server, and the server refuses
   * (`422 no_query_window`) to write a DM cursor without its window. The
   * writer that used to put it back is the pane's exit: the `query_windows_list`
   * broadcast after the close moves the selection away, and leaving the window
   * offers its visible tail to the cursor door. This is the client's mirror of
   * that refusal, so the doomed POST is not sent.
   *
   * "DM" here is cic's line: not a channel (this network's CHANTYPES) and not
   * a `$` name — `$server` keeps its cursor with no window, and the other `$`
   * names are cic's virtual windows. The server's line,
   * `Scrollback.dm_eligible?/1`, is a different rule: the fixed sigil set
   * `# & ! +` instead of CHANTYPES, and only the literal `$server` carved out.
   * They agree on every name a DM can carry — a nick cannot start with a
   * channel sigil, and `$server` is the only `$` name the read-cursor door
   * admits (`GrappaWeb.Validation.validate_target_name/1`). They differ on a
   * channel whose sigil this network's CHANTYPES omits: cic counts `&foo` as
   * a DM there, and skips a POST the server would take. An unknown slug
   * answers `false`: with no network there is nothing to decide and the
   * POST's own guards stay in charge. Untracked: it answers a question at
   * write time.
   */
  const queryWindowGone = (slug: string, name: string): boolean =>
    untrack(() => {
      if (name === "" || name.startsWith("$")) return false;
      const net = networkBySlug(slug);
      if (!net || isChannelName(name, chantypesForNetwork(net.id))) return false;
      return !queryWindowOpen(net.id, name);
    });

  /**
   * Returns the canonical casing for `nick` if a query window for it is
   * already open on `networkId`, otherwise returns `nick` unchanged.
   *
   * IRC nicks are case-insensitive (#121/#525); the server-side
   * `Grappa.QueryWindows` row is unique on `(subject, network_id,
   * lower(target_nick))` and the stored `target_nick` preserves the
   * first-opened casing. cic matches via `nickEquals` under this
   * network's CASEMAPPING (#1861): `A-Z` everywhere, plus `[ ] \ ~` →
   * `{ } | ^` on an rfc1459 network. The row's `targetNick` value is the
   * canonical casing for sidebar/scrollback ChannelKey derivation.
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
    const existing = untrack(queryWindowsByNetwork)[networkId] ?? [];
    const match = existing.find((w) =>
      nickEquals(w.targetNick, nick, casemappingForNetwork(networkId)),
    );
    return match ? match.targetNick : nick;
  };

  return {
    queryWindowsByNetwork,
    setQueryWindowsByNetwork,
    closeQueryWindowState,
    openQueryWindowState,
    queryWindowOpen,
    queryWindowGone,
    canonicalQueryNick,
  };
});

export const queryWindowsByNetwork = exports.queryWindowsByNetwork;
export const setQueryWindowsByNetwork = exports.setQueryWindowsByNetwork;
export const closeQueryWindowState = exports.closeQueryWindowState;
export const openQueryWindowState = exports.openQueryWindowState;
export const canonicalQueryNick = exports.canonicalQueryNick;
export const queryWindowOpen = exports.queryWindowOpen;
export const queryWindowGone = exports.queryWindowGone;
