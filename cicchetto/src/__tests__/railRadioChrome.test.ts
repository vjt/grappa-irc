import { describe, expect, it } from "vitest";
import { overscrollContainment, ruleBody, themeCss } from "./helpers/themeCss";

// #1697 — the rail radio's chrome, from the CSS side.
//
// Two defects with ONE root: the picker carried a hand-rolled `--rail-radio-*`
// chrome layer instead of the band `PaneTopBar` already provides, and its
// buttons sized their tap target in `rem`.
//
// The rem part is arithmetic, not taste. `html { font-size: var(--font-size) }`
// and `--font-size: 14px`, so the `min-width/height: 2rem` these two buttons
// carried resolved to 28px — against `--tap-min: 44px` (Apple HIG) and
// `--chrome-tap-min: 48px`. That is the whole reason the ✕ "renders but does
// not land". The cure is not a bigger number: it is wearing
// `.shell-chrome-btn`, which already carries the floor for every other chrome
// button in the app.
//
// jsdom applies no stylesheet, so this reads the source. It proves what the
// cascade is asked to do, never what a device paints — the tap itself is
// e2e/dogfood territory.

function declares(body: string, property: string): boolean {
  return new RegExp(`(^|;)\\s*${property}\\s*:`, "m").test(body);
}

// Absent rule == no delta left == pass, same reading as sharedButtonRules.ts:
// a per-instance class whose every declaration moved to the shared class it is
// worn beside carries no rule of its own.
function deltaBody(selector: string): string {
  try {
    return ruleBody(selector);
  } catch {
    return "";
  }
}

describe("#1697 — the rail radio's buttons wear the shared chrome button", () => {
  // Everything `.shell-chrome-btn` declares. A per-instance re-declaration is
  // the clone coming back, and the tap floor is the one that bites.
  const SHARED = [
    "background",
    "color",
    "border",
    "min-width",
    "min-height",
    "font-size",
    "cursor",
  ];

  it("the shared class is what carries the HIG floor, in absolute px", () => {
    // Guards the assertion below from being vacuous: adopting a class that has
    // stopped carrying the floor would buy nothing.
    const shared = ruleBody(".shell-chrome-btn");
    expect(shared).toMatch(/min-width:\s*var\(--chrome-tap-min\)/);
    expect(shared).toMatch(/min-height:\s*var\(--chrome-tap-min\)/);
    expect(themeCss).toMatch(/--chrome-tap-min:\s*48px/);
  });

  it.each([".rail-radio-picker-close", ".rail-radio-stop"])(
    "%s no longer re-declares any shared property",
    (selector) => {
      const body = deltaBody(selector);
      for (const property of SHARED) {
        expect(declares(body, property), `${selector} must not re-declare ${property}`).toBe(false);
      }
    },
  );

  // The CLASS, not the two examples. A future rail-radio control that sizes its
  // hit area in rem re-creates the same 28px defect, and nothing else would
  // catch it — the issue named one button; the sheet had two.
  it("no rail-radio rule sizes a tap target in rem", () => {
    const offenders = [...themeCss.matchAll(/^(\.rail-radio[a-z0-9-]*)\s*\{([^}]*)\}/gm)]
      .filter(([, , body]) => /min-(width|height):\s*[\d.]+rem/.test(body ?? ""))
      .map(([, selector]) => selector);
    expect(offenders).toEqual([]);
  });
});

describe("#1697 — the picker inherits the pane band instead of cloning it", () => {
  it("the hand-rolled header band is gone from the sheet", () => {
    // `.rail-radio-picker-head` / `.rail-radio-heading` were a lookalike of the
    // band `.topic-bar` provides. A rule left behind is a second chrome layer
    // still able to drift, whether or not any element still wears it.
    expect(() => ruleBody(".rail-radio-picker-head")).toThrow();
  });

  it("the band the picker now hosts still carries the pane chrome inset", () => {
    // This is the missing top padding, item 3a: the hand-rolled head took the
    // scroller's flat 0.5rem, while the band reads the shared inset pair.
    expect(ruleBody(".topic-bar")).toMatch(
      /padding:\s*var\(--pane-chrome-inset-block\) var\(--pane-chrome-inset-inline\)/,
    );
  });

  it("the picker no longer pads its own box, so the band can span it edge to edge", () => {
    // A padded scroller would inset the band and re-open the gap between it and
    // the two surfaces that render the same band flush.
    expect(declares(ruleBody(".rail-radio-picker"), "padding")).toBe(false);
  });

  it("the scrolling list keeps the #913 gesture contract", () => {
    // #913's descendant carve-out is load-bearing on iOS: `touch-action` does
    // not inherit, and iOS elects the gesture consumer from the hit-test
    // target's OWN value — so the rows need it, not just the scroller. Moving
    // the scroll onto an inner list must not drop either half.
    const list = ruleBody(".rail-radio-picker-list");
    expect(list).toMatch(/overflow-y:\s*auto/);
    // issue 2671 — containment comes from the shared rule, not this one.
    expect(overscrollContainment().both).toContain(".rail-radio-picker-list");
    expect(ruleBody(".rail-radio-picker *")).toMatch(/touch-action:\s*pan-y/);
  });
});
