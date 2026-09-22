import { describe, expect, it } from "vitest";
import { nestedRuleBodies, ruleBody, themeCss } from "./helpers/themeCss";

// issue 1791 — THE BOTTOM TAB ROW's bottom edge is `--viewport-height`, and
// this file is the only place that says so mechanically.
//
// ## Why the tab row and not the message buffer
//
// Every field report on this surface has been read off the BUFFER: "the
// scrollback is pushed off the visible viewport". The iOS 27 report (2026-09-21)
// is the one that separates the two — the shell does shrink, the buffer looks
// right, and the iOS form-accessory bar is drawn over the bottom channel-tab
// row. A cure verified against buffer position alone reads GREEN through that.
//
// The two are not the same measurement because they are decided by different
// things. The buffer is `.scrollback` inside `.shell-main`, the `1fr` grid row —
// it moves whenever anything redistributes space INSIDE the shell. The tab row
// is `.bottom-bar`, the last IN-FLOW child, so its bottom edge is the shell's
// bottom BORDER edge and nothing else. Four links decide where that lands:
//
//   html.is-ios { position: fixed; inset: 0 }      → html = the layout viewport
//   html.is-ios body { height: calc(var(--vh)*100) } → body = the written height
//   #root { height: 100% }                          → no height of its own
//   .shell-mobile { height: var(--viewport-height); padding-bottom: 0 }
//                                                   → border-box, flush bottom
//
// ⇒ the tab row's bottom edge sits exactly `--viewport-height` px below the top
// of the layout viewport, and the row is fully visible iff
// `--viewport-height <= visualViewport.offsetTop + visualViewport.height`.
//
// ## What this file is NOT
//
// SOURCE-LEVEL, the same posture as every safe-area guard in this suite: it
// proves what the cascade is ASKED to do, never what a device paints. It cannot
// see whether `--viewport-height` holds the right NUMBER on a real iPhone,
// which is the entire defect issue 1791 reports — that needs the device (#654:
// this class does not reproduce on desktop, and Playwright's iPhone emulation
// does not reproduce iOS keyboard physics). What it CAN do is fail the day
// someone re-parents, re-positions or re-sizes the tab row so that a later
// "fix" moves the buffer while leaving the row governed by something else.
//
// DOM ORDER is deliberately not asserted here. `<BottomBar />` is the last
// in-flow child of `.shell-mobile` in `Shell.tsx`, but a source-level reader of
// JSX would pin the shape of the file rather than the shape of the tree, and
// the overlay siblings that follow it are all `position: fixed`. The CSS half
// below is the half that can be checked without lying about what it checked.

const SHELL = ".shell-mobile";
const TAB_ROW = ".bottom-bar";

describe("issue 1791 — the bottom tab row's edge is --viewport-height", () => {
  it("sizes the mobile shell from --viewport-height", () => {
    // `nestedRuleBodies` and not `ruleBody`: the shell lives inside
    // `@media (max-width: 768px)` and has a second block under
    // `@supports not (height: 100dvh)`, and an assertion about which value the
    // height ends up with has to see both.
    const bodies = nestedRuleBodies(SHELL);
    const declaring = bodies.filter((body) => /(^|[;\s])height:/.test(body));
    expect(declaring.length).toBeGreaterThan(0);
    expect(declaring[0]).toMatch(/height:\s*var\(--viewport-height,\s*100dvh\)/);
  });

  it("keeps the shell's bottom edge flush — padding-bottom: 0, so the border edge IS the var", () => {
    // #1127 made this 0 to reclaim the home-indicator band, and its comment
    // carries the warning that matters here: with the keyboard up iOS reports
    // `env(safe-area-inset-bottom)` against the DEVICE, not the shrunken visual
    // viewport, so a non-zero inset on this edge double-counts against
    // `--viewport-height`. A non-zero value here would ALSO make the arithmetic
    // above wrong — the tab row's bottom edge would stop being the var.
    const bodies = nestedRuleBodies(SHELL).filter((body) => /padding-bottom:/.test(body));
    expect(bodies.length).toBe(1);
    expect(bodies[0]).toMatch(/padding-bottom:\s*0\s*;/);
  });

  it("leaves the tab row IN FLOW — it declares no position, so it cannot escape the shell box", () => {
    // A `position: fixed` tab row would anchor to the LAYOUT viewport, which
    // iOS does not shrink for the keyboard — the row would then sit behind the
    // whole keyboard rather than at the shell's edge, and `--viewport-height`
    // would stop describing it at all.
    expect(ruleBody(TAB_ROW)).not.toMatch(/(^|[;\s])position:/);
  });

  it("binds #root to the body rather than to a viewport unit of its own", () => {
    // UX-3 UNDEC: `100vh` resolves against the LAYOUT viewport on iOS, so a
    // `#root` with its own viewport unit would overflow `body` and re-open the
    // drag-the-whole-app-chrome failure. `height: 100%` keeps the chain intact.
    expect(ruleBody("#root")).toMatch(/height:\s*100%/);
  });

  it("sizes the iOS body from --vh, the sibling the same writer sets", () => {
    expect(ruleBody("html.is-ios body")).toMatch(/height:\s*calc\(var\(--vh,\s*1vh\)\s*\*\s*100\)/);
  });

  it("declares NEITHER var in the stylesheet — the JS tracker stays the one writer", () => {
    // `lib/viewportHeight.ts` is the single writer of both vars (#79/#209/#649
    // share that root cause). A CSS declaration would be a second source the
    // cascade could win with, silently, on one surface. The check is a census
    // rather than a spot read so a seventh copy is red the day it is written.
    const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const declarations = [...stripped.matchAll(/--(?:vh|viewport-height)\s*:/g)].map(
      (match) => match[0],
    );
    expect(declarations).toEqual([]);
    // Positive control for the regex: the sheet DOES declare the safe-area
    // tokens the same way, so an empty result above is an absence and not a
    // pattern that never matches anything.
    expect(stripped).toMatch(/--safe-area-inset-top\s*:/);
  });
});
