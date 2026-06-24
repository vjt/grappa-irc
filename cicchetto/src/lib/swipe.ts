// Pure swipe geometry for the compose textarea. DOM-free so it's
// unit-testable — the gesture itself is dogfood-only (Playwright webkit ≠
// iOS gesture physics). A swipe-right fires nick completion; we pick swipe
// (not double-tap) because double-tap collides with the native
// word-select. A point is {x, y} in client px.
export type Point = { x: number; y: number };

// Min rightward travel to count as a completion swipe.
export const SWIPE_MIN_PX = 40;
// Travel past which an in-progress drag is judged committed to an axis.
export const DRAG_SLOP_PX = 8;

// Terminal classification (on touchend): a rightward, horizontal-dominant
// swipe of at least minDistPx.
export const isSwipeRight = (
  start: Point,
  end: Point,
  minDistPx: number = SWIPE_MIN_PX,
): boolean => {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  return dx >= minDistPx && Math.abs(dy) < dx;
};

// Mid-drag check (on touchmove): has the drag cleared the slop AND
// committed to the horizontal axis? Direction-agnostic — used only to
// decide when to preventDefault (suppress native scroll + text-select)
// before we know the final direction.
export const isHorizontalDrag = (
  start: Point,
  current: Point,
  slopPx: number = DRAG_SLOP_PX,
): boolean => {
  const dx = current.x - start.x;
  const dy = current.y - start.y;
  return Math.abs(dx) > slopPx && Math.abs(dx) > Math.abs(dy);
};
