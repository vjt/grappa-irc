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
// UX-5 bucket BM (2026-05-20) → #473 — three buttons on the narrow row
// was still crowded (vjt 2026-05-19 dogfood, follow-up). BM moved archive
// + cog OUT of the topic-bar inline slot into a launcher footer inside the
// mobile members drawer; #473 retired that footer for `.rail-actions`, the
// ONE labelled action drawer at the bottom of `.shell-members` (present on
// both form factors, every window kind). The mobile arm below pins the
// post-state: cog + archive NOT inline in the topic-bar anymore; only the
// hamburger survives on its right edge, and the cog + archive live in the
// rail drawer. The "no standalone .shell-chrome row on mobile-channel"
// contract from BT still holds — that part is BT's reclamation; the buttons
// just moved into the rail without bringing the chrome row back.
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

import { expect, test } from "../fixtures/test";
import {
  closeMembersDrawer,
  loginAs,
  openRailMenu,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

test("ux-5-bt desktop — #71 INC-2: NO chrome row; topic-bar + rail cog; sidebar network-name bold + left-aligned", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Cold-load lands on home. #71 INC-2 removed the desktop .shell-chrome row
  // (cog moved to the permanent right rail); #500 folded the cog behind the rail
  // launcher menu, so open it (desktop: taps the launcher) then assert the cog.
  await openRailMenu(page);
  await expect(
    page.locator(".rail-actions-menu [data-testid='action-cluster-cog']"),
  ).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.locator(".shell-chrome")).toHaveCount(0);
  // #500 — close the launcher menu before switching windows; its full-viewport
  // backdrop would otherwise intercept the selectChannel sidebar click.
  await page.keyboard.press("Escape");
  await expect(page.locator(".rail-actions-menu")).toHaveCount(0, { timeout: 5_000 });

  // Switch to a joined channel — topic-bar mounts (no chrome row above it on
  // desktop anymore; the freed top is the topic's per INC-2).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();
  await expect(page.locator(".shell-chrome")).toHaveCount(0);
  await expect(page.locator(".topic-bar")).toHaveCount(1);
  // Cog must NOT be inside .topic-bar on desktop — it lives in the rail. Assert
  // the LIVE `action-cluster-cog` testid is absent from the topic-bar (the
  // retired `shell-chrome-cog` is gone from the DOM, so it would be vacuous).
  await expect(page.locator(".topic-bar [data-testid='action-cluster-cog']")).toHaveCount(0);
  // #500 — re-open the launcher menu on the channel window; the cog is reachable
  // in the rail (not the topic-bar).
  await openRailMenu(page);
  await expect(
    page.locator(".rail-actions-menu [data-testid='action-cluster-cog']"),
  ).toBeVisible();

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

test("@webkit ux-5-bt mobile — channel: NO standalone .shell-chrome row (#473 moved chrome buttons into the RailActions drawer)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Cold-load lands on home — TopicBar absent. The chrome element STAYS on
  // mobile-home (no TopicBar to host the ☰), which is what this test is about:
  // mounted here, absent on a channel. #985 took away its BAND, not its
  // existence — `height: 0` with the ☰ floated over the pane's corner — so the
  // host reads as hidden to Playwright while `toHaveCount(1)` on the next line
  // still says exactly what this precondition meant. The door is witnessed
  // directly instead.
  await expect(page.locator(".shell-chrome")).toHaveCount(1);
  await expect(page.getByTestId("shell-chrome-rail-opener")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".topic-bar")).toHaveCount(0);

  // Switch to channel via BottomBar (mobile selectChannel handles the
  // tap path internally).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // BT compression contract: .shell-chrome row NOT mounted in the
  // mobile-channel branch; .topic-bar IS mounted.
  await expect(page.locator(".topic-bar")).toHaveCount(1);
  await expect(page.locator(".shell-chrome")).toHaveCount(0);
  // #473 contract: cog + archive NO LONGER inline in .topic-bar — they live in
  // the `.rail-actions` drawer now. Assert their LIVE testids (`action-cluster-cog`
  // / `mobile-panel-archive`) are absent from the topic-bar (the retired
  // `shell-chrome-cog` / `shell-chrome-archive` are gone from the DOM, so
  // pointing at them would be vacuous).
  await expect(page.locator(".topic-bar [data-testid='action-cluster-cog']")).toHaveCount(0);
  await expect(page.locator(".topic-bar [data-testid='mobile-panel-archive']")).toHaveCount(0);
  // The affordances live inside the members drawer's `.rail-actions` launcher
  // menu (see ux-5-bm spec for the full mutex contract). Verified here as a
  // sanity link between the BT reclamation and the #473/#500 relocation: the cog
  // + archive rows are present in the rail launcher menu. openRailMenu opens the
  // members drawer then the launcher (mobile), revealing the buttons.
  await openRailMenu(page);
  await expect(
    page.locator(".rail-actions-menu [data-testid='action-cluster-cog']"),
  ).toHaveCount(1);
  await expect(
    page.locator(".rail-actions-menu [data-testid='mobile-panel-archive']"),
  ).toHaveCount(1);
  // #500 — opening the launcher opened the members drawer + menu; close both so
  // the hamburger tap-target checks + the re-open below run against the clean
  // topic-bar state (the open drawer/backdrop would otherwise occlude the tap).
  await page.keyboard.press("Escape");
  await expect(page.locator(".rail-actions-menu")).toHaveCount(0, { timeout: 5_000 });
  await closeMembersDrawer(page);

  // #305 — the mobile members hamburger ADOPTS `.shell-chrome-btn` and so
  // sizes from the shared tokens: the tap target meets the 48px HIG floor
  // (--chrome-tap-min, up from the old bespoke 44px box) and the ☰ glyph is
  // enlarged (--chrome-icon-size: 1.4rem, up from the base 14px — defect 1).
  // Round for webkit sub-pixel; parse the computed glyph size.
  const hamburger = page.locator(".topic-bar-hamburger");
  await expect(hamburger).toBeVisible({ timeout: 5_000 });
  const hamBox = await hamburger.boundingBox();
  if (hamBox === null) throw new Error("hamburger has no bounding box");
  expect(
    Math.round(hamBox.height),
    `#305 — hamburger tap target ${hamBox.height}px must meet the 48px HIG floor`,
  ).toBeGreaterThanOrEqual(48);
  const hamGlyphPx = await hamburger.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(
    hamGlyphPx,
    `#305 — hamburger glyph ${hamGlyphPx}px must be enlarged from the base 14px`,
  ).toBeGreaterThanOrEqual(18);

  // Per `feedback_e2e_visitor_members_list` — UI-shape spec is
  // registered-class today; satisfy the rule by asserting the members
  // drawer populates after a tap on the TopicBar hamburger.
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  const memberNames = drawer.locator(".members-pane .member-name");
  await expect.poll(async () => await memberNames.count()).toBeGreaterThan(0);
  await expect(drawer).toContainText(NETWORK_NICK);
});
