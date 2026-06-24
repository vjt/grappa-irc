import { describe, expect, it } from "vitest";
import { dragAxis, swipeDirection } from "../lib/swipe";

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
