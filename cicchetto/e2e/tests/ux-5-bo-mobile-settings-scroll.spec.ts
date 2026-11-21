// UX-5 bucket BO — mobile scroll-leak: surfaces inside `.shell-mobile`
// must opt back in to vertical pan or iOS escalates the gesture.
//
// Pre-bucket: `.settings-drawer`, `.archive-modal`, `.image-upload-modal`
// (the privacy modal), `.home-pane`, `.admin-pane`, `.admin-tab-panel`
// are all DOM descendants of `.shell.shell-mobile`. UX-3 PENT set
// `touch-action: none` on `.shell-mobile` to block iOS Safari's
// URL-bar reveal gesture. touch-action inherits, so every descendant
// inherits the pan-blanket. Touch pans inside any of those surfaces
// get rejected; iOS escalates the gesture to the document; the
// `installScrollPin` snap-yanks `window.scrollTo(0, 0)`, producing
// the visible flicker vjt reported on the settings drawer.
//
// Reviewer-loop dragon (post-investigation): the bug class is not
// modals-only — any `.shell-mobile` descendant with `overflow-y: auto`
// that doesn't re-assert touch-action shares the trap. Adjacent
// victims: `.home-pane` (default mount, tall on iPhone),
// `.admin-pane` + `.admin-tab-panel` (admin tabs).
//
// Working reference: the mobile `.shell-members` rule in default.css
// (members drawer, also a `.shell-mobile` descendant) explicitly
// re-asserts `touch-action: pan-y`. The six surfaces here simply missed
// the UX-3 PENT carve-out pass.
//
// Fix: mirror `.shell-members` — `touch-action: pan-y` on each affected
// selector, with `overscroll-behavior: contain` beside it at the time.
// Since issue 2671 that containment is declared once, in the shared
// rules at the top of default.css, and since its C5 follow-up
// `.admin-tab-panel` takes none: it is nested in `.admin-pane`, which
// stays contained.
//
// This spec asserts the CSS contract via getComputedStyle. We don't
// try to drive a touchmove gesture from Playwright (webkit's touch
// emulation doesn't faithfully reproduce iOS Safari's gesture
// escalation; the bug was operator-observed, the CSS contract is what
// we can verify deterministically). Style assertions catch the
// regression on every run; the operator-visible bug returns
// immediately if the CSS regresses.
//
// Coverage matrix:
//   - SettingsDrawer + ArchiveModal + HomePane: assert via computed
//     style. PrivacyModal + AdminPane / AdminTabPanel carry the
//     touch-action half but aren't asserted here — Privacy is short
//     ephemeral content; admin requires admin-user setup +
//     navigation (deferred to m-z journey spec if it ever flakes).
//     AdminTabPanel no longer gets `overscroll-behavior: contain`
//     (issue 2671 C5): a `contain` assertion on it would be wrong.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: subject-
// shape-agnostic CSS contract — registered vjt suffices.

import {
  loginAs,
  openRailMenu,
  openSettingsMobile,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

async function computedTouchAction(page: import("@playwright/test").Page, selector: string) {
  return page.locator(selector).evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      touchAction: cs.touchAction,
      overscrollBehaviorY: cs.overscrollBehaviorY,
    };
  });
}

test("@webkit @touch ux-5-bo — settings drawer asserts touch-action: pan-y + overscroll-behavior: contain", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // #71 INC-2 — on mobile home the settings cog lives in the rail's
  // ActionCluster (drawer top); reach it via the shared helper: open the rail
  // drawer (☰ rail opener on this non-channel window) → tap the cog.
  await openSettingsMobile(page);
  const drawer = page.locator(".settings-drawer.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });

  const styles = await computedTouchAction(page, ".settings-drawer.open");
  // touch-action: pan-y allows vertical scroll inside the drawer while
  // still blocking horizontal back-swipe gestures. Without this, the
  // drawer inherits `touch-action: none` from `.shell-mobile` and pan
  // gestures escalate to the document.
  expect(styles.touchAction).toBe("pan-y");
  // overscroll-behavior: contain prevents the scroll chain from
  // bubbling to the document body when the drawer's inner scroll
  // hits its edge (the flicker symptom in the operator-visible bug).
  expect(styles.overscrollBehaviorY).toBe("contain");
});

test("@webkit @touch ux-5-bo — settings drawer has an internal scroll authority (overflow-y: auto precondition)", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Same #71 INC-2 rail-drawer path as above.
  await openSettingsMobile(page);
  const drawer = page.locator(".settings-drawer.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });

  // Regression-guard `overflow-y: auto` on `.settings-drawer`. This is
  // a NECESSARY PRECONDITION for the touch-action: pan-y fix above to
  // matter: without an internal scroll container, gesture-routing is
  // moot. Programmatic `el.scrollTop = N` exercises the API path, not
  // the touch-gesture path (which Playwright's webkit emulation can't
  // faithfully reproduce against iOS Safari's real `installScrollPin`
  // escalation). The CSS computed-style assertion above is the real
  // bug contract; this test guards against a future refactor that
  // strips `overflow-y: auto` and silently re-breaks the chain.
  await drawer.evaluate((el) => {
    el.scrollTop = 200;
  });

  const drawerScroll = await drawer.evaluate((el) => el.scrollTop);
  expect(drawerScroll).toBeGreaterThan(0);
});

test("@webkit @touch ux-5-bo — archive modal asserts touch-action: pan-y + overscroll-behavior: contain", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Archive button is only rendered when a channel/query window is
  // focused (ShellChrome's `archiveSlug()` returns null on home /
  // mentions / admin). Select the autojoin channel so the chrome
  // archive button surfaces.
  //
  // UX-5 bucket BM (2026-05-20) — on mobile-channel the archive button
  // is no longer inline in the topic-bar (UX-5 BT inlined it; BM
  // moved it again into the members drawer footer as a launcher).
  // Open the drawer first via the hamburger, then tap the launcher.
  // Mutex side-effect: tapping the archive launcher closes the
  // drawer, which is precisely the post-tap state the test cares
  // about (we want the archive modal open, not the drawer).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await page.getByLabel(/open members sidebar/i).tap();
  await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });
  // #500 — the archive button lives behind the RailActions launcher menu (in the
  // DOM only after the launcher is tapped). Reveal it, then tap the archive row
  // from `.rail-actions-menu` where it now renders.
  await openRailMenu(page);
  await page.locator(".rail-actions-menu [data-testid='mobile-panel-archive']").tap();
  const modal = page.locator(".archive-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });

  const styles = await computedTouchAction(page, ".archive-modal");
  expect(styles.touchAction).toBe("pan-y");
  expect(styles.overscrollBehaviorY).toBe("contain");
});

test("@webkit @touch ux-5-bo — home pane asserts touch-action: pan-y (same .shell-mobile trap)", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Home pane is the default mount on login (no channel selected) —
  // it lives inside `.shell-main` → `.shell-mobile` and was a
  // confirmed adjacent victim of the same inherited-touch-action: none
  // trap as the modals. Reviewer dragon: without this re-assertion,
  // tall home pane (network rows + [Reconnect] chips from BR + onboard
  // copy) wouldn't scroll on iPhone.
  const home = page.locator(".home-pane");
  await expect(home).toBeVisible({ timeout: 5_000 });

  const styles = await computedTouchAction(page, ".home-pane");
  expect(styles.touchAction).toBe("pan-y");
  expect(styles.overscrollBehaviorY).toBe("contain");
});
