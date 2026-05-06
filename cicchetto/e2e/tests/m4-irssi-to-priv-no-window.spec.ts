// M4 — peer PRIVMSG to vjt's nick when cicchetto has NO query window open
// for that peer. Expected:
//   - DM persists server-side at channel = NETWORK_NICK (the inbound
//     DM target — grappa stores using the recipient nick as channel)
//   - cicchetto auto-opens a query window keyed on the SENDER nick
//     (subscribe.ts DM-listener loop calls openQueryWindowState then
//     re-keys the append from own-nick to sender — see subscribe.ts
//     "C4.1 / DM live-WS gap" comment)
//   - msg-unread badge on the auto-opened window shows "1" (cicchetto is
//     focused on #bofh, not the new DM window)
//   - clicking the DM window: scrollback renders the body AND the
//     badge clears (selection.ts isSelected gate)
//
// The auto-open code path is DIFFERENT from M6's outbound /msg:
//   - M6: compose.ts /msg handler explicitly calls openQueryWindowState
//   - M4: subscribe.ts DM-listener handler does it on inbound PRIVMSG
// Both end up in the same client-state store but the trigger paths
// are independent — M4 specifically pins the inbound side.
//
// Assertion order matters: badge MUST be checked BEFORE the click-
// to-inspect, otherwise the focus-switch clears the badge mid-test.

import { test, expect } from "@playwright/test";
import {
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarMessageBadge,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "m4-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const MESSAGE_BODY = "M4: inbound DM to nick";

test("M4 — inbound DM auto-opens query window with unread, clears on focus", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // Stay focused on #bofh — the DM lands in a NEW window we're NOT
  // looking at, so unread MUST bump. selectChannel here also doubles
  // as the WS-ready sync (own-nick subscribe.ts join for the dm-
  // listener topic happens off the same effect chain).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Pre-condition: no query window for the peer yet (fresh stack
  // guarantees it; assert anyway so a future cross-test contamination
  // surfaces here loudly instead of as a confusing "1 already there
  // before peer sent" flake).
  await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(0);

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    peer.privmsg(NETWORK_NICK, MESSAGE_BODY);

    // Server-side: row persisted at channel = NETWORK_NICK (the
    // RECIPIENT nick is the channel for inbound DMs) with sender =
    // PEER_NICK.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: NETWORK_NICK,
      sender: PEER_NICK,
      body: MESSAGE_BODY,
    });

    // Sidebar gains exactly one entry for the sender nick.
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(1, { timeout: 5_000 });

    // Unread badge "1" — cicchetto still on #bofh, query window is
    // unfocused by definition. Asserted BEFORE the click-to-inspect
    // because clicking would clear it (selection.ts isSelected gate).
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, PEER_NICK)).toHaveText("1", {
      timeout: 5_000,
    });

    // Focus the DM window: scrollback shows the body, badge clears.
    await selectChannel(page, NETWORK_SLUG, PEER_NICK, { awaitWsReady: false });
    await expect(scrollbackLine(page, "privmsg", MESSAGE_BODY)).toBeVisible({ timeout: 5_000 });
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(0);
  } finally {
    await peer.disconnect("M4 done");
  }
});
