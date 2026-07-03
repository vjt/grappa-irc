// Pure swipe geometry for the compose textarea. DOM-free so it's
// unit-testable — the gesture itself is dogfood-only (Playwright webkit ≠
// iOS gesture physics). Swipes drive nick completion (right) and history
// recall (up/down); we use swipe rather than double-tap (collides with the
// native word-select) or the arrow keys (absent on a stock mobile
// keyboard). A point is {x, y} in client px; screen y grows DOWNWARD.
export type Point = { x: number; y: number };
export type SwipeDirection = "right" | "left" | "up" | "down";
export type DragAxis = "horizontal" | "vertical";

// Min dominant-axis travel for a gesture to count as a swipe.
export const SWIPE_MIN_PX = 40;
// Travel past which an in-progress drag is judged committed to an axis.
export const DRAG_SLOP_PX = 8;
// Min dominant-axis velocity (px per ms) for a drag to count as a
// deliberate flick rather than a slow content-scroll drag. Below it a
// finger-drag is left to native pan-y textarea scrolling (#123 —
// reviewing a long draft on touch); at/above it the drag claims the
// history-recall / tab-complete gesture. 0.3px/ms ≈ 300px/s: above a
// deliberate read-drag (empirically <~150px/s), below a natural flick
// (>~500px/s). Velocity feel is a device call — vjt calibrates on-device
// post-ship; this is a defensible default, not a measured optimum.
export const SWIPE_MIN_VELOCITY_PX_PER_MS = 0.3;

// Terminal classification (on touchend): the dominant-axis direction, if
// that axis's travel reaches minDistPx. A perfect diagonal (|dx| === |dy|)
// is ambiguous → null; sub-threshold travel → null.
export const swipeDirection = (
  start: Point,
  end: Point,
  minDistPx: number = SWIPE_MIN_PX,
): SwipeDirection | null => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax === ay) return null;
  if (ax > ay) return ax >= minDistPx ? (dx > 0 ? "right" : "left") : null;
  return ay >= minDistPx ? (dy > 0 ? "down" : "up") : null;
};

// Velocity gate (#123): is the dominant-axis speed across [start → point]
// over elapsedMs at/above the flick threshold? Shared by BOTH the mid-drag
// axis-claim (should we preventDefault + own the gesture, or let native
// pan-y scroll the textarea?) and the touchend dispatch (does this gesture
// recall history?) — one velocity source of truth, so the claim and the
// dispatch can never drift to two thresholds. Velocity ONLY: the 8px slop
// (dragAxis) and 40px floor (swipeDirection) still bound displacement.
// Non-positive elapsed (same-tick events) counts as a flick — instantaneous
// travel is never a slow drag, and it guards the divide. Pure + DOM-free so
// it unit-tests without touch physics (jsdom can't synthesize momentum).
export const isFastSwipe = (
  start: Point,
  point: Point,
  elapsedMs: number,
  minVelocity: number = SWIPE_MIN_VELOCITY_PX_PER_MS,
): boolean => {
  if (elapsedMs <= 0) return true;
  const dominant = Math.max(Math.abs(point.x - start.x), Math.abs(point.y - start.y));
  return dominant / elapsedMs >= minVelocity;
};

// Mid-drag check (on touchmove): the axis the drag has committed to once it
// clears the slop. Direction-agnostic — used only to decide when to
// preventDefault (suppress native scroll + text-select) before the final
// direction is known. A perfect diagonal commits to neither → null.
export const dragAxis = (
  start: Point,
  current: Point,
  slopPx: number = DRAG_SLOP_PX,
): DragAxis | null => {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax === ay) return null;
  if (ax > ay) return ax > slopPx ? "horizontal" : null;
  return ay > slopPx ? "vertical" : null;
};
