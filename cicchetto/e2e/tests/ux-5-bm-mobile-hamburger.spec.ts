// UX-5 bucket BM → #473 — mobile-channel hamburger compress, now over
// the RailActions drawer.
//
// HISTORY: BM collapsed the crowded mobile-channel `.topic-bar` right edge
// (☰ + 📂 + ⚙) behind the hamburger, moving archive + cog into a bottom-fixed
// `.mobile-panel-actions` launcher footer inside the mobile members drawer.
// #473 retired that footer: EVERY rail affordance now lives in `.rail-actions`,
// the ONE labelled action drawer pinned at the bottom of `.shell-members`,
// mounted on BOTH desktop and mobile and on EVERY window kind. The footer is
// gone; `.rail-actions` is the rail on every form factor.
//
// Post-#473 end state (this spec's contract):
//   * Mobile + channel `.topic-bar`: archive + cog NOT inline — only the
//     members hamburger (☰) remains on the right edge.
//   * Tapping the hamburger opens `.shell-members.open` as before.
//   * Inside the open drawer: `.rail-actions` holds every affordance —
//     home / rooms / themes / archive / settings (cog) / admin / denoise.
//     Settings is the `action-cluster-cog` row; archive is `mobile-panel-archive`.
//   * Tapping the settings cog: drawer closes, SettingsDrawer opens.
//     Tapping archive: drawer closes, ArchiveModal opens. Mutex
//     (members | settings | archive | none) enforced via `lib/mobilePanel.ts`.
//   * Mobile + home / mentions / admin / server: the standalone `.shell-chrome`
//     row stays, but #71 INC-2 turned its button into the ☰ RAIL OPENER; the
//     cog + archive live in the rail it opens (#473).
//   * Desktop: #71 INC-2 REMOVED the standalone `.shell-chrome` row (cog moved
//     to the permanent right rail); #473 — the `.rail-actions` drawer IS present
//     on the desktop members aside now (one rail on both form factors).
//
// jsdom doesn't compute layout / cascade `@media` — per
// `feedback_cicchetto_browser_smoke` this layout fix MUST ship a
// Playwright e2e. Mobile arm pins the hamburger-as-only-button contract +
// the rail drawer contract + mutex. Desktop arm pins the rail's presence.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: UI shape
// contract, subject-shape-agnostic. Registered seed suffices.

import { expect, test } from "../fixtures/test";
import { loginAs, openRailMenu, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

test("ux-5-bm desktop — members aside carries the RailActions drawer", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

  // #71 INC-2 — desktop dropped the standalone .shell-chrome row (cog moved to
  // the permanent right rail); .topic-bar stays and the cog is reachable in the
  // rail's RailActions drawer.
  await expect(page.locator(".shell-chrome")).toHaveCount(0);
  await expect(page.locator(".topic-bar")).toHaveCount(1);
  // #500 — the cog + archive live behind the rail launcher menu now; open it
  // (desktop: taps the launcher) then assert the cog is reachable.
  await openRailMenu(page);
  await expect(
    page.locator(".rail-actions-menu [data-testid='action-cluster-cog']"),
  ).toBeVisible();

  // #473 — the members aside DOES carry the `.rail-actions` drawer now (the
  // retired mobile-only `.mobile-panel-actions` footer became one rail present
  // on both form factors). The container still holds the #500 launcher; the
  // always-on cog + archive rows live in the launcher menu it opens.
  const rail = page.locator(".shell-members .rail-actions");
  await expect(rail).toHaveCount(1);
  await expect(
    page.locator(".rail-actions-menu [data-testid='mobile-panel-archive']"),
  ).toHaveCount(1);
});

test("@webkit ux-5-bm mobile-channel — topic-bar hosts hamburger only; drawer hosts settings+archive launchers; mutex enforced", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Topic-bar compression contract: hamburger is the ONLY affordance on
  // the right edge. The cog + archive are NOT inline — they live in the rail
  // drawer. Assert their LIVE testids (`action-cluster-cog` / `mobile-panel-archive`,
  // #473) are absent from the topic-bar; the retired `shell-chrome-cog` /
  // `shell-chrome-archive` are gone from the DOM entirely, so pointing at them
  // would be vacuous.
  await expect(page.locator(".topic-bar [aria-label='open members sidebar']")).toHaveCount(1);
  await expect(page.locator(".topic-bar [data-testid='action-cluster-cog']")).toHaveCount(0);
  await expect(page.locator(".topic-bar [data-testid='mobile-panel-archive']")).toHaveCount(0);

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

  // #473 — the `.rail-actions` drawer hosts every affordance, including the
  // settings cog (`action-cluster-cog`) and the archive launcher
  // (`mobile-panel-archive`). Supersedes the retired `.mobile-panel-actions`
  // footer (whose `mobile-panel-settings` launcher no longer exists at all).
  const rail = drawer.locator(".rail-actions");
  await expect(rail).toBeVisible();
  // #500 folded the buttons behind the launcher menu — open it (the members
  // drawer is already open, so this only taps the launcher), then assert.
  await openRailMenu(page);
  await expect(
    page.locator(".rail-actions-menu [data-testid='action-cluster-cog']"),
  ).toHaveCount(1);
  await expect(
    page.locator(".rail-actions-menu [data-testid='mobile-panel-archive']"),
  ).toHaveCount(1);

  // Tap the rail's settings cog → launcher menu + drawer close, SettingsDrawer opens.
  await page.locator(".rail-actions-menu [data-testid='action-cluster-cog']").tap();
  await expect(page.locator(".shell-members.open")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".settings-drawer.open")).toBeVisible({ timeout: 5_000 });

  // Close settings (× button). Re-open the drawer to test archive launcher.
  await page.locator(".settings-drawer [data-testid='settings-drawer-close']").tap();
  await expect(page.locator(".settings-drawer.open")).toHaveCount(0, { timeout: 5_000 });

  await page.getByLabel(/open members sidebar/i).tap();
  await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });

  // Tap archive launcher → launcher menu + drawer close, ArchiveModal opens.
  // Re-open the launcher menu first (#500): re-opening the members drawer above
  // did not re-open the menu.
  await openRailMenu(page);
  await page.locator(".rail-actions-menu [data-testid='mobile-panel-archive']").tap();
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

test("@webkit ux-5-bm mobile-non-channel — home keeps its own ☰ door to the rail", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Cold-load lands on home. BM scope is mobile-channel only — non-channel
  // windows keep their OWN ☰, because there is no members hamburger on
  // home/mentions/admin/server to host it.
  //
  // This test used to be titled "standalone .shell-chrome row preserved" and
  // opened by asserting that row visible. #985 removed the row on vjt's call
  // ("solo l'hamburger, in alto a destra"): the host is now `height: 0` and the
  // ☰ floats over the pane's corner. What BM cares about survives that change
  // intact — a non-channel window has exactly one door, it is reachable, and
  // the cog is not in it — so the title and the opening assertion now name the
  // DOOR, which is what was always meant, instead of the band that used to
  // carry it. Nothing that BM measured has been dropped: the door's visibility
  // is asserted below, scoped INSIDE `.shell-chrome`, which is stricter than
  // the assertion removed here — so no twin is added for it (a second waiter on
  // the same fact is the duplicate-waiter shape). The cold-load settle budget
  // the removed assertion carried moves onto this one, which is now first.
  await expect(page.locator(".shell-chrome")).toHaveCount(1, { timeout: 10_000 });
  await expect(page.locator(".topic-bar")).toHaveCount(0);
  // #71 INC-2 — the standalone row's button is now the ☰ RAIL OPENER (the cog
  // moved into the rail it opens). Assert the opener is reachable here, and that
  // the cog is NOT in the chrome bar — it lives in the rail's RailActions drawer
  // now (#473). The retired `shell-chrome-cog` testid is gone from the DOM, so
  // assert against the LIVE `action-cluster-cog` to keep the check meaningful.
  await expect(page.locator(".shell-chrome [data-testid='shell-chrome-rail-opener']")).toBeVisible();
  await expect(page.locator(".shell-chrome [data-testid='action-cluster-cog']")).toHaveCount(0);
});
