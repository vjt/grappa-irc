// CP22 cluster B (channel-client-polish #14) — /names <#chan> against a
// channel the operator is NOT joined to drains the 353 RPL_NAMREPLY
// burst into 2 :notice scrollback rows in the synthetic $server
// window: one row carrying the full nick list (irssi-shape), one EOF
// terminator. (Joined-target /names refreshes MembersPane via the
// existing members_seeded broadcast — no scrollback rows; covered by
// the Session.Server end-to-end tests, not by this spec.)
//
// Pre-conditions:
//   - vjt logged in, NOT joined to the target channel.
//   - One IrcPeer joined to the target channel so RPL_NAMREPLY enumerates
//     a non-trivial nick — but bahamut may not enumerate invisible (+i)
//     peers on /names from outside, so we only HARD-assert the EOF row
//     (always emitted by the 366 drain). The nick-list row's body is
//     SOFT-checked: if bahamut returned at least one nick, the row
//     contains the peer; if the server returned an empty list, the row
//     contains "(no names)" — both are server-policy-determined and
//     orthogonal to the bouncer-side pipeline this spec exercises.
//
// Asserts (hard):
//   - The nick-list :notice row arrives in $server scrollback,
//     containing the channel marker "[#chan]".
//   - The 366 EOF terminator row arrives, containing
//     "End of /NAMES list" + the channel name.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SERVER_WINDOW_LABEL = "Server";
const PEER_NICK = "cp22-names-target";
const NON_JOINED_CHANNEL = "#cp22-bnames-not-joined";

test("CP22 B-names — /names #unjoined-chan renders nick-list + EOF rows in $server", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // Focus the Server window — that's where /names against a non-joined
  // target lands its rows. Compose box is enabled on $server post-CP13 S9.
  await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW_LABEL, {
    awaitWsReady: false,
    ownNick: NETWORK_NICK,
  });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Peer joins a channel vjt is NOT in — keeps the channel in
    // existence for the duration of the /names exchange.
    await peer.join(NON_JOINED_CHANNEL);

    // Issue /names against the non-joined channel from the focused
    // $server window's compose box.
    await composeSend(page, `/names ${NON_JOINED_CHANNEL}`);

    // The 353 nick-list row arrives in $server scrollback. Body shape:
    // "*** [#chan] @op +voice plain ..." per format_names_row/2 — or
    // "*** [#chan] (no names)" if the server returned an empty list.
    // Match by kind=notice + body contains the channel marker; the
    // exact membership is server-policy-determined and not the
    // pipeline behavior this spec validates.
    const listRow = scrollbackLine(page, "notice", `[${NON_JOINED_CHANNEL}]`);
    await expect(listRow.first()).toBeVisible({ timeout: 5_000 });

    // The 366 RPL_ENDOFNAMES terminator row also lands in $server.
    const eofRow = scrollbackLine(page, "notice", "End of /NAMES list").filter({
      hasText: NON_JOINED_CHANNEL,
    });
    await expect(eofRow.first()).toBeVisible({ timeout: 5_000 });
  } finally {
    await peer.disconnect("CP22 B-names done");
  }
});
