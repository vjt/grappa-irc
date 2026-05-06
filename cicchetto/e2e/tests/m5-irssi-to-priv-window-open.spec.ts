// M5 — peer PRIVMSG to vjt's nick when cic ALREADY has the query
// window open AND focused on it. Expected:
//   - DM persists server-side
//   - the row renders in cic's currently-focused query scrollback
//   - NO msg-unread badge bumps (focused window invariant; mirror of
//     M1's focused-channel rule, here applied to the DM topic)
//
// Pre-open the query window via /query (compose.ts → openQueryWindowState
// + setSelectedChannel). Distinct from M4: M5 exercises the
// "focused inbound DM" path, M4 the "unfocused inbound DM" path.
// Together they pin the selection.ts isSelected gate for query
// windows — the same rule M1/M2 prove for channels.

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

const PEER_NICK = "m5-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const MESSAGE_BODY = "M5: inbound DM to focused window";

test("M5 — inbound DM to focused query window renders inline, no unread", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // Channel-first focus to drive the WS-ready sync (own-nick subscribe
  // for dm-listener fires off the same boot effect chain).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // /query opens the window AND focuses it without sending anything.
  // After this, cic is on the (slug, PEER_NICK) query window, sidebar
  // shows the entry, no scrollback yet (no DM exchanged).
  await composeSend(page, `/query ${PEER_NICK}`);
  await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(1, { timeout: 5_000 });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    peer.privmsg(NETWORK_NICK, MESSAGE_BODY);

    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: NETWORK_NICK,
      sender: PEER_NICK,
      body: MESSAGE_BODY,
    });

    // Inbound DM renders in the focused query window's scrollback.
    await expect(scrollbackLine(page, "privmsg", MESSAGE_BODY)).toBeVisible({ timeout: 5_000 });

    // The M5 invariant: focused query window does NOT bump unread.
    // Mirror of M1's focused-channel rule for the query topic.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(0);
  } finally {
    await peer.disconnect("M5 done");
  }
});
