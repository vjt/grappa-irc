// Font-size preference — closed-set union with localStorage persistence
// and a single CSS-var write on `<html>`. Mirror-shape of theme.ts:
// boot-time entry called from main.tsx BEFORE render() so the first
// paint already has the right size — no FOUC + no flash on toggle.
//
// `--font-size` is plumbed into every cic surface via the default.css
// `:root` rule (default 14px = "M") + downstream `font-size: var(--font-size)`
// references. Setting it on `<html>` overrides `:root` without touching
// the stylesheet.
//
// localStorage only — per `feedback_no_localized_strings_server_side`,
// cic owns mobile UX; no server-side persistence, no wire bleed.

export type FontSizeKey = "S" | "M" | "L" | "XL" | "XXL";

const STORAGE_KEY = "cicchetto.fontSize";
const SIZES: Record<FontSizeKey, string> = {
  S: "12px",
  M: "14px",
  L: "16px",
  XL: "18px",
  XXL: "20px",
};

function isFontSizeKey(v: string | null): v is FontSizeKey {
  return v === "S" || v === "M" || v === "L" || v === "XL" || v === "XXL";
}

function readStoredSize(): FontSizeKey {
  const v = localStorage.getItem(STORAGE_KEY);
  return isFontSizeKey(v) ? v : "M";
}

function writeCssVar(size: FontSizeKey): void {
  document.documentElement.style.setProperty("--font-size", SIZES[size]);
}

export function getFontSize(): FontSizeKey {
  return readStoredSize();
}

export function setFontSize(size: FontSizeKey): void {
  localStorage.setItem(STORAGE_KEY, size);
  writeCssVar(size);
}

// Boot-time entry. Reads stored preference (falling back to "M") and
// writes `--font-size` on `<html>` so the first frame already has the
// right size.
export function applyFontSizeFromStorage(): void {
  writeCssVar(readStoredSize());
}
