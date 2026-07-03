import { describe, expect, it } from "vitest";
import {
  claimAxis,
  dragAxis,
  gestureAction,
  isFastSwipe,
  type ScrollBoundary,
  SWIPE_MIN_VELOCITY_PX_PER_MS,
  swipeDirection,
} from "../lib/swipe";

// Screen y grows DOWNWARD: a smaller y is "up". Boundary fixtures name the
// textarea's scroll state at touchstart.
const AT_BOTH: ScrollBoundary = { atTop: true, atBottom: true }; // non-overflowing draft
const AT_TOP: ScrollBoundary = { atTop: true, atBottom: false }; // long draft scrolled to first line
const AT_BOTTOM: ScrollBoundary = { atTop: false, atBottom: true }; // scrolled to last line
const MID: ScrollBoundary = { atTop: false, atBottom: false }; // scrolled into the middle

describe("swipeDirection", () => {
  it("classifies a clear rightward swipe", () => {
    expect(swipeDirection({ x: 0, y: 0 }, { x: 50, y: 8 })).toBe("right");
  });

  it("classifies a clear leftward swipe", () => {
    expect(swipeDirection({ x: 50, y: 0 }, { x: 0, y: 8 })).toBe("left");
  });

  it("classifies a clear upward swipe (screen y grows downward)", () => {
    expect(swipeDirection({ x: 0, y: 50 }, { x: 8, y: 0 })).toBe("up");
  });

  it("classifies a clear downward swipe", () => {
    expect(swipeDirection({ x: 0, y: 0 }, { x: 8, y: 50 })).toBe("down");
  });

  it("is null when the dominant-axis travel is below the threshold", () => {
    expect(swipeDirection({ x: 0, y: 0 }, { x: 30, y: 0 })).toBeNull();
    expect(swipeDirection({ x: 0, y: 0 }, { x: 5, y: 30 })).toBeNull();
  });

  it("includes the exact distance boundary (40px)", () => {
    expect(swipeDirection({ x: 0, y: 0 }, { x: 40, y: 0 })).toBe("right");
    expect(swipeDirection({ x: 0, y: 40 }, { x: 0, y: 0 })).toBe("up");
  });

  it("is null on a perfect diagonal (ambiguous axis)", () => {
    expect(swipeDirection({ x: 0, y: 0 }, { x: 50, y: 50 })).toBeNull();
    expect(swipeDirection({ x: 0, y: 0 }, { x: 50, y: -50 })).toBeNull();
  });

  it("picks the dominant axis on a non-tie diagonal", () => {
    // mostly-right with some down → right
    expect(swipeDirection({ x: 0, y: 0 }, { x: 60, y: 20 })).toBe("right");
    // mostly-down with some right → down
    expect(swipeDirection({ x: 0, y: 0 }, { x: 20, y: 60 })).toBe("down");
  });
});

describe("dragAxis", () => {
  it("commits to horizontal once past the slop", () => {
    expect(dragAxis({ x: 0, y: 0 }, { x: 20, y: 4 })).toBe("horizontal");
  });

  it("commits to vertical once past the slop", () => {
    expect(dragAxis({ x: 0, y: 0 }, { x: 4, y: 20 })).toBe("vertical");
  });

  it("is null before the dominant axis clears the slop", () => {
    expect(dragAxis({ x: 0, y: 0 }, { x: 5, y: 3 })).toBeNull();
  });

  it("is null on a perfect diagonal (no committed axis)", () => {
    expect(dragAxis({ x: 0, y: 0 }, { x: 20, y: 20 })).toBeNull();
  });

  it("commits regardless of direction (leftward / upward)", () => {
    expect(dragAxis({ x: 50, y: 0 }, { x: 30, y: 2 })).toBe("horizontal");
    expect(dragAxis({ x: 0, y: 50 }, { x: 2, y: 30 })).toBe("vertical");
  });
});

describe("isFastSwipe (#123 velocity gate)", () => {
  // The load-bearing gate: separates a deliberate slow content-scroll drag
  // (leave native pan-y scrolling intact) from a fast history-recall flick.
  // Velocity is dominant-axis px / ms; the 40px displacement floor lives in
  // swipeDirection, so these cases probe SPEED only. jsdom can't synthesize
  // touch momentum — a pure (start, point, elapsedMs) fn is the real gate.

  it("treats a fast vertical flick as a swipe (60px up in 100ms = 0.6px/ms)", () => {
    expect(isFastSwipe({ x: 0, y: 60 }, { x: 0, y: 0 }, 100)).toBe(true);
  });

  it("treats a slow read-drag as NOT a swipe (60px up in 400ms = 0.15px/ms)", () => {
    expect(isFastSwipe({ x: 0, y: 60 }, { x: 0, y: 0 }, 400)).toBe(false);
  });

  it("includes the exact velocity boundary (0.3px/ms → swipe)", () => {
    // 30px over 100ms = exactly the threshold; the gate is inclusive (>=).
    expect(isFastSwipe({ x: 0, y: 0 }, { x: 0, y: 30 }, 100)).toBe(true);
    // A hair slower (30px over 101ms ≈ 0.297px/ms) drops below → not a swipe.
    expect(isFastSwipe({ x: 0, y: 0 }, { x: 0, y: 30 }, 101)).toBe(false);
  });

  it("uses the dominant axis for speed (mostly-horizontal flick)", () => {
    // dominant = max(|dx|, |dy|) = 60px over 100ms = 0.6px/ms → swipe,
    // even though the vertical component is slow on its own.
    expect(isFastSwipe({ x: 0, y: 0 }, { x: 60, y: 5 }, 100)).toBe(true);
  });

  it("treats instantaneous travel (elapsed <= 0) as a swipe", () => {
    // Same-tick events (elapsed 0) mean effectively-infinite velocity — a
    // flick, never a slow drag. Guards a divide-by-zero.
    expect(isFastSwipe({ x: 0, y: 0 }, { x: 50, y: 0 }, 0)).toBe(true);
    expect(isFastSwipe({ x: 0, y: 0 }, { x: 50, y: 0 }, -5)).toBe(true);
  });

  it("is velocity-only — a tiny-but-fast move passes (40px floor is elsewhere)", () => {
    // 10px over 1ms = 10px/ms → fast; the 40px SWIPE_MIN_PX displacement
    // floor is enforced by swipeDirection at touchend, not here.
    expect(isFastSwipe({ x: 0, y: 0 }, { x: 0, y: 10 }, 1)).toBe(true);
  });

  it("honours an explicit minVelocity override", () => {
    // 60px / 100ms = 0.6px/ms: passes the default, fails a 1.0px/ms bar.
    expect(isFastSwipe({ x: 0, y: 0 }, { x: 0, y: 60 }, 100, 1.0)).toBe(false);
    expect(SWIPE_MIN_VELOCITY_PX_PER_MS).toBe(0.3);
  });
});

describe("claimAxis (#123 rework — boundary claim, NOT velocity)", () => {
  // The mid-drag decision: OWN the gesture (caller preventDefaults) vs leave it
  // to native pan-y scroll. Keyed off the scroll boundary sampled at
  // touchstart, NEVER velocity — that was the 659aa06 bug (velocity sampled on
  // the acceleration ramp abandoned real flicks and hijacked coalesced
  // scrolls). Distances here clear the 8px slop; the boundary fixture varies.

  it("claims a horizontal drag regardless of boundary (native pan-x is blocked)", () => {
    // Rightward past slop, mid-scroll: still claimed — a horizontal drag can
    // only select text otherwise, so we own it for tab-complete.
    expect(claimAxis({ x: 0, y: 0 }, { x: 20, y: 2 }, MID)).toBe("horizontal");
    expect(claimAxis({ x: 50, y: 0 }, { x: 30, y: 2 }, AT_TOP)).toBe("horizontal");
  });

  it("claims an up-drag only when the textarea is AT the top edge", () => {
    // At the top there is nothing to scroll up into → the up-drag is a
    // history-recall flick, claim it. This is the swipe-up the dogfood
    // reported as dead: the claim no longer depends on early-ramp velocity.
    expect(claimAxis({ x: 0, y: 60 }, { x: 0, y: 40 }, AT_TOP)).toBe("vertical");
    expect(claimAxis({ x: 0, y: 60 }, { x: 0, y: 40 }, AT_BOTH)).toBe("vertical");
  });

  it("does NOT claim an up-drag with scroll room — native scroll owns it", () => {
    // Scrolled into the middle / at the bottom: an up-drag scrolls the draft
    // up. Returning null leaves it to native pan-y (the #123 scroll fix).
    expect(claimAxis({ x: 0, y: 60 }, { x: 0, y: 40 }, MID)).toBeNull();
    expect(claimAxis({ x: 0, y: 60 }, { x: 0, y: 40 }, AT_BOTTOM)).toBeNull();
  });

  it("claims a down-drag only when the textarea is AT the bottom edge", () => {
    expect(claimAxis({ x: 0, y: 0 }, { x: 0, y: 20 }, AT_BOTTOM)).toBe("vertical");
    expect(claimAxis({ x: 0, y: 0 }, { x: 0, y: 20 }, AT_BOTH)).toBe("vertical");
  });

  it("does NOT claim a down-drag with scroll room below", () => {
    expect(claimAxis({ x: 0, y: 0 }, { x: 0, y: 20 }, MID)).toBeNull();
    expect(claimAxis({ x: 0, y: 0 }, { x: 0, y: 20 }, AT_TOP)).toBeNull();
  });

  it("is null before the drag clears the slop (still undecided)", () => {
    // Under 8px on both axes → no axis committed yet, even at a boundary.
    expect(claimAxis({ x: 0, y: 0 }, { x: 5, y: 3 }, AT_BOTH)).toBeNull();
  });

  it("is velocity-BLIND: a slow-starting flick at the top still claims", () => {
    // No elapsed/velocity input at all — the signature proves the claim can't
    // abandon a genuine flick just because its first slop-crossing is slow.
    expect(claimAxis({ x: 0, y: 100 }, { x: 0, y: 50 }, AT_TOP)).toBe("vertical");
  });
});

describe("gestureAction (#123 rework — touchend dispatch)", () => {
  // Terminal mapping over the WHOLE gesture: full-gesture velocity gate, then
  // 40px-floored direction → action. Boundary already filtered at claim time.

  it("maps a fast up-flick to recall-prev (older history)", () => {
    expect(gestureAction({ x: 0, y: 60 }, { x: 0, y: 0 }, 100)).toBe("recall-prev");
  });

  it("maps a fast down-flick to recall-next (newer history)", () => {
    expect(gestureAction({ x: 0, y: 0 }, { x: 0, y: 60 }, 100)).toBe("recall-next");
  });

  it("maps a fast rightward flick to tab-complete", () => {
    expect(gestureAction({ x: 0, y: 0 }, { x: 60, y: 5 }, 100)).toBe("tab-complete");
  });

  it("is null for a leftward flick (no mapped action)", () => {
    expect(gestureAction({ x: 60, y: 0 }, { x: 0, y: 5 }, 100)).toBeNull();
  });

  it("is null for a slow release even at full displacement (decelerated flick)", () => {
    // 60px up over 400ms = 0.15px/ms < 0.3 → a claimed drag that settled slowly
    // does NOT recall. The full-gesture measurement is the reliable gate.
    expect(gestureAction({ x: 0, y: 60 }, { x: 0, y: 0 }, 400)).toBeNull();
  });

  it("is null when travel is under the 40px direction floor, however fast", () => {
    // 30px up in 10ms = 3px/ms (fast) but below the SWIPE_MIN_PX floor → null.
    expect(gestureAction({ x: 0, y: 30 }, { x: 0, y: 0 }, 10)).toBeNull();
  });

  it("treats an instantaneous (same-tick) up-flick as a recall", () => {
    expect(gestureAction({ x: 0, y: 60 }, { x: 0, y: 0 }, 0)).toBe("recall-prev");
  });
});
