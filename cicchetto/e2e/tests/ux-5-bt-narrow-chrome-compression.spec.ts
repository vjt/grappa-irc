// UX-5 bucket BT — narrow-mode chrome+topic compression + sidebar
// network-name nit (left-align + bold).
//
// Pre-bucket symptoms (vjt 2026-05-19 dogfood):
//   * Narrow viewport (iPhone, ≤768px): TWO rows above the scrollback
//     area — `.shell-chrome` (archive/cog) THEN `.topic-bar`
//     (channel/topic/modes/count/hamburger). Each ~32px tall, together
//     eating ~25% of the visible scrollback on a 393×852 iPhone shape.
//   * Desktop sidebar: the network-header row (UX-4 bucket C) renders
//     the slug `<span class="sidebar-channel-name">` with regular
//     weight and the default `.sidebar-window-btn`
//     `justify-content: space-between` floats it toward the middle of
//     the row instead of left-anchored against the ⚙️ emoji.
//
// Post-bucket end state:
//   * Mobile + channel: `.shell-chrome` row is NOT mounted; the archive
//     + cog buttons live INSIDE `.topic-bar` (one row total above the
//     scrollback area, reclaiming ~32px).
//   * Mobile + home / mentions / admin / server: `.shell-chrome` row
//     STAYS (no TopicBar to absorb the buttons). Cog reachable.
//   * Desktop (any window): unchanged. Two rows on channel windows
//     (chrome + topic-bar separately stacked).
//   * Desktop sidebar: network-header `.sidebar-channel-name` is
//     `font-weight: bold` + the header `.sidebar-window-btn` uses
//     `justify-content: flex-start` so the slug is left-anchored.
//
// jsdom doesn't compute layout / cascade `@media` — per
// `feedback_cicchetto_browser_smoke` this CSS-driven layout fix MUST
// ship a Playwright e2e. Mobile arm pins the inline-vs-standalone
// chrome contract; desktop arm pins the negative-twin (desktop
// unchanged) PLUS the sidebar nit (getComputedStyle on the header
// span + button).
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: UI shape
// contract, subject-shape-agnostic. Registered seed suffices.

import { test, expect } from "@playwright/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

test("ux-5-bt desktop — chrome row + topic-bar SEPARATE; sidebar network-name bold + left-aligned", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Cold-load lands on home. Chrome row mounted; no topic-bar yet.
  await expect(page.getByTestId("shell-chrome")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".shell-chrome")).toHaveCount(1);

  // Switch to a joined channel — topic-bar mounts BELOW the chrome row
  // (negative-twin for the mobile compression: desktop unchanged).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();
  await expect(page.locator(".shell-chrome")).toHaveCount(1);
  await expect(page.locator(".topic-bar")).toHaveCount(1);
  // Cog must NOT be inside .topic-bar on desktop — keeps the two-row
  // layout. Inline cog is mobile-channel-only.
  await expect(page.locator(".topic-bar [data-testid='shell-chrome-cog']")).toHaveCount(0);

  // Sidebar network-name nit: header span computed weight is bold +
  // header button uses flex-start justification. getComputedStyle
  // returns "700" for bold (browser-normalized; "bold" keyword also
  // accepted defensively).
  const headerName = page.locator(
    "li.sidebar-network-header .sidebar-window-btn .sidebar-channel-name",
  );
  await expect(headerName).toBeVisible();
  const headerNameWeight = await headerName.evaluate((el) => getComputedStyle(el).fontWeight);
  expect(["700", "bold"]).toContain(headerNameWeight);

  const headerBtn = page.locator("li.sidebar-network-header .sidebar-window-btn");
  const headerBtnJustify = await headerBtn.evaluate((el) => getComputedStyle(el).justifyContent);
  expect(headerBtnJustify).toBe("flex-start");
});

test("@webkit ux-5-bt mobile — channel: NO standalone .shell-chrome row; cog INSIDE .topic-bar", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Cold-load lands on home — TopicBar absent. Chrome row STAYS on
  // mobile-home (no host row to absorb the buttons).
  await expect(page.getByTestId("shell-chrome")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".shell-chrome")).toHaveCount(1);
  await expect(page.locator(".topic-bar")).toHaveCount(0);

  // Switch to channel via BottomBar (mobile selectChannel handles the
  // tap path internally).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Compression contract: .shell-chrome row NOT mounted in the
  // mobile-channel branch; .topic-bar IS, with the cog inline.
  await expect(page.locator(".topic-bar")).toHaveCount(1);
  await expect(page.locator(".shell-chrome")).toHaveCount(0);
  await expect(page.locator(".topic-bar [data-testid='shell-chrome-cog']")).toHaveCount(1);
  await expect(page.locator(".topic-bar [data-testid='shell-chrome-cog']")).toBeVisible();
  // Archive button (network context present) ALSO inline.
  await expect(page.locator(".topic-bar [data-testid='shell-chrome-archive']")).toHaveCount(1);

  // Per `feedback_e2e_visitor_members_list` — UI-shape spec is
  // registered-class today; satisfy the rule by asserting the members
  // drawer populates after a tap on the inline TopicBar hamburger.
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  const memberNames = drawer.locator(".members-pane .member-name");
  await expect.poll(async () => await memberNames.count()).toBeGreaterThan(0);
  await expect(drawer).toContainText(NETWORK_NICK);
});
