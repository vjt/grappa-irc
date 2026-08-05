// #887 — the unread badge on the window you are LOOKING AT.
//
// The report (vjt, 2026-08-05, on a channel he had just been reading): focus
// the window → the badge disappears; switch away → it comes back at 1832.
// Nothing was wrong — the read cursor was where it should be — but the two
// states "you are looking at this" and "you have read this" were drawn
// identically (no badge), so the display lied by omission.
//
// The fix removes the suppression overwrite from `perChannelUnread` and pairs
// it with a read-at-the-tail cursor advance in ScrollbackPane, so the number
// answers one question everywhere: how much have you not read.
//
// Why this has to be a browser test, not jsdom: BOTH halves of the contract
// are geometry. "Holds while scrolled up" and "drains at the tail" are the
// same code path taking opposite branches on `atBottomNow`, and jsdom's
// zero-geometry pane reads as at-the-tail unconditionally — a jsdom test
// cannot tell the branches apart (measured: deleting the at-tail gate leaves
// the entire 171-test ScrollbackPane suite green). This spec is where that
// gate is actually pinned.
//
// Per `feedback_e2e_user_class_parity_matrix`: this pins the unread-badge
// CONTRACT, not a verb across user classes — one seeded registered user is
// the right shape.

import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarMessageBadge } from "../fixtures/cicchettoPage";
import {
  fetchAllMessagesAsc,
  restoreReadCursorToTail,
  setReadCursorToId,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const PEER_NICK = "badge887-buddy";
const RUN_ID = crypto.randomUUID().slice(0, 8);

// How far back to plant the cursor. Two hard bounds, and the window between
// them is where this scenario exists at all:
//   * FAR ENOUGH that the divider the pane activates on is off-screen, so the
//     pane lands NOT at the tail — the state whose badge must hold.
//   * UNDER 200, or `isFarBehind` (scrollback.ts, #693) trips, the cursor
//     freezes by design and the badge could never drain. That is #888's
//     subject, not this one.
const UNREAD_DEPTH = 120;

// Longer than the pane's read-at-the-tail debounce (500ms) plus generous
// browser slop. Every "the badge must NOT have moved" assertion waits this
// long first — a negative that does not outlive the mechanism it is denying
// proves nothing.
const PAST_READ_AT_TAIL_SETTLE_MS = 1_500;

// Longer than INPUT_EVENT_RECENCY_MS (1500ms). Waiting it out CLOSES the
// scroll-settle arm's input gate, so a cursor advance observed afterwards
// cannot be attributed to the operator's last wheel — it can only be the
// read-at-the-tail arm. Displacement, not coincidence.
const PAST_INPUT_RECENCY_MS = 2_200;

async function wheelOverPane(page: Page, deltaY: number): Promise<void> {
  // A REAL WheelEvent: ScrollbackPane's onScroll settle arm is gated on a
  // preceding operator input event, and a synthetic `dispatchEvent("scroll")`
  // does not stamp one (BUGHUNT-2).
  const box = await page.locator('[data-testid="scrollback"]').boundingBox();
  if (!box) throw new Error("scrollback bounding box null");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

async function badgeCount(page: Page): Promise<number> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const badge = sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL);
  if ((await badge.count()) === 0) return 0;
  const text = (await badge.textContent()) ?? "";
  const n = Number.parseInt(text.trim(), 10);
  return Number.isNaN(n) ? 0 : n;
}

test.describe("#887 focused-window unread badge", () => {
  // BUGHUNT-3 cascade rule: this spec deliberately leaves the cursor
  // mid-channel for most of its run. Restore to tail so downstream specs
  // inherit a fully-read #bofh.
  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("survives focus, holds while scrolled up, and falls as the operator reads", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();

    const rows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(rows.length).toBeGreaterThanOrEqual(UNREAD_DEPTH + 10);
    const lastRead = rows[rows.length - UNREAD_DEPTH];
    if (!lastRead) throw new Error("#887 spec: seeded #bofh rows missing expected index");

    // Plant the cursor BEFORE login so the channel hydrates already behind.
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, lastRead.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    const badge = sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL);

    // ── THE HEADLINE (RED pre-#887) ─────────────────────────────────────
    // Focusing the window used to zero this badge outright. It must be here,
    // showing the real distance.
    await expect(badge).toBeVisible({ timeout: 10_000 });
    const onFocus = await badgeCount(page);
    expect(onFocus).toBeGreaterThan(60);

    // ── HOLDS WHILE SCROLLED UP ─────────────────────────────────────────
    // The pane activated on the unread divider, ~120 rows above the tail, so
    // the operator is NOT looking at the newest rows. Waiting out the
    // read-at-the-tail debounce must change nothing: marking rows read
    // because they exist below the fold is precisely the mistake the
    // at-tail gate exists to refuse.
    await page.waitForTimeout(PAST_READ_AT_TAIL_SETTLE_MS);
    expect(await badgeCount(page)).toBe(onFocus);

    // ── FALLS AS THEY READ ──────────────────────────────────────────────
    // A real wheel down: rows scroll past, the scroll-settle arm advances the
    // cursor to the new visible tail, and the badge must come DOWN — not
    // vanish (that was the bug) and not hold.
    await wheelOverPane(page, 1_200);
    await expect
      .poll(async () => await badgeCount(page), { timeout: 10_000 })
      .toBeLessThan(onFocus);
    const afterReading = await badgeCount(page);
    // Still unread rows below: a partial read is a partial drop. Asserting
    // the INTERMEDIATE value is the point — a badge that only ever went
    // "N → gone" would satisfy a first-and-last check while being exactly
    // the vanishing behaviour #887 removed.
    expect(afterReading).toBeGreaterThan(0);

    // ── REACHES ZERO AT THE TAIL ────────────────────────────────────────
    await wheelOverPane(page, 20_000);
    await expect(badge).toHaveCount(0, { timeout: 10_000 });
  });

  test("a message arriving while the operator watches the tail clears itself", async ({ page }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();

    // Caught up and parked at the tail — the state the old suppression used
    // to paper over and the one no pre-existing writer can serve: leave /
    // blur / unmount all need the operator to STOP looking, and scroll-settle
    // needs an input event that never comes.
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, {
      timeout: 10_000,
    });

    // Close the scroll-settle arm's input gate before doing anything else:
    // `selectChannel` may have produced input events, and inside the recency
    // window a drain could be attributed to the settle arm rather than to the
    // read-at-the-tail one. After this wait only the latter can fire.
    await page.waitForTimeout(PAST_INPUT_RECENCY_MS);

    const peer = await IrcPeer.connect({ nick: PEER_NICK });
    try {
      await peer.join(CHANNEL);
      const body = `#887 watched arrival ${RUN_ID}`;
      peer.privmsg(CHANNEL, body);

      // The row lands and the pane tail-follows it into view.
      await expect(
        page.locator('[data-testid="scrollback-line"]', { hasText: body }),
      ).toBeVisible({ timeout: 10_000 });

      // …and settles back to no badge, with the operator having touched
      // nothing. Without the read-at-the-tail arm this sticks at 1 forever:
      // the row is past the cursor, the badge is no longer suppressed, and
      // every other writer is waiting for the operator to leave.
      //
      // The wait is load-bearing and must come BEFORE the assertion, not as
      // its timeout: `toHaveCount(0)` resolves on the FIRST poll that
      // succeeds, and the badge is legitimately absent for the instant
      // between the row landing and the count bumping — so a bare
      // auto-retrying assertion here would pass against a broken arm. Settle
      // past the debounce first, then read once.
      await page.waitForTimeout(PAST_READ_AT_TAIL_SETTLE_MS);
      expect(await badgeCount(page)).toBe(0);
    } finally {
      await peer.disconnect("#887 watched-arrival done");
    }
  });
});
