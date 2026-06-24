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
