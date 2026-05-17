import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  installScrollPin,
  installViewportHeightTracker,
  type VisualViewportLike,
} from "../lib/viewportHeight";

// Per `feedback_e2e_user_class_parity_matrix`: this is a CSS-layer
// shape bucket — single helper, single CSS var. Unit coverage proves
// the var-write happens on boot AND on every resize event. Real
// keyboard behaviour is verified by vjt on iPhone (Playwright doesn't
// emulate the OS keyboard); these tests are the mechanical contract.

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
  });

  it("writes the current viewport height on boot", () => {
    const { vp } = makeFakeVp(852);
    installViewportHeightTracker(vp);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");
  });

  it("updates the CSS var on every resize event", () => {
    const { vp, fireResize } = makeFakeVp(852);
    installViewportHeightTracker(vp);
    fireResize(620); // keyboard opens — viewport shrinks
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("620px");
    fireResize(852); // keyboard dismisses — viewport restores
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");
  });

  it("is a no-op when the viewport argument is undefined", () => {
    installViewportHeightTracker(undefined);
    // CSS var stays unset; .shell-mobile falls back to 100dvh.
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("");
  });

  it("subscribes to the resize event (not scroll or other)", () => {
    const addEventListener = vi.fn();
    const vp: VisualViewportLike = { height: 800, addEventListener };
    installViewportHeightTracker(vp);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });
});

describe("installScrollPin", () => {
  function makeFakeWindow(scrollY: number): {
    win: Window;
    scrollTo: ReturnType<typeof vi.fn>;
    fire: () => void;
  } {
    const scrollTo = vi.fn();
    const handlerBox: { fn: (() => void) | null } = { fn: null };
    const win = {
      scrollX: 0,
      scrollY,
      scrollTo,
      addEventListener(event: string, h: () => void) {
        if (event === "scroll") handlerBox.fn = h;
      },
    } as unknown as Window;
    return { win, scrollTo, fire: () => handlerBox.fn?.() };
  }

  it("snaps window back to (0, 0) when a scroll fires at non-zero", () => {
    const { win, scrollTo, fire } = makeFakeWindow(100);
    installScrollPin(win);
    fire();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("does NOT call scrollTo when already at (0, 0)", () => {
    const { win, scrollTo, fire } = makeFakeWindow(0);
    installScrollPin(win);
    fire();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("is a no-op when target is undefined", () => {
    expect(() => installScrollPin(undefined)).not.toThrow();
  });
});
