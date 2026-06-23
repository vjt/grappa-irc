import { EMOJI_CATEGORIES, type EmojiCategory } from "./emoji-data";

export const RECENTS_CAP = 32;
const STORAGE_KEY = "kbd-emoji-recents";

// Pure MRU update: move-to-front, dedupe, cap. Returns a new array.
export function addRecent(recents: string[], emoji: string): string[] {
  const next = [emoji, ...recents.filter((e) => e !== emoji)];
  return next.slice(0, RECENTS_CAP);
}

export function recentCategory(recents: string[]): EmojiCategory {
  return { id: "recents", label: "Recents", emojis: recents };
}

// Full category list with recents prepended (omitted when empty), for the
// picker to render. EMOJI_CATEGORIES is re-exported so the picker has one
// import site.
export function categoriesWithRecents(recents: string[]): EmojiCategory[] {
  return recents.length > 0 ? [recentCategory(recents), ...EMOJI_CATEGORIES] : EMOJI_CATEGORIES;
}

// localStorage persistence (host environment has it; guarded for jsdom).
export function loadRecents(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    // localStorage is an untrusted boundary: validate the shape rather
    // than casting, so a corrupted/foreign value can't crash the picker.
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((e) => typeof e === "string") ? parsed : [];
  } catch {
    return [];
  }
}

export function saveRecents(recents: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recents));
  } catch {
    /* no-op: private mode / quota */
  }
}

export { EMOJI_CATEGORIES };
