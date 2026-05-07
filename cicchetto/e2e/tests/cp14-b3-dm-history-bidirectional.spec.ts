// CP14 B3 — DM (query) window history is bidirectional via :dm_with.
//
// Production bug: DM windows showed ONLY outbound messages. IRC
// framing persists outbound on `channel = peer_nick` (vjt-grappa →
// peer) but inbound on `channel = own_nick` (peer → vjt-grappa).
// cic's loadInitialScrollback(peer) only fetched ?channel=peer, so
// inbound history was invisible.
//
// Fix landed alongside this spec:
//   - migration adds `:dm_with` text col on `messages` + index
//     (network_id, dm_with, server_time) — see
//     priv/repo/migrations/20260507151920_add_dm_with_to_messages.exs.
//   - `Grappa.Scrollback.dm_peer/4` derives the DM peer; called by
//     EventRouter (inbound) + Session.Server (outbound) at persist
//     time.
//   - `Scrollback.fetch/5` for nick-shaped channel names (no
//     #/&/!/+ sigil and not "$server") merges
//     `channel == ^name OR dm_with == ^name`.
//   - cic's own-nick query filter (`shouldKeepInOwnNickQuery` +
//     `ownNickIfOwnNickQuery` in lib/scrollback.ts) is DELETED — server
//     is now authoritative.
//
// This spec exercises the user-visible contract: open a fresh query
// window for a peer, BOTH directions of history are present in
// chronological order. Reload simulates the production "I logged in,
// scrollback should show what happened while I was away" path.

import { test, expect } from "@playwright/test";
import {
  composeSend,
  loginAs,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "b3-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_TO_VJT = "B3: inbound from peer to vjt";
const VJT_TO_PEER = "B3: outbound from vjt to peer";

test("CP14 B3 — DM query window shows both inbound and outbound history after reload", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Channel-first focus so the WS-ready boot chain (own-nick subscribe
  // for dm-listener, networks fetch, etc.) is fully evaluated before
  // the DM exchange. Same trick as M5.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Phase 1 — exchange both directions while connected.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Inbound: peer → vjt-grappa. Server persists with channel =
    // own_nick AND dm_with = peer (CP14 B3 derivation in EventRouter).
    peer.privmsg(NETWORK_NICK, PEER_TO_VJT);

    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: NETWORK_NICK,
      sender: PEER_NICK,
      body: PEER_TO_VJT,
    });

    // The dm-listener handler in subscribe.ts auto-opens the query
    // window for PEER_NICK on inbound DM. Selecting it makes cic load
    // the scrollback for PEER_NICK via REST (loadInitialScrollback).
    // With CP14 B3 the server returns the inbound row even though it
    // persisted under channel = own_nick (dm_with = peer matches).
    await selectChannel(page, NETWORK_SLUG, PEER_NICK);

    // Outbound: vjt → peer (typed in the now-focused query window).
    // Server persists with channel = peer AND dm_with = peer (the
    // outbound branch in Session.Server).
    await composeSend(page, VJT_TO_PEER);

    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: PEER_NICK,
      sender: NETWORK_NICK,
      body: VJT_TO_PEER,
    });
  } finally {
    await peer.disconnect("CP14 B3 done");
  }

  // Phase 2 — reload cic so the live signal store is wiped. The
  // bidirectional view must be reconstituted from the server's REST
  // history alone — this is the bug we're fixing.
  await page.reload();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, PEER_NICK);

  // Both directions must be visible in the freshly-opened query
  // window. Pre-CP14-B3 only the outbound row would show.
  await expect(scrollbackLine(page, "privmsg", PEER_TO_VJT)).toBeVisible({ timeout: 10_000 });
  await expect(scrollbackLine(page, "privmsg", VJT_TO_PEER)).toBeVisible({ timeout: 10_000 });
});
