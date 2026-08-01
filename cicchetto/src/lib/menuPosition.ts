// #487 — right-click context-menu placement math. Pure fn (no DOM) so the
// arithmetic is unit-testable without a real viewport; the component feeds it
// real measurements (getBoundingClientRect + window.innerWidth/innerHeight)
// and the real-viewport proof lives in the Playwright e2e
// (issue487-context-menu-viewport-clamp.spec.ts). jsdom returns 0-sized rects,
// so a jsdom placement test would be hollow — hence the seam.
//
// placeAxis is the 1D primitive, applied independently to X and Y:
//   * fits after the click          → keep the click coord (menu opens down/right)
//   * overflows the far edge         → FLIP before the click (menu opens up/left),
//                                      keeping the pointer on the menu edge like a
//                                      native context menu
//   * flip would underflow origin    → CLAMP to the last fully-visible coord (menu
//                                      slides off the cursor but stays whole)
//   * menu bigger than the viewport  → pin to 0 and let the CSS max-height +
//                                      overflow-y:auto scroll the overflow

export type MenuMeasurement = {
  clickX: number;
  clickY: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
};

export type MenuPlacement = { left: number; top: number };

export function placeAxis(click: number, size: number, viewport: number): number {
  if (size >= viewport) return 0;
  if (click + size <= viewport) return click;
  const flipped = click - size;
  return flipped >= 0 ? flipped : viewport - size;
}

export function computeMenuPosition(m: MenuMeasurement): MenuPlacement {
  return {
    left: placeAxis(m.clickX, m.menuWidth, m.viewportWidth),
    top: placeAxis(m.clickY, m.menuHeight, m.viewportHeight),
  };
}

// #588 — max-height cap for a menu that opens UPWARD from a bottom-pinned
// anchor (the rail actions launcher: `.rail-actions-menu { bottom: 100% }`).
// The space such a menu actually has is only what lies ABOVE the anchor —
// NOT the whole viewport, which is what the CSS `max-height:
// var(--viewport-height)` wrongly capped it at (the menu then grew off the
// top of the screen instead of scrolling). `anchorTop` is the anchor's
// distance from the viewport top (getBoundingClientRect().top); `gap` keeps
// a few px clear at the top for breathing room. Clamped at 0: an anchor near
// y=0 must never produce a NEGATIVE max-height (invalid CSS → rule ignored →
// the overflow bug returns). Sibling of `placeAxis`'s viewport-oversize
// pin — both hand the CSS `overflow-y: auto` a valid, in-viewport box.
export function spaceAbove(anchorTop: number, gap: number): number {
  return Math.max(0, anchorTop - gap);
}
