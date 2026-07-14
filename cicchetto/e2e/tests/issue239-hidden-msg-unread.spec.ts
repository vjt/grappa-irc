// #239 (P0) — hidden/control messages must NOT leave the unread counter stuck.
//
// Regression from #222: the render-layer presence filter hides
// join/part/quit/nick_change on large / pref-hidden channels, but the unread
// count derivation (selection.ts `perChannelUnread`) counted EVERY stored row.
// So a hidden control message arriving on a channel bumped the sidebar events
// badge — a badge the operator could never clear by reading, because the row
// never renders and no settle event advances the read cursor over it. The
// count and the pane disagreed about which rows "count".
//
// The fix reconciles BOTH to the ONE shared presence predicate
// (`presenceRowVisible`): the badge counts over VISIBLE rows only (Facet A),
// and on window display the server-owned cursor advances over the trailing run
// of hidden control messages (Facet B). This spec is the interactive witness
// for the VISIBLE outcomes (CLAUDE.md "assert outcomes not calls"):
//
//   1. A HIDDEN join arriving on a defocused channel does NOT bump the events
//      badge, while a VISIBLE privmsg on the same channel DOES bump the
//      message badge (the filter, not a blanket drop).
//   2. Opening the window (reading) clears the counter and it STAYS clear.
//
// RED proof (pre-fix): assertion 1's `eventsBadge toHaveCount(0)` fails — the
// hidden join bumps the events badge to "1" (the stuck-count bug). Implement →
// GREEN.
//
// Determinism: the peer's VISIBLE privmsg is sent AFTER the hidden join on the
// same ordered per-channel WS topic, so `messageBadge = "1"` is the barrier
// that proves the earlier join has already reached cic before we assert the
// events badge is 0 — no arrival race, no reload, no bare timeout. Facet B's
// trailing-hidden cursor-advance MATH (server-owned, only observable
// cross-device/reload) is proven authoritatively in the vitest boundary test
// (src/__tests__/presenceFilter.test.ts `trailingHiddenAdvanceTarget`).
//
// Per feedback_ux_e2e_mandatory: every cic UX-touching change ships a real
// Playwright e2e via scripts/integration.sh.

import { expect, test } from "../fixtures/test";
import {
  loginAs,
  selectChannel,
  sidebarEventsBadge,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const SERVER_WINDOW = "Server";
const PEER_NICK = "i239peer";
const WITNESS = "issue-239-visible-witness";

// Cursor was advanced mid-test (open #bofh → read). Restore to tail so
// downstream specs inherit a clean at-tail cursor (BUGHUNT-3 cascade rule).
test.afterEach(async () => {
  const vjt = getSeededVjt();
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
});

test("#239 — hidden control message does NOT bump the unread badge; reading clears it", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Focus #bofh first so its per-channel WS topic is subscribed (the badge
  // only updates live for a subscribed channel — see M2). ownNick sync waits
  // for the auto-joined self-JOIN line, proving REST + WS both landed.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Pin #bofh to HIDE presence via the production toggle (no need to seed 50
  // members — the size-default math is unit-tested; this is the interactive
  // hide path). The toggle lives in the TopicBar of the focused channel.
  const toggle = page.locator('[data-testid="presence-toggle"]');
  await expect(toggle).toBeVisible({ timeout: 5_000 });
  await toggle.click();

  // Clean baseline: cursor at the current tail so the count reflects ONLY the
  // peer traffic we are about to generate.
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);

  // Defocus to the Server window so #bofh's badges are observable (a focused +
  // visible window suppresses its own badge — decouple-unread-badge). Server
  // has no compose, so it can't produce client chatter that races the assert.
  await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW, { awaitWsReady: false });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // A HIDDEN control row (join) then a VISIBLE content row (privmsg), in that
    // order, on the same ordered per-channel topic. The privmsg is the arrival
    // barrier: when its badge shows, the earlier join has already reached cic.
    await peer.join(CHANNEL);
    peer.privmsg(CHANNEL, WITNESS);

    // 1. The VISIBLE privmsg bumps the message badge by exactly 1 (barrier).
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toHaveText("1", {
      timeout: 10_000,
    });

    // 2. THE #239 ASSERTION — the HIDDEN join did NOT bump the events badge.
    //    Pre-fix `perChannelUnread` counted the hidden join → this badge read
    //    "1" and could never be cleared by reading (the join never renders).
    await expect(sidebarEventsBadge(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0);

    // 3. Reading clears the counter. Open #bofh — presence stays hidden, so the
    //    own-JOIN line is suppressed; wait on the VISIBLE witness privmsg as the
    //    pane-ready signal instead of the (hidden) join line.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
    await expect(
      page
        .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
        .filter({ hasText: WITNESS }),
    ).toBeVisible({ timeout: 10_000 });

    // Leave the window — the read cursor advances over the visible privmsg the
    // operator saw. Back on Server, #bofh's badges are observable again.
    await selectChannel(page, NETWORK_SLUG, SERVER_WINDOW, { awaitWsReady: false });

    // 4. Both badges are clear and STAY clear — the message was read, the
    //    hidden control row was never counted.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(sidebarEventsBadge(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0);
  } finally {
    await peer.disconnect("239 witness done");
  }
});
