// Window-kind discriminated union and ordering selector.
//
// `WindowKind` matches the server-side atom names exactly so wire
// payloads map without transformation:
//   :channel   → "channel"
//   :query     → "query"
//   :server    → "server"
//   :list      → "list"
//   :mentions  → "mentions"
//   :home      → "home"         (UX-4 bucket B — identity-scoped, NOT per-network)
//   :admin     → "admin"        (UX-4 bucket N — identity-scoped, NOT per-network, admin-only)
//
// `Window` is the cicchetto-side representation of a single tab entry.
// `networkId` is the integer FK from the server `Network` schema;
// `target` is the channel name (e.g. "#grappa"), DM nick, or empty
// string for pseudo-windows (server, list, mentions, home, admin).
//
// `orderWindows` is a pure function: takes a flat list, groups by
// network_id (stable insertion order — first-seen networkId gets index
// 0), and within each group sorts: server first, channels (alpha),
// queries (alpha), list, mentions. Ephemeral kinds (list, mentions)
// only appear when they're in the input — no placeholder injection.
//
// The `home` and `admin` kinds are identity-scoped, NOT per-network —
// they never enter the per-network grouping path (Sidebar pins both as
// separate rows ABOVE the network sections; BottomBar omits them).
// They're listed in `WindowKind` so `selectedChannel.kind` accepts them
// (the active-pane dispatcher in Shell.tsx branches on them) without
// forcing every orderWindows-callsite to special-case their absence.

export type WindowKind = "channel" | "query" | "server" | "list" | "mentions" | "home" | "admin";

// The synthetic channel name used for the per-network server-messages
// window (kind = "server"). Server-side `Grappa.Session.NumericRouter`
// routes uncategorized server output (MOTD, untargeted NOTICEs, lifecycle
// events, numerics with no useful param) to scrollback rows keyed on this
// literal channel; cic subscribes to the per-channel WS topic for it,
// renders the window in Sidebar/BottomBar, and the ComposeBox special-
// cases it as a slash-only window. Single source: previously this literal
// was duplicated in compose.ts, subscribe.ts (5×), Sidebar.tsx, and
// BottomBar.tsx — drift between the cic-side string and the server-side
// `{:server, nil}` fanout would silently break the window.
export const SERVER_WINDOW_NAME = "$server";

// UX-4 bucket B: sentinels for the identity-scoped `home` window. Used
// as both `networkSlug` and `channelName` in `selectedChannel` — home
// is NOT bound to any network so both fields are sentinel literals
// (mirror of how `$server` is the synthetic channel for server pane).
// Single source: imported by Shell.tsx (selection dispatch), Sidebar.tsx
// (pinned row), HomePane.tsx (no-op self-check), and test mocks.
export const HOME_WINDOW_SLUG = "$home";
export const HOME_WINDOW_NAME = "$home";

// UX-4 bucket N: sentinels for the identity-scoped `admin` window.
// Mirror of the home sentinels. Admin is admin-only (gated on
// `me.is_admin === true` at the Sidebar projection AND at the Shell
// pane dispatcher) so non-admin operators see no admin row and can't
// reach the pane by hand-crafting a selection. Single source: imported
// by Shell.tsx (selection dispatch + pane mount), Sidebar.tsx (pinned
// row + visibility gate), SettingsDrawer.tsx (drawer "admin console"
// entry — secondary trigger).
export const ADMIN_WINDOW_SLUG = "$admin";
export const ADMIN_WINDOW_NAME = "$admin";

export type Window = {
  /** Stable string id for keying in UI lists. */
  id: string;
  networkId: number;
  kind: WindowKind;
  /** Channel name, DM target nick, or empty string for pseudo-windows. */
  target: string;
};

export type GroupedWindows = {
  networkId: number;
  windows: Window[];
};

// Within-network kind rank (lower = earlier). `home` and `admin` are
// identity-scoped (NOT per-network) so they never enter `orderWindows`;
// the ranks are listed here only so `Record<WindowKind, number>` stays
// exhaustive (a future change that does pass either through would
// surface at compile time, not silently drop).
const KIND_RANK: Record<WindowKind, number> = {
  home: -2,
  admin: -1,
  server: 0,
  channel: 1,
  query: 2,
  list: 3,
  mentions: 4,
};

/**
 * Groups `windows` by `networkId` and sorts within each group:
 *   server → channels (alpha) → queries (alpha) → list → mentions.
 *
 * Network group order is the insertion order of first occurrence in
 * the input array — no secondary sort is applied across networks.
 * Ephemeral kinds (`list`, `mentions`) only appear when present.
 */
export function orderWindows(windows: Window[]): GroupedWindows[] {
  // Collect networkId order and per-network window lists in one pass.
  const order: number[] = [];
  const byNetwork = new Map<number, Window[]>();

  for (const w of windows) {
    if (!byNetwork.has(w.networkId)) {
      order.push(w.networkId);
      byNetwork.set(w.networkId, []);
    }
    // biome-ignore lint/style/noNonNullAssertion: just set above
    byNetwork.get(w.networkId)!.push(w);
  }

  return order.map((networkId) => {
    // biome-ignore lint/style/noNonNullAssertion: key guaranteed by loop above
    const list = byNetwork.get(networkId)!.slice();
    list.sort((a, b) => {
      const rankDiff = KIND_RANK[a.kind] - KIND_RANK[b.kind];
      if (rankDiff !== 0) return rankDiff;
      // Same kind: sort alpha case-insensitively by target.
      return a.target.toLowerCase().localeCompare(b.target.toLowerCase());
    });
    return { networkId, windows: list };
  });
}
