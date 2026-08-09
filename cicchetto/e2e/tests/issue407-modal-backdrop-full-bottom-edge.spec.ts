// #407 — the one shape the extraction left without a witness.
//
// `.modal-backdrop` carries the scrim's paint and centring and DELIBERATELY no
// geometry: on its own it is `position: fixed` with `left/right/top: 0` and no
// bottom and no height — a zero-height box. Every scrim must also wear exactly
// one geometry variant. `.modal-backdrop-viewport` adds the #143 keyboard-aware
// height; `.modal-backdrop-full` adds the one declaration that makes the scrim
// span the layout viewport: `bottom: 0`.
//
// `modalChrome.test.ts` pins all of that, but jsdom applies no stylesheet — it
// proves what the cascade is ASKED to do, never what a browser paints. Two of
// the three shapes already have a real-browser witness: issue219 clicks
// `.names-modal-close` and waits for the modal to hide, and issue232 clicks
// `.mode-modal-backdrop` at (6, 6). The `-full` geometry had none, and the two
// modals that use it (confirm, delete-account) both dismiss on scrim click with
// no spec clicking either.
//
// WHY THE BOTTOM AND NOT THE CORNER issue232 USES. A click at (6, 6) lands on
// any box anchored at `top: 0`, so it passes whether or not the scrim has a
// height at all — it cannot tell `.modal-backdrop-full` from the bare base.
// `bottom: 0` is the single declaration the variant contributes, so the click
// has to go where only that declaration can carry it: the bottom edge.
//
// RED / GREEN: drop `bottom: 0` from `.modal-backdrop-full`, or ship the scrim
// wearing the base with no geometry variant, and the scrim collapses to zero
// height — the box assertion names it, and the click falls through to the
// window chrome behind while the modal stays open. Restore either and it
// passes. The bottom-left corner is clear of occluders by construction: the
// only rules at or above the scrim's z-index are `.error-banners` (z 1000) and
// `.diag-float` (z 99999), and both are anchored to the TOP.
//
// The confirm modal is opened through the destructive close × (#195) and then
// DISMISSED, which is the safe branch — it never PARTs. The spec asserts the
// channel is still there afterwards, so a regression that turned dismissal into
// confirmation could not hide behind a green scrim test. Registered vjt seed;
// desktop chromium (untagged — an iPhone run would measure the VISUAL viewport,
// which is the other variant's business).

import {
  confirmModal,
  loginAs,
  selectChannel,
  sidebarCloseButton,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

test("#407 the -full scrim spans to the viewport bottom, and a click there dismisses", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // #195 — the destructive close × opens the leave-channel confirm.
  await sidebarCloseButton(page, NETWORK_SLUG, CHANNEL).click();
  const confirm = confirmModal(page);
  await expect(confirm).toBeVisible({ timeout: 5_000 });

  const scrim = page.locator(".confirm-modal-backdrop");
  await expect(scrim).toHaveClass(/\bmodal-backdrop\b/);
  await expect(scrim).toHaveClass(/\bmodal-backdrop-full\b/);

  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("no viewport size — headless config changed");
  const box = await scrim.boundingBox();
  if (box === null) throw new Error("the scrim has no box: it is not rendered");

  // Named first, so a collapsed scrim reports as a geometry failure rather than
  // as an out-of-bounds click position further down.
  expect(Math.round(box.y), "the scrim must start at the viewport top").toBe(0);
  expect(Math.round(box.y + box.height), "the scrim must reach the viewport bottom").toBe(
    viewport.height,
  );

  // The hit test the box assertion cannot stand in for: the scrim must actually
  // RECEIVE a pointer event down there, not merely measure as if it would.
  await scrim.click({ position: { x: 6, y: box.height - 6 } });
  await expect(confirm).toHaveCount(0, { timeout: 5_000 });

  // Dismissed, not confirmed — the channel is still in the sidebar.
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1);
});
