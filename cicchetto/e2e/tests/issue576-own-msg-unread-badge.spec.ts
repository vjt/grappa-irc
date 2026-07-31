// GH #576 — the unread badge counted the operator's OWN content rows.
//
// Nothing filtered the unread count by sender: a line you typed was
// "unread" until some later event moved the read cursor past it. The
// optimistic send-time cursor advance (scrollback.ts) normally masks it,
// but that advance has gaps — and a server `read_cursor_set` arriving from
// another session (last-write-wins, no forward-only gate) can pull the
// local cursor BELOW your own last message, re-exposing it as unread with
// no peer line after it. The operator sees a badge on a window whose last
// lines are all theirs and cannot clear it by reading (F5 fixed it: the
// server cursor was already ahead, the client copy had fallen behind).
//
// The fix excludes own-authored CONTENT from the count — the content-row
// twin of #532 A (own PRESENCE), on BOTH count doors: the client
// `perChannelUnread` memo (selection.ts) AND the server cold-load seed
// (`Scrollback.exclude_own_authored/3` + `ReadCursor` twin). This spec
// pins the CLIENT surface in a real browser (per feedback_ux_e2e_mandatory
// — vitest can't exercise the live WS echo + cross-device cursor regress +
// Solid render path the badge depends on); the server exclusion is pinned
// by the Elixir unit tests (scrollback_test / read_cursor_test /
// window_counts_test).
//
// Method: send own lines in a focused DM (the belt advances the cursor),
// then FORCE the read cursor BACK below them (the exact cross-device
// regress the report describes) and focus away. Pre-fix the badge shows
// the own lines; post-fix it shows nothing until a PEER line arrives.

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarMessageBadge,
  sidebarWindow,
  waitForDmListenerReady,
} from "../fixtures/cicchettoPage";
import {
  assertMessagePersisted,
  fetchAllMessagesAsc,
  restoreReadCursorToTail,
  setReadCursorToId,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "i576-peer";
const OPENER = "#576: peer opener — read, cursor baseline sits here";
const OWN_A = "#576: my own line A — read by definition, must not badge";
const OWN_B = "#576: my own line B — read by definition, must not badge";
const REPLY = "#576: peer reply after my lines — this one DOES badge";

test.afterEach(async () => {
  const vjt = getSeededVjt();
  // Restore the DM cursor to the tail so the own/peer rows this spec leaves
  // in the shared backend don't poison a later spec (or a --repeat-each
  // rerun) via a stale backward cursor. Idempotent + guarded.
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, PEER_NICK).catch(() => {});
});

test("#576 — own content lines don't badge; a later peer line does", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Channel-first focus drives the WS-ready sync the own-nick DM-listener
  // subscribe boots off (mirrors #532 B / ux-6-k / M4).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await waitForDmListenerReady(page, NETWORK_SLUG);

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Peer opens the DM. Focus it so it renders (the send-time advance's
    // anti-poison gate #50 needs a non-empty pane), and read it — the
    // cursor baseline will be restored to exactly this line below.
    peer.privmsg(NETWORK_NICK, OPENER);
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: PEER_NICK,
      sender: PEER_NICK,
      body: OPENER,
    });
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(1, { timeout: 5_000 });
    await selectChannel(page, NETWORK_SLUG, PEER_NICK, { awaitWsReady: false });
    await expect(scrollbackLine(page, "privmsg", OPENER).last()).toBeVisible({ timeout: 5_000 });

    // Send two OWN lines in the focused DM. They echo back over WS and
    // render; the belt advances the cursor past them (that is the mask this
    // fix is belt-and-braces over — we defeat it next).
    await composeSend(page, OWN_A);
    await composeSend(page, OWN_B);
    for (const body of [OWN_A, OWN_B]) {
      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel: PEER_NICK,
        sender: NETWORK_NICK,
        body,
      });
      await expect(scrollbackLine(page, "privmsg", body).last()).toBeVisible({ timeout: 5_000 });
    }

    // Focus AWAY so the DM is neither selected nor visible — otherwise the
    // focused-window suppression would zero its badge for an unrelated
    // reason and the assertion would be vacuous.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });

    // Reproduce the report: FORCE the read cursor back to the peer opener,
    // i.e. BELOW the two own lines (a cross-device / out-of-order
    // `read_cursor_set` the last-write-wins client adopts). Now the only
    // rows past the cursor are the operator's own — pre-fix a "2" badge the
    // operator can't clear by reading; post-fix nothing at all.
    const rows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, PEER_NICK);
    const openerRows = rows.filter((r) => r.body === OPENER);
    const openerId = openerRows[openerRows.length - 1]?.id;
    expect(openerId, "peer opener row must exist to seed the cursor baseline").toBeTruthy();
    await setReadCursorToId(vjt.token, NETWORK_SLUG, PEER_NICK, openerId as number);

    // #576 assertion: NO message badge on the DM window whose only unread
    // rows are the operator's own lines. Pre-fix `perChannelUnread` counted
    // them → `.sidebar-msg-unread` rendered "2"; post-fix own content is
    // excluded → the badge element is absent.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, PEER_NICK)).toHaveCount(0, {
      timeout: 5_000,
    });

    // A PEER line after the own ones DOES count — proving the badge
    // mechanism is live (the 0 above is the own-exclusion, not a dead
    // badge). Exactly one unread peer line ⟹ "1".
    peer.privmsg(NETWORK_NICK, REPLY);
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: PEER_NICK,
      sender: PEER_NICK,
      body: REPLY,
    });
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, PEER_NICK)).toHaveText("1", {
      timeout: 5_000,
    });
  } finally {
    await peer.disconnect("#576 done");
  }
});
