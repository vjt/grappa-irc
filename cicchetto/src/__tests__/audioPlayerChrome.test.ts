import { describe, expect, it } from "vitest";
import { ruleBody, themeCss } from "./helpers/themeCss";

// #1697 — the DOCKED transport's chrome, from the CSS side.
//
// This file deliberately asserts NOTHING about the row's tap floor, and the
// omission is the point rather than an oversight.
//
// What was measured: `html { font-size: var(--font-size) }` with
// `--font-size: 14px`, so the row's `min-width/height: 2.5rem` resolves to
// 35px — under the 44px `--tap-min` floor. Same class as the rail picker's ✕
// at 2rem/28px; #115 sized these in rem and #306's absolute-px sweep never
// reached them.
//
// Why it is not fixed here: #1697 names the PICKER's ✕. Lifting this row grows
// the docked bar by ~9px, a visible change to a surface that was looked at and
// approved. That decision is not this issue's to take, so the finding was
// carved out and filed on its own.
//
// A test asserting `2.5rem` would be worse than no test — it would encode a
// known defect and stop anyone from finding it (CLAUDE.md: never assert buggy
// behavior). So what is pinned here is floor-NEUTRAL: that the control this
// issue adds is styled by the row's SHARED rule rather than by a bespoke copy
// beside it. When the carve-out lands, all four move together because they
// already share one rule.
//
// jsdom applies no stylesheet, so this reads the source. It proves what the
// cascade is asked to do, never what a device paints.

describe("#1697 — the hide control shares the transport row's rule", () => {
  const GROUP =
    ".audio-mini-player-toggle,\n.audio-mini-player-hide,\n.audio-mini-player-close,\n.audio-mini-player-share";

  it("styles the hide control in the shared group, not in a copy of it", () => {
    // `ruleBody` throws on an absent rule, so a group that stopped naming the
    // hide control fails here rather than passing vacuously — the #734 guard.
    expect(ruleBody(GROUP)).toMatch(/flex:\s*none/);
    expect(() => ruleBody(".audio-mini-player-hide")).toThrow();
  });

  it("keeps the four controls sized from ONE declaration, whatever it says", () => {
    // The invariant that survives the carve-out: one rule sets the row's box,
    // so raising the floor later is a single edit and cannot leave a straggler.
    // Keyed on "they agree", not on the value — which is exactly what lets this
    // test stay honest while the value is still wrong.
    const body = ruleBody(GROUP);
    const width = body.match(/min-width:\s*([^;]+);/)?.[1]?.trim();
    const height = body.match(/min-height:\s*([^;]+);/)?.[1]?.trim();
    expect(width).toBeDefined();
    expect(width).toBe(height);
  });

  it("no OTHER rule re-declares the box of one of the four controls", () => {
    // A second rule setting min-width/height on one of these four would split
    // the row in two and defeat the single-edit property above — the
    // cascade-override shape the rail's sibling guard caught on a mutant, where
    // the class was worn and the floor overridden underneath it.
    //
    // Scoped to the four CONTROLS on purpose. `.audio-mini-player-label` and
    // `-seek` legitimately carry `min-width: 0` — that is the flex ellipsis
    // chain, not a tap-target box, and an earlier draft of this test flagged
    // both. A guard that cries about layout it does not govern gets deleted by
    // the next reader, which is worse than not having it.
    const CONTROLS = GROUP.split(",\n");
    const offenders = [
      ...themeCss.matchAll(/^([.a-z0-9\-,\n]*audio-mini-player[^{]*)\{([^}]*)\}/gm),
    ]
      .filter(([, selectors, body]) => {
        const list = (selectors ?? "").trim();
        if (list === GROUP) return false;
        const touchesAControl = CONTROLS.some((c) =>
          new RegExp(`(^|[\\s,])${c.replace(".", "\\.")}([\\s,{]|$)`).test(list),
        );
        return touchesAControl && /min-(width|height):/.test(body ?? "");
      })
      .map(([, selectors]) => (selectors ?? "").trim());
    expect(offenders).toEqual([]);
  });
});
