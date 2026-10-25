// issue 2465 — a REAL one-finger drag on a scroller (the scrollback, the compose
// textarea), and the browser's own reading of it. Shared by the edge-swipe
// specs (#308, #1041) for their hard constraint — "a vertical drag is never
// hijacked" — and by issue 2465's own.
//
// Why a real drag and not a dispatched TouchEvent. Since issue 2465 the Shell
// holds a document `touchmove` guard for its whole life that cancels any move
// nothing under the finger can scroll, because on iOS with the keyboard up a
// move left to the browser on such a surface pans the WHOLE shell. A dispatched
// event lands on whatever element the spec names, so a spec that named the
// shell root measured "the browser keeps the drag" on a surface that cannot
// scroll — which is that very pan. Here chromium HIT-TESTS the finger and
// drives its own scroll, so the assertion becomes the one the constraint was
// always about: the pane really scrolled, and nothing cancelled the move.
//
// Chromium only: Playwright's WebKit backend has no touch-drag verb, and its
// scroll is not iOS's either (feedback_playwright_webkit_not_ios_scroll). The
// caller's context needs `hasTouch`.

import type { Page } from "@playwright/test";

export type Pt = { x: number; y: number };

export type ScrollerDrag = {
  // Pre-state, read before the first touch: the finger lands inside the
  // scroller, and the scroller really overflows. Without both, "it scrolled"
  // and "nothing cancelled it" mean nothing.
  landsOnScroller: boolean;
  overflowPx: number;
  scrollTopBefore: number;
  // What the window saw: every touchmove that reached it, and whether any was
  // cancelled. A window listener runs after every document one, the guard's
  // included, so it reads the final verdict — but only of the moves that were
  // still CANCELABLE: once chromium starts scrolling, later moves arrive
  // non-cancelable and the guard leaves them alone. The scrollTop delta is
  // what carries "the browser kept it"; this field says nobody tried to stop
  // it while it still could be stopped.
  moves: number;
  prevented: boolean;
  // Read once the drag (and any fling) has had its frames.
  scrollTopAfter: number;
};

type Probe = { moves: number; prevented: boolean };

const SCROLLBACK = '[data-testid="scrollback"]';

// Drag one finger through `pts` (start, moves, end) on chromium's real input
// pipeline, with a frame between moves so the engine scrolls as it would under
// a finger, and read the scroller matched by `selector` around it.
export async function dragScroller(page: Page, selector: string, pts: Pt[]): Promise<ScrollerDrag> {
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (!first || !last || pts.length < 3) throw new Error("need a start, a move and an end");

  const pre = await page.evaluate(
    ({ sel, start }) => {
      const sc = document.querySelector<HTMLElement>(sel);
      if (sc === null) throw new Error(`${sel} not found`);
      const w = window as unknown as { __shellTouchProbe?: Probe; __shellTouchBound?: true };
      // Reset per drag; the listener itself is bound once per page, or a second
      // drag would count every move twice.
      w.__shellTouchProbe = { moves: 0, prevented: false };
      // …and the settle wait below starts with no memory of an earlier drag.
      (window as unknown as { __lastTop?: number }).__lastTop = undefined;
      if (w.__shellTouchBound === undefined) {
        w.__shellTouchBound = true;
        window.addEventListener("touchmove", (e) => {
          const probe = w.__shellTouchProbe;
          if (probe === undefined) return;
          probe.moves += 1;
          if (e.defaultPrevented) probe.prevented = true;
        });
      }
      const hit = document.elementFromPoint(start.x, start.y);
      return {
        landsOnScroller: hit !== null && sc.contains(hit),
        overflowPx: sc.scrollHeight - sc.clientHeight,
        scrollTopBefore: sc.scrollTop,
      };
    },
    { sel: selector, start: first },
  );

  const cdp = await page.context().newCDPSession(page);
  const point = (p: Pt) => [{ x: p.x, y: p.y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(first) });
  for (const p of pts.slice(1, -1)) {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(p) });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(last) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();

  // Settled when two reads a frame apart agree: a fling may still be moving it.
  await page.waitForFunction(
    (sel) => {
      const sc = document.querySelector<HTMLElement>(sel);
      if (sc === null) return false;
      const w = window as unknown as { __lastTop?: number };
      const settled = w.__lastTop === sc.scrollTop;
      w.__lastTop = sc.scrollTop;
      return settled;
    },
    selector,
    { polling: 100 },
  );

  const post = await page.evaluate((sel) => {
    const sc = document.querySelector<HTMLElement>(sel);
    const w = window as unknown as { __shellTouchProbe?: Probe };
    return {
      probe: w.__shellTouchProbe ?? { moves: 0, prevented: false },
      top: sc?.scrollTop ?? -1,
    };
  }, selector);

  return {
    ...pre,
    moves: post.probe.moves,
    prevented: post.probe.prevented,
    scrollTopAfter: post.top,
  };
}

export async function dragScrollback(page: Page, pts: Pt[]): Promise<ScrollerDrag> {
  return await dragScroller(page, SCROLLBACK, pts);
}

// The edge-swipe specs' (#308, #1041) DISPATCHED gesture — kept dispatched
// because what they assert of it is a JS-level fact, the directive's claim.
// Synthesize a touch gesture on the element under pts[0] — what a finger there
// would hit — and let it bubble to `.shell-mobile`, where the edge directive
// listens: touchstart at pts[0], a touchmove per interior point, touchend at
// the last. Returns whether ANY touchmove was preventDefaulted — dispatchEvent
// returns false iff a listener called preventDefault (the claim signal, read
// exactly as issue123 does).
//
// issue 2465 — the target used to be `.shell-mobile` itself. Since then the
// Shell's document guard cancels a move nothing under the finger can scroll,
// and the shell root scrolls nothing, so that target made every move read as
// claimed. Over the (seeded, overflowing) scrollback the guard stands aside
// and `prevented` is the directive's claim again, nobody else's.
export async function synthEdgeGesture(page: Page, pts: Pt[]): Promise<{ prevented: boolean }> {
  return await page.evaluate((points) => {
    const first = points[0];
    const last = points[points.length - 1];
    if (!first || !last) throw new Error("need at least a start and an end point");
    const hit = document.elementFromPoint(first.x, first.y);
    const root = document.querySelector(".shell-mobile");
    if (!(hit instanceof HTMLElement) || !root?.contains(hit)) {
      throw new Error("the start point does not land inside .shell-mobile");
    }
    const mk = (p: { x: number; y: number }) =>
      new Touch({ identifier: 1, target: hit, clientX: p.x, clientY: p.y });
    const fire = (type: "touchstart" | "touchmove" | "touchend", p: { x: number; y: number }) => {
      const t = mk(p);
      const active = type === "touchend" ? [] : [t];
      return hit.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: active,
          targetTouches: active,
          changedTouches: [t],
        }),
      );
    };
    fire("touchstart", first);
    let prevented = false;
    for (let i = 1; i < points.length - 1; i++) {
      const p = points[i];
      if (p && !fire("touchmove", p)) prevented = true;
    }
    fire("touchend", last);
    return { prevented };
  }, pts);
}
