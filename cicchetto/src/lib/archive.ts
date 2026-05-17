import { createSignal } from "solid-js";
import { type ArchiveEntry, listArchive } from "./api";
import { token } from "./auth";
import { identityScopedStore } from "./identityScopedStore";
import { channelsBySlug } from "./networks";
import { queryWindowsByNetwork } from "./queryWindows";

// Per-network archive store. Source-of-truth for cic's per-network
// Archive collapsed-section in the Sidebar (CP15 B4).
//
// Lifecycle:
//   1. On user expand of the per-network Archive `<details>`, Sidebar
//      calls `loadArchive(slug)` which fetches GET /archive and writes
//      the entries into `archivedBySlug()[slug]`. Lazy by design — the
//      list can be O(hundreds) per network and the user rarely opens it.
//   2. Re-loading the same slug is a deliberate refresh (no double-load
//      gate like `members.loadedChannels`); the user re-expanding signals
//      "give me the current state."
//   3. Identity rotation flushes the whole store via `clearArchive` —
//      registered as the identityScopedStore reset (dup-A3 close).
//
// Sort order: server-side `Scrollback.list_archive/3` already returns
// entries sorted by `last_activity` DESC. The store preserves the wire
// order; the renderer is pure pass-through.

const exports_ = identityScopedStore((onIdentityChange) => {
  const [archivedBySlug, setArchivedBySlug] = createSignal<Record<string, ArchiveEntry[]>>({});
  // UX-2 (2026-05-17) — modal-open signal for the mobile BottomBar
  // archive chip. `null` = closed; a network slug = modal open for
  // that network. One signal, not per-network state, because only one
  // modal is visible at a time. Read by `ArchiveModal.tsx`; written by
  // `BottomBar.tsx`'s chip click + the modal's close affordances.
  //
  // Lives INSIDE the identityScopedStore so token rotation closes any
  // open modal alongside `archivedBySlug` flush — otherwise a previous
  // identity's modal could linger on top of the new identity's shell.
  const [archiveModalNetwork, setArchiveModalNetwork] = createSignal<string | null>(null);

  const clearArchive = (): void => {
    setArchivedBySlug({});
    setArchiveModalNetwork(null);
  };

  // Identity-transition cleanup. A token rotation MUST flush the prior
  // identity's archive cache AND close any open modal before the new
  // identity's first load fires.
  onIdentityChange(clearArchive);

  const loadArchive = async (slug: string): Promise<void> => {
    const t = token();
    if (!t) return;
    try {
      const entries = await listArchive(t, slug);
      setArchivedBySlug((prev) => ({ ...prev, [slug]: entries }));
    } catch {
      // Leave the prior entries (if any) in place. Sidebar's renderer
      // tolerates an absent slug key as "not loaded yet"; a transient
      // failure shouldn't blank the user's previously-rendered list.
    }
  };

  return {
    archivedBySlug,
    archiveModalNetwork,
    loadArchive,
    clearArchive,
    setArchiveModalNetwork,
  };
});

export const archivedBySlug = exports_.archivedBySlug;
export const archiveModalNetwork = exports_.archiveModalNetwork;
export const loadArchive = exports_.loadArchive;
export const clearArchive = exports_.clearArchive;
export const setArchiveModalNetwork = exports_.setArchiveModalNetwork;

// UX-2 — shared archive-visibility filter. Pre-UX-2 lived inline in
// `Sidebar.tsx` as `visibleArchiveForNetwork/2`. UX-2's mobile chip +
// modal need the SAME filter (a re-JOINed channel or re-opened query
// must not appear in either surface) — lifted here so the two
// rendering surfaces share one verb. Sidebar still calls this; chip
// gating + modal list both read through it.
//
// CP15 B5 contract preserved: render-time derivation, backing
// `archivedBySlug` cache untouched. Server-side `Scrollback.list_archive/3`
// does the same exclusion via active_keyset, but the client-side cache
// survives JOIN echoes; re-JOIN of an archived channel would otherwise
// dup the row in active + archive sections.
export function visibleArchiveForNetwork(slug: string, networkId: number): ArchiveEntry[] {
  const entries = archivedBySlug()[slug] ?? [];
  if (entries.length === 0) return entries;
  const liveChannels = new Set((channelsBySlug()?.[slug] ?? []).map((c) => c.name));
  const liveQueries = new Set(
    (queryWindowsByNetwork()[networkId] ?? []).map((qw) => qw.targetNick),
  );
  return entries.filter((entry) => {
    if (entry.kind === "channel") return !liveChannels.has(entry.target);
    return !liveQueries.has(entry.target);
  });
}
