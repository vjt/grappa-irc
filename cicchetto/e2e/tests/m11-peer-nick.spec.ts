// M11 — peer NICK change in a focused channel.
//
// Manual matrix: irssi (peer) types `/nick newname` while sitting in
// #bofh with vjt. Expected:
//   - server-side persists the rename as kind=:nick_change with
//     sender=oldNick and meta.new_nick=newNick
//   - cicchetto scrollback shows `* oldNick is now known as newNick`
//     (ScrollbackPane.tsx:248 — the nick_change render branch)
//   - members list updates: oldNick gone, newNick present
//   - focused-channel invariant: presence kinds bump eventsUnread NOT
//     messagesUnread (no msg-unread badge)
//
// IRC wire: NICK newname (no parameters beyond the new nick). Bahamut
// echoes the rename to every channel both nicks share with the originator.

import { test, expect } from "@playwright/test";
import {
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_OLD_NICK = "m11-peer";
// Per-run unique new nick so retries / parallel runs don't collide on
// bahamut's `nick already in use` (433 ERR_NICKNAMEINUSE).
const PEER_NEW_NICK = `m11-renamed-${crypto.randomUUID().slice(0, 6)}`;
const CHANNEL = AUTOJOIN_CHANNELS[0];

test("M11 — peer NICK change renders nick_change row + updates members list", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(composeTextarea(page)).toBeVisible();

  const peer = await IrcPeer.connect({ nick: PEER_OLD_NICK });
  try {
    await peer.join(CHANNEL);

    // Old nick visible in members before the rename.
    await expect(
      page.locator(".members-pane li", { hasText: PEER_OLD_NICK }),
    ).toBeVisible({ timeout: 5_000 });

    await peer.changeNick(PEER_NEW_NICK);

    // Server-side: persisted as :nick_change with sender=oldNick.
    // Body is null for nick_change — meta.new_nick carries the
    // rename target. Match by kind.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: CHANNEL,
      sender: PEER_OLD_NICK,
      kind: "nick_change",
    });

    // DOM scrollback row: `* old is now known as new`. Substring match
    // on the new nick is unique per run (crypto-suffix), so no
    // strict-mode collision across retries.
    await expect(
      scrollbackLine(page, "nick_change", PEER_NEW_NICK),
    ).toBeVisible({ timeout: 5_000 });

    // Members list updated atomically: old gone, new present.
    await expect(
      page.locator(".members-pane li", { hasText: PEER_OLD_NICK }),
    ).toHaveCount(0, { timeout: 5_000 });
    await expect(
      page.locator(".members-pane li", { hasText: PEER_NEW_NICK }),
    ).toBeVisible({ timeout: 5_000 });

    // Presence kinds (nick_change is one) do NOT bump messagesUnread —
    // the focused-channel msg badge stays absent. eventsUnread split
    // (C7.5) means the dim event badge MAY appear; we don't pin its
    // value here because focus also clears events on selection.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0);
  } finally {
    await peer.disconnect("M11 done");
  }
});
