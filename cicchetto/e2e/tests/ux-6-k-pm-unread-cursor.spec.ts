// UX-6 bucket K — PM (peer-DM) read-cursor advances on focus-leave.
//
// Bug as filed by vjt 2026-05-20: the in-pane "unread-marker" gray
// separator in a peer DM window did NOT clear on focus — every visit
// re-rendered the same marker above the same inbound row, even after
// the operator had clearly read it. Channels did NOT have this bug.
// Sending a message to the peer DID clear the marker, which is the
// signature this spec pins.
//
// Root cause (lib/grappa/read_cursor.ex pre-K): the cursor-write
// validator `message_belongs?/4` filtered `m.channel == ^channel`
// alone. Inbound DMs persist at `channel = own_nick, dm_with = peer`
// (CP14-B3 derivation in EventRouter); cic POSTs the cursor for the
// peer's query window (`channel = peer`); the literal match failed,
// the validator returned `:invalid_message`, the server replied 422,
// and the in-pane marker never advanced. Outbound DMs (`channel =
// peer, dm_with = peer`) passed the literal match — which is why
// "sending a message clears the marker" was the precise repro.
//
// Fix: share `Grappa.Scrollback.channel_or_dm_where/3` between
// `Scrollback.fetch/6` (read path) and `ReadCursor.message_belongs?/4`
// (cursor-write path). One predicate, one rule.
//
// The signature this spec asserts on:
//   1. Peer sends an inbound DM. cic auto-opens the query window.
//   2. Operator clicks the auto-opened window (focus arrives).
//   3. Operator focuses ANY other window (focus-leave fires →
//      selection.ts POSTs the cursor for the peer window with the
//      inbound DM's id).
//   4. Server `/me`'s `read_cursors[networkSlug][peer]` reflects the
//      inbound DM's id. Pre-K this was null (422 rejected).
//
// Reading `/me` directly is the most reliable signal:
//   * Pre-fix: `/me` returned no cursor for the peer (422 prevented
//     persist).
//   * Post-fix: `/me` returns the inbound DM's id.
//
// The sidebar/in-pane DOM signals are downstream of the same
// `read_cursor_set` WS event the persist triggers — asserting on the
// server-side state via `/me` cuts out the WS-broadcast race and is
// what the production bug surfaces as: it's the cursor persistence
// that was broken.

import { test, expect } from "../fixtures/test";
import {
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted, getReadCursor } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "ux6k-peer";
const CHANNEL = AUTOJOIN_CHANNELS[0];
const PM_BODY = "UX-6-K: inbound DM that should advance the cursor";

test("UX-6 K — focus-leave on a peer DM window advances the server-side read cursor for the peer", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // Channel-first focus to drive the WS-ready sync (own-nick subscribe
  // for the DM-listener boots off the same effect chain). Mirrors M4.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // FLAKE-D (2026-05-23) — same race shape as cp14-b3: peer.privmsg
  // can land before cic's own-nick DM-listener subscribe completes,
  // server fan-outs to zero subscribers, sidebar never auto-opens,
  // spec times out at the `sidebarWindow.toHaveCount(1)` check.
  await waitForDmListenerReady(page, NETWORK_SLUG);

  // Pre-condition: no cursor exists for the peer window yet (fresh
  // stack, vjt never DM'd ux6k-peer before).
  const preCursor = await getReadCursor(vjt.token, NETWORK_SLUG, PEER_NICK);
  expect(preCursor).toBeNull();

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Peer sends an INBOUND DM to vjt. Persisted server-side at
    // `channel = NETWORK_NICK, dm_with = PEER_NICK` — the storage
    // shape that exposed the K bug.
    peer.privmsg(NETWORK_NICK, PM_BODY);

    // Probe via REST against channel = PEER_NICK so the peer-DM
    // aggregation (channel == peer OR dm_with == peer) returns the
    // inbound row — same lookup cic uses when opening the auto-
    // spawned window.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: PEER_NICK,
      sender: PEER_NICK,
      body: PM_BODY,
    });

    // The dm-listener handler in subscribe.ts auto-opens the query
    // window for PEER_NICK on inbound DM. Wait for the sidebar entry.
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(1, { timeout: 5_000 });

    // Step 1 — focus the peer window. selection.ts's on(selectedChannel)
    // effect runs; the leave-arm fires for the OLD selection (#bofh),
    // not the new one. No cursor is set for the peer YET (focus
    // alone doesn't set; only LEAVING a window does).
    await selectChannel(page, NETWORK_SLUG, PEER_NICK, { awaitWsReady: false });

    // The DM body must be visible before we leave — guards against a
    // race where we leave before loadInitialScrollback resolves and
    // selection.ts's setCursorForWindow no-ops on an empty scrollback
    // tail.
    await expect(scrollbackLine(page, "privmsg", PM_BODY)).toBeVisible({ timeout: 5_000 });

    // Step 2 — focus away. selection.ts's leave-arm fires for the
    // peer window, POSTs the cursor for PEER_NICK with the inbound
    // DM's id. Server-side `ReadCursor.set/4` is where the pre-K
    // bug surfaced: the literal `m.channel == ^channel` validator
    // rejected the inbound row (whose channel field is NETWORK_NICK,
    // not PEER_NICK) with `:invalid_message`, and the POST got 422.
    // Post-K the shared `channel_or_dm_where/3` predicate accepts the
    // OR-shape and the persist succeeds.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });

    // Step 3 — assert the cursor landed in the DB. Pre-K this stays
    // null forever (422 on every leave); post-K it points at the
    // inbound DM. Poll because the cursor write is fire-and-forget
    // (selection.ts's setReadCursor uses `void`).
    //
    // Strict-id assertion (reviewer LOW): the only message in the
    // (vjt, peer) bidirectional view at this point IS the inbound
    // DM, so a non-null cursor MUST equal a positive integer pointing
    // at it. Pinning `> 0` (rather than `not.toBeNull`) catches a
    // future regression where cic POSTs a stale/zero id; pinning the
    // exact id would require threading the inserted row's id through
    // (assertMessagePersisted doesn't return it), and the integer
    // shape is the meaningful contract.
    await expect
      .poll(() => getReadCursor(vjt.token, NETWORK_SLUG, PEER_NICK), {
        timeout: 5_000,
        intervals: [100, 200, 500],
      })
      .toBeGreaterThan(0);
  } finally {
    await peer.disconnect("UX-6 K done");
  }
});
