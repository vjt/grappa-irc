// P-0b — peer-away banner. When the operator /msg's a peer who is
// AWAY, upstream sends back a 301 RPL_AWAY. Pre-P-0b that leaked as
// a bare notice; with P-0b the server emits a typed `peer_away` wire
// event on Topic.user/1 and cic mounts the PeerAwayBanner inside the
// peer's DM scrollback pane.
//
// This e2e drives the full path:
//   1. peer connects + sets `/AWAY :Gone fishing`
//   2. operator opens a DM window via /msg (the textarea path)
//   3. server's standalone-301 arm fires → cic banner appears
//
// Per `feedback_ux_e2e_mandatory`: every cic UX-touching change ships
// with a Playwright e2e via scripts/integration.sh.

import { test, expect } from "@playwright/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "p0b-away-peer";
const AWAY_MESSAGE = "Gone fishing — back at 5pm";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("P-0b — /msg to away peer surfaces peer_away banner in DM window", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Peer goes AWAY before the operator messages them. AWAY ack = 306
    // RPL_NOWAWAY back to peer; the peer is now flagged +a server-side
    // and any inbound PRIVMSG triggers a 301 back to the sender.
    await peer.away(AWAY_MESSAGE);

    // Operator opens a DM via /msg. compose.ts splits on slash-cmd and
    // routes to send_privmsg server-side; the server opens the DM
    // window via the standard PRIVMSG path. Bahamut sees PRIVMSG to an
    // away peer and replies with 301 carrying AWAY_MESSAGE.
    await composeSend(page, `/msg ${PEER_NICK} ping`);

    // The DM window auto-opens on outbound /msg (compose.ts's
    // explicit openQueryWindowState call). Sanity check before we
    // assert the banner.
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(1, { timeout: 5_000 });

    // Switch focus to the DM window — the banner mounts only when the
    // selected window matches (slug, peer).
    await selectChannel(page, NETWORK_SLUG, PEER_NICK, { awaitWsReady: false });

    // Banner renders peer + the away message verbatim. Server is the
    // source of truth for the message text; the "is away" framing is
    // built by cic per feedback_no_localized_strings_server_side.
    const banner = page.locator("[data-testid='peer-away-banner']");
    await expect(banner).toBeVisible({ timeout: 5_000 });
    await expect(banner).toContainText(PEER_NICK);
    await expect(banner).toContainText("is away");
    await expect(banner).toContainText(AWAY_MESSAGE);
  } finally {
    await peer.disconnect("P-0b done");
  }
});
