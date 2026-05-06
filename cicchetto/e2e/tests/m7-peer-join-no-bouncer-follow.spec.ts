// M7 — peer JOIN on a channel that grappa is NOT bound to.
//
// Manual matrix: peer joins a random channel grappa has no presence
// in. Expected:
//   - grappa never sees the peer's JOIN (not a member of that channel)
//   - cicchetto sidebar gains NO entry for that channel
//
// The negative assertion needs a sync point: we have to know that any
// IRC activity from the peer that COULD have surfaced in cic has had
// time to propagate. We do that by chaining a second JOIN to #bofh
// (where grappa IS) and waiting for THAT join event to render in cic
// scrollback. Once that arrives, we know all earlier peer→IRC traffic
// (including the #other JOIN) has been processed by the leaf and
// either pushed by grappa or correctly ignored.
//
// CHANNEL_OUTSIDE is a fresh name for this spec (no autojoin row, no
// other test joins it). Each spec runs against a clean stack so cross-
// test contamination isn't a concern; the unique name is for grep-
// readability in trace failures.

import { test, expect } from "@playwright/test";
import {
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "m7-peer";
const BOUND_CHANNEL = AUTOJOIN_CHANNELS[0];
const OUTSIDE_CHANNEL = "#m7-outside";

test("M7 — peer JOIN on unbound channel does NOT add sidebar entry", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // Focus #bofh so the sync-point JOIN line lands in the currently-
  // visible scrollback (avoids false-negatives where the line is
  // appended to a non-rendered window's store). The WS-ready guard
  // also pins that the #bofh topic subscription has completed before
  // the peer fires.
  await selectChannel(page, NETWORK_SLUG, BOUND_CHANNEL, { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Peer joins the unbound channel first. Grappa is not a member of
    // OUTSIDE_CHANNEL, so the leaf does not forward this JOIN to grappa.
    await peer.join(OUTSIDE_CHANNEL);
    // Peer joins #bofh — grappa IS in #bofh, so the leaf forwards this
    // JOIN to grappa, which pushes a `join` scrollback row to cic via WS.
    await peer.join(BOUND_CHANNEL);

    // Sync point. The peer JOIN row appearing in #bofh proves grappa
    // has processed all earlier peer activity in IRC stream order;
    // anything #m7-outside was going to surface in cic would have by now.
    await expect(scrollbackLine(page, "join", `${PEER_NICK} has joined`)).toBeVisible({
      timeout: 5_000,
    });

    // The actual M7 invariant: no sidebar entry for the unbound channel.
    // sidebarWindow scopes to the network section, so a hypothetical
    // OUTSIDE_CHANNEL string elsewhere on the page (e.g. inside the
    // scrollback) does not falsely match.
    await expect(sidebarWindow(page, NETWORK_SLUG, OUTSIDE_CHANNEL)).toHaveCount(0);
  } finally {
    await peer.disconnect("M7 done");
  }
});
