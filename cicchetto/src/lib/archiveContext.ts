import { selectedChannel } from "./selection";

// UX-5 bucket BM (2026-05-20) — shared accessor: which network slug
// should the archive affordance be active for, given the current
// selection? Returns null when the selection has no network context
// (home / mentions / admin / pre-select).
//
// Pre-bucket this lived inline in `ShellChrome.ChromeButtons` as
// `archiveSlug()`. BM added a second surface — the mobile members
// drawer footer's archive launcher (Shell.tsx) — that needs the
// EXACT same predicate. Per CLAUDE.md "Implement once, reuse
// everywhere": lifted here so a future window kind (e.g. `:search`)
// gets uniform archive treatment across both surfaces from one edit.
export function archiveSlugForSelection(): string | null {
  const sel = selectedChannel();
  if (sel === null) return null;
  if (sel.kind === "home" || sel.kind === "mentions" || sel.kind === "admin") return null;
  return sel.networkSlug;
}
