// GH #235 — "jump to next active window" (irssi Alt+A).
//
// A button (sidebar-bottom-left on desktop, overlay bottom-bar-right on
// mobile) and the Alt+A keybinding jump focus to the NEXT window with
// unread activity. Priority tiers: mention/highlight channels AND query
// (DM) windows come FIRST, ahead of ordinary channel traffic; repeated
// taps cycle until nothing is unread, at which point the affordance
// auto-hides.
//
// This spec asserts the USER-VISIBLE OUTCOME (which window is focused
// after each jump), not a hollow "handler fired" — the ordering fn is
// unit-tested separately in src/__tests__/activeWindows.test.ts.
//
// Seeding produces exactly two unread windows on the seeded network:
//   * a DM (query) window  → TIER 0 (a PM), even though it arrives LAST
//   * #bofh ordinary line   → TIER 1 (plain channel traffic)
// so the tier precedence (DM before channel, regardless of arrival
// order) is the thing under test. One peer drives both: it JOINs #bofh
// and sends a plain line, then PRIVMSGs the operator's nick to open the
// DM. Neither window is focused when the activity lands (focus parks on
// the neutral $server window), so both accrue unread.

import { expect, test } from "../fixtures/test";
import {
  loginAs,
  selectChannel,
  sidebarMessageBadge,
  sidebarWindow,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const CHANNEL_LINE = "235 ordinary channel traffic";
const DM_LINE = "235 direct message";

const NEXT_ACTIVE_BTN = '[data-testid="next-active-btn"]';
const NEXT_ACTIVE_COUNT = '[data-testid="next-active-btn"] .next-active-count';

// Drive: read #bofh (clears its baseline unread), park focus on the
// neutral $server window, then have `peer` produce one tier-1 (#bofh
// plain line) and one tier-0 (DM) unread window. Returns the connected
// peer so the caller can disconnect it. Asserts the seeding landed
// (both windows unread) BEFORE returning, so a seeding failure is
// pinpointed here rather than masked as a jump failure.
async function seedTwoTierUnread(
  page: Parameters<typeof loginAs>[0],
  token: string,
  peerNick: string,
): Promise<IrcPeer> {
  // Clear #bofh's baseline unread by focusing it (cursor baselines to
  // tail), then park focus on $server — a window that is NOT in the
  // channel/query cycle — so #bofh and the DM both stay unfocused.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
  // The own-nick DM topic must be subscribed before the peer DMs, or
  // the inbound broadcast fastlanes to zero subscribers (harness gotcha).
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: peerNick });
  await peer.join(CHANNEL);

  // Tier 1 — ordinary channel line (no mention of the operator's nick).
  peer.privmsg(CHANNEL, CHANNEL_LINE);
  await assertMessagePersisted({
    token,
    networkSlug: NETWORK_SLUG,
    channel: CHANNEL,
    sender: peerNick,
    body: CHANNEL_LINE,
  });
  await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toBeVisible({ timeout: 10_000 });

  // Tier 0 — a DM opens the peer's query window (unfocused → unread).
  peer.privmsg(NETWORK_NICK, DM_LINE);
  await expect(sidebarWindow(page, NETWORK_SLUG, peerNick)).toBeVisible({ timeout: 10_000 });

  return peer;
}

test("desktop: Alt+A / button jumps DM (tier 0) before channel (tier 1), then auto-hides", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const peerNick = "act235-d";
  await loginAs(page, vjt);

  const peer = await seedTwoTierUnread(page, vjt.token, peerNick);
  try {
    // The affordance is visible and reports BOTH active windows. Waiting
    // on the count "2" also removes the seed race — both windows are in
    // the unread cycle before the first jump.
    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("2", { timeout: 10_000 });

    // Jump 1 (button click) → the DM window wins on tier, though it
    // arrived AFTER the channel line.
    await page.locator(NEXT_ACTIVE_BTN).click();
    await expect(sidebarWindow(page, NETWORK_SLUG, peerNick)).toHaveClass(/selected/, {
      timeout: 10_000,
    });

    // Jump 2 (Alt+A keybinding — the SAME verb) → the ordinary channel.
    await page.keyboard.press("Alt+a");
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveClass(/selected/, {
      timeout: 10_000,
    });

    // Both read now → nothing active → the affordance auto-hides.
    await expect(page.locator(NEXT_ACTIVE_BTN)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await peer.disconnect("235 desktop done");
  }
});

test("@webkit mobile: bottom-bar affordance jumps DM before channel, then auto-hides", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const peerNick = "act235-m";
  await loginAs(page, vjt);

  const peer = await seedTwoTierUnread(page, vjt.token, peerNick);
  try {
    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("2", { timeout: 10_000 });

    // Mobile uses the button for both jumps (no physical Alt+A chord).
    await page.locator(NEXT_ACTIVE_BTN).click();
    await expect(sidebarWindow(page, NETWORK_SLUG, peerNick)).toHaveClass(/selected/, {
      timeout: 10_000,
    });

    await page.locator(NEXT_ACTIVE_BTN).click();
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveClass(/selected/, {
      timeout: 10_000,
    });

    await expect(page.locator(NEXT_ACTIVE_BTN)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await peer.disconnect("235 mobile done");
  }
});
