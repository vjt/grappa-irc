import { describe, expect, it } from "vitest";
import { ruleBody } from "./helpers/themeCss";

// #1040 — the CSS half of the expanded home rail. RailActions.test.tsx pins the
// component half (which kind expands, what stops being rendered, what refcount
// is not held); this pins the geometry, which is where the whole difference
// between "expanded column" and "overlay left open" actually lives.
//
// The base `.rail-actions-menu` is built for a popover floating over a nick
// list: `position: absolute`, `bottom: 100%` (it opens UPWARD), and a
// `max-height` derived from the JS-measured space above the launcher (#588 →
// #913). Every one of those exists because a menu opening upward over a list
// has only the space above it. Home has no list — `RailContext` renders nothing
// for the kind — so the constraint is gone and the column lays out in flow.
//
// Leaving any single one of these on would ship a subtly broken rail rather
// than a loud one: still absolute → the column overlays whatever the rail
// holds and the aside collapses to nothing; still `margin-top: auto` → the
// buttons hug the bottom edge instead of reading from the top; still capped by
// `--rail-menu-space-above` → the cap is measured only while the transient menu
// is open, so on home it falls back to the pre-measure viewport value and the
// rows can grow past the rail. Source-level guards, because jsdom resolves
// neither `calc()` nor a flex layout — the felt result is the e2e's job
// (issue1040-home-rail-expanded.spec.ts).

describe("#1040 expanded home rail geometry", () => {
  it("un-floors the container so the column reads from the top of the rail", () => {
    const body = ruleBody(".rail-actions.expanded");
    // The base rule's `margin-top: auto` is what pins the launcher to the
    // BOTTOM of the flex rail. An expanded column pinned to the bottom is the
    // popover shape wearing a different position value.
    expect(body).toMatch(/margin-top:\s*0/);
  });

  it("lets the column shrink and scroll instead of spilling out of the aside", () => {
    const body = ruleBody(".rail-actions.expanded");
    // `.shell-members` is `overflow-y: visible` (#500 moved the scroll into
    // `.members-pane`), and home renders no `.members-pane` at all — so a
    // `flex-shrink: 0` column taller than the rail does not scroll, it spills
    // out of the aside and the bottom rows become unreachable.
    expect(body).toMatch(/flex-shrink:\s*1/);
    expect(body).toMatch(/min-height:\s*0/);
  });

  it("takes the popover geometry off the menu itself", () => {
    const body = ruleBody(".rail-actions.expanded .rail-actions-menu");
    // Out of the absolute/upward/`bottom: 100%` anchoring …
    expect(body).toMatch(/position:\s*static/);
    // … and out of the cap that only means something while a transient menu is
    // measuring the space above a launcher that no longer exists here.
    expect(body).toMatch(/max-height:\s*none/);
  });

  it("keeps the scroll owner and its touch contract intact", () => {
    // The base rule already carries `overflow-y: auto` + `touch-action:
    // pan-y` (and the shared containment rule lists it, issue 2671), and the
    // `.rail-actions-menu *` descendant carve-out (#913) that makes iOS
    // actually honour the pan. The expanded rule must NOT re-declare the
    // scroll away — reusing the proven machinery is the whole reason the
    // menu, not the container, stays the scroller.
    const base = ruleBody(".rail-actions-menu");
    expect(base).toMatch(/overflow-y:\s*auto/);
    expect(base).toMatch(/touch-action:\s*pan-y/);
    expect(ruleBody(".rail-actions.expanded .rail-actions-menu")).not.toMatch(/overflow-y:\s*/);
  });
});
