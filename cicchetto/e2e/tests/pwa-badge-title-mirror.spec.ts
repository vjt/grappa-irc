// pwa-badge-title-mirror — PWA icon badge (2026-06-21).
//
// The home-screen icon badge (`navigator.setAppBadge`) is NOT
// observable from Playwright (it lives on the OS launcher) and needs
// GRANTED notification permission on a real installed PWA — so the icon
// itself is verified by device dogfood. The `document.title` mirror is
// the one badge surface a headless browser CAN see, and it is driven by
// the SAME `badge` signal.
//
// This spec exercises the foreground optimistic increment: a notify-
// worthy MENTION landing in an UNFOCUSED window bumps the badge signal
// (`subscribe.ts` → `incrementBadge`), which the badge effect mirrors
// into `document.title` as a `(n) ` prefix. Same trigger path as the
// foreground beep + mention-badge bump, so it reuses the proven
// unfocused-mention choreography from `push-trigger-channel-mention`.
//
// Robust against any seeded unread the `/me` badge seed already shows:
// the assertion is that the title's badge number INCREASES after the
// mention, not that it equals a fixed value.

import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const PEER_NICK = "badge-mentioner";
const TARGET_CHANNEL = "#badge-title";

// Reads the leading `(n)` badge prefix the title mirror writes (0 if
// absent), evaluated in the browser context.
const TITLE_BADGE = () => Number(document.title.match(/^\((\d+)\)/)?.[1] ?? "0");

test("an unfocused channel mention bumps the document.title badge prefix", async ({ page }) => {
  const vjt = getSeededVjt();

  await loginAs(page, vjt);
  // Anchor focus on the autojoin channel — the mention target stays
  // unfocused so `effectivelyFocused` is false and the increment fires.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(TARGET_CHANNEL);
    // Operator joins so the Session.Server is in the channel and cic
    // subscribes to its topic (the mention must reach routeMessage).
    await page.locator(".compose-box textarea").fill(`/join ${TARGET_CHANNEL}`);
    await page.locator(".compose-box textarea").press("Enter");
    await selectChannel(page, NETWORK_SLUG, TARGET_CHANNEL, { ownNick: NETWORK_NICK });

    // Re-focus the autojoin channel so the mention lands UNFOCUSED.
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

    const before = await page.evaluate(TITLE_BADGE);

    // Peer mentions the operator at a word boundary in the unfocused
    // channel — `mentionsUser` matches, `incrementBadge` fires.
    peer.privmsg(TARGET_CHANNEL, `${NETWORK_NICK}: ping while you're elsewhere`);

    await expect
      .poll(() => page.evaluate(TITLE_BADGE), {
        message: "document.title badge prefix should increment on the unfocused mention",
      })
      .toBeGreaterThan(before);
  } finally {
    await peer.disconnect("badge title-mirror done");
    await partChannel(vjt.token, NETWORK_SLUG, TARGET_CHANNEL).catch(() => {});
  }
});
