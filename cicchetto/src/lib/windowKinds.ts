// Window-kind discriminated union and ordering selector.
//
// `WindowKind` matches the server-side atom names exactly so wire
// payloads map without transformation:
//   :channel   → "channel"
//   :query     → "query"
//   :server    → "server"
//   :list      → "list"
//   :mentions  → "mentions"
//
// `Window` is the cicchetto-side representation of a single tab entry.
// `networkId` is the integer FK from the server `Network` schema;
// `target` is the channel name (e.g. "#grappa"), DM nick, or empty
// string for pseudo-windows (server, list, mentions).
//
// `orderWindows` is a pure function: takes a flat list, groups by
// network_id (stable insertion order — first-seen networkId gets index
// 0), and within each group sorts: server first, channels (alpha),
// queries (alpha), list, mentions. Ephemeral kinds (list, mentions)
// only appear when they're in the input — no placeholder injection.

export type WindowKind = "channel" | "query" | "server" | "list" | "mentions";

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

// Within-network kind rank (lower = earlier).
const KIND_RANK: Record<WindowKind, number> = {
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
