// UX-5 bucket A — drop duplicate top-left hamburger.
//
// Pre-bucket symptoms (vjt 2026-05-19 dogfood, post-UX-4 cluster close):
//   * Narrow view (iPhone): the ShellChrome top-left hamburger
//     duplicated TopicBar's top-right `.topic-bar-hamburger`. Two
//     buttons → same members drawer.
//   * Wide view (desktop): the ShellChrome hamburger toggled a
//     `.shell-sidebar.open` class — but the desktop sidebar has no
//     `.open` CSS rule (the sidebar is always-visible on desktop) and
//     the mobile branch doesn't render the sidebar DOM at all. The
//     button did nothing — visual clutter on top of every window kind.
//
// Post-bucket end state:
//   * Desktop (any window): ZERO chrome hamburgers; TopicBar's
//     hamburger is in DOM for joined channels but CSS-hidden via
//     `display: none` outside the `@media (max-width: 768px)` block.
//   * Mobile + channel: exactly ONE hamburger visible — TopicBar's
//     top-right `.topic-bar-hamburger` opening the members drawer.
//   * Mobile + home: ZERO hamburgers (TopicBar isn't mounted for
//     non-channel kinds; ShellChrome no longer renders one).
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: this
// spec asserts a UI shape contract that is subject-shape-agnostic
// (ShellChrome + TopicBar render identically across visitor /
// nickserv / registered). One pass against the registered seed
// suffices; the per-class loop pattern is reserved for behavior that
// branches on identity.

import { test, expect } from "@playwright/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

test("ux-5-a desktop — ZERO chrome hamburgers; TopicBar hamburger CSS-hidden on desktop", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Cold-load lands on home (UX-4 bucket B). Chrome bar mounted;
  // hamburger DOM count is ZERO end-to-end.
  await expect(page.getByTestId("shell-chrome")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".shell-chrome-hamburger")).toHaveCount(0);
  // Belt-and-suspenders: no aria-labelled chrome hamburger either.
  await expect(page.getByLabel(/open channel sidebar/i)).toHaveCount(0);

  // Switch to a joined channel — TopicBar mounts, its hamburger is in
  // DOM (count 1) but `display: none` on desktop via @media. Pin both
  // the chrome ZERO contract and the TopicBar CSS-hidden contract so a
  // future regression that resurrects the chrome hamburger OR breaks
  // the @media gate gets caught.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();
  await expect(page.locator(".shell-chrome-hamburger")).toHaveCount(0);
  await expect(page.locator(".topic-bar-hamburger")).toHaveCount(1);
  await expect(page.locator(".topic-bar-hamburger")).not.toBeVisible();

  // Settings cog still always reachable (UX-4 bucket L rule survives).
  await expect(page.getByTestId("shell-chrome-cog")).toBeVisible();
});

test("@webkit ux-5-a mobile — exactly ONE visible hamburger (TopicBar members) on channel; ZERO on home", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Cold-load lands on home — no channel context, TopicBar unmounted,
  // ZERO hamburgers anywhere.
  await expect(page.getByTestId("shell-chrome")).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".shell-chrome-hamburger")).toHaveCount(0);
  await expect(page.locator(".topic-bar-hamburger")).toHaveCount(0);

  // Switch to channel via BottomBar (mobile). selectChannel handles
  // the mobile tap path internally.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // After channel selection: ZERO chrome hamburgers (dropped
  // end-to-end), ONE visible TopicBar hamburger (top-right, members
  // drawer toggle).
  await expect(page.locator(".shell-chrome-hamburger")).toHaveCount(0);
  await expect(page.locator(".topic-bar-hamburger")).toHaveCount(1);
  await expect(page.locator(".topic-bar-hamburger")).toBeVisible();
  // Members hamburger has the canonical aria-label.
  await expect(page.getByLabel(/open members sidebar/i)).toBeVisible();

  // Per `feedback_e2e_visitor_members_list`: every visitor-touching
  // spec asserts the members list is populated post-JOIN. Registered
  // class here today; satisfy the rule by tapping the single
  // hamburger, asserting the members drawer opens and lists include
  // own nick.
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });
  const memberNames = drawer.locator(".members-pane .member-name");
  await expect.poll(async () => await memberNames.count()).toBeGreaterThan(0);
  await expect(drawer).toContainText(NETWORK_NICK);
});
