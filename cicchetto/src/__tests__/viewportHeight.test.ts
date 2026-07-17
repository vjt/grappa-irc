import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installSmartScrollPin,
  installViewportHeightTracker,
  type VisualViewportLike,
} from "../lib/viewportHeight";

// UX-6 D9 — single helper, two CSS vars (--viewport-height legacy +
// --vh Telegram pattern). Unit coverage proves both vars write on
// boot AND on every resize event. Real keyboard behaviour is verified
// by vjt on iPhone (Playwright doesn't emulate the OS keyboard);
// these tests are the mechanical contract.

function makeFakeVp(initialHeight: number): {
  vp: VisualViewportLike;
  fireResize: (h: number) => void;
  setHeight: (h: number) => void;
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
    // Change the reported height WITHOUT dispatching a resize event — the
    // #285-reopen "silent settle" an installed iOS PWA emits no `resize` for.
    setHeight: (h: number) => {
      height = h;
    },
  };
}

describe("viewportHeight module", () => {
  beforeEach(() => {
    // Fake timers so the boot settle re-read schedule (#285 reopen) never
    // leaks a deferred CSS-var write across tests; tests that don't advance
    // are unaffected (the synchronous boot write happens before any timer).
    vi.useFakeTimers();
    document.documentElement.style.removeProperty("--viewport-height");
    document.documentElement.style.removeProperty("--vh");
  });

  afterEach(() => {
    vi.useRealTimers();
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

  it("re-reads the settled viewport height on a post-boot timer, WITHOUT a resize event (#285 reopen)", () => {
    // The reported P0 mechanism: on a cold iOS-PWA kill+relaunch the boot read
    // latches an INFLATED height (pre-settle), and the corrective settle fires
    // NO `resize` event — so the one-shot boot write is never re-read and the
    // scroll container bakes to the inflated height forever. The reopen fix
    // re-reads visualViewport.height on a short post-boot timer schedule,
    // event-independently, so the settled (smaller) height overwrites the
    // inflated boot value even when no resize ever fires.
    const { vp, setHeight } = makeFakeVp(852); // boot reads the inflated full-screen height
    installViewportHeightTracker(vp);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");

    // Silent settle: the real usable height is 762 (safe-area/chrome settled),
    // but iOS emits NO resize event, so the resize handler never runs.
    setHeight(762);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("852px");

    // The boot settle re-read fires on its timer and corrects the var — with no
    // resize event in play.
    vi.advanceTimersByTime(2000);
    expect(document.documentElement.style.getPropertyValue("--viewport-height")).toBe("762px");
    expect(document.documentElement.style.getPropertyValue("--vh")).toBe("7.62px");
  });

  it("subscribes to the resize event only (D9 dropped vv.scroll — vvOffsetTop unreliable per WebKit #297779)", () => {
    const addEventListener = vi.fn();
    const vp: VisualViewportLike = { height: 800, addEventListener };
    installViewportHeightTracker(vp);
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener).toHaveBeenCalledWith("resize", expect.any(Function));
  });
});

describe("installSmartScrollPin (UX-6 D10)", () => {
  type Handlers = {
    scroll?: () => void;
    touchstart?: () => void;
    touchend?: () => void;
    touchcancel?: () => void;
  };

  function makeFakes(scrollY: number): {
    win: Window;
    doc: Document;
    scrollTo: ReturnType<typeof vi.fn>;
    fireScroll: () => void;
    fireTouchStart: () => void;
    fireTouchEnd: () => void;
  } {
    const scrollTo = vi.fn();
    const winHandlers: Handlers = {};
    const docHandlers: Handlers = {};
    const win = {
      scrollX: 0,
      scrollY,
      scrollTo,
      addEventListener(event: string, h: () => void) {
        if (event === "scroll") winHandlers.scroll = h;
      },
    } as unknown as Window;
    const doc = {
      addEventListener(event: string, h: () => void) {
        if (event === "touchstart") docHandlers.touchstart = h;
        if (event === "touchend") docHandlers.touchend = h;
        if (event === "touchcancel") docHandlers.touchcancel = h;
      },
    } as unknown as Document;
    return {
      win,
      doc,
      scrollTo,
      fireScroll: () => winHandlers.scroll?.(),
      fireTouchStart: () => docHandlers.touchstart?.(),
      fireTouchEnd: () => docHandlers.touchend?.(),
    };
  }

  it("snaps window back to (0, 0) when scroll fires with no touch active", () => {
    const { win, doc, scrollTo, fireScroll } = makeFakes(100);
    installSmartScrollPin(win, doc);
    fireScroll();
    expect(scrollTo).toHaveBeenCalledWith(0, 0);
  });

  it("does NOT snap when touch is in flight", () => {
    const { win, doc, scrollTo, fireScroll, fireTouchStart } = makeFakes(100);
    installSmartScrollPin(win, doc);
    fireTouchStart();
    fireScroll();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does NOT snap within 50ms grace after touchend (catches momentum)", () => {
    const { win, doc, scrollTo, fireScroll, fireTouchStart, fireTouchEnd } = makeFakes(100);
    installSmartScrollPin(win, doc);
    fireTouchStart();
    fireTouchEnd();
    // performance.now() advances by sub-ms; grace window applies immediately
    fireScroll();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("does NOT call scrollTo when already at (0, 0)", () => {
    const { win, doc, scrollTo, fireScroll } = makeFakes(0);
    installSmartScrollPin(win, doc);
    fireScroll();
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("is a no-op when target is undefined", () => {
    expect(() => installSmartScrollPin(undefined)).not.toThrow();
  });
});
