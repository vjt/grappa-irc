// Pure double-tap detector for the compose textarea. DOM-free so it's
// unit-testable — the gesture itself is dogfood-only (Playwright webkit
// ≠ iOS gesture physics). A "tap" is {t: epoch ms, x, y: client px}.
export type Tap = { t: number; x: number; y: number };

export const DOUBLE_TAP_MS = 300;
export const DOUBLE_TAP_PX = 24;

export const isDoubleTap = (
  prev: Tap | null,
  next: Tap,
  maxDelayMs: number = DOUBLE_TAP_MS,
  maxDistPx: number = DOUBLE_TAP_PX,
): boolean =>
  prev !== null &&
  next.t - prev.t <= maxDelayMs &&
  Math.abs(next.x - prev.x) <= maxDistPx &&
  Math.abs(next.y - prev.y) <= maxDistPx;
