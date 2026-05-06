// M3 — cic-driven PRIVMSG to a channel: type in compose, assert
// the row renders in scrollback as own-message.
//
// Manual matrix: vjt types a message in cic's #bofh compose box.
// Expected:
//   - the message persists server-side (round-trip through grappa →
//     leaf → grappa echo path)
//   - the row appears in cic's scrollback with sender = own nick
//   - no msg-unread badge bump (focused channel)
//
// This is the FIRST cic-write spec — exercises composeSend + the
// own-message WS echo (the BUG 6 single-bump path landed at 7817bf8).
// No peer needed: grappa fastlane-pushes own messages back to all
// subscribers of the channel topic, so cic's own page sees its own
// row arrive via WS within milliseconds.
//
// `@webkit @iphone-15-pro` is intentionally NOT yet on this spec —
// the chromium baseline lands first per the bucket-A→E plan;
// webkit-paint shaped specs (BUG7's territory) come in a second pass
// once chromium is green across the matrix.

import { test, expect } from "@playwright/test";
import {
  composeSend,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const MESSAGE_BODY = "M3: cic-driven outbound";

test("M3 — cic compose to focused channel renders own-msg, no unread", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  await composeSend(page, MESSAGE_BODY);

  // Server-side: own message persisted as :privmsg with sender =
  // NETWORK_NICK. assertMessagePersisted polls REST until the row
  // appears, isolating "did grappa receive + persist" from the WS
  // echo path tested next.
  await assertMessagePersisted({
    token: vjt.token,
    networkSlug: NETWORK_SLUG,
    channel: CHANNEL,
    sender: NETWORK_NICK,
    body: MESSAGE_BODY,
  });

  // DOM: own row arrives via WS fastlane (cluster commit 0b0cb33 +
  // 7817bf8 — single push, single bump).
  await expect(scrollbackLine(page, "privmsg", MESSAGE_BODY)).toBeVisible({ timeout: 5_000 });

  // Focused channel: own message must not bump messagesUnread (the
  // selection.ts isSelected gate suppresses it for both inbound AND
  // outbound on the active window).
  await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0);
});
