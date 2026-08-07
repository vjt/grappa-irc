import { describe, expect, it } from "vitest";
import { ruleBody, themeCss } from "./helpers/themeCss";

// #985 — the non-channel mobile band. `.shell-chrome` was a full-width
// `<header>` in `.shell-main`'s flex column holding one right-aligned ☰ and
// nothing else, priced at `var(--chrome-tap-min) + 1rem + 1px` and SCALING with
// the operator's text size. It cost that on every non-channel window, in the
// state where vertical space is scarcest (keyboard up). #986 emptied it of its
// second glyph (`@` moved to the rail), so what is left is a band around a
// single button.
//
// These are SOURCE-level guards, the same shape as `railMenuSafeArea.test.ts`
// and for the same reason: jsdom has no layout engine, so the rendered
// geometry is not observable in any gate that runs locally. The rendered
// outcome — scrollback starting at the top of the pane, opener still tappable
// — is pinned in `e2e/tests/issue985-mobile-floating-opener.spec.ts`.

describe("#985 the chrome band is out of flow", () => {
  it("`.shell-chrome` costs zero height and no longer paints a band", () => {
    const body = ruleBody(".shell-chrome");
    // The whole point: the row is still in the DOM (every non-channel window
    // needs its opener) but takes no vertical space from the scrollback.
    expect(body).toMatch(/height:\s*0\b/);
    // The three declarations that MADE it a band. `padding: 0.5rem 1rem` is the
    // one that priced it; with `box-sizing: border-box` a surviving padding
    // would floor the border box above the `height: 0` and quietly give some of
    // the band back.
    expect(body).not.toMatch(/border-bottom:/);
    expect(body).not.toMatch(/padding:\s*0\.5rem/);
    expect(body).not.toMatch(/background:/);
  });

  it("the opener anchors to `.shell-chrome` itself, not to `.shell-main`", () => {
    // Deliberate: making `.shell-main` the containing block would re-anchor
    // every `position: absolute` descendant that currently resolves past it.
    // A zero-height positioned row is the containing block with no blast
    // radius — so `.shell-main` must stay unpositioned.
    expect(ruleBody(".shell-chrome")).toMatch(/position:\s*relative/);
    // `.shell-mobile .shell-main` lives inside the ≤768px @media block, so it
    // is indented and `ruleBody` (top-level rules only) cannot reach it.
    const mobileMain = /\.shell-mobile \.shell-main\s*\{([^}]*)\}/.exec(themeCss)?.[1];
    expect(mobileMain).toBeDefined();
    expect(mobileMain).not.toMatch(/position:/);
  });

  it("the floated opener paints above the in-pane scrollback floats", () => {
    // It overflows a zero-height box, so its later-in-DOM siblings (the
    // scrollback, its pinned overlay, the float stack) would paint over it
    // without an explicit stacking order. 40 is the tallest in-pane float
    // (the next-active circle); 89/90 is the members drawer, which must stay
    // ON TOP of the opener that opens it.
    const z = /z-index:\s*(\d+)/.exec(ruleBody(".shell-chrome"))?.[1];
    expect(z).toBeDefined();
    expect(Number(z)).toBeGreaterThan(40);
    expect(Number(z)).toBeLessThan(89);
  });

  it("the floated opener brings its own opaque backing", () => {
    // `.shell-chrome-btn` declares `background: transparent`, which was fine
    // while the band supplied the surface behind the glyph. Floating puts it
    // over arbitrary scrollback text AND over a themed background image
    // (`:root.theme-has-bg .scrollback-pane::before`), so it needs its own.
    expect(themeCss).toMatch(
      /\.shell-chrome \.shell-chrome-rail-opener\s*\{[^}]*background:\s*var\(--bg\)/,
    );
  });

  it("no safe-area inset is re-applied at the float", () => {
    // `.shell-mobile` already carries `padding-top: env(safe-area-inset-top)`
    // (UX-3 BIS), and `.shell-main` sits inside that padding box — so the
    // pane's top edge is ALREADY below the island. Adding the inset again here
    // would double-count it: the #913 trap, pointed the other way.
    expect(ruleBody(".shell-chrome")).not.toMatch(/safe-area-inset-top/);
    expect(themeCss).not.toMatch(
      /\.shell-chrome \.shell-chrome-rail-opener\s*\{[^}]*safe-area-inset-top/,
    );
  });

  it("the flex spacer is gone with the band that needed it", () => {
    // `justify-content: flex-end` on a shrink-wrapped float does the job the
    // `flex: 1` spacer did inside a full-width row. Dead code, deleted.
    expect(() => ruleBody(".shell-chrome-spacer")).toThrow();
    expect(themeCss).not.toMatch(/shell-chrome-spacer/);
  });
});
