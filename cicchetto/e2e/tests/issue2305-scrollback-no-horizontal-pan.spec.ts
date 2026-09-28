// issue 2305 — the scrollback pane must never pan sideways, asserted on the
// COMPUTED value in a real engine.
//
// WHY THIS EXISTS NEXT TO `src/__tests__/scrollbackNoHorizontalPan.test.ts`,
// WHICH IS NOT REDUNDANT WITH IT. That file is a textual scan of the
// stylesheet: it reads `.scrollback`'s rule body and pins what the body
// DECLARES for the x axis, that the `overflow` shorthand is absent, and that
// exactly one rule block decides the pane's overflow. Those are strong and
// they stay. But it measures the TEXT DECLARED in one file, and two things
// can still be true with it green:
//
//   1. A LATER rule — anywhere in the sheet, in a media query, in a
//      `html.is-ios27-band` block, in a file the scan never opens — is more
//      specific and wins the cascade. The scan looks at one selector in one
//      file and cannot see a competitor by construction.
//   2. The ENGINE COMPUTES THE DECLARED VALUE INTO A DIFFERENT ONE, which is
//      not a hypothetical: it is what happened here, and it is why this file
//      exists. The rule shipped `overflow-x: clip` and the scan went green on
//      it while both engines resolved `hidden` — CSS Overflow 3 computes a
//      `clip` on one axis to `hidden` when the other axis scrolls, and this
//      pane must scroll in y. Measured at `about:blank` on detached elements,
//      reading both axes in one pass, Chrome 147 and Mobile Safari 26.4
//      agreeing to the character: clip+visible→clip, clip+scroll→HIDDEN,
//      clip+clip→clip, clip+auto→HIDDEN, hidden+scroll→hidden. The engine
//      PARSES `clip` and then computes it away.
//
// jsdom can arbitrate neither: it resolves no cascade and implements no
// layout, so there is no computed overflow in there to read. This spec asks
// the engine what it actually resolved.
//
// WHY BOTH TAGS, WHICH IS TO SAY: WHY TWO ENGINES. Point 2 is a question
// about what an ENGINE does with a declaration, so a gate that asks it of
// exactly one engine has answered half of its own question. `@webkit` puts
// this on `webkit-iphone-15`, the platform vjt's iOS PWA screenshot of
// `#irc40` came from; `@touch` puts it on `chromium-pixel-touch`, the Blink
// half. Both engines agreeing is also what tells a spec-mandated computed
// value apart from a per-engine quirk — though it does NOT rule out a shared
// toolchain cause, since both load the same bundle from the same build.
//
// 🔴 A tag is an opt-IN to a touch project and simultaneously an opt-OUT of
// the desktop default: `chromium`'s `grepInvert` is the complement of the two
// touch projects' greps, so a tagged spec does not also run there. Read the
// config header's "also runs on" as "in addition to the other touch project",
// never as additive to the desktop. Measured on `playwright test --list`:
// untagged this file would be collected once, on desktop `chromium` alone;
// with both tags it is collected twice, once per touch project, and never on
// the desktop. Nothing is lost by that — `chromium-pixel-touch` is the same
// engine as the desktop project, so the Blink answer is covered either way.
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
   * The other half of the claim, and the axis the whole rule exists to
   * PRESERVE. A one-value `overflow` shorthand would set both axes and read
   * `hidden` here too, which is indistinguishable from the fix on x and kills
   * the scrolling this pane exists for — so this is the value that separates
   * the two.
   */
  overflowY: string;
  /**
   * POS CTRL, read in the SAME `evaluate` as the two values above, from the
   * SAME rule block. Both are declared by `.scrollback` (`flex: 1` and
   * `min-height: 0`) and both differ from their initial values (`0` and
   * `auto`), so they can only read as pinned here if the element really is
   * the pane AND the stylesheet really reached it. Without them a green on
   * `overflowX` would not distinguish "the engine resolved the pane's own
   * rule" from "I measured something else entirely" — and an element that is
   * absent or unstyled is exactly how a spec goes green while proving
   * nothing.
   */
  control: { flexGrow: string; minHeight: string };
  /**
   * Second half of the control: a box with area. A computed overflow on a
   * `display: none` subtree is a value nobody paints, so the pane has to be
   * laid out for the reading to mean anything.
   */
  laidOut: boolean;
};

test("@webkit @touch issue2305 — the scrollback pane resolves overflow-x: hidden and keeps scrolling vertically", async ({
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

  // The claim, and `hidden` EXACT is the strong form rather than the lax one.
  // The reported bug is `auto` — an axis left to fall through and become a
  // real horizontal scroller — and `auto`, `scroll` and `visible` all stay
  // red here. What the exact match ADDS is that `clip` goes red too, which is
  // deliberate: `clip` is the value this rule first shipped, and it is
  // unreachable while the axis below scrolls. A `clip|hidden` alternation
  // would accept it back and hide exactly the regression this spec was
  // written to find.
  expect(pane.overflowX).toBe("hidden");
  expect(pane.overflowY).toBe("scroll");
});
