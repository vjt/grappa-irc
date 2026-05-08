// cic-members-panel-scope-fix: members pane is scoped to actively-joined
// channels. Pre-fix, the right-hand `<aside class="shell-members">`
// rendered MembersPane for ALL window types, including:
//   - the Server pseudo-window (no channel, no members)
//   - DM (query) windows (no member list, peer-to-peer)
//   - parked / failed / kicked channels (stale or absent members)
// MembersPane internally rendered "not joined" for everything but
// `:joined`, but the 14rem grid column stayed reserved on desktop and
// the right hamburger toggled an empty drawer — both visual noise.
//
// Post-fix, three render-time gates apply:
//   1. `<aside class="shell-members">` only mounts MembersPane when
//      `isActiveChannelJoined()` is true (Shell.tsx desktop + mobile).
//   2. The desktop `.shell` container picks up the `.shell-no-members`
//      class — collapses the grid to `16rem 1fr` so the main pane
//      reclaims the right column.
//   3. TopicBar suppresses the right hamburger AND the nick count when
//      the active channel isn't joined (TopicBar.tsx).
//
// This spec exercises the three relevant non-joined cases (server, DM,
// parked channel via /part) plus the joined baseline; the unit tests
// in src/__tests__/windowState.test.ts + Shell.test.tsx cover the
// pending/failed/kicked branches that don't have an easy e2e shape
// (would require synthesizing failure numerics from upstream).

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
const SERVER_WINDOW_LABEL = "Server";
const DM_PEER = "members-scope-peer";
// Random per-run suffix so the spec is repeatable on a long-lived
// testnet — same shape as cp15-b5/m8.
const PARK_CHANNEL = `#cic-members-scope-${crypto.randomUUID().slice(0, 8)}`;

test.afterEach(async () => {
  const vjt = getSeededVjt();
  await partChannel(vjt.token, NETWORK_SLUG, PARK_CHANNEL).catch(() => {});
});

test("cic-members-panel-scope — joined channel shows MembersPane (baseline)", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // Joined-channel render path — pane mounts inside .shell-members,
  // and the .shell does NOT carry the .shell-no-members modifier.
  await expect(page.locator(".shell-members .members-pane")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".shell.shell-no-members")).toHaveCount(0);
  // TopicBar shows the nick count + hamburger. The hamburger has
  // `display: none` on desktop (CSS in default.css:357 — drawer toggle
  // is mobile-only) so we assert presence in DOM, not visibility.
  await expect(page.locator(".topic-bar-count")).toBeVisible();
  await expect(page.locator(".topic-bar [aria-label='open members sidebar']")).toHaveCount(1);
});

test("cic-members-panel-scope — Server window does NOT mount MembersPane", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await expect(sidebarWindow(page, NETWORK_SLUG, SERVER_WINDOW_LABEL)).toHaveCount(1);
  await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW_LABEL, { awaitWsReady: false });

  // Pane suppressed.
  await expect(page.locator(".shell-members .members-pane")).toHaveCount(0);
  // Grid collapses on desktop (.shell-mobile is single-column anyway).
  await expect(page.locator(".shell.shell-no-members, .shell-mobile")).toHaveCount(1);
  // TopicBar isn't rendered for the server window (kind !== "channel"),
  // so neither the count nor the hamburger surface.
  await expect(page.locator(".topic-bar-count")).toHaveCount(0);
  await expect(page.locator(".topic-bar [aria-label='open members sidebar']")).toHaveCount(0);
});

test("cic-members-panel-scope — DM (query) window does NOT mount MembersPane", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });
  // Open a DM via the /msg slash-command (compose.ts → openQueryWindow
  // server roundtrip → query_windows_list broadcast → sidebar entry).
  await composeSend(page, `/msg ${DM_PEER} hello`);
  await expect(sidebarWindow(page, NETWORK_SLUG, DM_PEER)).toHaveCount(1, { timeout: 5_000 });
  await selectChannel(page, NETWORK_SLUG, DM_PEER, { awaitWsReady: false });

  await expect(page.locator(".shell-members .members-pane")).toHaveCount(0);
  await expect(page.locator(".shell.shell-no-members, .shell-mobile")).toHaveCount(1);
  // TopicBar isn't rendered for query windows either.
  await expect(page.locator(".topic-bar-count")).toHaveCount(0);
});

test("cic-members-panel-scope — parked channel suppresses MembersPane + TopicBar hamburger", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // /join then PART (via REST) to drive the channel into a non-joined
  // state while keeping the sidebar entry around (parked / archive
  // section). Using `partChannel` REST instead of `/part` slash-cmd
  // avoids racing composeSend's textarea-clearing assert against the
  // ComposeBox unmount that follows the parked-state transition.
  await composeSend(page, `/join ${PARK_CHANNEL}`);
  await expect(sidebarWindow(page, NETWORK_SLUG, PARK_CHANNEL)).toHaveCount(1, { timeout: 5_000 });
  // Wait for the joined-state UI to settle (MembersPane appears) before
  // parting — otherwise we might race the JOIN echo and assert on the
  // pre-pending render path.
  await selectChannel(page, NETWORK_SLUG, PARK_CHANNEL, { ownNick: NETWORK_NICK });
  await expect(page.locator(".shell-members .members-pane")).toBeVisible({ timeout: 5_000 });

  await partChannel(vjt.token, NETWORK_SLUG, PARK_CHANNEL);

  // After PART: window state transitions away from :joined. MembersPane
  // unmounts, TopicBar suppresses the right hamburger + count, and the
  // grid collapses on desktop. The sidebar entry stays (archive
  // section); we don't assert on its presence here — that's covered by
  // cp15-b6-part-archive-rejoin.
  await expect(page.locator(".shell-members .members-pane")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".topic-bar [aria-label='open members sidebar']")).toHaveCount(0);
  await expect(page.locator(".topic-bar-count")).toHaveCount(0);
});
