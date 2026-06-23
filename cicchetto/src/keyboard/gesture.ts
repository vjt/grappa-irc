// Pure pointer state machine for one key press. No DOM, no timers, no
// framework. The component feeds pointer samples and (on its own timer)
// calls openVariations(); the engine tracks phase + highlight and returns
// a terminal intent on up().

export interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface KeyGestureConfig {
  keyRect: Rect;
  moveSlopPx: number;
  yBandPadPx: number;
}

export interface StripGeometry {
  top: number; // y of strip top edge (smaller = higher on screen)
  bottom: number; // y of strip bottom edge (>= top, <= key top)
  cellCentersX: number[];
  defaultIndex: number;
}

export type GesturePhase =
  | { kind: "idle" }
  | { kind: "pressed" } // magnify balloon up, no strip yet
  | { kind: "longpress"; highlight: number | null }; // null = cancelled

export type GestureIntent =
  | { kind: "commit-base" }
  | { kind: "commit-variant"; index: number }
  | { kind: "cancel" };

// Tunable defaults (the component passes these in; named, no magic
// numbers at call sites).
export const LONG_PRESS_MS = 300;
export const MOVE_SLOP_PX = 10;
export const Y_BAND_PAD_PX = 12;

// Analytic strip geometry: cells of `cellWidth` laid out centered over
// the key, clamped to [0, viewportWidth], sitting `gap` px above the key
// with height `stripHeight`. defaultIndex = the cell whose center is
// nearest the key's horizontal center (the one "directly above").
export function computeStripGeometry(opts: {
  keyRect: Rect;
  variantCount: number;
  cellWidth: number;
  stripHeight: number;
  gap: number;
  viewportWidth: number;
}): StripGeometry {
  const { keyRect, variantCount, cellWidth, stripHeight, gap, viewportWidth } = opts;
  const totalWidth = variantCount * cellWidth;
  const keyCenter = (keyRect.left + keyRect.right) / 2;
  let startX = keyCenter - totalWidth / 2;
  // clamp horizontally
  startX = Math.max(0, Math.min(startX, viewportWidth - totalWidth));
  const cellCentersX = Array.from(
    { length: variantCount },
    (_, i) => startX + cellWidth * i + cellWidth / 2,
  );
  const bottom = keyRect.top - gap;
  const top = bottom - stripHeight;
  const defaultIndex =
    cellCentersX
      .map((x, i) => [Math.abs(x - keyCenter), i] as const)
      .sort((a, b) => a[0] - b[0])[0]?.[1] ?? 0;
  return { top, bottom, cellCentersX, defaultIndex };
}

export class KeyGesture {
  private cfg: KeyGestureConfig;
  private state: GesturePhase = { kind: "idle" };
  private strip: StripGeometry | null = null;
  private cancelled = false;

  constructor(cfg: KeyGestureConfig) {
    this.cfg = cfg;
  }

  phase(): GesturePhase {
    return this.state;
  }

  down(_x: number, _y: number): void {
    this.state = { kind: "pressed" };
    this.strip = null;
    this.cancelled = false;
  }

  // Called by the component's long-press timer if still pressed.
  openVariations(strip: StripGeometry): void {
    if (this.state.kind !== "pressed") return;
    this.strip = strip;
    this.state = { kind: "longpress", highlight: strip.defaultIndex };
  }

  // Track the finger during a long-press: pick the nearest variant cell,
  // freeze the highlight when the finger rises above the strip, and cancel
  // (sticky) when it drops below the pressed key. No-op until a strip is open.
  move(x: number, y: number): void {
    if (this.state.kind !== "longpress" || this.strip === null) return;
    if (this.cancelled) return; // sticky cancel

    // Below the pressed key's bottom edge → close (cancel).
    if (y > this.cfg.keyRect.bottom) {
      this.cancelled = true;
      this.state = { kind: "longpress", highlight: null };
      return;
    }

    // Above the strip's top edge → freeze (keep current highlight).
    if (y < this.strip.top) return;

    // Tracking band: over the strip OR down to the key bottom (incl. the
    // gap between them). Highlight = nearest cell center to x.
    const nearest =
      this.strip.cellCentersX
        .map((cx, i) => [Math.abs(cx - x), i] as const)
        .sort((a, b) => a[0] - b[0])[0]?.[1] ?? 0;
    this.state = { kind: "longpress", highlight: nearest };
  }

  up(): GestureIntent {
    const s = this.state;
    this.state = { kind: "idle" };
    if (s.kind === "longpress") {
      if (s.highlight === null) return { kind: "cancel" };
      return { kind: "commit-variant", index: s.highlight };
    }
    return { kind: "commit-base" };
  }
}
