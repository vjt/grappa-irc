// M2 — peer PRIVMSG to a channel cicchetto is NOT focused on.
//
// Manual matrix: irssi (peer) sends to #bofh while vjt is viewing a
// different window (Server). Expected:
//   - the message is persisted server-side
//   - the #bofh sidebar entry shows a msg-unread badge with "1"
//
// Cousin of M1, inverse of the focus invariant: M1 proves "focused
// channel does not bump unread"; M2 proves "defocused channel does
// bump unread by exactly 1" (matches the BUG 6 regression pin in
// cluster commit 7817bf8 — single PRIVMSG, single bump).
//
// Focus shifted to "Server" (always-present sidebar window, never
// closeable, no autojoin race) — selecting a real channel could
// re-trigger the JOIN-self auto-focus path and confuse the focus
// invariant we want to assert against.

import { test, expect } from "@playwright/test";
import {
  loginAs,
  selectChannel,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "m2-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const SERVER_WINDOW = "Server";
const MESSAGE_BODY = "M2: defocused-channel inbound";

test("M2 — peer PRIVMSG to defocused channel bumps msg-unread badge by 1", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // Visit #bofh FIRST with the WS-ready sync so we know the channel
  // topic subscription has landed (joinChannel fired + server-side
  // JOIN echoed). THEN defocus by switching to Server. Without this
  // up-front sync, the peer's PRIVMSG races the WS subscribe and the
  // unread bump is silently skipped (no WS push = no routeMessage =
  // no bumpMessageUnread).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  // Server window is always present and has no compose, so selecting
  // it can't accidentally produce client-side chatter that would race
  // the unread-bump assertion. WS-ready guard is off here — Server
  // windows have no JOIN line to wait for and the #bofh topic was
  // already proven subscribed above.
  await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW, { awaitWsReady: false });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(CHANNEL);
    peer.privmsg(CHANNEL, MESSAGE_BODY);

    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: CHANNEL,
      sender: PEER_NICK,
      body: MESSAGE_BODY,
    });

    // BUG 6 contract: ONE PRIVMSG → messagesUnread bump of exactly 1.
    // Asserting on text "1" (not just visibility) catches a regression
    // to the double-bump path the cluster's 7817bf8 commit pinned.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toHaveText("1", {
      timeout: 5_000,
    });
  } finally {
    await peer.disconnect("M2 done");
  }
});
