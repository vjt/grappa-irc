// CP22 cluster B (channel-client-polish #14) — /who <#chan> drains the
// 352 RPL_WHOREPLY burst into N+1 :notice scrollback rows in the
// target channel (when joined) or in $server (otherwise). Body is an
// irssi-shape compact string; meta.numeric (352|315) + meta.who
// structured payload available for future tabular polish but the
// existing notice render is sufficient for v1.
//
// Pre-conditions:
//   - vjt logged in, focused on #bofh (autojoined).
//   - One IrcPeer connected so RPL_WHOREPLY returns at least one row.
//
// Asserts:
//   - Notice rows arrive in #bofh scrollback after `/who #bofh` typed
//     in the focused-channel compose box.
//   - At least one row's body contains "[#bofh]" + the peer's nick.
//   - The "End of /WHO list" terminator row also lands.

import { test, expect } from "../fixtures/test";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "cp22-who-target";
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("CP22 B-who — /who #channel renders N+1 notice rows in joined channel", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Peer must be on the channel for RPL_WHOREPLY to enumerate non-trivial.
    await peer.join(CHANNEL);

    // Issue /who #bofh from the focused-channel compose box.
    await composeSend(page, `/who ${CHANNEL}`);

    // At least one WHO reply row arrives — body shape is the irssi-style
    // formatter "*** [#bofh] <nick> <modes> <user>@<host> ...".
    // Match by kind=notice + body contains channel + peer nick.
    const peerRow = scrollbackLine(page, "notice", PEER_NICK).filter({
      hasText: `[${CHANNEL}]`,
    });
    await expect(peerRow.first()).toBeVisible({ timeout: 5_000 });

    // The 315 RPL_ENDOFWHO terminator row also lands in #bofh.
    const eofRow = scrollbackLine(page, "notice", "End of /WHO list").filter({
      hasText: CHANNEL,
    });
    await expect(eofRow.first()).toBeVisible({ timeout: 5_000 });
  } finally {
    await peer.disconnect("CP22 B-who done");
  }
});
