// #356 — cic-side single source of truth for the keyword highlight list.
//
// Unlike the presence watch list (notifyWatch.ts, kept fresh by the server's
// notify_list broadcast), the keyword list is server user_settings with NO
// broadcast: each mutation push (add/del/list) returns the authoritative full
// list ({patterns: string[]}). We mirror that response into this signal so
// BOTH the /hilight command AND the watch-lists settings section read ONE
// state that can't drift — the settings section refreshes on open, and a
// /hilight from the compose box updates the same store an open section reads.
//
// cic NEVER originates state here: the signal only ever holds what the last
// server round-trip returned (CLAUDE.md window-state invariant family).

import { createSignal } from "solid-js";
import { pushWatchlistAdd, pushWatchlistDel, pushWatchlistList } from "./socket";

const [highlightPatterns, setHighlightPatterns] = createSignal<string[]>([]);

export { highlightPatterns };

// Add a pattern; mirror + return the authoritative post-mutation list.
export async function addHighlight(pattern: string): Promise<string[]> {
  const { patterns } = await pushWatchlistAdd(pattern);
  setHighlightPatterns(patterns);
  return patterns;
}

// Remove a pattern; mirror + return the authoritative post-mutation list.
export async function delHighlight(pattern: string): Promise<string[]> {
  const { patterns } = await pushWatchlistDel(pattern);
  setHighlightPatterns(patterns);
  return patterns;
}

// Fetch the current list (settings-section open). Mirror + return it.
export async function refreshHighlights(): Promise<string[]> {
  const { patterns } = await pushWatchlistList();
  setHighlightPatterns(patterns);
  return patterns;
}

// Identity teardown (logout / account switch) — mirror the other stores'
// reset shape so a switched-in account never briefly shows the prior one's
// patterns before its own refresh lands.
export function resetHighlightPatterns(): void {
  setHighlightPatterns([]);
}
