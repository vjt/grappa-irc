import { beforeEach, describe, expect, it, vi } from "vitest";

import { installViewportHeightTracker, type VisualViewportLike } from "../lib/viewportHeight";

// UX-6 D9 — single helper, two CSS vars (--viewport-height legacy +
// --vh Telegram pattern). Unit coverage proves both vars write on
// boot AND on every resize event. Real keyboard behaviour is verified
// by vjt on iPhone (Playwright doesn't emulate the OS keyboard);
// these tests are the mechanical contract.

function makeFakeVp(initialHeight: number): {
  vp: VisualViewportLike;
  fireResize: (h: number) => void;
} {
  let handler: (() => void) | null = null;
  let height = initialHeight;
  const vp: VisualViewportLike = {
    get height() {
      return height;
    },
    addEventListener(event, h) {
      if (event === "resize") handler = h;
    },
  } as VisualViewportLike;
  return {
    vp,
    fireResize: (h: number) => {
      height = h;
      handler?.();
    },
  };
}

describe("viewportHeight module", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--viewport-height");
    document.documentElement.style.removeProperty("--vh");
  });

  it("writes --viewport-height (px) on boot", () => {
    const { vp } = makeFakeVp(852);
    installViewportHeightTracker(vp);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");
  });

  it("writes --vh (px, height * 0.01) on boot — Telegram pattern", () => {
    const { vp } = makeFakeVp(852);
    installViewportHeightTracker(vp);
    // 852 * 0.01 = 8.52
    expect(document.documentElement.style.getPropertyValue("--vh")).toBe("8.52px");
  });

  it("updates both vars on every resize event", () => {
    const { vp, fireResize } = makeFakeVp(852);
    installViewportHeightTracker(vp);
    fireResize(620); // keyboard opens — viewport shrinks
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("620px");
    expect(document.documentElement.style.getPropertyValue("--vh")).toBe("6.20px");
    fireResize(852); // keyboard dismisses — viewport restores
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");
    expect(document.documentElement.style.getPropertyValue("--vh")).toBe("8.52px");
  });

  it("is a no-op when the viewport argument is undefined", () => {
    installViewportHeightTracker(undefined);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--vh")).toBe("");
  });

  it("subscribes to the resize event only (D9 dropped vv.scroll — vvOffsetTop unreliable per WebKit #297779)", () => {
    const addEventListener = vi.fn();
    const vp: VisualViewportLike = { height: 800, addEventListener };
    installViewportHeightTracker(vp);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });
});
