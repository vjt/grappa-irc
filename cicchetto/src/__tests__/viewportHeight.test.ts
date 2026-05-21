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

function makeFakeVp(
  initialHeight: number,
  initialOffsetTop = 0,
): {
  vp: VisualViewportLike;
  fireResize: (h: number) => void;
  fireScroll: (offsetTop: number) => void;
} {
  const handlers: Record<string, (() => void) | null> = { resize: null, scroll: null };
  let height = initialHeight;
  let offsetTop = initialOffsetTop;
  const vp: VisualViewportLike = {
    get height() {
      return height;
    },
    get offsetTop() {
      return offsetTop;
    },
    addEventListener(event, h) {
      handlers[event] = h;
    },
  } as VisualViewportLike;
  return {
    vp,
    fireResize: (h: number) => {
      height = h;
      handlers.resize?.();
    },
    fireScroll: (o: number) => {
      offsetTop = o;
      handlers.scroll?.();
    },
  };
}

describe("viewportHeight module", () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty("--viewport-height");
    document.documentElement.style.removeProperty("--vv-offset-top");
  });

  it("writes the current viewport height on boot", () => {
    const { vp } = makeFakeVp(852);
    installViewportHeightTracker(vp);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");
  });

  it("writes --vv-offset-top on boot (UX-6 D6 iOS layout-shift cancel)", () => {
    const { vp } = makeFakeVp(852, 0);
    installViewportHeightTracker(vp);
    expect(document.documentElement.style.getPropertyValue("--vv-offset-top")).toBe("0px");
  });

  it("updates the CSS var on every resize event", () => {
    const { vp, fireResize } = makeFakeVp(852);
    installViewportHeightTracker(vp);
    fireResize(620); // keyboard opens — viewport shrinks
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("620px");
    fireResize(852); // keyboard dismisses — viewport restores
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");
  });

  it("updates --vv-offset-top on vv.scroll (iOS layout-viewport shift)", () => {
    const { vp, fireScroll } = makeFakeVp(852, 0);
    installViewportHeightTracker(vp);
    fireScroll(120); // iOS scrolls layout viewport up on focus
    expect(document.documentElement.style.getPropertyValue("--vv-offset-top")).toBe("120px");
    fireScroll(0); // keyboard dismisses — layout viewport restores
    expect(document.documentElement.style.getPropertyValue("--vv-offset-top")).toBe("0px");
  });

  it("is a no-op when the viewport argument is undefined", () => {
    installViewportHeightTracker(undefined);
    // CSS vars stay unset; .shell-mobile falls back to 100dvh + 0px translateY.
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("");
    expect(document.documentElement.style.getPropertyValue("--vv-offset-top")).toBe("");
  });

  it("subscribes to both resize and scroll events", () => {
    const addEventListener = vi.fn();
    const vp: VisualViewportLike = { height: 800, offsetTop: 0, addEventListener };
    installViewportHeightTracker(vp);
    expect(addEventListener).toHaveBeenCalledTimes(2);
    expect(addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
    expect(addEventListener).toHaveBeenCalledWith("scroll", expect.any(Function));
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
