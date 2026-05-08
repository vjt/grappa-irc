import { createSignal } from "solid-js";
import { type ArchiveEntry, listArchive } from "./api";
import { token } from "./auth";
import { identityScopedStore } from "./identityScopedStore";

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

  const clearArchive = (): void => {
    setArchivedBySlug({});
  };

  // Identity-transition cleanup. A token rotation MUST flush the prior
  // identity's archive cache before the new identity's first load fires.
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

  return { archivedBySlug, loadArchive, clearArchive };
});

export const archivedBySlug = exports_.archivedBySlug;
export const loadArchive = exports_.loadArchive;
export const clearArchive = exports_.clearArchive;
