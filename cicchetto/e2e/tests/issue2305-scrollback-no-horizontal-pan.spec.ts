// issue 2305 — the scrollback pane must never pan sideways, asserted on the
// COMPUTED value in a real engine.
//
// WHY THIS EXISTS NEXT TO `src/__tests__/scrollbackNoHorizontalPan.test.ts`,
// WHICH IS NOT REDUNDANT WITH IT. That file is a textual scan of the
// stylesheet: it reads `.scrollback`'s rule body and pins that the body
// DECLARES `overflow-x: clip` exactly once, that the `overflow` shorthand is
// absent, and that there is exactly one rule block deciding the pane's
// overflow. Those are strong and they stay. But it measures the TEXT
// DECLARED in one file, and two things can still be true with it green:
//
//   1. A LATER rule — anywhere in the sheet, in a media query, in a
//      `html.is-ios27-band` block, in a file the scan never opens — is more
//      specific and wins the cascade. The scan looks at one selector in one
//      file and cannot see a competitor by construction.
//   2. The ENGINE does not honour the value. `clip` is a CSS Overflow 3
//      addition, not a universal one, and an engine that does not know it
//      drops the declaration — at which point `overflow-y: scroll` forces
//      the x axis' `visible` to compute back to `auto` and the pane is a
//      horizontal scroller again, which IS the reported bug. The sheet would
//      still say `clip`. jsdom cannot arbitrate this: it resolves no cascade
//      and implements no layout, so there is no computed overflow in there
//      to read.
//
// This spec answers both by asking the engine what it actually resolved.
//
// WHY `@webkit` AND NOT THE DESKTOP DEFAULT. vjt's report is an iOS PWA
// screenshot of `#irc40`: the platform where the bug was SEEN is WebKit, and
// point 2 above is an engine-support question, which is the one class of
// regression a run on the other engine cannot see. An untagged spec runs on
// desktop `chromium` and NOWHERE ELSE, so it would have been a green off the
// defect's platform.
//
// 🔴 The tag is an opt-IN to `webkit-iphone-15` and simultaneously an opt-OUT
// of `chromium`: that project's `grepInvert` is the complement of the touch
// projects' greps, so a tagged spec does not also run there. Measured on
// `playwright test --list`, which collects this file on `webkit-iphone-15`
// alone — do not read the config header's "also runs on" as additive to the
// desktop default. The consequence is deliberate but it IS a gap: nothing
// here proves Chromium resolves `clip` on this pane. Adding `@touch`
// alongside would buy `chromium-pixel-touch` and close it, at one more test.
//
// WHAT THIS SPEC DELIBERATELY DOES NOT DO. It does not synthesise an mIRC art
// row, does not detect one, and does not attempt a horizontal scroll or drag.
// Giving over-wide art its own scrollable box — and deciding how a row is
// even recognised as art — is issue 2312, and vjt's ruling ("lascia perdere
// per ora, metti overflow e bon") cut it out of this slice. What is in scope
// is the invariant this PR actually ships, and a shipped invariant gets a
// real-browser gate.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: a
// subject-shape-agnostic CSS contract — the pane's overflow does not branch
// on user class — so the registered spec user suffices.

import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0] as string;

type PaneOverflow = {
  /** The claim under test. */
  overflowX: string;
  /**
   * The other half of the claim: the shorthand would have taken this with
   * it. `overflow: clip` and `overflow-x: clip` are indistinguishable on the
   * x axis and differ here, so this is what separates the fix from the one
   * edit that would break the pane outright.
   */
  overflowY: string;
  /**
   * POS CTRL, read in the SAME `evaluate` as the two values above, from the
   * SAME rule block. Both are declared by `.scrollback` (`flex: 1` and
   * `min-height: 0`) and both differ from their initial values (`0` and
   * `auto`), so they can only read as pinned here if the element really is
   * the pane AND the stylesheet really reached it. Without them a green on
   * `overflowX` would not distinguish "the engine resolved clip" from "I
   * measured something else entirely" — and an element that is absent or
   * unstyled is exactly how a spec goes green while proving nothing.
   */
  control: { flexGrow: string; minHeight: string };
  /**
   * Second half of the control: a box with area. A computed overflow on a
   * `display: none` subtree is a value nobody paints, so the pane has to be
   * laid out for the reading to mean anything.
   */
  laidOut: boolean;
};

test("@webkit issue2305 — the scrollback pane resolves overflow-x: clip and keeps scrolling vertically", async ({
  page,
}) => {
  if (CHANNEL === undefined) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const pane: PaneOverflow = await page.evaluate(() => {
    const el = document.querySelector(".scrollback");
    // Thrown, not returned as a sentinel: a missing pane means the app never
    // reached a channel window, which is a different failure from a wrong
    // overflow and must not be reported as one.
    if (el === null) throw new Error("no .scrollback — the shell did not reach a channel");
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return {
      overflowX: cs.overflowX,
      overflowY: cs.overflowY,
      control: { flexGrow: cs.flexGrow, minHeight: cs.minHeight },
      laidOut: rect.width > 0 && rect.height > 0,
    };
  });

  // The control is asserted FIRST and on its own, so that a failure here
  // reads as "the measurement was not taken on the pane" rather than as a
  // regression in the overflow itself.
  expect(pane.laidOut).toBe(true);
  expect(pane.control).toEqual({ flexGrow: "1", minHeight: "0px" });

  // The claim. `clip` and not `hidden`: `hidden` clips identically and still
  // makes the pane a scroll container on x, which leaves a `scrollLeft`
  // settable and the class of bug alive. An engine that dropped the
  // declaration reports `auto` here — forced by the `scroll` below, per CSS
  // Overflow 3 — which is the reported bug rather than a near miss.
  expect(pane.overflowX).toBe("clip");
  expect(pane.overflowY).toBe("scroll");
});
