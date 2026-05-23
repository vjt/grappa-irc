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
//   3. TopicBar suppresses the right hamburger when the active channel
//      isn't joined (TopicBar.tsx).
//
// This spec exercises the three relevant non-joined cases (server, DM,
// parked channel via /part) plus the joined baseline; the unit tests
// in src/__tests__/windowState.test.ts + Shell.test.tsx cover the
// pending/failed/kicked branches that don't have an easy e2e shape
// (would require synthesizing failure numerics from upstream).
//
// UX-5 bucket BT (2026-05-19) — the "X nicks" count strip was dropped
// from the TopicBar (vjt 2026-05-19 dogfood — "useless"; MembersPane
// is the canonical surface). Pre-bucket this spec asserted on
// `.topic-bar-count` visibility in four places; the hamburger
// presence assertion below covers the same joined-state contract
// (both gate on the same `windowIsJoined(key())` predicate).

import { test, expect } from "@playwright/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
// UX-5 bucket BT (2026-05-19) — UX-4 bucket C merged the Server window
// selector INTO the `.sidebar-network-header` row, which renders the
// network slug (e.g. `bahamut-test`) and NOT a literal "Server"
// label. The pre-bucket constant `"Server"` made `sidebarWindow` resolve
// 0 hits (test latent-broken since UX-4 C). Resolve to the network slug
// which IS the rendered text in the header row.
const SERVER_WINDOW_LABEL = NETWORK_SLUG;
const DM_PEER = "members-scope-peer";

test("cic-members-panel-scope — joined channel shows MembersPane (baseline)", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // Joined-channel render path — pane mounts inside .shell-members,
  // and the .shell does NOT carry the .shell-no-members modifier.
  await expect(page.locator(".shell-members .members-pane")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator(".shell.shell-no-members")).toHaveCount(0);
  // TopicBar shows the hamburger. The hamburger has `display: none`
  // on desktop (CSS in default.css — drawer toggle is mobile-only)
  // so we assert presence in DOM, not visibility.
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
  // so the hamburger doesn't surface.
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
  await expect(page.locator(".topic-bar [aria-label='open members sidebar']")).toHaveCount(0);
});

// The pre-GREEN-CI parked-channel sub-test was deleted: UX-4 bucket E's
// close-watcher (`selection.ts`) auto-redirects focus AWAY from any
// channel that drops out of `channelsBySlug` (which happens
// synchronously on REST PART via the eager `cleanup_local` +
// `broadcast_channels_changed` path in `Grappa.Session.Server`). Net
// effect: the operator cannot be focused on a parked channel — the
// state isn't reachable as an active selection. The pseudo-row case
// (failed JOIN, peer KICK) is covered by:
//   * cp15-b6-pending-to-failed-invite-only — :failed suppression
//   * cp15-b6-kicked — :kicked suppression
// which exercise the SAME `isActiveChannelJoined()` predicate gating
// MembersPane mount + grid collapse. Adding a third parked-state spec
// would assert a state cic intentionally prevents, conflicting with
// the close-watcher's transition-driven redirect.
//
// The non-channel suppression contract is covered by the joined-baseline
// (test 1) and Server / DM windows (tests 2 + 3) above.
