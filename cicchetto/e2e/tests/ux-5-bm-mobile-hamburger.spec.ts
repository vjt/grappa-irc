// UX-5 bucket BM — mobile-channel hamburger compress.
//
// Pre-bucket (post-UX-5-BT) mobile-channel `.topic-bar` row holds THREE
// affordances on the right edge: members hamburger (☰), archive (📂),
// settings cog (⚙). vjt 2026-05-19 dogfood: three buttons crowd the
// narrow row; collapse them behind the existing hamburger.
//
// Post-bucket end state:
//   * Mobile + channel `.topic-bar`: archive + cog buttons NOT inline
//     anymore — only the members hamburger remains.
//   * Tapping the hamburger opens `.shell-members.open` as before.
//   * Inside the open members drawer: bottom-fixed `.mobile-panel-actions`
//     footer holds two launcher buttons — settings + archive (when
//     network context exists).
//   * Tapping the in-drawer settings launcher: drawer closes,
//     SettingsDrawer opens. Mutex enforced via `lib/mobilePanel.ts`.
//   * Tapping the in-drawer archive launcher: drawer closes,
//     ArchiveModal opens.
//   * Mobile + home / mentions / admin / server: unchanged from UX-5 BT
//     (standalone `.shell-chrome` row still holds archive + cog — there's
//     no members hamburger on non-channel windows to host the launchers).
//   * Desktop: unchanged — desktop members aside has no launcher footer.
//
// jsdom doesn't compute layout / cascade `@media` — per
// `feedback_cicchetto_browser_smoke` this layout fix MUST ship a
// Playwright e2e. Mobile arm pins the new hamburger-as-only-button
// contract + drawer launcher contract + mutex. Desktop arm pins the
// negative-twin (desktop members aside has NO launcher footer).
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: UI shape
// contract, subject-shape-agnostic. Registered seed suffices.

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

test("ux-5-bm desktop — members aside has NO launcher footer", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

  // Desktop chrome unchanged: standalone .shell-chrome row + .topic-bar.
  await expect(page.locator(".shell-chrome")).toHaveCount(1);
  await expect(page.locator(".topic-bar")).toHaveCount(1);

  // Negative-twin: desktop members aside does NOT carry the BM launcher
  // footer. Launcher footer is mobile-only.
  await expect(page.locator(".shell-members .mobile-panel-actions")).toHaveCount(0);
});

test("@webkit ux-5-bm mobile-channel — topic-bar hosts hamburger only; drawer hosts settings+archive launchers; mutex enforced", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Topic-bar compression contract: hamburger is the ONLY affordance on
  // the right edge. archive + cog NOT inline anymore.
  await expect(page.locator(".topic-bar [aria-label='open members sidebar']")).toHaveCount(1);
  await expect(page.locator(".topic-bar [data-testid='shell-chrome-cog']")).toHaveCount(0);
  await expect(page.locator(".topic-bar [data-testid='shell-chrome-archive']")).toHaveCount(0);

  // Standalone .shell-chrome row STAYS absent on mobile-channel (UX-5 BT
  // contract preserved — BM doesn't reintroduce it).
  await expect(page.locator(".shell-chrome")).toHaveCount(0);

  // Tap hamburger → drawer opens.
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });

  // Members populated per `feedback_e2e_visitor_members_list`.
  const memberNames = drawer.locator(".members-pane .member-name");
  await expect.poll(async () => await memberNames.count()).toBeGreaterThan(0);
  await expect(drawer).toContainText(NETWORK_NICK);

  // Bottom-fixed launcher footer hosts BOTH settings + archive buttons.
  const launcherFooter = drawer.locator(".mobile-panel-actions");
  await expect(launcherFooter).toBeVisible();
  await expect(launcherFooter.locator("[data-testid='mobile-panel-settings']")).toHaveCount(1);
  await expect(launcherFooter.locator("[data-testid='mobile-panel-archive']")).toHaveCount(1);

  // Tap settings launcher → drawer closes, SettingsDrawer opens.
  await launcherFooter.locator("[data-testid='mobile-panel-settings']").tap();
  await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".settings-drawer.open")).toBeVisible({ timeout: 5_000 });

  // Close settings (× button). Re-open the drawer to test archive launcher.
  await page.locator(".settings-drawer [data-testid='settings-drawer-close']").tap();
  await expect(page.locator(".settings-drawer.open")).toHaveCount(0, { timeout: 5_000 });

  await page.getByLabel(/open members sidebar/i).tap();
  await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });

  // Tap archive launcher → drawer closes, ArchiveModal opens.
  await page
    .locator(".shell-members.open .mobile-panel-actions [data-testid='mobile-panel-archive']")
    .tap();
  await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".archive-modal")).toBeVisible({ timeout: 5_000 });
});

// NOTE: the reverse-transition (settings-open → hamburger tap closes
// settings + opens drawer) is NOT testable as an e2e flow. SettingsDrawer
// + ArchiveModal each cover the full viewport on mobile (slide-in from
// right, backdrop intercepts taps). The topic-bar hamburger is behind
// them and unreachable via tap. In real iPhone UX the operator's reverse
// path is × (close) → tap hamburger — both halves pinned individually
// (× close in the main mutex test above, hamburger open in the first
// mutex test). The `toggleMembersPanel` close-siblings arm itself is
// pinned at the unit level by `src/__tests__/mobilePanel.test.ts`.

test("@webkit ux-5-bm mobile-non-channel — standalone .shell-chrome row preserved on home", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Cold-load lands on home. BM scope is mobile-channel only — non-
  // channel windows keep the standalone .shell-chrome row (no members
  // hamburger on home/mentions/admin/server to host the launchers).
  await expect(page.getByTestId("shell-chrome")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".shell-chrome")).toHaveCount(1);
  await expect(page.locator(".topic-bar")).toHaveCount(0);
  // Cog reachable via the standalone row.
  await expect(page.locator(".shell-chrome [data-testid='shell-chrome-cog']")).toBeVisible();
});
