import { describe, expect, it } from "vitest";
import { isHorizontalDrag, isSwipeRight } from "../lib/swipe";

describe("isSwipeRight", () => {
  it("is true for a clear rightward, horizontal-dominant swipe", () => {
    expect(isSwipeRight({ x: 10, y: 100 }, { x: 70, y: 108 })).toBe(true);
  });

  it("is false when the rightward distance is below the threshold", () => {
    expect(isSwipeRight({ x: 10, y: 100 }, { x: 40, y: 100 })).toBe(false);
  });

  it("is false for a leftward swipe", () => {
    expect(isSwipeRight({ x: 100, y: 100 }, { x: 20, y: 100 })).toBe(false);
  });

  it("is false when vertical movement dominates", () => {
    expect(isSwipeRight({ x: 10, y: 10 }, { x: 60, y: 120 })).toBe(false);
  });

  it("includes the exact distance boundary (dx === 40px)", () => {
    expect(isSwipeRight({ x: 10, y: 100 }, { x: 50, y: 100 })).toBe(true);
  });

  it("rejects the exact 45° rightward diagonal (dx === |dy|)", () => {
    expect(isSwipeRight({ x: 0, y: 0 }, { x: 50, y: 50 })).toBe(false);
    expect(isSwipeRight({ x: 0, y: 0 }, { x: 50, y: -50 })).toBe(false);
  });
});

describe("isHorizontalDrag", () => {
  it("is false before the drag clears the slop", () => {
    expect(isHorizontalDrag({ x: 10, y: 10 }, { x: 15, y: 10 })).toBe(false);
  });

  it("is true once a horizontal-dominant drag clears the slop", () => {
    expect(isHorizontalDrag({ x: 10, y: 10 }, { x: 30, y: 14 })).toBe(true);
  });

  it("is false for a vertical-dominant drag past the slop", () => {
    expect(isHorizontalDrag({ x: 10, y: 10 }, { x: 22, y: 60 })).toBe(false);
  });

  it("is true for a leftward horizontal drag (direction-agnostic)", () => {
    expect(isHorizontalDrag({ x: 100, y: 10 }, { x: 80, y: 12 })).toBe(true);
  });

  it("rejects the exact 45° drag (|dx| === |dy|) as not axis-committed", () => {
    expect(isHorizontalDrag({ x: 0, y: 0 }, { x: 20, y: 20 })).toBe(false);
  });
});
