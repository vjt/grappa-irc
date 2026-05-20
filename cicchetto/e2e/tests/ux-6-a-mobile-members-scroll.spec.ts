// UX-6 bucket A — scroll-leak universal fix on mobile overlays.
//
// vjt 2026-05-20 dogfood: opening members drawer or archive window on
// iPhone STILL allows the entire app chrome to scroll underneath.
// UX-5 BO (`03a08f5`) added `touch-action: pan-y` +
// `overscroll-behavior: contain` to 6 `.shell-mobile` descendants
// (settings + archive + image-upload + home + admin + admin-tab-panel
// + members WRAPPER). UX-5 BM (`dd01dba`) moved the members drawer's
// scroll authority OFF the `.shell-members` wrapper (now
// `overflow-y: visible`, footer-launcher flex container) ONTO the
// inner `.members-pane` (`overflow-y: auto; flex: 1 1 auto`) — but
// BM did NOT migrate the carve-out pair onto the new scroller. So
// `.shell-mobile .shell-members .members-pane` today: `overflow-y:
// auto` but `touch-action` defaults to the inherited
// `.shell-mobile { touch-action: none }` blanket (UX-3 PENT
// ~:2144) and `overscroll-behavior` defaults to `auto`.
//
// Consequence: vertical pan inside the members list is rejected at
// gesture origin (touch-action: none inherited), iOS escalates to
// the document, `installScrollPin` (`lib/viewportHeight.ts:95-108`)
// snap-yanks `window.scrollTo(0, 0)` producing the visible flicker
// + apparent body-scroll-leak vjt sees.
//
// Fix: mirror `.settings-drawer` / `.archive-modal` — re-assert
// `touch-action: pan-y` + `overscroll-behavior: contain` on the
// ACTUAL scrolling element `.shell-mobile .shell-members .members-pane`,
// not just the wrapper. One-feature-one-code-path: the wrapper rule
// (~:2252) is now decorative-only (no own scroll); the scroller rule
// (~:2273) takes the gesture-routing responsibility.
//
// CSS-source-walker pattern per UX-5 BO + BD: assert via
// `getComputedStyle` against the actual rendered surface. We don't
// drive a real iOS touchmove from Playwright (webkit emulation
// doesn't faithfully reproduce iOS Safari's `installScrollPin`
// escalation chain — BO's caveat). The CSS contract assertion
// catches the regression on every run.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`:
// subject-shape-agnostic CSS contract — registered vjt suffices.

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

async function computedTouchAction(page: import("@playwright/test").Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      touchAction: cs.touchAction,
      overscrollBehaviorY: cs.overscrollBehaviorY,
      overflowY: cs.overflowY,
    };
  });
}

test("@webkit ux-6-a — mobile members pane (the actual scroller) asserts touch-action: pan-y + overscroll-behavior: contain", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Open the members drawer from a channel window (mobile path: the
  // hamburger trio lives in the topic bar on `.shell-mobile`).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await page.getByLabel(/open members sidebar/i).tap();
  await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });

  // The members-pane is the INNER scroll authority post-UX-5 BM:
  // wrapper `.shell-members` is `overflow-y: visible` (a flex column),
  // inner `.members-pane` carries `overflow-y: auto`. Gesture-routing
  // must live on the element that actually scrolls, otherwise the
  // pan is rejected at gesture origin (inherited touch-action: none
  // from `.shell-mobile` blanket) and iOS escalates to document
  // (-> installScrollPin snap-yank -> visible flicker / body-leak).
  const styles = await computedTouchAction(page, ".shell-mobile .shell-members .members-pane");
  expect(styles.overflowY).toBe("auto");
  expect(styles.touchAction).toBe("pan-y");
  expect(styles.overscrollBehaviorY).toBe("contain");
});

test("@webkit ux-6-a — opening members drawer adds html.overlay-open; closing removes it", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Baseline: no overlay open → no class on <html>.
  const hasOverlayClass = () =>
    page.evaluate(() => document.documentElement.classList.contains("overlay-open"));
  expect(await hasOverlayClass()).toBe(false);

  // Open members drawer → class lands.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await page.getByLabel(/open members sidebar/i).tap();
  await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });
  await expect.poll(hasOverlayClass).toBe(true);

  // Close drawer by tapping the backdrop on the LEFT half (drawer
  // is right-aligned, max-width 18rem; pointer events on the right
  // portion hit the aside / members-pane, which intercepts). The
  // backdrop's onClick handler in Shell.tsx ~:390 dispatches
  // setMembersOpen(false). Using { position } pins the tap to the
  // viewport coordinate space directly so the click lands on the
  // backdrop, not the drawer.
  await page.locator(".shell-drawer-backdrop.open").click({ position: { x: 10, y: 100 } });
  await expect(page.locator(".shell-members.open")).toHaveCount(0);
  await expect.poll(hasOverlayClass).toBe(false);
});

test("@webkit ux-6-a — html.overlay-open suspends root touch-action so gesture-escalation can't reach installScrollPin", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // The CSS contract for `html.overlay-open { touch-action: none }`
  // (default.css ~:145). This is the root-level escalation killer:
  // when any overlay is open, root touch-action goes to `none` so
  // iOS can't escalate the gesture past the overlay's own `pan-y`
  // carve-out. Asserted by toggling the class manually + reading
  // computed style — Playwright webkit can't faithfully reproduce
  // the gesture escalation itself (BO's caveat); the CSS contract
  // is the deterministic regression guard.
  await page.evaluate(() => document.documentElement.classList.add("overlay-open"));
  const ta = await page.evaluate(() => getComputedStyle(document.documentElement).touchAction);
  expect(ta).toBe("none");
  await page.evaluate(() => document.documentElement.classList.remove("overlay-open"));
});
