// GH #265 — the "jump to next active window" affordance (#235) counts
// MESSAGES only (PRIVMSG/NOTICE/ACTION), NOT presence churn
// (JOIN/PART/QUIT/NICK/MODE/TOPIC/KICK).
//
// Pre-#265 the activity gate fed on `selection.unreadCounts` (the TOTAL
// = messages + events), so a window with ONLY join/part spam or a mode
// flip lit the affordance even though nothing was said. #265 re-points
// the gate to `selection.messagesUnread` (content kinds only) — presence
// churn no longer inflates the count. This spec asserts the USER-VISIBLE
// outcome: the `.next-active-count` badge, driven by `activeWindowCount()`.
//
// Seeding produces exactly two unfocused windows on the seeded network:
//   * a DM (query) window  → ONE inbound PRIVMSG (content)  → MUST count
//   * #bofh                 → ONLY a peer JOIN (presence)    → MUST NOT count
// One peer drives both: it JOINs #bofh (presence-only — deliberately NO
// channel PRIVMSG) then PRIVMSGs the operator's nick to open the DM.
// Focus parks on the neutral $server window so neither accrues via focus.
//
// The event-only window is verified to have ACCRUED its event badge
// BEFORE the count is asserted — so the RED (gate on the total) fails on
// the COUNT VALUE ("Expected 1 Received 2"), never on a mis-seeded window
// or a missing-locator timeout. Under the total gate #bofh's `eventsUnread`
// bumps the count to 2; under the message-scoped gate it contributes 0.

import { expect, test } from "../fixtures/test";
import {
  loginAs,
  selectChannel,
  sidebarEventsBadge,
  sidebarMessageBadge,
  sidebarWindow,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const DM_LINE = "265 direct message counts";

const NEXT_ACTIVE_BTN = '[data-testid="next-active-btn"]';
const NEXT_ACTIVE_COUNT = '[data-testid="next-active-btn"] .next-active-count';

// Drive: read #bofh (baselines its cursor to tail so pre-session unread
// clears), park focus on the neutral $server window, then have `peer`
// produce ONE event-only window (#bofh: a JOIN, NO channel PRIVMSG) and
// ONE message window (a DM). Returns the connected peer so the caller can
// disconnect it. Asserts the seeding landed — the #bofh EVENT badge AND
// the DM MESSAGE badge — BEFORE returning, so a seeding failure is
// pinpointed here and (crucially) the RED assertion fails on the count
// value rather than a not-yet-accrued window.
async function seedEventOnlyAndMessageWindows(
  page: Parameters<typeof loginAs>[0],
  peerNick: string,
): Promise<IrcPeer> {
  // Clear #bofh's baseline unread by focusing it (cursor baselines to
  // tail), then park focus on $server — a window that is NOT in the
  // channel/query cycle — so #bofh and the DM both stay unfocused.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
  // The own-nick DM topic must be subscribed before the peer DMs, or the
  // inbound broadcast fastlanes to zero subscribers (harness gotcha).
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: peerNick });

  // Event-only window — a peer JOIN into #bofh (the operator is in it, so
  // the JOIN persists + fans out on the per-channel topic while #bofh is
  // unfocused). #bofh is tiny (< LARGE_CHANNEL_THRESHOLD) so the JOIN is
  // VISIBLE per the presence filter → accrues `eventsUnread`. Deliberately
  // NO channel PRIVMSG: #bofh carries ZERO content-unread.
  await peer.join(CHANNEL);
  await expect(sidebarEventsBadge(page, NETWORK_SLUG, CHANNEL)).toBeVisible({ timeout: 10_000 });

  // Message window — a DM opens the peer's query window (unfocused →
  // unread content).
  peer.privmsg(NETWORK_NICK, DM_LINE);
  await expect(sidebarWindow(page, NETWORK_SLUG, peerNick)).toBeVisible({ timeout: 10_000 });
  await expect(sidebarMessageBadge(page, NETWORK_SLUG, peerNick)).toBeVisible({ timeout: 10_000 });

  return peer;
}

test("desktop: #265 next-active count includes the message (DM) window, excludes the event-only channel", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const peerNick = "act265-d";
  await loginAs(page, vjt);

  const peer = await seedEventOnlyAndMessageWindows(page, peerNick);
  try {
    // #bofh accrued a presence-only event badge (asserted in the seeder);
    // the DM accrued a message badge. The activity gate is message-scoped,
    // so ONLY the DM counts → the affordance reports "1", NOT "2".
    //
    // Pre-#265 (gate on the total) #bofh's event bumps this to "2" and the
    // assertion fails with a clean `Expected "1" Received "2"`.
    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", { timeout: 10_000 });

    // And the ONE active window is the DM — a button jump lands there,
    // never on the presence-only #bofh.
    await page.locator(NEXT_ACTIVE_BTN).click();
    await expect(sidebarWindow(page, NETWORK_SLUG, peerNick)).toHaveClass(/selected/, {
      timeout: 10_000,
    });

    // The DM is now read → nothing active → the affordance auto-hides
    // (#bofh's presence-only churn never made it active).
    await expect(page.locator(NEXT_ACTIVE_BTN)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await peer.disconnect("265 desktop done");
  }
});

test("@webkit mobile: #265 bottom-bar next-active count excludes the event-only channel", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const peerNick = "act265-m";
  await loginAs(page, vjt);

  const peer = await seedEventOnlyAndMessageWindows(page, peerNick);
  try {
    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", { timeout: 10_000 });

    await page.locator(NEXT_ACTIVE_BTN).click();
    await expect(sidebarWindow(page, NETWORK_SLUG, peerNick)).toHaveClass(/selected/, {
      timeout: 10_000,
    });

    await expect(page.locator(NEXT_ACTIVE_BTN)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await peer.disconnect("265 mobile done");
  }
});
