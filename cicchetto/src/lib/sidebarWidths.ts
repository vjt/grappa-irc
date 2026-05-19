// Desktop sidebar width preferences — two flat localStorage keys, two
// CSS custom properties on <html>. Mirror-shape of fontSize.ts:
//
//   * Sync boot-time read so the first paint already has the right grid
//     template — no flash of default width as Shell mounts. applyFromStorage
//     is called from main.tsx BEFORE render().
//   * setSidebarWidth writes BOTH localStorage AND the CSS var. ResizeHandle
//     calls it only on pointerup (drag-end), not on every pointermove —
//     during drag the CSS var is mutated directly by the handle for live
//     visual feedback without thrashing localStorage.
//
// localStorage only — per `feedback_no_localized_strings_server_side`,
// device-local UI prefs (different desktops have different ergonomic widths)
// stay client-side. fontSize.ts + theme.ts set the precedent.
//
// Clamp policy:
//   * Min width:  MIN_WIDTH_PX (operator can't accidentally hide the column).
//   * Max width:  50% of window.innerWidth (operator can't accidentally hide
//                 all scrollback). Evaluated at read/write time against the
//                 current viewport, so resizing the browser narrower than
//                 the stored width clamps down on next read.

export type SidebarSide = "left" | "right";

const STORAGE_KEY: Record<SidebarSide, string> = {
  left: "cicchetto.sidebarWidth",
  right: "cicchetto.membersWidth",
};

const CSS_VAR: Record<SidebarSide, string> = {
  left: "--sidebar-width",
  right: "--members-width",
};

const DEFAULT_PX: Record<SidebarSide, number> = {
  left: 256,
  right: 224,
};

export const MIN_WIDTH_PX = 160;

function viewportMaxPx(): number {
  if (typeof window === "undefined") return Number.POSITIVE_INFINITY;
  return Math.max(MIN_WIDTH_PX, Math.floor(window.innerWidth / 2));
}

export function clampWidth(px: number): number {
  if (!Number.isFinite(px)) return DEFAULT_PX.left;
  return Math.min(viewportMaxPx(), Math.max(MIN_WIDTH_PX, Math.round(px)));
}

function readStoredWidth(side: SidebarSide): number {
  const raw = localStorage.getItem(STORAGE_KEY[side]);
  if (raw === null) return DEFAULT_PX[side];
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_PX[side];
  return clampWidth(n);
}

function writeCssVar(side: SidebarSide, px: number): void {
  document.documentElement.style.setProperty(CSS_VAR[side], `${px}px`);
}

export function getSidebarWidth(side: SidebarSide): number {
  return readStoredWidth(side);
}

export function setSidebarWidth(side: SidebarSide, px: number): number {
  const clamped = clampWidth(px);
  localStorage.setItem(STORAGE_KEY[side], String(clamped));
  writeCssVar(side, clamped);
  return clamped;
}

// Boot-time entry. Reads both stored widths (falling back to defaults)
// and writes both CSS vars on <html> so the first paint already has the
// right grid template.
export function applySidebarWidthsFromStorage(): void {
  writeCssVar("left", readStoredWidth("left"));
  writeCssVar("right", readStoredWidth("right"));
}
