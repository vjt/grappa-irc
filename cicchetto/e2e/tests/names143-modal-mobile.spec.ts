// #143 — NamesModal mobile defects (follow-up to #140). Three fixes:
//
//   1. KEYBOARD OCCLUSION. The modal centered in the full LAYOUT
//      viewport while the visible region (window.visualViewport.height)
//      is shorter when the on-screen keyboard is up — so its lower half
//      sat under the keyboard. Fix: the backdrop now spans the VISIBLE
//      region (`height: var(--viewport-height)`) instead of `inset: 0`,
//      so `align-items: center` centers within what the user can see.
//      UX-6-D's `installSmartScrollPin` already clamps `vv.offsetTop`
//      toward 0, so NO offsetTop math is needed (offsetTop is
//      WebKit-broken — bug #297779, stuck at 24px post-dismiss; the
//      `translateY(offsetTop)` approach failed catastrophically across
//      D6/D8 — see DESIGN_NOTES 2026-05-21 UX-6-D).
//
//   3. CLOSE × TAP TARGET. Bumped to the project-standard 44px Apple-HIG
//      hit box (the #133 precedent shared by every top-pinned card ×).
//
// (#2, denser per-row spacing, is a pure visual CSS tweak with no
//  deterministic geometry contract worth asserting — it's covered by
//  the CSS rule + on-device review.)
//
// CHROMIUM LIMITATION (feedback_playwright_webkit_not_ios_scroll):
// chromium's layout viewport == its visual viewport (there is no OS
// keyboard), so it CANNOT reproduce the real iOS layout/visual
// divergence that triggers the occlusion. This spec therefore asserts
// the CSS CONTRACT, not the iOS physics: with `--viewport-height` pinned
// to a keyboard-shrunk value (exactly what `installViewportHeightTracker`
// writes from `vv.height` on iOS — unit-covered in
// viewportHeight.test.ts), the modal stays fully inside that visible
// region. Real on-device occlusion still needs Mezmerize dogfood before
// final close — flagged on #grappa.

import type { Page } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Stand-in for "the keyboard leaves ~300px of the screen visible". The
// window stays full-height; only the visible-region var shrinks — the
// same shape iOS produces (full layout viewport, short visual viewport).
const FAKE_VISIBLE_PX = 300;

async function openNamesModal(page: Page) {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await composeSend(page, `/names ${CHANNEL}`);
  const modal = page.getByTestId("names-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  return modal;
}

test("#143 — NamesModal stays within the keyboard-shrunk visible viewport", async ({ page }) => {
  const modal = await openNamesModal(page);

  // Simulate the iOS keyboard-up state: pin the visible-region var to a
  // value far below the window height. `installViewportHeightTracker`
  // would write this from `vv.height`; we set it directly because
  // chromium has no keyboard to shrink the visual viewport.
  await page.evaluate((px) => {
    document.documentElement.style.setProperty("--viewport-height", `${px}px`);
  }, FAKE_VISIBLE_PX);

  // The modal must stay fully inside [0, FAKE_VISIBLE_PX]; its bottom
  // edge cannot fall into the keyboard region. Pre-fix, the backdrop
  // centered in the full layout viewport, parking the lower half below.
  const box = await modal.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    expect(box.y).toBeGreaterThanOrEqual(-1);
    expect(box.y + box.height).toBeLessThanOrEqual(FAKE_VISIBLE_PX + 1);
  }
});

test("#143 — NamesModal close × is a 44px Apple-HIG tap target (#133)", async ({ page }) => {
  const modal = await openNamesModal(page);

  const box = await modal.getByLabel("close names").boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  }
});
