import { describe, expect, it } from "vitest";
import { computeMenuPosition, placeAxis, spaceAbove } from "./menuPosition";

// #487 — the member-list right-click context menu must stay inside the
// viewport. The positioning math is a PURE fn so the arithmetic is
// unit-testable without a real viewport (jsdom's getBoundingClientRect
// returns 0-sized rects — a jsdom placement test would be hollow). The
// real-viewport proof lives in the Playwright e2e
// (issue487-context-menu-viewport-clamp.spec.ts); these tests pin the
// flip/clamp arithmetic.
//
// placeAxis is the 1D primitive applied independently to X and Y, over a
// half-open interval [start, end) rather than [0, viewport):
//   * fits after the click         → keep the click coord (open down/right)
//   * overflows the far edge        → FLIP before the click (open up/left,
//                                     pointer stays on the menu edge)
//   * flip would underflow `start`  → CLAMP to the last fully-visible coord
//   * menu bigger than the interval → pin to `start` (CSS max-height + scroll)
//
// #949 — the interval used to be hardcoded to [0, viewport). Zero is the
// LAYOUT viewport origin, which under `viewport-fit=cover` (index.html) is the
// physical top of the display, behind the status bar; `viewport` is likewise
// the physical bottom, behind the home indicator. Both pins addressed occluded
// coordinates. The bounds are now supplied by the caller, which reads them off
// a fixed `inset: env(safe-area-inset-*)` frame — see ContextMenu.tsx.

describe("placeAxis (1D flip/clamp primitive)", () => {
  it("keeps the click coord when the menu fits after it", () => {
    expect(placeAxis(100, 120, 0, 1000)).toBe(100);
  });

  it("flips before the click point when the menu overflows the far edge", () => {
    // click 950, menu 120, end 1000 → 1070 > 1000 → flip: 950 - 120
    expect(placeAxis(950, 120, 0, 1000)).toBe(830);
  });

  it("keeps a click that lands exactly at the far edge", () => {
    // click 880, menu 120, end 1000 → 880 + 120 == 1000 → fits, no flip
    expect(placeAxis(880, 120, 0, 1000)).toBe(880);
  });

  it("clamps to fully-visible when a flip would underflow the interval start", () => {
    // click 100, menu 180, [0,200) → overflow (280>200) AND menu fits
    // (180<200); flip 100-180=-80 < 0 → clamp to end-size = 20
    expect(placeAxis(100, 180, 0, 200)).toBe(20);
  });

  it("pins to the interval start when the menu is bigger than the interval", () => {
    expect(placeAxis(150, 300, 0, 200)).toBe(0);
    expect(placeAxis(150, 200, 0, 200)).toBe(0); // equal counts as oversized
  });

  // #949 — the four cases above with a non-zero `start` / a pulled-in `end`.
  // Every one of them used to answer with a coordinate inside an inset.

  it("pins to the safe start, not to zero, when the menu is oversized", () => {
    // The #913 defect at this door: an oversized menu pinned to y=0, which
    // under viewport-fit=cover is the physical top of the display. On a
    // notched iPhone the first row rendered behind the status bar and the
    // menu's own overflow scroll could not bring it back — the box itself
    // starts inside the occluded strip.
    expect(placeAxis(150, 900, 59, 818)).toBe(59);
  });

  it("clamps a flip against the safe start, not against zero", () => {
    // The [0,200) clamp case above, shifted into a safe [59, 259): click 100,
    // menu 180 → 280 > 259 → flip to -80, which is below the safe START, so we
    // clamp. The last FULLY VISIBLE origin is end-size = 79, not 20.
    expect(placeAxis(100, 180, 59, 259)).toBe(79);
  });

  it("flips against the safe end, not against the physical bottom", () => {
    // click 800, menu 120, safe [59, 818): 800+120=920 > 818 → flip to 680.
    // Against the physical bottom (852) it would have "fitted" at 800 and the
    // tail would have run under the home indicator.
    expect(placeAxis(800, 120, 59, 818)).toBe(680);
  });

  it("never returns a coordinate before the safe start, even for a click inside the inset", () => {
    // A press can land inside the LEFT inset in landscape (iOS does not
    // swallow touches there the way it does under the status bar), and the
    // menu would then open from a column the display corner is eating.
    expect(placeAxis(10, 120, 59, 818)).toBe(59);
  });
});

describe("computeMenuPosition (both axes)", () => {
  // A safe area equal to the full viewport: what every non-notched browser and
  // every engine in the Playwright suite reports (env(safe-area-inset-*) → 0).
  // Keeping the pre-#949 expectations under this shape is the point — the fix
  // must be a NO-OP where there is no inset.
  const noInset = (width: number, height: number) => ({
    top: 0,
    right: width,
    bottom: height,
    left: 0,
  });

  it("passes through when the menu fits below-and-right of the click", () => {
    expect(
      computeMenuPosition({
        clickX: 100,
        clickY: 200,
        menuWidth: 120,
        menuHeight: 200,
        viewportWidth: 1280,
        viewportHeight: 720,
        safeArea: noInset(1280, 720),
      }),
    ).toEqual({ left: 100, top: 200 });
  });

  it("flips up when the menu would overflow the bottom (the #487 report)", () => {
    const p = computeMenuPosition({
      clickX: 100,
      clickY: 700,
      menuWidth: 120,
      menuHeight: 200,
      viewportWidth: 1280,
      viewportHeight: 720,
      safeArea: noInset(1280, 720),
    });
    expect(p.top).toBe(500); // 700 - 200
    expect(p.left).toBe(100); // X fits — unchanged
  });

  it("flips left when the menu would overflow the right edge (members rail)", () => {
    const p = computeMenuPosition({
      clickX: 1270,
      clickY: 100,
      menuWidth: 120,
      menuHeight: 200,
      viewportWidth: 1280,
      viewportHeight: 720,
      safeArea: noInset(1280, 720),
    });
    expect(p.left).toBe(1150); // 1270 - 120
    expect(p.top).toBe(100);
  });

  it("flips both axes for a bottom-right corner click", () => {
    expect(
      computeMenuPosition({
        clickX: 1276,
        clickY: 716,
        menuWidth: 120,
        menuHeight: 200,
        viewportWidth: 1280,
        viewportHeight: 720,
        safeArea: noInset(1280, 720),
      }),
    ).toEqual({ left: 1156, top: 516 });
  });

  it("pins to the top when the menu is taller than a short viewport", () => {
    // mobile keyboard up → --viewport-height ~180, menu ~200 → top 0 + scroll
    const p = computeMenuPosition({
      clickX: 100,
      clickY: 150,
      menuWidth: 120,
      menuHeight: 200,
      viewportWidth: 390,
      viewportHeight: 180,
      safeArea: noInset(390, 180),
    });
    expect(p.top).toBe(0);
  });

  // #949 — a portrait iPhone 15 under viewport-fit=cover: 393×852 layout
  // viewport, 59px status-bar inset at the top, 34px home-indicator inset at
  // the bottom. The safe box is therefore [59, 818) on Y and [0, 393) on X.
  const iphone15Portrait = { top: 59, right: 393, bottom: 818, left: 0 };

  it("keeps an oversized menu clear of the status bar instead of pinning to y=0", () => {
    const p = computeMenuPosition({
      clickX: 100,
      clickY: 400,
      menuWidth: 200,
      menuHeight: 900,
      viewportWidth: 393,
      viewportHeight: 852,
      safeArea: iphone15Portrait,
    });
    expect(p.top).toBe(59);
  });

  it("keeps a bottom-edge flip clear of the home indicator", () => {
    // Against the physical bottom (852) the menu "fits" at y=800 and its tail
    // runs into the home-indicator strip. Against the safe bottom (818) it
    // flips to 800-120=680.
    const p = computeMenuPosition({
      clickX: 100,
      clickY: 800,
      menuWidth: 200,
      menuHeight: 120,
      viewportWidth: 393,
      viewportHeight: 852,
      safeArea: iphone15Portrait,
    });
    expect(p.top).toBe(680);
  });

  it("respects the side insets in landscape, where the notch eats a column", () => {
    // Landscape iPhone: 852×393, notch on the leading edge → 59px left inset,
    // 59px right inset, 21px bottom. Safe box: X [59, 793), Y [0, 372).
    const p = computeMenuPosition({
      clickX: 700,
      clickY: 100,
      menuWidth: 200,
      menuHeight: 120,
      viewportWidth: 852,
      viewportHeight: 393,
      safeArea: { top: 0, right: 793, bottom: 372, left: 59 },
    });
    // 700 + 200 = 900 > 793 → flip to 500. Against the physical width (852)
    // it would have "fitted" at 700 and run under the rounded corner.
    expect(p.left).toBe(500);
  });

  // The keyboard-up case is where the VISUAL viewport and the safe-area frame
  // disagree, and the placement has to take whichever bound is tighter. The
  // frame is laid out against the LAYOUT viewport, which iOS does NOT shrink
  // for the on-screen keyboard; `viewportHeight` (visualViewport.height) is
  // what shrinks. Both are measured from the same origin, so they compose as a
  // plain min/max — see the note in computeMenuPosition.
  it("takes the visual viewport's bottom when the keyboard has pulled it above the safe bottom", () => {
    const p = computeMenuPosition({
      clickX: 100,
      clickY: 400,
      menuWidth: 200,
      menuHeight: 120,
      viewportWidth: 393,
      viewportHeight: 516, // keyboard up: 852 - ~336
      safeArea: iphone15Portrait, // bottom still 818, the keyboard is not an inset
    });
    // 400 + 120 = 520 > 516 → flip to 280. Trusting the 818 safe bottom would
    // have left the menu under the keyboard — the #487 symptom.
    expect(p.top).toBe(280);
  });

  it("keeps the safe TOP even when the visual viewport is the tighter bottom", () => {
    // Both bounds bite at once: the keyboard caps the bottom at 516 and the
    // status bar the top at 59, and a 600px menu fits neither.
    const p = computeMenuPosition({
      clickX: 100,
      clickY: 300,
      menuWidth: 200,
      menuHeight: 600,
      viewportWidth: 393,
      viewportHeight: 516,
      safeArea: iphone15Portrait,
    });
    expect(p.top).toBe(59);
  });
});

// #588 — the rail actions menu opens UPWARD from a launcher pinned at the
// bottom of the rail (`.rail-actions-menu { bottom: 100% }`). Its usable
// height is NOT the whole viewport — it is only the space ABOVE the anchor
// (the `.rail-actions` container top). Capping `max-height` at that space is
// what makes the already-present `overflow-y: auto` engage instead of the
// menu growing off the top of the screen (the #588 defect). `spaceAbove` is
// that one-number cap: px available above `anchorTop`, minus a top gap for
// breathing room, clamped at 0 so a launcher near y=0 never yields a NEGATIVE
// max-height (invalid CSS → ignored → the bug returns). Pure fn, same
// jsdom-hollow reasoning as `placeAxis`; the visible proof is the Playwright
// e2e (issue500-rail-launcher-overflow.spec.ts short-viewport variant).
describe("spaceAbove (rail upward-menu max-height cap)", () => {
  it("returns the space above the anchor minus the top gap", () => {
    // launcher top at 500px, keep 8px clear → menu may be 492px tall.
    expect(spaceAbove(500, 8)).toBe(492);
  });

  it("clamps to 0 when the anchor sits within the gap of the top", () => {
    // launcher near y=0 (tiny viewport) → 4 - 8 = -4 must NOT be negative.
    expect(spaceAbove(4, 8)).toBe(0);
  });

  it("returns 0 when the anchor is exactly one gap below the top", () => {
    expect(spaceAbove(8, 8)).toBe(0);
  });

  it("returns 0 for an anchor flush with the viewport top", () => {
    expect(spaceAbove(0, 8)).toBe(0);
  });
});
