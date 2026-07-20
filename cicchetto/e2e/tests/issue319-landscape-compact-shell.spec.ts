// #319 — small-phone (~5") landscape falls into the desktop three-column
// shell with DESKTOP-WIDTH rails, so the center scrollback is a narrow
// sliver: text wraps every 3-4 tokens and the topic bar wraps to 2 lines,
// truncating the channel name to `#snif…`.
//
// Root cause: the mobile shell is gated on WIDTH only
// (`theme.ts MOBILE_QUERY = "(max-width: 768px)"`). A 5" phone rotated to
// landscape reports a CSS width > 768px, so `isMobile()` is false and
// Shell.tsx renders the desktop `.shell` with both rails pinned at their
// desktop widths (16rem / 14rem) on a physically tiny, SHORT screen.
//
// Fix (issue #319): a dedicated landscape-compact CSS tier —
// `@media (orientation: landscape) and (max-height: 500px) and
// (min-width: 769px)` — that RE-PROPORTIONS the desktop shell instead of
// collapsing it (the maintainer explicitly does NOT want the portrait
// drawer shell here — "un pelo di left e right bar"): slim both rails so
// the center gets the majority of the width, and clamp the topic strip to
// ONE line so the channel name is shown first.
//
// Watch-out pinned here: iPad landscape is legitimately desktop (rails
// fine). The tier is height-gated at ≤500px, and an iPad in landscape is
// 768px tall — WELL above the gate — so this spec's assertions describe a
// tier iPad never enters. (No separate iPad negative-twin needed: the gate
// is a pure CSS predicate, not runtime-branched.)
//
// jsdom doesn't compute layout / cascade `@media` (per
// `feedback_cicchetto_browser_smoke`), so this CSS-driven layout fix MUST
// ship a real-browser Playwright e2e. Runs on the desktop chromium project
// (the desktop shell is what renders at width > 768px); the viewport is
// overridden to a 5" landscape shape (844×390).
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: this is a
// UI-shape/layout contract, subject-shape-agnostic. Registered seed suffices.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// 5" phone rotated to landscape: wide-ISH (> 768px so the desktop shell
// renders) but SHORT (≤ 500px). Matches the #319 capture shape.
test.use({ viewport: { width: 844, height: 390 } });

test.setTimeout(60_000);

test("#319 landscape 5\" — slim proportioned rails, center gets the majority, single-line topic", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

  // Desktop three-pane shell IS rendered (width > 768px) — NOT the portrait
  // drawer shell. The maintainer wants the rails KEPT, just slimmed.
  await expect(page.locator(".shell").first()).toBeVisible();
  await expect(page.locator(".shell.shell-mobile")).toHaveCount(0);

  const sidebar = page.locator(".shell-sidebar");
  const members = page.locator(".shell-members");
  const main = page.locator(".shell-main");

  // Both rails stay visible ("un pelo di left e right bar") — NOT collapsed
  // into drawers.
  await expect(sidebar).toBeVisible();
  await expect(members).toBeVisible();

  const sidebarBox = await sidebar.boundingBox();
  const membersBox = await members.boundingBox();
  const mainBox = await main.boundingBox();
  if (!sidebarBox || !membersBox || !mainBox) throw new Error("shell panes have no bounding box");

  // Rails are SLIM in this tier. RED pre-fix: the desktop rails render at
  // 16rem (256px) / 14rem (224px) — nowhere near slim. 11rem (176px) is a
  // generous ceiling that the desktop widths blow past and the compact
  // widths clear.
  expect(
    sidebarBox.width,
    `#319 — left rail ${sidebarBox.width}px must be slim (< 176px) in landscape-compact`,
  ).toBeLessThan(176);
  expect(
    membersBox.width,
    `#319 — right rail ${membersBox.width}px must be slim (< 176px) in landscape-compact`,
  ).toBeLessThan(176);

  // The center scrollback gets the MAJORITY of the width so text stops
  // wrapping every few tokens. RED pre-fix: 844 − 256 − 224 = 364px = 43%.
  expect(
    mainBox.width,
    `#319 — center pane ${mainBox.width}px must exceed half the 844px viewport`,
  ).toBeGreaterThan(844 / 2);

  // Topic strip is clamped to ONE line in this tier (drops the 2-line wrap
  // that stole width from the channel name). RED pre-fix: `-webkit-line-clamp`
  // is 2 (see default.css `.topic-bar-topic-text`).
  const topicText = page.locator(".topic-bar-topic-text").first();
  await expect(topicText).toBeVisible();
  const clamp = await topicText.evaluate((el) => getComputedStyle(el).webkitLineClamp);
  expect(clamp, `#319 — topic must clamp to 1 line in landscape-compact, got ${clamp}`).toBe("1");

  // Channel name is shown first and fits (no `#snif…` truncation robbing the
  // name of width). scrollWidth ≤ clientWidth means the text is not clipped.
  const channelName = page.locator(".topic-bar-channel").first();
  await expect(channelName).toBeVisible();
  const nameFits = await channelName.evaluate(
    (el) => el.scrollWidth <= el.clientWidth + 1,
  );
  expect(nameFits, "#319 — channel name must not be ellipsis-truncated in landscape-compact").toBe(
    true,
  );
});
