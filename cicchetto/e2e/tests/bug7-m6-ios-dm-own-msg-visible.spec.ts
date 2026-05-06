// BUG7-M6 — webkit + iPhone 15 variant of M6 (cicchetto-driven DM via
// `/msg`). Same iOS-shape input path as bug7-ios-own-msg-visible:
// tap-to-focus + per-keystroke type + tap send. Pins the same
// regression class — own-msg visibility post-compose-send — but on
// the DM auto-open + auto-focus path rather than the focused-channel
// path.
//
// **Expected RED on prod head**, same as bug7-ios-own-msg-visible.
// The chromium M6 spec has been GREEN since bucket B; this proves
// (or disproves) whether the bug is paint-path-shared between the
// two surfaces. Two RED specs with the same root cause = single fix
// in S5; two RED specs with different traces = two fixes.
//
// `@webkit` opts into the webkit-iphone-15 project.

import { test, expect } from "@playwright/test";
import {
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "bug7m6-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const MESSAGE_BODY = `BUG7-M6-ios: DM own-msg @ ${crypto.randomUUID().slice(0, 8)}`;

test("@webkit BUG7-M6 — cicchetto /msg DM own-msg visible on iOS-shaped input", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    const ta = composeTextarea(page);
    await expect(ta).toBeVisible();

    // iOS-shape: tap to focus (triggers virtual-keyboard show on a
    // real device), per-keystroke type, tap send button.
    await ta.tap();
    await ta.pressSequentially(`/msg ${PEER_NICK} ${MESSAGE_BODY}`, { delay: 20 });

    const sendButton = page.locator(".compose-box button", { hasText: /^send$/i });
    await sendButton.tap();
    await expect(ta).toHaveValue("", { timeout: 5_000 });

    // Sidebar entry for the DM target appears (auto-open via
    // openQueryWindowState in compose.ts /msg handler).
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(1, { timeout: 5_000 });

    // First door: server persistence — same as M6 chromium.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: PEER_NICK,
      sender: NETWORK_NICK,
      body: MESSAGE_BODY,
    });

    // Second door: own-msg visible in the auto-focused DM scrollback.
    // toBeVisible enforces the viewport-intersection check — a row
    // that's painted but virtual-keyboard-occluded fails here.
    await expect(scrollbackLine(page, "privmsg", MESSAGE_BODY)).toBeVisible({ timeout: 5_000 });
  } finally {
    await peer.disconnect("BUG7-M6 done");
  }
});
