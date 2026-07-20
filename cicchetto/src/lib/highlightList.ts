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
//
// Identity-scoped (identityScopedStore): because there is NO broadcast, a
// logout/account-switch would otherwise leave the prior account's patterns in
// the signal until a manual refresh — a switched-in account would briefly
// render the previous one's list. The `onIdentityChange` reset clears it on
// rotation, so the next account starts empty and refreshes to its own list.

import { createSignal } from "solid-js";
import { identityScopedStore } from "./identityScopedStore";
import { pushWatchlistAdd, pushWatchlistDel, pushWatchlistList } from "./socket";

const exports_ = identityScopedStore((onIdentityChange) => {
  const [highlightPatterns, setHighlightPatterns] = createSignal<string[]>([]);

  // Logout / account switch — clear the mirror (no broadcast self-heals it).
  onIdentityChange(() => setHighlightPatterns([]));

  // Add a pattern; mirror + return the authoritative post-mutation list.
  const addHighlight = async (pattern: string): Promise<string[]> => {
    const { patterns } = await pushWatchlistAdd(pattern);
    setHighlightPatterns(patterns);
    return patterns;
  };

  // Remove a pattern; mirror + return the authoritative post-mutation list.
  const delHighlight = async (pattern: string): Promise<string[]> => {
    const { patterns } = await pushWatchlistDel(pattern);
    setHighlightPatterns(patterns);
    return patterns;
  };

  // Fetch the current list (settings-section open). Mirror + return it.
  const refreshHighlights = async (): Promise<string[]> => {
    const { patterns } = await pushWatchlistList();
    setHighlightPatterns(patterns);
    return patterns;
  };

  return { highlightPatterns, addHighlight, delHighlight, refreshHighlights };
});

export const highlightPatterns = exports_.highlightPatterns;
export const addHighlight = exports_.addHighlight;
export const delHighlight = exports_.delHighlight;
export const refreshHighlights = exports_.refreshHighlights;
