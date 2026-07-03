// Pure swipe geometry for the compose textarea. DOM-free so it's
// unit-testable — the gesture itself is dogfood-only (Playwright webkit ≠
// iOS gesture physics). Swipes drive nick completion (right) and history
// recall (up/down); we use swipe rather than double-tap (collides with the
// native word-select) or the arrow keys (absent on a stock mobile
// keyboard). A point is {x, y} in client px; screen y grows DOWNWARD.
export type Point = { x: number; y: number };
export type SwipeDirection = "right" | "left" | "up" | "down";
export type DragAxis = "horizontal" | "vertical";

// The textarea's native-scroll boundary state, sampled at touchstart. `atTop`
// = scrolled to the first line (can't pan up further); `atBottom` = scrolled to
// the last line. A short, non-overflowing draft is at BOTH boundaries at once.
export type ScrollBoundary = { atTop: boolean; atBottom: boolean };

// The action a completed gesture maps to, or null for no-op.
export type GestureAction = "recall-prev" | "recall-next" | "tab-complete" | null;

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
// over elapsedMs at/above the flick threshold? Applied ONCE, at touchend, over
// the WHOLE gesture — NOT mid-drag. The 2026-07-03 rework moved it here: the
// old code sampled velocity at the first 8px-slop crossing (the acceleration
// ramp, where a genuine flick still reads slow) and abandoned irrevocably, so
// real flicks died and iOS-coalesced scroll-drags got hijacked (dogfood
// double-failure). The mid-drag CLAIM now keys off the scroll BOUNDARY
// (`claimAxis`), not speed; velocity only decides, at release, whether the
// completed gesture was a deliberate flick vs a slow settle. Full-gesture
// displacement + elapsed are both large by touchend → the measurement is
// reliable. The 8px slop (dragAxis) and 40px floor (swipeDirection) still bound
// displacement. Non-positive elapsed (same-tick events) counts as a flick —
// instantaneous travel is never a slow drag, and it guards the divide. Pure +
// DOM-free so it unit-tests without touch physics (jsdom can't synthesize
// momentum).
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

// Mid-drag CLAIM decision (#123 rework, 2026-07-03): once a drag clears the
// slop, do we OWN the gesture (caller preventDefaults, suppressing native
// scroll + drag-to-select) or leave it to the textarea's native `pan-y`
// scroll? Claim ONLY a drag native scroll can't consume:
//   * horizontal — `touch-action: pan-y` already blocks native pan-x, so a
//     horizontal drag would otherwise select text; we own it (→ tab-complete);
//   * vertical PAST a scroll boundary — up while `atTop`, or down while
//     `atBottom`. A short, non-overflowing draft is at BOTH boundaries, so any
//     vertical flick on it claims (the stock-keyboard history affordance).
// A vertical drag WITH scroll room in its direction returns null → native
// pan-y scrolls the draft; the caller never preventDefaults it. `boundary` is
// sampled at touchstart (intent is fixed when the finger lands: scroll to the
// edge first, THEN a second flick recalls). Velocity plays NO part here — see
// `isFastSwipe`; the flick test is deferred to touchend over the whole gesture.
export const claimAxis = (
  start: Point,
  current: Point,
  boundary: ScrollBoundary,
  slopPx: number = DRAG_SLOP_PX,
): DragAxis | null => {
  const axis = dragAxis(start, current, slopPx);
  if (axis === null) return null; // under the slop — still undecided
  if (axis === "horizontal") return "horizontal";
  // Vertical: claim only when the textarea can't scroll further this way.
  const movingUp = current.y - start.y < 0;
  if (movingUp) return boundary.atTop ? "vertical" : null;
  return boundary.atBottom ? "vertical" : null;
};

// Terminal dispatch at touchend: given a CLAIMED gesture's full [start → end]
// span over elapsedMs, which action fires? Gated by the full-gesture velocity
// (a claimed flick that decelerated into a slow release is not a recall) and
// then the 40px-floored direction: up → older history, down → newer history,
// right → nick tab-complete. Left / sub-floor / slow → null (no-op). The
// boundary gate already ran at claim time (`claimAxis`), so a vertical action
// here is known to be at the matching edge. Pure + DOM-free — unit-testable.
export const gestureAction = (
  start: Point,
  end: Point,
  elapsedMs: number,
  minDistPx: number = SWIPE_MIN_PX,
  minVelocity: number = SWIPE_MIN_VELOCITY_PX_PER_MS,
): GestureAction => {
  if (!isFastSwipe(start, end, elapsedMs, minVelocity)) return null;
  switch (swipeDirection(start, end, minDistPx)) {
    case "up":
      return "recall-prev";
    case "down":
      return "recall-next";
    case "right":
      return "tab-complete";
    default:
      return null; // "left" / null → no mapped action
  }
};
