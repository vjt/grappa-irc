// UX-5 bucket BJ — the "JOIN-self banner" (a.k.a. join-splash row) is
// dead. Pre-BJ, ScrollbackPane rendered a `<div data-testid="join-banner">`
// strip above the scrollback on own-nick JOIN, duplicating topic
// (already in TopicBar) and the members list (already in MembersPane).
// vjt dogfood verdict 2026-05-19: "what the fuck is that useful for…
// let's fucking remove it." Killed wholesale; this spec is the
// regression guard.
//
// Post-BJ contract:
//   - `[data-testid="join-banner"]` is NEVER in the DOM, on any
//     window kind, before or after JOIN, on desktop or mobile.
//   - Topic continues to render via TopicBar (asserted indirectly by
//     `cic-members-panel-scope` baseline + dedicated topic-bar tests).
//   - Members continue to render via MembersPane (asserted by
//     `cic-members-panel-scope` baseline).
//   - The C5.0 auto-focus contract survives — `/join #chan` still
//     promotes the new channel to `.selected` in the sidebar.
//     Asserted by `m8-cicchetto-join`; re-asserted positively here
//     to document that the auto-focus side-effect was the only piece
//     of the entangled `createEffect` that needed to survive.

import { test, expect } from "@playwright/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const NEW_CHANNEL = `#ux-5-bj-${crypto.randomUUID().slice(0, 8)}`;

test.afterEach(async () => {
  const vjt = getSeededVjt();
  await partChannel(vjt.token, NETWORK_SLUG, NEW_CHANNEL).catch(() => {});
});

test("ux-5-bj — joined channel does NOT render the join-splash row", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // MembersPane has had time to mount — JOIN settled. If the banner
  // ever returns, this is the canonical surface where it would.
  await expect(page.locator(".shell-members .members-pane")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('[data-testid="join-banner"]')).toHaveCount(0);
});

test("ux-5-bj — /join'ing a fresh channel does NOT render the splash + auto-focus still works", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  await composeSend(page, `/join ${NEW_CHANNEL}`);
  await expect(sidebarWindow(page, NETWORK_SLUG, NEW_CHANNEL)).toHaveCount(1, { timeout: 5_000 });
  // C5.0 auto-focus survives — the same `createEffect` that USED to
  // gate the banner mount also called `setSelectedChannel`; BJ split
  // the side-effect into its own gated effect so /join still promotes.
  await expect(sidebarWindow(page, NETWORK_SLUG, NEW_CHANNEL)).toHaveClass(/selected/, {
    timeout: 5_000,
  });
  // Banner stays dead post-join.
  await expect(page.locator('[data-testid="join-banner"]')).toHaveCount(0);
});
