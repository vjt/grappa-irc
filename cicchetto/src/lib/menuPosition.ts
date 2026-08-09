// #487 — right-click context-menu placement math. Pure fn (no DOM) so the
// arithmetic is unit-testable without a real viewport; the component feeds it
// real measurements (getBoundingClientRect + window.innerWidth/innerHeight)
// and the real-viewport proof lives in the Playwright e2e
// (issue487-context-menu-viewport-clamp.spec.ts). jsdom returns 0-sized rects,
// so a jsdom placement test would be hollow — hence the seam.
//
// placeAxis is the 1D primitive, applied independently to X and Y, over the
// half-open interval [start, end):
//   * fits after the click          → keep the click coord (menu opens down/right)
//   * overflows the far edge         → FLIP before the click (menu opens up/left),
//                                      keeping the pointer on the menu edge like a
//                                      native context menu
//   * flip would underflow `start`   → CLAMP to the last fully-visible coord (menu
//                                      slides off the cursor but stays whole)
//   * menu bigger than the interval  → pin to `start` and let the CSS max-height +
//                                      overflow-y:auto scroll the overflow
//
// #949 — that interval used to be hardcoded [0, viewport). Under
// `viewport-fit=cover` (index.html) 0 is the PHYSICAL top of the display, so
// the oversize pin put the first row behind the status bar, and `viewport` is
// the physical bottom, so a flip could tuck the tail under the home indicator
// (in landscape, the same on X against the notch/rounded corners). Both edges
// carried the #913 defect at a different door. The interval is now the
// caller's, taken from a fixed `inset: env(safe-area-inset-*)` frame the
// engine lays out — see ContextMenu.tsx for why that frame, and not a JS read
// of `env()`, is the seam.

export type SafeArea = { top: number; right: number; bottom: number; left: number };

export type MenuMeasurement = {
  clickX: number;
  clickY: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  safeArea: SafeArea;
};

export type MenuPlacement = { left: number; top: number };

export function placeAxis(click: number, size: number, start: number, end: number): number {
  if (size >= end - start) return start;
  if (click + size <= end) return Math.max(click, start);
  const flipped = click - size;
  return flipped >= start ? flipped : end - size;
}

// The two bounds come from different places and both can bite:
//   * `safeArea` is a laid-out box, so its edges are LAYOUT-viewport
//     coordinates — it knows the notch, and does NOT know the keyboard (iOS
//     never shrinks the layout viewport for it).
//   * `viewport{Width,Height}` is the VISUAL viewport, which knows the
//     keyboard and not the notch. #487 chose it deliberately: `innerHeight`
//     stays full-screen with the keyboard up and would let the menu render
//     underneath it.
// They compose as a plain `min` because both are measured from the layout
// viewport's origin — true while `visualViewport.offsetTop/Left` are 0, which
// holds for this non-scrolling, non-zoomable app shell. A pinch-zoomed page
// would need the offsets added in; the pre-#949 code made the same assumption.
export function computeMenuPosition(m: MenuMeasurement): MenuPlacement {
  return {
    left: placeAxis(
      m.clickX,
      m.menuWidth,
      m.safeArea.left,
      Math.min(m.viewportWidth, m.safeArea.right),
    ),
    top: placeAxis(
      m.clickY,
      m.menuHeight,
      m.safeArea.top,
      Math.min(m.viewportHeight, m.safeArea.bottom),
    ),
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
//
// #913 — the return value is no longer the final max-height: `anchorTop` is
// measured from the layout viewport origin, which under `viewport-fit=cover`
// is BEHIND the status bar, so the caller publishes this as
// `--rail-menu-space-above` and the stylesheet subtracts
// `var(--safe-area-inset-top)` before capping. `gap` is breathing room only —
// it is NOT a notch allowance, and must not be grown into one.
export function spaceAbove(anchorTop: number, gap: number): number {
  return Math.max(0, anchorTop - gap);
}
