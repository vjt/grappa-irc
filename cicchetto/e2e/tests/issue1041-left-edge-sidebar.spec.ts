// #1041 — the left-edge swipe opens the mobile channel sidebar, and that
// sidebar is ABSENT from the DOM whenever it is not on screen: mounted when the
// gesture commits, destroyed when it hides. Both halves are asserted here as
// VISIBLE outcomes (element count + on-screen geometry), not as a class flip.
//
// Same harness + same limits as #308 INC-A's sibling spec:
//   * chromium, untagged — chromium's TouchEvent/Touch constructors are
//     reliable (webkit's are not — Playwright webkit ≠ real iOS scroll), so the
//     gesture is synthesized in-page. A NARROW viewport forces isMobile() true
//     so `.shell-mobile` mounts and the edge directive binds.
//   * The FEEL (does the drag read right under a real finger, does iOS momentum
//     survive, does the enter animation look like a drawer rather than a pop)
//     is a DEVICE call: synthetic events drive no pixel-scroll and chromium is
//     not iOS Safari. That part is vjt's on-device dogfood, declared as such —
//     this spec does not cover it and must not be read as if it did.
import type { Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { dragScrollback, type Pt, synthEdgeGesture } from "../fixtures/shellTouch";
import { expect, specNick, specUser, test } from "../fixtures/test";

// iPhone-15-ish portrait: narrow enough for isMobile() (max-width query).
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const CHANNEL = AUTOJOIN_CHANNELS[0];

// The mobile drawer instance specifically — the desktop branch mounts the same
// `.shell-sidebar` class in its grid, and scoping under `.shell-mobile` keeps
// this spec honest if that ever renders side by side.
const SIDEBAR = ".shell-mobile .shell-sidebar";

// left→center: the opening gesture.
function leftEdgeOpenSwipe(): Pt[] {
  return [
    { x: 5, y: 400 },
    { x: 70, y: 404 },
    { x: 140, y: 408 },
    { x: 195, y: 410 },
  ];
}

async function openChannel(page: Page): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
}

// Fully slid in: the panel's left edge has reached the viewport's. Asserting
// GEOMETRY, not the `.open` class — a drawer that is classed open while parked
// at translateX(-100%) is off-screen and the operator sees nothing. Polled
// because the enter animation takes 200ms.
async function expectSlidIn(page: Page): Promise<void> {
  await expect.poll(async () => (await page.locator(SIDEBAR).boundingBox())?.x ?? null).toBe(0);
}

test("issue1041 — left-edge right-swipe mounts the sidebar and slides it on screen", async ({
  page,
}) => {
  await openChannel(page);

  // The premise: on mobile the sidebar is not hidden, it is ABSENT.
  await expect(page.locator(SIDEBAR)).toHaveCount(0);

  const { prevented } = await synthEdgeGesture(page, leftEdgeOpenSwipe());

  expect(prevented).toBe(true); // claimed the horizontal gesture
  await expect(page.locator(SIDEBAR)).toBeVisible();
  await expectSlidIn(page);
  // …and it is the real Sidebar, not an empty shell: the channel row is there.
  await expect(page.locator(`${SIDEBAR} [data-window-name="${CHANNEL}"]`)).toBeVisible();
});

test("issue1041 — the backdrop tap hides the sidebar and DESTROYS it (no hidden box left behind)", async ({
  page,
}) => {
  await openChannel(page);
  await synthEdgeGesture(page, leftEdgeOpenSwipe());
  await expectSlidIn(page);

  // Tap the backdrop clear of the panel (the drawer caps at 18rem = 288px on a
  // 390px viewport, so x=350 is uncovered backdrop).
  await page.locator(".shell-drawer-backdrop.open").click({ position: { x: 350, y: 400 } });

  // THE ask: not `display:none`, not `translateX(-100%)` — gone. This is what
  // separates #1041 from the always-mounted `.shell-members` drawer, and it is
  // the assertion that fails if someone "simplifies" the deferred unmount into
  // a permanent mount with a class toggle.
  await expect(page.locator(SIDEBAR)).toHaveCount(0);
});

test("issue1041 — picking the ALREADY-selected row still dismisses the drawer", async ({
  page,
}) => {
  await openChannel(page);
  await synthEdgeGesture(page, leftEdgeOpenSwipe());
  await expectSlidIn(page);

  // Deliberately the row that is already active: a Shell-side effect watching
  // `selectedChannel()` — the obvious alternative to Sidebar's restored
  // `onSelect` prop — sees no change here and would leave the drawer stuck open
  // over the window the operator just asked for. This case is why the prop came
  // back, so it is the case that has to be pinned.
  await page.locator(`${SIDEBAR} [data-window-name="${CHANNEL}"] .sidebar-window-btn`).click();

  await expect(page.locator(SIDEBAR)).toHaveCount(0);
});

// THE hard constraint (#308), inherited by the new arm: a vertical drag that
// STARTS at the left edge is never claimed → never preventDefaulted → the
// browser owns the vertical scroll, and nothing mounts. If this ever
// preventDefaults, native scroll on the left third of every mobile screen is
// broken.
//
// issue 2465 — measured as a REAL drag (chromium hit-tests the finger and
// scrolls the pane itself) instead of a TouchEvent dispatched on the shell
// root: the root scrolls nothing, so "the browser keeps it" there was the
// whole-shell pan the Shell's guard now cancels. What the constraint protects
// is the scroll, so the scroll is what is asserted.
test("issue1041 — a vertical drag from the left edge never hijacks scroll (no mount, no preventDefault)", async ({
  page,
}) => {
  await openChannel(page);

  const drag = await dragScrollback(page, [
    { x: 5, y: 200 },
    { x: 7, y: 300 },
    { x: 4, y: 430 },
    { x: 5, y: 520 },
  ]);

  // Pre-state: the finger lands on the pane, the pane can scroll, and it has
  // room to scroll toward older rows (finger down → scrollTop decreases).
  expect(drag.landsOnScroller).toBe(true);
  expect(drag.overflowPx).toBeGreaterThan(400);
  expect(drag.scrollTopBefore).toBeGreaterThan(200);
  expect(drag.moves).toBeGreaterThan(0);

  expect(drag.prevented).toBe(false); // vertical was left entirely to the browser
  expect(drag.scrollTopAfter).toBeLessThan(drag.scrollTopBefore - 100); // …which scrolled it
  await expect(page.locator(SIDEBAR)).toHaveCount(0);
});

test("issue1041 — a rightward swipe from the CENTER does not mount the sidebar (zone separation)", async ({
  page,
}) => {
  await openChannel(page);

  const { prevented } = await synthEdgeGesture(page, [
    { x: 195, y: 400 },
    { x: 275, y: 404 },
    { x: 365, y: 408 },
  ]);

  expect(prevented).toBe(false); // center gesture is not armed → never claims
  await expect(page.locator(SIDEBAR)).toHaveCount(0);
});

// An open overlay is a CHILD of `.shell-mobile`, so its touches still bubble to
// the edge directive. Without the overlay guard in Shell the left swipe would
// stack a second drawer underneath the members drawer that is already up.
test("issue1041 — the left swipe is refused while the members drawer is open", async ({ page }) => {
  await openChannel(page);

  // #308 INC-A's own gesture: right→center opens members.
  await synthEdgeGesture(page, [
    { x: 385, y: 400 },
    { x: 320, y: 404 },
    { x: 250, y: 408 },
    { x: 195, y: 410 },
  ]);
  await expect(page.locator(".shell-members.open")).toBeVisible();

  await synthEdgeGesture(page, leftEdgeOpenSwipe());

  await expect(page.locator(SIDEBAR)).toHaveCount(0);
  await expect(page.locator(".shell-members.open")).toBeVisible(); // untouched
});
