// issue 2368 — when a peer we have an open query window with changes nick,
// the server INSERTs ONE `nick_change` row into the OLD nick's query window
// (vjt's ruling, option E), so the conversation left behind says where the
// peer went: `* <old> is now known as <new>`, with <new> a button that opens
// the query window for the new nick.
//
// Coverage is bounded by IRC itself: bahamut sends a NICK only to peers who
// share a channel with the renamer, so the peer here sits in a channel with
// us. It sits in TWO, because that is where a per-channel fan-out would
// write the row twice — the claim is ONE row in the query, however many
// channels are shared.
//
// Nothing else moves (issue 1365 still holds): no window is renamed and the
// new nick only gets a window when the operator clicks.

import {
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
  waitForDmListenerReady,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import {
  assertMessagePersisted,
  fetchAllMessagesAsc,
  joinChannel,
  listChannelNames,
  partChannel,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const SECOND_CHANNEL = `${CHANNEL}-2368`;
// Per-run-unique: bahamut holds a ghosted nick for a linger window.
const RUN = crypto.randomUUID().slice(0, 6);
const PEER_OLD_NICK = `rn2368a${RUN}`;
const PEER_NEW_NICK = `rn2368b${RUN}`;

test("peer rename writes ONE row into the old query, whose new nick opens the new query", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await waitForDmListenerReady(page, NETWORK_SLUG);

  // The POST only asks; the precondition is the channel being listed.
  await joinChannel(vjt.token, NETWORK_SLUG, SECOND_CHANNEL);
  await expect
    .poll(() => listChannelNames(vjt.token, NETWORK_SLUG), { timeout: 10_000 })
    .toContain(SECOND_CHANNEL);

  const peer = await IrcPeer.connect({ nick: PEER_OLD_NICK });
  // The nick the server GRANTED, held before the rename (#944): `peer.nick`
  // follows `changeNick`.
  const oldNick = peer.nick;
  try {
    for (const ch of [CHANNEL, SECOND_CHANNEL]) {
      await peer.join(ch);
      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel: ch,
        sender: oldNick,
        kind: "join",
      });
    }

    peer.privmsg(await specLiveNick(), "ciao #2368");
    await expect(sidebarWindow(page, NETWORK_SLUG, oldNick)).toHaveCount(1, { timeout: 10_000 });

    await selectChannel(page, NETWORK_SLUG, oldNick);
    await waitForQueryWindowReady(page, NETWORK_SLUG, oldNick);

    await peer.changeNick(PEER_NEW_NICK);

    // LIVE: the rename line lands in the old query window, once.
    const renameLine = scrollbackLine(page, "nick_change", PEER_NEW_NICK);
    await expect(renameLine).toHaveCount(1, { timeout: 10_000 });
    await expect(renameLine).toContainText(`${oldNick} is now known as ${PEER_NEW_NICK}`);

    // PERSISTED: exactly one row in the old query, not one per shared channel.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: oldNick,
      sender: oldNick,
      kind: "nick_change",
    });
    const queryRows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, oldNick);
    expect(queryRows.filter((m) => m.kind === "nick_change")).toHaveLength(1);

    // No window was minted for the new nick by the rename itself.
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NEW_NICK)).toHaveCount(0);

    // The new nick is the way to follow: clicking it opens + focuses its query.
    await renameLine.locator(".scrollback-sender", { hasText: PEER_NEW_NICK }).click();
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NEW_NICK)).toHaveCount(1, {
      timeout: 5_000,
    });
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NEW_NICK)).toHaveClass(/selected/, {
      timeout: 5_000,
    });
  } finally {
    await peer.disconnect("#2368 done");
    await partChannel(vjt.token, NETWORK_SLUG, SECOND_CHANNEL);
  }
});
