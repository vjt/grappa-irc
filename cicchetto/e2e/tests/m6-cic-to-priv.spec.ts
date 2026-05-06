// M6 — cic-driven PRIVMSG to a nick (DM): /msg target body opens
// the query window, switches focus, and renders the own-msg.
//
// Manual matrix: vjt types `/msg <nick> <body>` in the active
// compose. Expected:
//   - DM persists server-side at channel = <target>
//   - query window for <target> appears in sidebar (auto-opened by
//     compose.ts's /msg handler via openQueryWindowState)
//   - cic auto-focuses the new query window
//   - own message renders in that window's scrollback
//   - no msg-unread badge (focused)
//
// A peer is online to act as the DM target — without a present nick,
// the leaf would NOTICE back "no such nick" and grappa would not
// persist a DM row (msg goes to leaf which rejects, no echo). The
// peer is otherwise silent: this is a cic-only assertion, the peer's
// inbound side is M5's job.
//
// Page-object's selectChannel helper isn't used to switch to the DM
// window — `/msg` does that automatically inside compose.ts. We just
// wait for the query window's sidebar entry to appear after submit.

import { test, expect } from "@playwright/test";
import {
  composeSend,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarMessageBadge,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "m6-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const MESSAGE_BODY = "M6: cic-driven DM outbound";

test("M6 — cic /msg opens query window, focuses, renders own-msg", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // Start in a real channel so the compose box is visible (Server
  // window has no compose). selectChannel + ownNick syncs WS-ready
  // for #bofh — same pattern as M1/M2/M7.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Peer joins the network so the DM target nick is visible to the
  // leaf. M6 doesn't assert peer-side; the peer is just here to be
  // a valid recipient. Peer doesn't need to JOIN any channel — DMs
  // route by nick.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // /msg auto-opens the query window AND switches focus AND sends
    // the body. One compose interaction = three DOM consequences.
    await composeSend(page, `/msg ${PEER_NICK} ${MESSAGE_BODY}`);

    // Sidebar gains an entry for the peer-nick (the DM target).
    // sidebarWindow scopes by network section, so a hypothetical
    // PEER_NICK string elsewhere doesn't false-match.
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(1, { timeout: 5_000 });

    // Server-side: DM row persisted at channel = PEER_NICK with
    // sender = NETWORK_NICK. The wire shape mirrors a regular
    // PRIVMSG row; the channel field is the nick because that's the
    // PRIVMSG target.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: PEER_NICK,
      sender: NETWORK_NICK,
      body: MESSAGE_BODY,
    });

    // DOM: own DM row in the now-focused query window scrollback.
    await expect(scrollbackLine(page, "privmsg", MESSAGE_BODY)).toBeVisible({ timeout: 5_000 });

    // Focused query window: no unread bump on own send.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(0);
  } finally {
    await peer.disconnect("M6 done");
  }
});
