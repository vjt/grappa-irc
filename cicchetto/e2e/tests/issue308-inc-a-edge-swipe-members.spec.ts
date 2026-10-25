// #308 INC-A — the right-edge swipe opens the members drawer (gesture 1),
// an ADDITIVE second door onto the permanent right rail (the BottomBar stays
// the primary nav — #71 ruling). This e2e guards the WIRING + the hard
// constraint, NOT the iOS feel:
//
//   * chromium, untagged — chromium's TouchEvent/Touch constructors are
//     reliable (webkit's are not — feedback_playwright_webkit_not_ios_scroll),
//     so we synthesize the gesture in-page. A NARROW viewport forces
//     isMobile() true so `.shell-mobile` mounts and the edge directive binds.
//   * The FEEL (does a real finger-drag feel right, does native momentum
//     survive) is a device call vjt dogfoods post-deploy — synthetic events
//     can't drive real pixel-scroll.
//
// The load-bearing gates are the swipe/touchGesture unit tests (jsdom); this
// e2e proves the directive is wired to the real Shell + opens the real drawer,
// and — the hard constraint — that a VERTICAL drag is left untouched (never
// preventDefaulted), so native vertical scroll survives.
import type { Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { dragScrollback, synthEdgeGesture } from "../fixtures/shellTouch";
import { expect, specNick, specUser, test } from "../fixtures/test";

// iPhone-15-ish portrait: narrow enough for isMobile() (max-width query).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const CHANNEL = AUTOJOIN_CHANNELS[0];

async function openChannel(page: Page): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
}

test("issue308 INC-A — right-edge left-swipe opens the members drawer", async ({ page }) => {
  await openChannel(page);
  const W = await page.evaluate(() => window.innerWidth);
  await expect(page.locator(".shell-members.open")).toHaveCount(0); // starts closed

  const { prevented } = await synthEdgeGesture(page, [
    { x: W - 5, y: 400 },
    { x: W - 70, y: 404 },
    { x: W - 140, y: 408 },
    { x: W - 195, y: 410 },
  ]);

  await expect(page.locator(".shell-members.open")).toBeVisible();
  expect(prevented).toBe(true); // claimed the horizontal gesture
});

// THE hard constraint, full-stack: a vertical drag STARTING at the right edge
// is never claimed → never preventDefaulted → the browser owns the vertical
// scroll, and no drawer opens. If this ever preventDefaults, native scroll is
// broken — the single most important interaction (#308).
//
// issue 2465 — measured as a REAL drag (chromium hit-tests the finger and
// scrolls the pane itself) instead of a TouchEvent dispatched on the shell
// root: the root scrolls nothing, so "the browser keeps it" there was the
// whole-shell pan the Shell's guard now cancels. What the constraint protects
// is the scroll, so the scroll is what is asserted.
test("issue308 INC-A — a vertical drag from the edge never hijacks scroll (no open, no preventDefault)", async ({
  page,
}) => {
  await openChannel(page);
  const W = await page.evaluate(() => window.innerWidth);

  const drag = await dragScrollback(page, [
    { x: W - 5, y: 200 },
    { x: W - 3, y: 300 },
    { x: W - 6, y: 430 },
    { x: W - 5, y: 520 },
  ]);

  // Pre-state: the finger lands on the pane, the pane can scroll, and it has
  // room to scroll toward older rows (finger down → scrollTop decreases).
  expect(drag.landsOnScroller).toBe(true);
  expect(drag.overflowPx).toBeGreaterThan(400);
  expect(drag.scrollTopBefore).toBeGreaterThan(200);
  expect(drag.moves).toBeGreaterThan(0);

  expect(drag.prevented).toBe(false); // vertical was left entirely to the browser
  expect(drag.scrollTopAfter).toBeLessThan(drag.scrollTopBefore - 100); // …which scrolled it
  await expect(page.locator(".shell-members.open")).toHaveCount(0);
});

test("issue308 INC-A — a horizontal swipe from the CENTER does not open the drawer (zone separation)", async ({
  page,
}) => {
  await openChannel(page);
  const W = await page.evaluate(() => window.innerWidth);

  const { prevented } = await synthEdgeGesture(page, [
    { x: Math.round(W / 2), y: 400 },
    { x: Math.round(W / 2) - 80, y: 404 },
    { x: Math.round(W / 2) - 170, y: 408 },
  ]);

  expect(prevented).toBe(false); // center gesture is not armed → never claims
  await expect(page.locator(".shell-members.open")).toHaveCount(0);
});
