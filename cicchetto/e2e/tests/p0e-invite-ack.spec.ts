// P-0e — invite-ack ephemeral row. When the operator issues `/invite
// peer #channel` and upstream relays it, Bahamut sends back a 341
// RPL_INVITING. Pre-P-0e that leaked as a bare notice on the active
// window with empty body; with P-0e the server emits a typed
// `invite_ack` wire event on the channel's per-channel topic and cic
// renders an ephemeral synthetic row in the channel scrollback.
//
// This e2e drives the full path:
//   1. peer connects (Bahamut INVITE requires target nick to exist)
//   2. operator focused on an autojoined channel
//   3. operator issues `/invite <peer> <channel>` via composeSend
//   4. server's 341 handler fires → cic appends an invite-ack row
//
// Per `feedback_ux_e2e_mandatory`: every cic UX-touching change ships
// with a Playwright e2e via scripts/integration.sh.

import { expect, test } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "p0e-invitee";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("P-0e — /invite to a peer surfaces invite-ack synthetic row in channel scrollback", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Bahamut requires the INVITE target to exist on-network — offline
  // nicks return 401 ERR_NOSUCHNICK and there's no 341 ack. Connect
  // a peer first; we don't need it to join anything, just exist.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await composeSend(page, `/invite ${PEER_NICK} ${CHANNEL}`);

    // Server's apply_effects :invite_ack arm broadcasts on
    // Topic.channel(subject, slug, channel) → cic's subscribe.ts channel
    // handler dispatches into appendInviteAck → InviteAckRows mounts a
    // new synthetic row in the channel pane.
    const row = page.locator("[data-testid='invite-ack-row']").first();
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row).toContainText("→");
    await expect(row).toContainText("invited");
    await expect(row).toContainText(PEER_NICK);
  } finally {
    await peer.disconnect("P-0e done");
  }
});
