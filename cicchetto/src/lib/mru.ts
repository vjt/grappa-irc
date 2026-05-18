import { createEffect, createSignal, untrack } from "solid-js";
import { type ChannelKey, decodeChannelKey } from "./channelKey";
import { identityScopedStore } from "./identityScopedStore";
import { networks } from "./networks";

// UX-4 bucket E — most-recently-used window history.
//
// Tracks the order in which the operator focused channel/query windows
// so that closing the currently-selected window can auto-shift focus to
// the next-most-recently-viewed live window instead of stranding the
// operator on the empty "select chan to see scrollback" pane.
//
// Scope is INTENTIONALLY narrow: only `kind ∈ {channel, query}` windows
// enter the MRU. The other kinds either ARE the fallback target (home,
// server) or are ephemeral (list, mentions) and shouldn't take focus
// when an unrelated window closes. See `selection.ts`'s recordFocus
// call site for the kind-discriminating gate.
//
// Identity-scoped via identityScopedStore — mru clears on token
// rotation/logout, mirroring selection / queryWindows / windowState.
// A fresh login starts with an empty history; the picker falls through
// to server-window-or-home until the operator focuses the first
// channel/query.
//
// Pruning: a `DELETE /networks` removes a slug from `networks()` for
// good. Entries for that slug in MRU are dead permanently — the
// picker's predicate would skip them but they'd sit in the array until
// MRU_MAX evictions pushed them out. The networks() effect below
// proactively drops MRU entries whose slug is no longer in the live
// list — mirrors bucket D's `lastConnectionState` Map prune.
//
// Per-channel staleness (channel parted, query closed) is NOT pruned
// proactively — the predicate at pick time filters dead entries, and
// re-opening the same channel pushes it back to MRU front via
// recordFocus. Proactive pruning on channelsBySlug / queryWindowsByNetwork
// change would couple this module to those stores and run on every
// PART/JOIN; the predicate-at-pick-time pattern keeps the coupling at
// the call site (selection.ts) where it's needed.
//
// API:
//   * `mru()`            — read-only signal, head is most-recent.
//   * `recordFocus(key)` — dedup-push to front, slice to MRU_MAX.
//   * `evictFromMru(key)` — drop a specific key (called before picker
//     to prevent the just-closed window from being picked).
//   * `pickLiveMru(exclude, isLive)` — first MRU entry that passes the
//     isLive predicate AND is not exclude. Returns null when nothing
//     matches → caller falls back to server-window or home.

const MRU_MAX = 32;

const exports = identityScopedStore((onIdentityChange) => {
  const [mru, setMru] = createSignal<ChannelKey[]>([]);

  onIdentityChange(() => setMru([]));

  const recordFocus = (key: ChannelKey): void => {
    setMru((prev) => {
      // Short-circuit when key is already at head — no allocation, no
      // setMru change, no re-render of mru() consumers.
      if (prev[0] === key) return prev;
      const filtered = prev.filter((k) => k !== key);
      const next: ChannelKey[] = [key, ...filtered];
      return next.length > MRU_MAX ? next.slice(0, MRU_MAX) : next;
    });
  };

  const evictFromMru = (key: ChannelKey): void => {
    setMru((prev) => {
      if (!prev.includes(key)) return prev;
      return prev.filter((k) => k !== key);
    });
  };

  // First MRU entry (most-recent first) that is NOT `exclude` AND for
  // which `isLive(key)` returns true. Returns null when no candidate
  // qualifies — caller falls back to server-window-or-home.
  //
  // Reads mru() inside an untrack — the picker is invoked from a
  // createEffect whose dependencies should NOT include the mru signal
  // (we don't want re-runs when mru itself changes; only when the
  // close-trigger changes).
  const pickLiveMru = (
    exclude: ChannelKey | null,
    isLive: (key: ChannelKey) => boolean,
  ): ChannelKey | null => {
    const list = untrack(mru);
    for (const k of list) {
      if (k === exclude) continue;
      if (isLive(k)) return k;
    }
    return null;
  };

  // Prune MRU entries whose slug is no longer in `networks()` — fires
  // on a DELETE /networks (slug disappears) or network-list mutation
  // that drops a slug. Per-channel staleness is NOT handled here (see
  // moduledoc).
  createEffect(() => {
    const nets = networks();
    if (!nets) return;
    const liveSlugs = new Set(nets.map((n) => n.slug));
    setMru((prev) => {
      const filtered = prev.filter((k) => {
        const decoded = decodeChannelKey(k);
        if (decoded === null) return false;
        return liveSlugs.has(decoded.slug);
      });
      return filtered.length === prev.length ? prev : filtered;
    });
  });

  return { mru, recordFocus, evictFromMru, pickLiveMru };
});

export const mru = exports.mru;
export const recordFocus = exports.recordFocus;
export const evictFromMru = exports.evictFromMru;
export const pickLiveMru = exports.pickLiveMru;
