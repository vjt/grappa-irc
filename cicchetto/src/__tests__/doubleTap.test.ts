import { describe, expect, it } from "vitest";
import { isDoubleTap } from "../lib/doubleTap";

describe("isDoubleTap", () => {
  it("is false with no previous tap", () => {
    expect(isDoubleTap(null, { t: 100, x: 10, y: 10 })).toBe(false);
  });

  it("is true for two close taps within the delay + distance", () => {
    expect(isDoubleTap({ t: 100, x: 10, y: 10 }, { t: 350, x: 14, y: 12 })).toBe(true);
  });

  it("is false when the second tap is too slow", () => {
    expect(isDoubleTap({ t: 100, x: 10, y: 10 }, { t: 500, x: 10, y: 10 })).toBe(false);
  });

  it("is false when the second tap is too far on the X axis", () => {
    expect(isDoubleTap({ t: 100, x: 10, y: 10 }, { t: 200, x: 60, y: 10 })).toBe(false);
  });

  it("is false when the second tap is too far on the Y axis", () => {
    expect(isDoubleTap({ t: 100, x: 10, y: 10 }, { t: 200, x: 10, y: 60 })).toBe(false);
  });

  it("includes the exact delay boundary (Δt === 300ms)", () => {
    expect(isDoubleTap({ t: 100, x: 10, y: 10 }, { t: 400, x: 10, y: 10 })).toBe(true);
  });

  it("includes the exact distance boundary (Δx === 24px)", () => {
    expect(isDoubleTap({ t: 100, x: 10, y: 10 }, { t: 200, x: 34, y: 10 })).toBe(true);
  });
});
