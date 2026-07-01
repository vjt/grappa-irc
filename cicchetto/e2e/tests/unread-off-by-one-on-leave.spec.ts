// #163 — off-by-one unread on leave: the LAST message of a channel must
// STAY marked-read when the pane was pinned to the bottom at leave time.
//
// Root cause (confirmed): the leave/settle read-cursor is sourced from
// `lastFullyVisibleRowId(listRef)` in `ScrollbackPane.tsx`. Its per-row
// test `row.offsetTop + row.offsetHeight > viewportBottom` uses a STRICT
// `>`. When the pane is pinned to the bottom, sub-pixel/fractional
// geometry (fractional scrollHeight, last-card margin, integer scrollTop
// rounding) makes the LAST row test as `bottom > viewportBottom`, so the
// loop `break`s BEFORE assigning it as the candidate → the cursor lands
// one message short of the true tail. That ONE function feeds every
// cursor-write settle path (onCleanup unmount, onScroll snapshot +
// 500ms settle, visibility-hide), so on leaving the channel the sidebar
// badge returns to "1 unread" and re-selecting re-injects the
// `── 1 unread message ──` divider.
//
// This pin asserts the VISIBLE outcome — sidebar badge 0 and NO marker
// re-injected after a leave → return — NOT a cursor/fetch spy. Hollow-
// green history (#78/#146/#159): a spec that passes while the bug lives
// is worse than none. RED against current code (badge stays 1, marker
// re-injects), GREEN once the at-bottom short-circuit lands.
//
// Per BUGHUNT-3 cascade rule: this spec advances the cursor on the
// shared seeded `vjt @ bahamut-test/#bofh`, so `afterAll` restores the
// cursor to tail for downstream specs.

import { expect, test } from "../fixtures/test";
import {
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarMessageBadge,
} from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import {
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "unread-offbyone-buddy";

// Settle budget for the auto-follow scroll + the leave-arm/onCleanup
// cursor write to commit. The local cursor advances optimistically
// (forward-only) so the derived badge memo recomputes without a WS
// round-trip; 800ms matches the sibling cursor specs.
const LEAVE_SETTLE_MS = 800;

test.describe("#163 off-by-one unread on leave (pinned to bottom)", () => {
  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("#163 last message stays read after leaving pinned-to-bottom", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();

    // Clean baseline: channel fully-read at first focus so any post-leave
    // unread is THIS bug, not a leftover from a prior spec.
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);

    await loginAs(page, vjt);

    // Focus #bofh — the pane loads scrollback and pins to the bottom
    // (`atBottom` starts true).
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // A peer sends a REAL tail message. Because the pane is pinned to the
    // bottom it auto-follows, so this row becomes the visible true tail —
    // the row that MUST stay marked read.
    const tailBody = `unread-offbyone tail ${crypto.randomUUID().slice(0, 8)}`;
    const peer = await IrcPeer.connect({ nick: PEER_NICK });
    try {
      await peer.join(CHANNEL);
      peer.privmsg(CHANNEL, tailBody);

      await expect(scrollbackLine(page, "privmsg", tailBody)).toBeVisible({
        timeout: 10_000,
      });

      // Let the auto-follow scroll + focused-at-bottom settle commit so
      // the pane is genuinely pinned to the bottom when the leave write
      // computes the cursor.
      await page.waitForTimeout(LEAVE_SETTLE_MS);

      // LEAVE without reload: focus the always-present $server window
      // (windowName === slug maps to the server tab). This fires the
      // leave/settle cursor write for #bofh via `lastFullyVisibleRowId`.
      await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, {
        awaitWsReady: false,
      });

      // Load-bearing assertion #1: the leaving channel's sidebar UNREAD
      // badge is ABSENT. Under the off-by-one the cursor lands one short
      // of `tailBody`, so `count_after(cursor)` === 1 and the badge
      // materializes showing "1". With the at-bottom short-circuit the
      // cursor is the true tail → count 0 → badge absent.
      await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toHaveCount(
        0,
        { timeout: 5_000 },
      );

      // Re-select #bofh. Load-bearing assertion #2: NO `── 1 unread
      // message ──` divider is re-injected. The marker derives from the
      // cursor snapshot on focus; a one-short cursor re-injects it.
      await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
      await expect(scrollbackLine(page, "privmsg", tailBody)).toBeVisible({
        timeout: 5_000,
      });
      await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0, {
        timeout: 5_000,
      });
    } finally {
      await peer.disconnect("unread-offbyone done");
    }
  });
});
