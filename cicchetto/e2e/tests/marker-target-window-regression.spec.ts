// Switch-target marker + scroll regression — the marker logic and the
// scroll-on-switch logic share a stale-`markerRef` bug.
//
// Repro flow (mirrors the live-prod repro vjt walked through 2026-05-10):
//   1. Open a DM (query) window.
//   2. Type a PRIVMSG → peer auto-replies (testnet bot).
//   3. Pre-fix: `<scrollback-unread-marker>` injects between own-msg
//      and peer reply, even though the user is reading live. Why:
//      ScrollbackPane's `rows` memo only checks `cursor`, not focus
//      session-time, so any peer arrival with `server_time > cursor`
//      spawns a marker. Cursor only advances on own-msg, so a focused
//      send-then-reply leaves a "1 unread" mid-page.
//   4. Switch to a TALL channel (#bofh has 100+ rows).
//      Pre-fix: viewport stays at top instead of bottom. Why:
//      `markerRef` from the prior DM still holds a (now-disposed)
//      ref; the key createEffect takes the marker branch and calls
//      `scrollIntoView` on a stale node, never falling through to
//      `scrollTop = scrollHeight`.
//
// Both bugs share the leaky `markerRef`:
//   - bug A leaks visually as a wrong marker on the source window;
//   - bug B leaks as a wrong scroll position on the target window.
// jsdom can't see either (no layout, no `::before`-style ref-drift).
// This spec is the only line of defense.

import { expect, test } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "marker-target-buddy";
const CHANNEL = AUTOJOIN_CHANNELS[0];
// Unique-per-run body prefix so retries don't strict-mode-collide with
// prior runs' persisted scrollback (the test is on a real grappa
// session, not a fresh-DB seed-per-spec). Each test then prefixes its
// own tag (T1/T2) so cross-test bodies in the same run don't collide
// either when the second test reads scrollback after the first ran.
const RUN_ID = crypto.randomUUID().slice(0, 8);
const ownBody = (tag: string): string => `marker-target T${tag} own ${RUN_ID}`;
const replyBody = (tag: string): string => `marker-target T${tag} reply ${RUN_ID}`;

// BUGHUNT-3 cascade fix (2026-05-25) — both tests assume `#bofh`
// reads as "fully read" at mount. Upstream specs that emit PRIVMSG /
// JOIN / PART on `#bofh` (m1, m10, m11, push-trigger-*, etc.) push
// new rows past whatever cursor the BUGHUNT-2 cursor-* / cp14-b1
// afterAll left behind, recreating a mid-pane cursor → unread-marker
// injects → `scrollIntoView(marker)` lands mid-pane instead of at
// the bottom and T2's `dist <= 50` fails. Restore at start of each
// test so the spec is robust against intervening row arrivals.
test.beforeEach(async () => {
  const vjt = getSeededVjt();
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("focused-window send+reply does NOT spawn unread marker", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const own = ownBody("1");
  const reply = replyBody("1");
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Open the DM by typing /query — the window gains focus.
    await composeSend(page, `/query ${PEER_NICK}`);
    // Send an own-PRIVMSG in the focused DM.
    await composeSend(page, own);
    // Wait for own-msg to land in the scrollback.
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: own }),
    ).toBeVisible({ timeout: 5_000 });
    // Peer replies on the same DM topic.
    peer.privmsg(NETWORK_NICK, reply);
    // Wait for the reply to land.
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: reply }),
    ).toBeVisible({ timeout: 5_000 });
    // The invariant: NO unread-marker. The user was reading live the
    // whole time — both messages arrived during their focus session.
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0);
  } finally {
    await peer.disconnect("marker-target T1 done");
  }
});

test("switching to tall window after focused send scrolls target to bottom", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const own = ownBody("2");
  const reply = replyBody("2");
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Set up the bug pre-condition: a DM with own-msg + peer-reply
    // (this is the path that leaks markerRef on the source window).
    await composeSend(page, `/query ${PEER_NICK}`);
    await composeSend(page, own);
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: own }),
    ).toBeVisible({ timeout: 5_000 });
    peer.privmsg(NETWORK_NICK, reply);
    await expect(
      page.locator('[data-testid="scrollback-line"]', { hasText: reply }),
    ).toBeVisible({ timeout: 5_000 });

    // Pad the channel with extra rows so scrollHeight > clientHeight
    // and "at bottom vs at top" is observable. The autojoin channel
    // already has the self-JOIN line; pad with N peer messages.
    for (let i = 0; i < 60; i++) {
      peer.privmsg(CHANNEL, `pad-${i}`);
    }
    // Wait for the last pad message to land in the channel's scrollback
    // store (server persists + broadcasts on the channel topic). We're
    // still focused on the DM — the rows accumulate in the channel's
    // background store, and the channel's <ScrollbackPane> instance
    // hasn't seen them yet because it's not mounted.

    // Switch to the tall channel — the target window.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });

    // The invariant: target window's scrollback viewport is at the
    // bottom (last row visible). Read scrollTop / scrollHeight /
    // clientHeight from the live DOM via evaluate — Playwright doesn't
    // expose scroll geometry directly. Allow a 50px slop for the
    // SCROLL_BOTTOM_THRESHOLD_PX in production code.
    await expect
      .poll(
        async () =>
          page.evaluate(() => {
            const sb = document.querySelector('[data-testid="scrollback"]');
            if (!sb) return null;
            const dist = sb.scrollHeight - sb.scrollTop - sb.clientHeight;
            return dist;
          }),
        {
          timeout: 5_000,
          message: "scroll position should be at bottom (dist <= 50)",
        },
      )
      .toBeLessThanOrEqual(50);
  } finally {
    await peer.disconnect("marker-target T2 done");
  }
});
