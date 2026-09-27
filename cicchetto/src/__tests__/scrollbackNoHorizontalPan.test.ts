import { describe, expect, it } from "vitest";
import { nestedRuleBodies } from "./helpers/themeCss";

// issue 2305 — the scrollback pane must NEVER pan horizontally.
//
// The bug was an ABSENCE, and that is why this file asserts a declaration
// rather than a value being pretty. `.scrollback` declared `overflow-y: scroll`
// and nothing for x; per CSS Overflow 3 an axis that is not `visible` forces
// the other axis' `visible` to compute to `auto`, so the pane became a
// horizontal scroller the moment any row outgrew it. mIRC block art — runs of
// spaces with fg = bg — is such a row, and vjt's iOS PWA screenshot of `#irc40`
// had every line dragged off to the left, art and ordinary messages alike.
//
// ## Why this reads the source instead of measuring a render
//
// The claim is about a computed overflow regime. jsdom resolves no cascade and
// paints nothing, so there is no clipping in here to observe — a rendered proof
// needs a real engine, and this file does not pretend to be one. What CAN be
// pinned is the declaration the regime follows from.
//
// `nestedRuleBodies` strips CSS comments, which is load-bearing rather than
// tidy: the prose above this rule names `overflow-x`, `clip` and `hidden`
// several times over, and a guard doing a substring match on the sheet would
// read the JUSTIFICATION and report on the CONFIGURATION. It also throws when
// the selector has no rule at all, so a rename cannot pass this vacuously.

/**
 * Values of `overflow-x` that still make the element a scroll container, so a
 * `scrollLeft` nobody set stays settable and an engine — or the browser
 * scrolling a focusable descendant into view — can pan the pane after all.
 * `hidden` is in here on purpose: it clips identically and fixes the symptom
 * while leaving the class of bug alive. See `.credits-*`, which paid for that
 * with a measured 178px single-frame jump.
 */
const SCROLL_CONTAINER_VALUES = ["auto", "scroll", "hidden"];

/** Every `property: value` pair in a rule body, in source order. */
function declarations(body: string): { property: string; value: string }[] {
  const out: { property: string; value: string }[] = [];
  for (const raw of body.split(";")) {
    const colon = raw.indexOf(":");
    if (colon === -1) continue;
    out.push({ property: raw.slice(0, colon).trim(), value: raw.slice(colon + 1).trim() });
  }
  return out;
}

/**
 * The values a rule body declares for EXACTLY `property`. Exact, not a prefix
 * match: `overflow` and `overflow-x` are different declarations with different
 * blast radii, and the whole point of the third test below is telling them
 * apart.
 */
function valuesOf(body: string, property: string): string[] {
  return declarations(body)
    .filter((one) => one.property === property)
    .map((one) => one.value);
}

describe("issue 2305 — the scrollback pane never scrolls sideways", () => {
  // One and only one. A second block is a second place to decide the pane's
  // overflow, and the later one would silently win over everything asserted
  // below — so a new block goes red here and has to be reasoned about.
  it("decides the pane's overflow in exactly one rule", () => {
    expect(nestedRuleBodies(".scrollback")).toHaveLength(1);
  });

  it("DECLARES overflow-x, so the axis never falls through to the computed auto", () => {
    const [body] = nestedRuleBodies(".scrollback");
    if (body === undefined) throw new Error(".scrollback has no rule body");
    // The regression is the declaration going missing, not its value changing:
    // delete the line and CSS hands the pane `auto` back, which is the reported
    // bug with nothing in the sheet to show for it.
    expect(valuesOf(body, "overflow-x")).toHaveLength(1);
  });

  it("pins it to clip, which creates no scroll container at all", () => {
    const [body] = nestedRuleBodies(".scrollback");
    if (body === undefined) throw new Error(".scrollback has no rule body");
    const [value] = valuesOf(body, "overflow-x");
    expect(value).toBe("clip");
    // Stated as its own assertion because it is the REASON, and the reason is
    // what a future edit will be tempted to drop: `hidden` looks like the same
    // cure and is not.
    expect(SCROLL_CONTAINER_VALUES).not.toContain(value);
  });

  it("leaves the vertical axis scrolling — the shorthand would take it away", () => {
    const [body] = nestedRuleBodies(".scrollback");
    if (body === undefined) throw new Error(".scrollback has no rule body");
    // `overflow: clip` reads like a tidier spelling of the line above and is
    // the one edit that would break this pane outright: the shorthand sets BOTH
    // axes, so the scrollback would stop scrolling at all. Asserting the
    // shorthand's ABSENCE is what separates the two.
    expect(valuesOf(body, "overflow")).toEqual([]);
    expect(valuesOf(body, "overflow-y")).toEqual(["scroll"]);
  });
});
