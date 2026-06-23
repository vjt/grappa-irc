import { describe, expect, it } from "vitest";
import { computeStripGeometry, KeyGesture } from "../gesture";

const RECT = { left: 100, right: 140, top: 200, bottom: 244 }; // a key

describe("computeStripGeometry", () => {
  it("centers cells over the key and defaults to the cell above the key", () => {
    const g = computeStripGeometry({
      keyRect: RECT,
      variantCount: 3,
      cellWidth: 40,
      stripHeight: 50,
      gap: 8,
      viewportWidth: 400,
    });
    expect(g.cellCentersX).toHaveLength(3);
    // strip sits ABOVE the key
    expect(g.bottom).toBeLessThanOrEqual(RECT.top);
    expect(g.top).toBeLessThan(g.bottom);
    // default = cell nearest the key center (x = 120)
    const keyCenter = 120;
    const nearest = g.cellCentersX
      .map((x, i) => [Math.abs(x - keyCenter), i] as const)
      .sort((a, b) => a[0] - b[0])[0]?.[1];
    expect(g.defaultIndex).toBe(nearest);
  });

  it("clamps the strip within the viewport", () => {
    const g = computeStripGeometry({
      keyRect: { left: 360, right: 400, top: 200, bottom: 244 },
      variantCount: 6,
      cellWidth: 40,
      stripHeight: 50,
      gap: 8,
      viewportWidth: 400,
    });
    expect(Math.min(...g.cellCentersX) - 20).toBeGreaterThanOrEqual(0);
    expect(Math.max(...g.cellCentersX) + 20).toBeLessThanOrEqual(400);
  });
});

describe("KeyGesture tap vs long-press", () => {
  it("quick down→up with no long-press commits the base char", () => {
    const g = new KeyGesture({ keyRect: RECT, moveSlopPx: 10, yBandPadPx: 12 });
    g.down(120, 220);
    expect(g.phase().kind).toBe("pressed");
    expect(g.up()).toEqual({ kind: "commit-base" });
  });

  it("after openVariations, phase is longpress with default highlight", () => {
    const g = new KeyGesture({ keyRect: RECT, moveSlopPx: 10, yBandPadPx: 12 });
    g.down(120, 220);
    g.openVariations({
      top: 140,
      bottom: 190,
      cellCentersX: [80, 120, 160],
      defaultIndex: 1,
    });
    const p = g.phase();
    expect(p.kind).toBe("longpress");
    if (p.kind === "longpress") expect(p.highlight).toBe(1);
  });

  it("up while never opened, after a small move, still commits base", () => {
    const g = new KeyGesture({ keyRect: RECT, moveSlopPx: 10, yBandPadPx: 12 });
    g.down(120, 220);
    g.move(124, 222); // within slop
    expect(g.up()).toEqual({ kind: "commit-base" });
  });
});

describe("KeyGesture variation selection", () => {
  const STRIP = { top: 140, bottom: 190, cellCentersX: [80, 120, 160], defaultIndex: 1 };
  const RECT2 = { left: 100, right: 140, top: 200, bottom: 244 };
  const make = () => {
    const g = new KeyGesture({ keyRect: RECT2, moveSlopPx: 10, yBandPadPx: 12 });
    g.down(120, 220);
    g.openVariations(STRIP);
    return g;
  };

  it("tracks X to nearest cell at the key's Y band", () => {
    const g = make();
    g.move(162, 220); // over rightmost cell's x, at key Y
    const p = g.phase();
    expect(p.kind === "longpress" && p.highlight).toBe(2);
    expect(g.up()).toEqual({ kind: "commit-variant", index: 2 });
  });

  it("tracks X when the finger is over the strip itself", () => {
    const g = make();
    g.move(82, 150); // over leftmost cell, inside strip
    const p = g.phase();
    expect(p.kind === "longpress" && p.highlight).toBe(0);
  });

  it("freezes highlight when finger goes ABOVE the strip top", () => {
    const g = make();
    g.move(160, 220); // highlight -> 2
    g.move(80, 100); // above strip top: should NOT change to 0
    const p = g.phase();
    expect(p.kind === "longpress" && p.highlight).toBe(2);
  });

  it("cancels (closes) when finger goes BELOW the key bottom", () => {
    const g = make();
    g.move(160, 220); // highlight -> 2
    g.move(120, 300); // below key bottom
    const p = g.phase();
    expect(p.kind === "longpress" && p.highlight).toBe(null);
    expect(g.up()).toEqual({ kind: "cancel" });
  });

  it("cancel is sticky: moving back up does not reopen", () => {
    const g = make();
    g.move(120, 300); // cancel
    g.move(120, 150); // back over strip
    const p = g.phase();
    expect(p.kind === "longpress" && p.highlight).toBe(null);
  });
});
