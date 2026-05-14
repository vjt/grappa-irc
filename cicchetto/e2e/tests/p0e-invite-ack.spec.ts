// P-0e + P-0f — invite-ack ephemeral row. When the operator issues
// `/invite peer #channel` and upstream relays it, Bahamut sends back
// 341 RPL_INVITING. P-0f flipped the route from per-channel topic to
// USER topic + $server window mount, because operators usually invite
// peers to channels they are NOT in (per-channel routing was a silent
// drop in the common case — `feedback_silent_retry_anti_pattern`).
//
// This e2e drives the full path:
//   1. peer connects (Bahamut INVITE requires target nick to exist)
//   2. operator focused on $server window for the network
//   3. operator issues `/invite <peer> <channel>` via composeSend
//   4. server's 341 handler fires → broadcast on Topic.user/1 → cic
//      appends an invite-ack synthetic row in $server scrollback
//
// Per `feedback_ux_e2e_mandatory`: every cic UX-touching change ships
// with a Playwright e2e via scripts/integration.sh.

import { expect, test } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "p0e-invitee";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("P-0e + P-0f — /invite to a peer surfaces invite-ack row in the $server window", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Start on a channel so we have a baseline focus state — the test
  // exercises the cross-window-routing case (operator on a channel,
  // invite-ack lands in $server). selectChannel confirms login.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Bahamut requires the INVITE target to exist on-network — offline
  // nicks return 401 ERR_NOSUCHNICK and there's no 341 ack. Connect
  // a peer first; we don't need it to join anything, just exist.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Issue /invite from the channel window. P-0f routes the ack to
    // the user-topic regardless of which window the operator is on.
    await composeSend(page, `/invite ${PEER_NICK} ${CHANNEL}`);

    // Switch to the $server window — that's where InviteAckRows mounts
    // post-P-0f.
    await selectChannel(page, NETWORK_SLUG, "Server", { awaitWsReady: false });

    const row = page.locator("[data-testid='invite-ack-row']").first();
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row).toContainText("→");
    await expect(row).toContainText("invited");
    await expect(row).toContainText(PEER_NICK);
    // P-0f — row text now also includes the target channel since the
    // $server window aggregates invites issued to any channel.
    await expect(row).toContainText(CHANNEL);
  } finally {
    await peer.disconnect("P-0e done");
  }
});
