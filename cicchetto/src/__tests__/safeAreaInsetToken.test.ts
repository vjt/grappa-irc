import { describe, expect, it } from "vitest";
import { ruleBody, themeCss } from "./helpers/themeCss";

// #1751 — ONE mechanism for the safe-area insets, instead of one copy per
// surface.
//
// The reported symptom was the radio station picker riding under the notch.
// The picker is NOT the defect (it is abspos `inset: 0` inside `.shell-members`
// and so resolves against an ancestor that already insets itself — giving it
// its own inset would DOUBLE-COUNT, the #205 regression the `.shell-members`
// base rule records). The defect the symptom points at is that
// `env(safe-area-inset-*)` was hand-written at 23 declarations across 16 rules,
// with four different floors, and a new top-reaching surface joins that set by
// remembering to.
//
// THE INVARIANT, and it is mechanical on purpose: `env(safe-area-inset-*)`
// appears EXACTLY ONCE PER EDGE, at `:root`, and every consumer reads the
// token. That is checkable by reading the sheet, needs no list of which
// surfaces reach the physical top (a semantic judgement that would rot), and
// has no exclusion list. The next copy is red in CI the day it is written.
//
// WHY A TOKEN AND NOT INLINE `env()` — this reverses the note that used to sit
// on `:root` saying inline "is right for a padding: the engine substitutes it
// and nobody has to read it back". True of the ENGINE, false of every gate we
// run. Playwright synthesizes no safe-area inset on any engine (they resolve to
// 0 — measured in e2e/tests/issue913-rail-menu-safe-area.spec.ts) and jsdom
// resolves no `env()` at all, so an inline site is not observable ANYWHERE. A
// site reading the token is stubbable (`:root:root { --safe-area-inset-top:
// 59px }`), which is exactly how the #913 spec proves its own wiring. #913
// introduced the token for that reason on the one site it touched; this
// finishes the move rather than reversing it.
//
// SOURCE-LEVEL, like every safe-area guard in this suite. It proves what the
// cascade is asked to do, never what a device paints — the felt behaviour on a
// notched phone stays vjt's to confirm.

const EDGES = ["top", "right", "bottom", "left"] as const;

/**
 * Every declaration in the sheet that mentions a safe-area inset, as
 * `"<selector> | <declaration>"`, sorted.
 *
 * The `[^{}]` classes cannot span a brace, so this matches INNERMOST rules at
 * any depth and an `@media` prelude is never captured as a selector — a rule
 * inside one comes back under its own selector, which is what the mobile
 * overrides need. Comments are stripped, so prose naming `env()` can neither
 * satisfy nor trip an assertion.
 */
function insetCensus(): string[] {
  const stripped = themeCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const rows: string[] = [];
  for (const rule of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = (rule[1] ?? "").trim().replace(/\s+/g, " ");
    for (const declaration of (rule[2] ?? "")
      .split(";")
      .map((text) => text.trim())
      .filter(Boolean)) {
      if (!declaration.includes("safe-area-inset")) continue;
      rows.push(`${selector} | ${declaration.replace(/\s+/g, " ")}`);
    }
  }
  return rows.sort();
}

describe("#1751 — the safe-area inset has one source and one edit point", () => {
  it.each(EDGES)(":root exposes the %s inset as a token with a 0px fallback", (edge) => {
    // The `0px` fallback is load-bearing, not defensive, and now serves every
    // consumer instead of the two that spelled it out: an engine that does not
    // know the variable makes a bare `env()` declaration invalid as a whole,
    // which drops the whole property. On `.context-menu-safe-area`'s `inset`
    // shorthand that collapsed the ruler to a zero-sized rect (#949); on
    // `.rail-actions-menu`'s cap it brought the #588 overflow back.
    expect(ruleBody(":root")).toMatch(
      new RegExp(`--safe-area-inset-${edge}:\\s*env\\(safe-area-inset-${edge},\\s*0px\\)`),
    );
  });

  it("writes env(safe-area-inset-*) nowhere but those four declarations", () => {
    // THE mechanism assertion. Everything else in this file is a transcription;
    // this is the rule. A seventh copy of `max(x, env(safe-area-inset-top))` on
    // a new pane fails here by existing, with no census of top-reaching
    // surfaces to keep current and nothing to add to an allowlist.
    const offenders = insetCensus().filter(
      (row) => !row.startsWith(":root |") && /env\(safe-area-inset-/.test(row),
    );
    expect(offenders).toEqual([]);
  });

  it("moves no pixel: every consumer keeps the floor it already had", () => {
    // The census, transcribed from the stylesheet at 713736f9 (origin/main,
    // pre-extraction) and rewritten through the token BY HAND, one declaration
    // at a time. `max(<floor>, env(x))` and `max(<floor>, var(--x))` compute
    // the same length, so this pin is what makes "an extraction changes no
    // pixel" (#407) a measured claim here rather than an assurance.
    //
    // The four floors are NOT noise and are deliberately not unified: 1rem on
    // the drawer + viewport scrim, 0.75rem on the three modals and the A2HS
    // hint, 0.5rem on the diag float, and none at all on the shell containers
    // and the fixed drawers. Each has its own comment and its own incident
    // behind it; one shared floor would re-space five surfaces nobody reported.
    //
    // A floorless site reads the token bare rather than `max(0px, var(--x))`:
    // same value, and the difference between "this surface has a floor" and
    // "it does not" stays legible in the sheet.
    expect(insetCensus()).toEqual(CENSUS);
  });

  it("leaves the picker OUT — the clearance belongs to its container", () => {
    // The issue asked for `max(<x>, env(safe-area-inset-top))` here. The
    // symptom was real (the band DID paint under the notch on the phone) but
    // the fix is not: on desktop the picker's ancestor is a grid child of the
    // inset `.shell`, so its BORDER BOX has already moved and an inset here
    // would double-count. The phone case is fixed where it belongs — the
    // mobile drawer carries its clearance on `top` instead of `padding-top`,
    // because padding is invisible to an abspos child. Measured; see the note
    // at that rule, and issue1751-safe-area-token.spec.ts for the numbers.
    expect(ruleBody(".rail-radio-picker")).not.toMatch(/safe-area-inset/);
  });
});

// Transcribed census. A new safe-area consumer is a new row here, which is the
// point: adding one is a deliberate edit to a list somebody reads, not a line
// copied from whichever rule was nearest.
const CENSUS = [
  ".archive-modal | padding: max(0.75rem, var(--safe-area-inset-top)) 1rem max(1.5rem, var(--safe-area-inset-bottom))",
  // Already on the token before #1751 — #913 and #949 put it there, and the
  // redundant `, 0px)` inside the `var()` is left exactly as they wrote it.
  // The token cannot be undeclared, so it is inert; rewriting two dense
  // load-bearing comments to remove an inert fallback is not this change.
  ".context-menu | max-height: max( 0px, calc( var(--viewport-height, 100vh) - var(--safe-area-inset-top, 0px) - var(--safe-area-inset-bottom, 0px) ) )",
  ".context-menu-safe-area | inset: var(--safe-area-inset-top) var(--safe-area-inset-right) var(--safe-area-inset-bottom) var(--safe-area-inset-left)",
  // #1773 — the credits modal is full-bleed (`inset: 0`, no `.modal-backdrop`
  // ancestor to inherit clearance from), so it insets itself. The `.credits-roll`
  // row lives inside the `prefers-reduced-motion` arm, where the roll stops
  // animating and becomes an ordinary scrollable column: only THEN does its
  // padding reach the physical edges, which is why the animated rule has none.
  ".credits-chrome | right: max(0.5rem, var(--safe-area-inset-right))",
  ".credits-chrome | top: max(0.5rem, var(--safe-area-inset-top))",
  // #1934 — the fast-forward button is the same guard in the opposite corner:
  // one full-bleed modal, two corners of controls, so it insets itself for the
  // same reason and with the same floor.
  ".credits-ff | bottom: max(0.5rem, var(--safe-area-inset-bottom))",
  ".credits-ff | right: max(0.5rem, var(--safe-area-inset-right))",
  ".credits-roll | padding: max(3rem, var(--safe-area-inset-top)) 1.5rem max(3rem, var(--safe-area-inset-bottom))",
  // #1931 — the ending parks the roll, and it parks it by reusing the
  // `prefers-reduced-motion` posture above declaration for declaration
  // (`creditsFinaleCss.test.ts` pins the pair as a set). So this row is the
  // deliberate SECOND copy of the row above, floor included: a static roll
  // reaches the physical edges whichever of the two reasons stopped it, and
  // giving the ending a different floor would inset the same column by a
  // different amount depending on how the reader got there.
  ".credits-roll-ended | padding: max(3rem, var(--safe-area-inset-top)) 1.5rem max(3rem, var(--safe-area-inset-bottom))",
  ".delete-account-modal | padding: max(0.75rem, var(--safe-area-inset-top)) 1rem max(1.5rem, var(--safe-area-inset-bottom))",
  ".diag-float | top: max(0.5rem, var(--safe-area-inset-top))",
  ".error-banners | padding-top: var(--safe-area-inset-top)",
  ".image-upload-modal | padding: 1.5rem 1.5rem max(1.5rem, var(--safe-area-inset-bottom))",
  ".install-a2hs | bottom: max(0.75rem, var(--safe-area-inset-bottom))",
  ".install-a2hs | right: max(0.75rem, var(--safe-area-inset-right))",
  ".modal-backdrop-viewport | padding: max(1rem, var(--safe-area-inset-top)) 1rem max(1.5rem, var(--safe-area-inset-bottom)) 1rem",
  ".next-active-btn-mobile | right: calc(0.5rem + var(--safe-area-inset-right))",
  ".rail-actions-menu | max-height: max( 0px, calc( var(--rail-menu-space-above, var(--viewport-height, 80vh)) - var(--safe-area-inset-top, 0px) ) )",
  ".settings-drawer | padding: max(1rem, var(--safe-area-inset-top)) 1rem max(1.5rem, var(--safe-area-inset-bottom)) 1rem",
  ".shell | padding-bottom: var(--safe-area-inset-bottom)",
  ".shell | padding-left: var(--safe-area-inset-left)",
  ".shell | padding-right: var(--safe-area-inset-right)",
  ".shell | padding-top: var(--safe-area-inset-top)",
  // 🔴 The two fixed drawers carry the TOP clearance on `top` + a compensating
  // `height`, NOT on `padding-top`, and that is not a spelling choice — it is
  // #1751's actual defect. Padding is invisible to a container's absolutely
  // positioned descendants, so a padded top-pinned drawer leaves `.rail-radio-
  // picker` (`inset: 0`) under the notch. Measured; see the note at the mobile
  // `.shell-members` rule. A future edit that "tidies" these back into a
  // `padding-top` re-opens the bug silently on the phone, and lands here first.
  ".shell-members | height: calc(var(--viewport-height, 100dvh) - var(--safe-area-inset-top))",
  ".shell-members | padding-bottom: max(1.5rem, var(--safe-area-inset-bottom))",
  ".shell-members | top: var(--safe-area-inset-top)",
  ".shell-mobile .shell-sidebar | height: calc(var(--viewport-height, 100dvh) - var(--safe-area-inset-top))",
  ".shell-mobile .shell-sidebar | padding-bottom: max(1.5rem, var(--safe-area-inset-bottom))",
  ".shell-mobile .shell-sidebar | top: var(--safe-area-inset-top)",
  ".shell-mobile | padding-left: var(--safe-area-inset-left)",
  ".shell-mobile | padding-right: var(--safe-area-inset-right)",
  ".shell-mobile | padding-top: var(--safe-area-inset-top)",
  // issue 2163 — the first consumers in this census that are not box-model
  // properties, and the distinction is the whole of that fix. The desktop
  // `.shell` rows above put the inset on the CONTAINER's padding, which under
  // `box-sizing: border-box` leaves the shell's bottom `var(--safe-area-inset-
  // bottom)` as a transparent strip: the grid tracks stop short of a border box
  // that does not. These three extend each column's own background back down
  // through that strip with an outer box-shadow, offset by exactly the
  // container's own inset.
  //
  // "Moves no pixel" therefore holds here by CONSTRUCTION rather than by
  // arithmetic: a box-shadow occupies no space and moves no descendant — which
  // is also why it is a shadow and not padding on the asides. Padding there
  // would drag `.rail-radio-picker` (abspos `inset: 0`, the row-block above)
  // into the gesture strip, the #1751 defect this file is named for.
  ".shell:not(.shell-mobile) .crt-splash | box-shadow: 0 var(--safe-area-inset-bottom) 0 #000",
  ".shell:not(.shell-mobile) .home-pane | box-shadow: 0 var(--safe-area-inset-bottom) 0 var(--adm-surface-1)",
  ".shell:not(.shell-mobile) > .shell-sidebar, .shell:not(.shell-mobile) > .shell-members | box-shadow: 0 var(--safe-area-inset-bottom) 0 var(--bg-alt)",
  ".theme-editor-modal | padding: max(0.75rem, var(--safe-area-inset-top)) 1rem max(1.5rem, var(--safe-area-inset-bottom))",
  ":root | --safe-area-inset-bottom: env(safe-area-inset-bottom, 0px)",
  ":root | --safe-area-inset-left: env(safe-area-inset-left, 0px)",
  ":root | --safe-area-inset-right: env(safe-area-inset-right, 0px)",
  ":root | --safe-area-inset-top: env(safe-area-inset-top, 0px)",
  // issue 2302 — and then there were fourteen. Same kind of row as the one
  // above and for the same reason: `.shell` shifts the FLOW, and everything
  // fixed/absolute that anchors to the top sits outside its padding box, so
  // each of these restates the inset in order to ADD the clearance to it. The
  // `env()`-once invariant this file exists for is UNTOUCHED — not one of
  // these writes `env(`, they all read the token, which is why the offenders
  // assertion above stays green while this transcription grows.
  //
  // 🔴 THIS IS WHERE FOLDING THE CLEARANCE INTO THE TOKEN WOULD HAVE LANDED,
  // and why it could not. One declaration under `html.is-ios27-band` would
  // replace all thirteen rows — but `--safe-area-inset-top:
  // calc(var(--safe-area-inset-top) + …)` is a self-reference and invalid at
  // computed-value time, and the only other spelling needs a SECOND `env(`
  // write, which the offenders assertion rejects by design. Even granting
  // both, `:root:root` (0,2,0) — how issue913, issue1751 and issue2190 stub
  // this very token — outranks `html.is-ios27-band` (0,1,1), so the grown
  // value would be discarded in exactly the specs that measure it. Thirteen
  // rows is the price of that, and the census in `ios27Band.test.ts` is what
  // keeps the list from rotting.
  "html.is-ios27-band .archive-modal | padding: max(0.75rem, calc(var(--safe-area-inset-top) + var(--ios27-band-clearance))) 1rem max(1.5rem, var(--safe-area-inset-bottom))",
  "html.is-ios27-band .context-menu-safe-area | inset: calc(var(--safe-area-inset-top) + var(--ios27-band-clearance)) var(--safe-area-inset-right) var(--safe-area-inset-bottom) var(--safe-area-inset-left)",
  "html.is-ios27-band .credits-chrome | top: max(0.5rem, calc(var(--safe-area-inset-top) + var(--ios27-band-clearance)))",
  "html.is-ios27-band .credits-roll | padding: max(3rem, calc(var(--safe-area-inset-top) + var(--ios27-band-clearance))) 1.5rem max(3rem, var(--safe-area-inset-bottom))",
  "html.is-ios27-band .credits-roll-ended | padding: max(3rem, calc(var(--safe-area-inset-top) + var(--ios27-band-clearance))) 1.5rem max(3rem, var(--safe-area-inset-bottom))",
  "html.is-ios27-band .delete-account-modal | padding: max(0.75rem, calc(var(--safe-area-inset-top) + var(--ios27-band-clearance))) 1rem max(1.5rem, var(--safe-area-inset-bottom))",
  "html.is-ios27-band .diag-float | top: max(0.5rem, calc(var(--safe-area-inset-top) + var(--ios27-band-clearance)))",
  "html.is-ios27-band .error-banners | padding-top: calc(var(--safe-area-inset-top) + var(--ios27-band-clearance))",
  "html.is-ios27-band .modal-backdrop-viewport | padding: max(1rem, calc(var(--safe-area-inset-top) + var(--ios27-band-clearance))) 1rem max(1.5rem, var(--safe-area-inset-bottom)) 1rem",
  "html.is-ios27-band .settings-drawer | padding: max(1rem, calc(var(--safe-area-inset-top) + var(--ios27-band-clearance))) 1rem max(1.5rem, var(--safe-area-inset-bottom)) 1rem",
  // issue 2190 — the ONLY row here that is not a surface insetting itself:
  // it is an OVERRIDE of the `.shell | padding-top` row above, gated on the
  // iOS 27 compositor-band class, and it restates the inset precisely so it
  // can add to it. Dropping the `var(--safe-area-inset-top)` term would not
  // shrink this census by a row, it would REPLACE the inset with the bare
  // clearance and pull the content up under the Dynamic Island — the #913
  // trap run in reverse. Spelled without the figure since issue 2295: it
  // read «38px» from `11fe3d0b7` (2026-09-19, the 38→16 retune) onward, a
  // stale number inside the warning about a trap, which is how the trap
  // gets believed. The assertion below never carried the value and so never
  // went stale — the prose did. Do not put it back.
  // `ios27Band.test.ts` owns that call; this row only records that a second
  // consumer of the top inset now exists, deliberately.
  "html.is-ios27-band .shell | padding-top: calc(var(--safe-area-inset-top) + var(--ios27-band-clearance))",
  // The two drawers are ONE grouped rule, so the selector list comes back
  // whole and both declarations sit under it. Grouped on purpose: the sheet
  // already warns that two drawers answering the same geometry problem two
  // different ways is how the next one gets copied from whichever was nearer.
  "html.is-ios27-band .shell-mobile .shell-sidebar, html.is-ios27-band .shell-mobile .shell-members | height: calc( var(--viewport-height, 100dvh) - var(--safe-area-inset-top) - var(--ios27-band-clearance) )",
  "html.is-ios27-band .shell-mobile .shell-sidebar, html.is-ios27-band .shell-mobile .shell-members | top: calc(var(--safe-area-inset-top) + var(--ios27-band-clearance))",
  "html.is-ios27-band .theme-editor-modal | padding: max(0.75rem, calc(var(--safe-area-inset-top) + var(--ios27-band-clearance))) 1rem max(1.5rem, var(--safe-area-inset-bottom))",
];
