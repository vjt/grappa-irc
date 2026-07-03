import { describe, expect, it } from "vitest";
import {
  dragAxis,
  isFastSwipe,
  SWIPE_MIN_VELOCITY_PX_PER_MS,
  swipeDirection,
} from "../lib/swipe";

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
