import { describe, expect, it } from "vitest";
import { focusRules, horizontalInsets, isZeroInset, nestedRuleBodies } from "./helpers/themeCss";

// #96 — keyboard focus visibility.
//
// WHAT THIS PROVES: the stylesheet never takes the focus indicator away
// without putting one back, and the surfaces #96 names carry an authored
// ring. Both are source-level invariants over `src/themes/default.css`.
//
// WHAT THIS DOES NOT PROVE — and no jsdom test can:
//   * that a ring is actually PAINTED. jsdom has no layout and nwsapi does
//     not match `:focus-visible`, so `getComputedStyle` after `.focus()`
//     returns nothing useful. Only a real browser can answer that.
//   * that the ring has sufficient CONTRAST. `--accent` is a per-theme token
//     and operators author their own themes (lib/customTheme.ts), so the
//     contrast ratio is not a property of this file at all.
//   * that the ring is not CLIPPED by an ancestor's overflow. That is
//     geometry; it needs a browser.
// The ring geometry chosen here (inset on the edge-to-edge sidebar rows,
// outset on the padded chrome buttons) is an argued choice, NOT a measured
// one. See the #96 PR body.

describe("#96 — focus indicators are never silently removed", () => {
  // The defect this catches, in its original form: BOTH of the stylesheet's
  // two `:focus-visible` rules read `{ color: var(--fg); outline: none }`.
  // They suppressed the UA ring for keyboard users and left a colour shift
  // as the only cue — an indicator with no area. A rule may still legally
  // drop the outline, but only by supplying its own indicator (the text
  // inputs do this: they swap the outline for an accent border).
  const REPLACEMENTS = ["box-shadow", "border-color"];

  // Declaration-level, not a regex over the block: a `/outline:\s*(?!none)/`
  // "does it also set a real outline?" guard backtracks its own `\s*` to zero
  // and matches `outline: none` itself, which made the first cut of this test
  // unfalsifiable — the mutation that re-suppressed a ring left it green.
  // Last write wins, as the cascade does inside one block.
  const outlineValue = (body: string): string | null => {
    let value: string | null = null;
    for (const decl of body.split(";")) {
      const colon = decl.indexOf(":");
      if (colon < 0) continue;
      if (decl.slice(0, colon).trim() !== "outline") continue;
      value = decl.slice(colon + 1).trim();
    }
    return value;
  };

  it("no focus rule suppresses the outline without supplying an indicator", () => {
    const offenders = focusRules()
      .filter(({ body }) => {
        const outline = outlineValue(body);
        return outline === "none" || outline === "0";
      })
      .filter(({ body }) => !REPLACEMENTS.some((decl) => body.includes(decl)))
      .map(({ selectors }) => selectors);

    expect(offenders).toEqual([]);
  });

  // #96's named surfaces. The sidebar is the app's primary keyboard
  // navigation surface and shipped with NO authored focus style: whatever
  // the UA happened to draw was the cue, on every theme.
  const RINGED = [
    ".sidebar-home-section li .sidebar-window-btn:focus-visible",
    ".sidebar-admin-section li .sidebar-window-btn:focus-visible",
    ".sidebar-network-section li .sidebar-window-btn:focus-visible",
    ".sidebar-network-section li .sidebar-close:focus-visible",
    ".sidebar-network-section li .sidebar-umode-indicator:focus-visible",
    ".shell-chrome-btn:focus-visible",
    ".settings-drawer-close:focus-visible",
    ".service-modal-prompt-input:focus-visible",
  ];

  it.each(RINGED)("%s declares a visible outline", (selector) => {
    const owning = focusRules().filter(({ selectors }) => selectors.includes(selector));
    expect(owning.length).toBeGreaterThan(0);
    const withRing = owning.filter(({ body }) => /^\d/.test(outlineValue(body) ?? ""));
    expect(withRing.length).toBeGreaterThan(0);
  });
});

// issue 2375 — the `>` prompt's ring above is drawn INSET (`outline-offset:
// -2px`, so the row's own frame can't clip it), which means it occupies the
// input's innermost 2px. With `padding: 0.25rem 0` the caret and the first
// glyph sat ON that ring (vjt's iOS screenshot). Both horizontal sides need a
// real gap. What this cannot prove: that the gap clears the ring once painted
// — that is geometry, and the e2e spec measures it in a browser.
describe("issue 2375 — the services prompt text clears its inset focus ring", () => {
  it(".service-modal-prompt-input declares a non-zero horizontal padding on both sides", () => {
    const insets = nestedRuleBodies(".service-modal-prompt-input").flatMap(horizontalInsets);
    const padding = insets.filter(({ property }) => property.startsWith("padding"));
    // A 2-value shorthand yields ONE inline component (it covers both sides).
    expect(padding.length).toBeGreaterThan(0);
    expect(padding.filter(({ component }) => isZeroInset(component))).toEqual([]);
  });
});
