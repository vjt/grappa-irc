// #1438 — a vertical drag on the media viewer dismisses it, and the modal
// follows the finger on the way out.
//
// WHAT THESE PROVE, and what they deliberately do not:
//
//   1. DISMISSAL (chromium): a synthesized vertical drag on the modal makes the
//      viewer GO AWAY. The outcome asserted is the visible one — the dialog is
//      gone — not that a callback fired. Reverting the wiring turns this red.
//   2. DISPLACEMENT (chromium): mid-drag, the browser's own computed matrix
//      says the modal has moved by exactly the finger's travel and by nothing
//      else. That second half is the point: the modal is centered by a CSS
//      `transform: translate(-50%, -50%)` that an inline transform REPLACES, so
//      a paint that forgot to re-state it would displace the modal by half its
//      own height and this assertion is what measures the difference.
//   3. CSS CONTRACT (@webkit, iPhone 15): the modal container is
//      `touch-action: none` on the real target browser, so iOS hands the whole
//      vertical drag to our JS instead of reading it as its own overscroll.
//      Same guard shape as #213's third test, on the container rather than the
//      image because a <video> has to dismiss like an <img>.
//
// NOT PROVEN ANYWHERE, on purpose rather than by omission:
//
//   * The FEEL. A synthesized TouchEvent drives no compositor and Playwright's
//     webkit does not reproduce real iOS scroll physics
//     (feedback_playwright_webkit_not_ios_scroll), so nothing here says the
//     follow is smooth or that DISMISS_COMMIT_FRACTION = 0.15 is the right
//     threshold. That is a device call — vjt's, on a phone, post-ship, exactly
//     as the sibling #213 gesture was calibrated.
//   * That a <video>'s NATIVE CONTROLS survive the gesture. The argument is
//     that a vertical claim never takes a scrubber drag (which is horizontal)
//     and never takes a tap under the 8px slop — but the controls live in the
//     UA shadow DOM, `closest()` cannot see them, and no assertion here
//     reaches them. The video's DISMISSAL is covered in jsdom
//     (MediaViewerModal.test.tsx); the controls are not covered at all.
//
// The binder's decision table — which drags commit, which spring back, what it
// refuses to claim — is unit-tested against a bare element in
// src/__tests__/mediaViewerGesture.test.ts. These are the end-to-end doors.

import type { Locator, Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { openMediaViewerInPlace, uploadImageAndGetLink } from "../fixtures/mediaViewer";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Upload a tiny image and open it in the media viewer, mirroring #213's
// harness: the anchor's OWN click opens the overlay (no Playwright
// scroll-into-view).
//
// The duplication this used to carry — "these six lines across nine files",
// out of scope when #1438 landed — is now fixtures/mediaViewer.ts (#1441). What
// is left here is the login + channel selection this spec's three tests share.
async function openImageViewer(page: Page): Promise<{ viewer: Locator }> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  const { link } = await uploadImageAndGetLink(page, "x1438.png");
  return { viewer: await openMediaViewerInPlace(page, link) };
}

// One vertical drag on the modal, plus the browser's own reading of where the
// modal sat before and during it. Body inlined in the page rather than passed
// as a stringified function: `new Function` in page context is eval, and cic
// serves a CSP with no `unsafe-eval` — the drag would throw where it matters
// and nowhere else.
//
// `dy` is applied in TWO moves because the binder claims LATE: it decides on a
// touchmove, never on the touchstart. `lift` is optional so a caller can read
// the paint with the finger still down, which is the only moment it exists.
async function dragOnModal(
  viewer: Locator,
  dy: number,
  lift: boolean,
): Promise<{ before: number; after: number }> {
  return viewer.evaluate(
    (el, opts) => {
      // The vertical component of the computed matrix — what the browser
      // actually resolved, not the inline string we wrote.
      const verticalOffset = (): number => new DOMMatrixReadOnly(getComputedStyle(el).transform).f;
      const at = (y: number): Touch =>
        new Touch({ identifier: 1, target: el, clientX: 200, clientY: y });
      const fire = (type: string, touch: Touch): void => {
        const list = type === "touchend" ? [] : [touch];
        el.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: list,
            targetTouches: list,
            changedTouches: [touch],
          }),
        );
      };
      const y0 = 200;
      const before = verticalOffset();
      fire("touchstart", at(y0));
      fire("touchmove", at(y0 + Math.sign(opts.dy) * 40));
      fire("touchmove", at(y0 + opts.dy));
      const after = verticalOffset();
      if (opts.lift) fire("touchend", at(y0 + opts.dy));
      return { before, after };
    },
    { dy, lift },
  );
}

test("#1438 — a downward drag on the viewer dismisses it (chromium)", async ({ page }) => {
  test.slow();
  const { viewer } = await openImageViewer(page);

  // Half a viewport of travel — comfortably past the commit fraction whatever
  // the exact threshold is, so this spec asserts the dismissal and not the
  // calibration of a constant it does not own.
  const half = Math.round((await page.evaluate(() => window.innerHeight)) / 2);
  await dragOnModal(viewer, half, true);

  await expect(viewer).toBeHidden({ timeout: 5_000 });
});

test("#1438 — mid-drag the modal moves by the finger's travel, centering intact (chromium)", async ({
  page,
}) => {
  test.slow();
  const { viewer } = await openImageViewer(page);

  // A correct paint moves the modal by exactly the 90px pulled: the rule's own
  // `translate(-50%, -50%)` contributes -height/2 to that same component, so a
  // paint that dropped the centering would read +height/2 + 90 instead. The
  // two failure modes are far apart, and the browser does the arithmetic.
  const { before, after } = await dragOnModal(viewer, 90, false);

  expect(after - before).toBeCloseTo(90, 0);
});

test("@webkit #1438 — the viewer container is touch-action:none (iPhone 15)", async ({ page }) => {
  test.slow();
  const { viewer } = await openImageViewer(page);

  // Declared on the CONTAINER, not the media element: the UA intersects
  // touch-action down the ancestor chain, which is what makes a <video>
  // dismissible on the same terms as an <img>. Reverting the rule turns this
  // red — and nothing else in the suite would.
  const touchAction = await viewer.evaluate((el) => getComputedStyle(el).touchAction);
  expect(touchAction).toBe("none");
});
