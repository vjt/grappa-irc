// M1 — peer PRIVMSG to a channel that cicchetto is currently focused on.
//
// Manual matrix: irssi (peer) sends to a channel the cicchetto user is
// currently viewing. Expected:
//   - the message appears in cicchetto's scrollback
//   - NO unread badge bumps in the sidebar (focused channel == read)
//   - NO mention badge (peer doesn't mention own nick)
//
// Wiring:
//   - peer connects via IrcPeer (uses bahamut-test alias → leaf-v4)
//   - peer JOINs #bofh (cicchetto is autojoined there via the seeder)
//   - cicchetto loginAs() (token + subject pre-seeded into localStorage)
//   - cicchetto selectChannel(#bofh) — explicit, even though autojoin makes
//     it the only candidate, so the spec reads as "vjt is focused"
//   - peer PRIVMSGs the channel
//   - assert: scrollback has the new line; no msg-unread badge
//
// expect.poll over the locators handles WS arrival latency. No
// arbitrary sleeps.

import { test, expect } from "@playwright/test";
import {
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "m1-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const MESSAGE_BODY = "M1: focused-channel inbound";

test("M1 — peer PRIVMSG to focused channel renders inline, no unread", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Sanity: compose textarea visible — confirms the focus actually
  // landed on a writable channel (server windows have no compose).
  await expect(composeTextarea(page)).toBeVisible();

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL);
    peer.privmsg(CHANNEL, MESSAGE_BODY);

    // First door: server-side persistence. Cheaper than DOM polling
    // and pinpoints whether a failure is server-side or client-side
    // (if this passes but the DOM assert fails, the bug is in
    // cicchetto's WS or render path, not in grappa).
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: CHANNEL,
      sender: PEER_NICK,
      body: MESSAGE_BODY,
    });

    // Second door: DOM. The PRIVMSG row arrives via WS push
    // (channel:phx_push event from grappa).
    await expect(scrollbackLine(page, "privmsg", MESSAGE_BODY)).toBeVisible({ timeout: 5_000 });

    // Third door: NO unread badge on the focused channel. The
    // selection-side reactive logic (selection.ts) should not bump
    // messagesUnread for the currently selected key. Use `count() === 0`
    // via a poll rather than `not.toBeVisible` — the badge element is
    // simply not rendered when count is 0, so toBeVisible would pass
    // for the wrong reason during pre-WS render.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0);
  } finally {
    await peer.disconnect("M1 done");
  }
});
