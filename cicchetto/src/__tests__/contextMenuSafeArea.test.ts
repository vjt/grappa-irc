import { describe, expect, it } from "vitest";
import { ruleBody, themeCss } from "./helpers/themeCss";

// #949 — the context menu carried #913's defect at a second door. #913 fixed
// `.rail-actions-menu`, whose cap measured the space above the launcher from
// `getBoundingClientRect().top`: under `viewport-fit=cover` that origin is the
// PHYSICAL top of the display, behind the status bar. `d129bfb0` recorded that
// the `placeAxis` / context-menu clamp had the same origin bug "on both edges"
// and wanted its own issue. This is the stylesheet half of it.
//
// Two rules carry the fix and they answer different questions:
//   * `.context-menu-safe-area` is a RULER — a fixed, unpainted box inset by
//     all four `env(safe-area-inset-*)` values, whose `getBoundingClientRect()`
//     hands the placement math the safe box as resolved lengths. It exists
//     because #913 established JS must not read the inset out of a custom
//     property: `getComputedStyle().getPropertyValue()` on an unregistered one
//     can return the token stream, and the resulting NaN is swallowed by any
//     `|| 0` into a no-op that looks like a fix. A rect cannot be a token
//     stream.
//   * `.context-menu`'s `max-height` is the SIZE cap, and it stays in CSS
//     because the placement effect measures the menu's rendered height — a cap
//     applied inline after that measurement would position a box against a
//     height it no longer has.
//
// SOURCE-LEVEL guards, for the reason #913 and #205 already record: Playwright
// resolves `env(safe-area-inset-*)` to 0 on every engine in the suite and jsdom
// resolves neither `env()` nor `calc()`, so no gate we run can observe the
// on-device geometry. The wiring is pinned in ContextMenu.test.tsx and the
// arithmetic in lib/menuPosition.test.ts; the FELT result on a notched iPhone
// is confirmable only by dogfood.

describe("#949 context menu safe-area clamp", () => {
  it(":root exposes the bottom inset alongside #913's top one", () => {
    // The height cap subtracts BOTH vertical insets, and the `0px` fallback is
    // load-bearing on each: without it an engine that does not know the
    // variable invalidates the whole declaration, dropping the cap entirely —
    // which is the uncapped #487 overflow, back.
    expect(ruleBody(":root")).toMatch(/--safe-area-inset-top:\s*env\(safe-area-inset-top,\s*0px\)/);
    expect(ruleBody(":root")).toMatch(
      /--safe-area-inset-bottom:\s*env\(safe-area-inset-bottom,\s*0px\)/,
    );
  });

  it("the ruler is fixed, so its rect shares the menu's coordinate space", () => {
    // `position: fixed` is what makes the rect comparable to the press
    // coordinates and to the menu's own fixed box. An absolutely-positioned
    // ruler would report its offset parent's frame and quietly mis-place
    // everything by that parent's origin.
    expect(ruleBody(".context-menu-safe-area")).toMatch(/position:\s*fixed/);
  });

  it("the ruler is inset by all four safe-area values, each with a 0px fallback", () => {
    // Asserted per-edge rather than against the `inset:` shorthand as written:
    // a longhand rewrite must keep passing, and a DROPPED edge must fail. The
    // bottom and the two sides are not decoration — the bottom is the home
    // indicator, and in landscape the sides are the notch and the rounded
    // corners, which is the other half of `d129bfb0`'s "both edges".
    const body = ruleBody(".context-menu-safe-area");
    for (const edge of ["top", "right", "bottom", "left"]) {
      expect(body).toMatch(new RegExp(`env\\(safe-area-inset-${edge},\\s*0px\\)`));
    }
  });

  it("the ruler cannot be touched, so it never eats the backdrop's click-outside", () => {
    // It is a sibling of `.context-menu-backdrop` inside the same portal and
    // covers nearly the same area. Without this it would swallow the press
    // that is supposed to close the menu.
    expect(ruleBody(".context-menu-safe-area")).toMatch(/pointer-events:\s*none/);
  });

  it("the ruler is declared once, so the measured box is the one written here", () => {
    // The rect is read from live layout, so ANY second rule reaching this class
    // silently redefines what the placement math measures.
    expect(themeCss.match(/\.context-menu-safe-area/g)?.length).toBe(1);
  });

  it(".context-menu caps its height against the viewport MINUS both vertical insets", () => {
    const body = ruleBody(".context-menu");
    expect(body).toMatch(/max-height:[^;]*var\(--viewport-height,\s*100vh\)/);
    expect(body).toMatch(/max-height:[^;]*var\(--safe-area-inset-top,\s*0px\)/);
    expect(body).toMatch(/max-height:[^;]*var\(--safe-area-inset-bottom,\s*0px\)/);
  });

  it("the cap is clamped at zero, because a negative max-height is no cap at all", () => {
    // Subtracting two insets from a keyboard-shrunk `--viewport-height` can go
    // negative. An out-of-range max-height is an ignored declaration, and an
    // ignored cap is the #487 overflow — the same trap #588/#913 hit.
    expect(ruleBody(".context-menu")).toMatch(/max-height:\s*max\(\s*0px\s*,/);
  });

  it("the menu still scrolls whatever the cap leaves over", () => {
    // The cap only relocates the overflow; `overflow-y: auto` is what makes the
    // hidden rows reachable. Capping without it reproduces #487's unclickable
    // tail with extra steps.
    expect(ruleBody(".context-menu")).toMatch(/overflow-y:\s*auto/);
  });
});
