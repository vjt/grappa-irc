import { describe, expect, it } from "vitest";
import { ruleBody, themeCss } from "./helpers/themeCss";

// #913 — the rail actions menu opened INTO the iOS safe area: the topmost row
// (home) rendered behind the status bar, and the menu did not scroll.
//
// Residue of #588, not a regression of it. #588 replaced a CSS cap of the WHOLE
// viewport with a JS cap of the space above the launcher, which is correct in
// principle but measures from the wrong origin: `getBoundingClientRect().top`
// is relative to the LAYOUT viewport, and under `viewport-fit=cover` that
// origin is the PHYSICAL top edge of the display, underneath the status bar.
// The 8px `RAIL_MENU_TOP_GAP` is breathing room, not a ~59px status-bar
// allowance.
//
// The inset is subtracted HERE, in CSS, and not in RailActions.tsx: `env()` is
// substituted by the engine at computed-value time, but reading it back out of
// an unregistered custom property with `getComputedStyle().getPropertyValue()`
// is not guaranteed to yield a length — it can hand back the literal token
// stream, which `parseFloat` turns into NaN and a `|| 0` fallback silently
// swallows, leaving the bug in place while looking fixed. Every other inset in
// this stylesheet is a plain CSS `env()` for the same reason; this one joins
// them. JS supplies only what CSS cannot know — the anchor's viewport offset,
// as `--rail-menu-space-above` (see RailActions.test.tsx for that half).
//
// SOURCE-LEVEL guards. Playwright does not synthesize `env(safe-area-inset-*)`
// (they resolve to 0), and jsdom resolves neither `env()` nor `calc()`, so the
// on-device geometry is not observable in any gate we run — the `:root`
// indirection exists partly so a browser test CAN stub a non-zero inset. The
// felt behaviour still needs a real notched device.

describe("#913 rail actions menu safe-area cap", () => {
  it(":root exposes the top inset as a custom property with a 0px fallback", () => {
    // The indirection is what makes the inset overridable by a test and keeps
    // `env()` resolution in the engine. The `0px` fallback matters on its own:
    // a bare `env(safe-area-inset-top)` on an engine that does not know the
    // variable makes the whole declaration invalid, which would drop the cap
    // entirely and bring the #588 overflow back on non-iOS browsers.
    expect(ruleBody(":root")).toMatch(/--safe-area-inset-top:\s*env\(safe-area-inset-top,\s*0px\)/);
  });

  it(".rail-actions-menu subtracts the inset from the JS-measured space above", () => {
    const body = ruleBody(".rail-actions-menu");
    expect(body).toMatch(/max-height:[^;]*var\(--rail-menu-space-above/);
    expect(body).toMatch(/max-height:[^;]*var\(--safe-area-inset-top,\s*0px\)/);
  });

  it("the cap is clamped at zero and keeps its pre-measure fallback", () => {
    const body = ruleBody(".rail-actions-menu");
    // Subtracting the inset can drive the result negative on a short viewport.
    // A negative max-height is out of range; clamp explicitly rather than lean
    // on used-value clamping, per the #588 note that an ignored cap returns the
    // overflow bug.
    expect(body).toMatch(/max-height:\s*max\(\s*0px\s*,/);
    // Until the effect measures (menu closed, or the frame before open), the
    // custom property is unset and the cap falls back to the viewport height —
    // the #588 pre-measure fallback, now nested in the same expression instead
    // of a second declaration that could drift from it.
    expect(body).toMatch(/var\(--rail-menu-space-above,\s*var\(--viewport-height,\s*80vh\)\)/);
  });

  it(".rail-actions-menu carries the overlay-scroller touch-action carve-out", () => {
    // The menu is an overlay scroller living inside the `touch-action: none`
    // blanket (`.shell-mobile`, and `html.overlay-open #root > div` while the
    // rail lock is held). Every sibling scroller in this stylesheet —
    // `.members-pane`, `.settings-drawer`, `.archive-modal` — re-asserts
    // `pan-y` on the scroller AND on its descendants, because touch-action does
    // not inherit and iOS elects the gesture consumer from the hit-test
    // target's own value (UX-6 bucket A v2). The action rows ARE the hit-test
    // targets here. Without the carve-out, shrinking the cap makes the menu
    // overflow but the pan can still be refused — the same symptom, a second
    // cause.
    expect(ruleBody(".rail-actions-menu")).toMatch(/touch-action:\s*pan-y/);
    expect(themeCss).toMatch(/\.rail-actions-menu \*\s*\{[^}]*touch-action:\s*pan-y/);
  });
});
