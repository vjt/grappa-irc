import { describe, expect, it } from "vitest";
import { HoldToCloseGesture, MOVE_SLOP_PX } from "../holdToClose";

// Pure state machine for the #172 hold-to-confirm close gate: drive the engine
// with plain method calls and assert OUTCOMES (did it confirm?), no DOM, no
// timers — the handler factory owns the real setTimeout; the core only decides.

const make = () => new HoldToCloseGesture({ moveSlopPx: MOVE_SLOP_PX });

describe("HoldToCloseGesture — touch/pen hold gate", () => {
  it("a held touch press that reaches the timer confirms", () => {
    const g = make();
    expect(g.down("touch", 10, 10).gated).toBe(true);
    expect(g.holding()).toBe(true);
    expect(g.timerElapsed()).toBe(true);
    expect(g.phaseOf()).toBe("confirmed");
  });

  it("a touch release BEFORE the timer does not confirm (the fat-finger tap)", () => {
    const g = make();
    g.down("touch", 10, 10);
    g.release(); // pointerup before the threshold
    expect(g.holding()).toBe(false);
    // a late-firing timer can never resurrect a released hold
    expect(g.timerElapsed()).toBe(false);
    expect(g.phaseOf()).toBe("cancelled");
  });

  it("a drift past MOVE_SLOP_PX cancels the hold (a scroll, not a close)", () => {
    const g = make();
    g.down("touch", 10, 10);
    g.move(10 + MOVE_SLOP_PX + 1, 10);
    expect(g.holding()).toBe(false);
    expect(g.timerElapsed()).toBe(false);
  });

  it("a drift within slop keeps the hold armed", () => {
    const g = make();
    g.down("touch", 10, 10);
    g.move(10 + MOVE_SLOP_PX - 1, 10);
    expect(g.holding()).toBe(true);
    expect(g.timerElapsed()).toBe(true);
  });

  it("pointercancel/leave (release) drops an in-flight hold", () => {
    const g = make();
    g.down("pen", 5, 5);
    g.release();
    expect(g.timerElapsed()).toBe(false);
  });

  it("a mouse press is not gated — no hold; confirms via the click path", () => {
    const g = make();
    expect(g.down("mouse", 0, 0).gated).toBe(false);
    expect(g.holding()).toBe(false);
    // even a stray timer must not confirm a non-gated (mouse) press here
    expect(g.timerElapsed()).toBe(false);
  });
});
