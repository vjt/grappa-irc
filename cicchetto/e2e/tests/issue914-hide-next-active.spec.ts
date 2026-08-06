// GH #914 — a Settings toggle that hides the #235 "jump to next active
// window" (»N) button. Off by default; ONE preference governing BOTH
// placements (desktop sidebar + mobile overlay).
//
// The preference is PRESENTATIONAL. `jumpToNextActiveWindow()` is shared with
// the Alt+A keybinding and Ctrl+N — #235 keeps exactly one code path — so
// hiding the button must not disable the verb. THAT is what the desktop test
// exists to catch: after the button is gone, Alt+A must still jump. An
// assertion that merely proves the button is absent would pass against a
// broken build that also killed the keybinding.
//
// The mobile test cannot make that claim: there is no physical Alt+A chord on
// a phone, so hiding the overlay deliberately leaves NO jump affordance —
// which is precisely what the reporter asked for. It earns its place for a
// different reason: the mobile button is a SEPARATE mount site (a viewport-
// fixed overlay / ScrollbackPane float stack, #280), so it proves the one
// preference reaches the other placement, not just the sidebar one.
//
// Seeding mirrors issue235-next-active-window.spec.ts: clear the autojoin
// channel's baseline unread by focusing it, park focus on the neutral $server
// window (outside the channel/query cycle), then have a peer DM the operator
// so exactly ONE window — a tier-0 query — is unread. Waiting on the count
// "1" also removes the seed race.

import {
  closeSettings,
  loginAs,
  openSettingsSection,
  selectChannel,
  sidebarWindow,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const DM_LINE = "914 direct message";

const NEXT_ACTIVE_BTN = '[data-testid="next-active-btn"]';
const NEXT_ACTIVE_COUNT = '[data-testid="next-active-btn"] .next-active-count';

test.setTimeout(90_000);

// Produce exactly one unread window (a tier-0 DM) with focus parked on
// $server. Returns the connected peer so the caller can disconnect it.
async function seedOneUnreadDm(
  page: Parameters<typeof loginAs>[0],
  peerNick: string,
): Promise<IrcPeer> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
  // The own-nick DM topic must be subscribed before the peer DMs, or the
  // inbound broadcast fastlanes to zero subscribers (harness gotcha).
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: peerNick });
  peer.privmsg(NETWORK_NICK, DM_LINE);
  await expect(sidebarWindow(page, NETWORK_SLUG, peerNick)).toBeVisible({ timeout: 10_000 });
  return peer;
}

test("desktop: the toggle hides the button and Alt+A STILL jumps", async ({ page }) => {
  const vjt = getSeededVjt();
  const peerNick = "act914-d";
  await loginAs(page, vjt);

  const peer = await seedOneUnreadDm(page, peerNick);
  try {
    // Default (no stored preference) → the affordance renders, reporting the
    // one unread window.
    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", { timeout: 10_000 });

    // Off by default in the drawer too, then flip it ON.
    await openSettingsSection(page, "display");
    await expect(page.getByTestId("hide-next-active-toggle")).not.toBeChecked();
    await page.getByTestId("hide-next-active-toggle").check();
    await closeSettings(page);

    // The button is gone while the window is STILL unread — i.e. hidden by the
    // preference, not by #235's auto-hide.
    await expect(page.locator(NEXT_ACTIVE_BTN)).toHaveCount(0, { timeout: 10_000 });
    await expect(sidebarWindow(page, NETWORK_SLUG, peerNick)).not.toHaveClass(/selected/);

    // THE assertion. The button is hidden; the verb must be untouched, so the
    // keybinding still jumps to the unread DM window.
    await page.keyboard.press("Alt+a");
    await expect(sidebarWindow(page, NETWORK_SLUG, peerNick)).toHaveClass(/selected/, {
      timeout: 10_000,
    });
  } finally {
    await peer.disconnect("914 desktop done");
  }
});

test("@webkit mobile: the same toggle hides the overlay placement", async ({ page }) => {
  const vjt = getSeededVjt();
  const peerNick = "act914-m";
  await loginAs(page, vjt);

  const peer = await seedOneUnreadDm(page, peerNick);
  try {
    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", { timeout: 10_000 });

    await openSettingsSection(page, "display");
    await expect(page.getByTestId("hide-next-active-toggle")).not.toBeChecked();
    await page.getByTestId("hide-next-active-toggle").check();
    await closeSettings(page);

    // Same single preference, other mount site: the overlay is gone while the
    // DM window is still unread.
    await expect(page.locator(NEXT_ACTIVE_BTN)).toHaveCount(0, { timeout: 10_000 });
    await expect(sidebarWindow(page, NETWORK_SLUG, peerNick)).not.toHaveClass(/selected/);
  } finally {
    await peer.disconnect("914 mobile done");
  }
});
