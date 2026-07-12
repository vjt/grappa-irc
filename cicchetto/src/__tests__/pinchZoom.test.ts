import { describe, expect, it } from "vitest";
import {
  applyPan,
  applyPinch,
  clamp,
  clampScale,
  clampTransform,
  DOUBLE_TAP_SCALE,
  distance,
  IDENTITY,
  MAX_SCALE,
  MIN_SCALE,
  maxTranslate,
  midpoint,
  type Size,
  type Transform,
  toggleZoom,
} from "../lib/pinchZoom";

// The pure pinch/pan geometry (gemello di swipe.ts) is DOM-free so it
// unit-tests without touch physics. A `Transform` is the CSS state applied to
// the modal <img>: { scale, tx, ty } → `translate(tx, ty) scale(scale)` with a
// center transform-origin. `Size` is the viewport (container) the image is
// confined to. Pan is clamped so a zoomed image can never fly entirely off the
// viewer.
const VIEWPORT: Size = { width: 400, height: 300 };

describe("distance", () => {
  it("is the euclidean distance between two points", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
  });

  it("is zero for coincident points", () => {
    expect(distance({ x: 7, y: 9 }, { x: 7, y: 9 })).toBe(0);
  });
});

describe("midpoint", () => {
  it("is the average of the two points", () => {
    expect(midpoint({ x: 0, y: 0 }, { x: 10, y: 20 })).toEqual({ x: 5, y: 10 });
  });
});

describe("clamp", () => {
  it("passes a value already in range through", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });
  it("clamps below the floor and above the ceiling", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
    expect(clamp(42, 0, 10)).toBe(10);
  });
});

describe("clampScale", () => {
  it("keeps a scale within the allowed zoom range", () => {
    expect(clampScale(2)).toBe(2);
  });
  it("floors at MIN_SCALE (never zoom out past fit)", () => {
    expect(clampScale(0.3)).toBe(MIN_SCALE);
  });
  it("ceils at MAX_SCALE (no infinite zoom)", () => {
    expect(clampScale(99)).toBe(MAX_SCALE);
  });
});

describe("maxTranslate", () => {
  it("is zero at scale 1 — an unzoomed image cannot pan", () => {
    expect(maxTranslate(1, 400)).toBe(0);
  });
  it("grows with scale: half the overflow at the given scale", () => {
    // At 2x over a 400px axis the image is 800px wide → 400px overflow →
    // 200px pannable each side.
    expect(maxTranslate(2, 400)).toBe(200);
  });
  it("never goes negative below scale 1", () => {
    expect(maxTranslate(0.5, 400)).toBe(0);
  });
});

describe("clampTransform", () => {
  it("forces translate to 0 when not zoomed", () => {
    const t: Transform = { scale: 1, tx: 50, ty: 50 };
    expect(clampTransform(t, VIEWPORT)).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it("keeps a within-bounds pan untouched when zoomed", () => {
    const t: Transform = { scale: 2, tx: 100, ty: 50 };
    expect(clampTransform(t, VIEWPORT)).toEqual({ scale: 2, tx: 100, ty: 50 });
  });

  it("clamps an over-panned image back to the confinement bound", () => {
    // 2x over 400×300 → max pan 200 (x), 150 (y).
    const t: Transform = { scale: 2, tx: 9999, ty: -9999 };
    expect(clampTransform(t, VIEWPORT)).toEqual({ scale: 2, tx: 200, ty: -150 });
  });

  it("clamps scale AND re-clamps the now-illegal translate together", () => {
    const t: Transform = { scale: 99, tx: 5000, ty: 5000 };
    const out = clampTransform(t, VIEWPORT);
    expect(out.scale).toBe(MAX_SCALE);
    expect(out.tx).toBe(maxTranslate(MAX_SCALE, VIEWPORT.width));
    expect(out.ty).toBe(maxTranslate(MAX_SCALE, VIEWPORT.height));
  });
});

describe("applyPinch", () => {
  it("scales relative to the gesture-start distance", () => {
    const start: Transform = { scale: 1, tx: 0, ty: 0 };
    // fingers move twice as far apart → 2x.
    expect(applyPinch(start, 100, 200, VIEWPORT)).toEqual({ scale: 2, tx: 0, ty: 0 });
  });

  it("compounds on the start scale (mid-gesture continuation)", () => {
    const start: Transform = { scale: 2, tx: 0, ty: 0 };
    expect(applyPinch(start, 100, 150, VIEWPORT).scale).toBe(3);
  });

  it("clamps the resulting scale to MAX_SCALE", () => {
    const start: Transform = { scale: 1, tx: 0, ty: 0 };
    expect(applyPinch(start, 100, 9999, VIEWPORT).scale).toBe(MAX_SCALE);
  });

  it("re-clamps translate when pinching back down shrinks the pan bound", () => {
    // start zoomed-and-panned at 3x (pan 400/2*(3-1)=... within bound), pinch
    // back to ~1x → translate must collapse to 0.
    const start: Transform = { scale: 3, tx: 200, ty: 100 };
    const out = applyPinch(start, 300, 100, VIEWPORT); // 3 * (100/300) = 1
    expect(out.scale).toBe(1);
    expect(out.tx).toBe(0);
    expect(out.ty).toBe(0);
  });

  it("is a no-op when the start distance is zero (divide guard)", () => {
    const start: Transform = { scale: 2, tx: 10, ty: 10 };
    expect(applyPinch(start, 0, 200, VIEWPORT)).toEqual(start);
  });
});

describe("applyPan", () => {
  it("adds the drag delta to the start translate when zoomed", () => {
    const start: Transform = { scale: 2, tx: 10, ty: 20 };
    expect(applyPan(start, { x: 30, y: -5 }, VIEWPORT)).toEqual({ scale: 2, tx: 40, ty: 15 });
  });

  it("clamps a pan that would push the image past the confinement bound", () => {
    const start: Transform = { scale: 2, tx: 150, ty: 0 };
    // max x pan at 2x/400 = 200; +100 would be 250 → clamp to 200.
    expect(applyPan(start, { x: 100, y: 0 }, VIEWPORT).tx).toBe(200);
  });

  it("cannot pan an unzoomed image (bound is 0)", () => {
    const start: Transform = { scale: 1, tx: 0, ty: 0 };
    expect(applyPan(start, { x: 50, y: 50 }, VIEWPORT)).toEqual({ scale: 1, tx: 0, ty: 0 });
  });
});

describe("toggleZoom", () => {
  it("zooms an unzoomed image to the double-tap scale, centered", () => {
    expect(toggleZoom(IDENTITY)).toEqual({ scale: DOUBLE_TAP_SCALE, tx: 0, ty: 0 });
  });

  it("resets a zoomed image back to fit", () => {
    expect(toggleZoom({ scale: 3, tx: 100, ty: 50 })).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it("resets even a slightly-zoomed image (any scale above MIN)", () => {
    expect(toggleZoom({ scale: 1.2, tx: 5, ty: 5 }).scale).toBe(MIN_SCALE);
  });
});
