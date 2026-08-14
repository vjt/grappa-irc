// #1229 — the unread exemption has a ceiling now, and crossing it is visible.
//
// S20's ring cap never evicts a row at/after the read cursor. That exemption
// had no ceiling, so a channel the operator does not read holds ALL of its
// unread rows and the cap does nothing. Since the pane renders every retained
// row (measured on origin/main: 1084 retained rows produce 1084
// `.scrollback-line` nodes, ratio 1.0000, no windowing anywhere in the render
// path), retention and rendered DOM are the same curve — ~19-26 KB of renderer
// memory per row, ~26 MB for the reporter's window, against a ceiling iOS
// applies per web process.
//
// The bound is one page of unread (`UNREAD_RETENTION_CAP = PAGE_LIMIT`), and
// past it the window joins the far-behind state the client already has for
// exactly this shape: divider suppressed, "N unread — jump back" banner,
// `jumpToUnread` rebuilding the region from the server.
//
// ── What this spec pins, and why each assertion is here ──────────────────
//
// The gesture is ONE live PRIVMSG, not a flood. The cursor is planted so the
// window sits at one page of unread MINUS one, so a single arriving row is the
// whole crossing — a burst would prove the same thing while also inviting the
// ircd's flood kill into the spec.
//
//   1. Before the gesture: no bar, and the in-pane divider is there. Without
//      this the outcome could be a bar that was already up for another reason
//      (a cold far-behind resume, #693) and the spec would test nothing.
//   2. After it: the bar is up with the honest total, and the divider is gone.
//      That is the state transition, seen from outside.
//   3. The OLDEST unread row is gone from the DOM, and the rows the operator
//      is looking at are NOT. This is the one assertion that distinguishes the
//      implementation that shipped from the simpler one that did not: dropping
//      "everything but the newest page" would have satisfied (2) while
//      deleting the screen out from under a reader scrolled up in history.
//      The absence assertion is only meaningful because the list is not
//      virtualised — every retained row is in the DOM whatever the scroll
//      position, which is the same measurement that motivated the fix.
//   4. `scrollTop` is preserved across the bite, within the tolerance the
//      sibling scroll specs use. Rows leaving from BELOW the fold must not
//      move the viewport.
//
// Scrolling up is also what keeps the precondition alive: `setCursorIfAdvances`
// is forward-only, so with the pane scrolled into the read context the settle
// writer can only propose an id BELOW the planted cursor, and is refused. A
// pane left at the tail would advance the cursor to the newest row, unread
// would fall to zero, and the ceiling would never be approached.
//
// ── NOT covered here, deliberately ───────────────────────────────────────
//
// The far-behind banner's own behaviour (jump, dismiss, badge) belongs to
// #693/#888/#1019 and is pinned there; this spec asserts only that the bound
// DELIVERS the window into that state. The memory figures above are not
// asserted by any e2e — they were measured with a browser and a heap probe,
// and a spec that re-measured them would be pinning the host, not the product.
//
// This spec does NOT claim anything about the half-height frame #1229 was
// filed for: that reproduces with the admin pane focused and zero scrollback
// rows mounted, so no scrollback bound can explain it.

import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import {
  fetchAllMessagesAsc,
  getReadCursor,
  resetSubject,
  setReadCursorToId,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// `UNREAD_RETENTION_CAP` in `lib/scrollback.ts` — one page, the same number
// `isFarBehind` already draws the line at. Mirrored rather than imported: the
// e2e bundle is the built app, and a spec that imported the source constant
// would keep passing if the shipped bundle disagreed with it.
const UNREAD_BOUND = 200;

// Enough history that the pane has a read context to be scrolled up INTO,
// above the bound so the planted cursor has somewhere to sit.
const SEED_COUNT = 420;
const SEED_SENDER = "seed-bot";

// One short of the ceiling: the protected region is the cursor row plus the
// rows after it, so `UNREAD_BOUND - 1` unread rows leave exactly `UNREAD_BOUND`
// protected — the last state before the bound bites.
const UNREAD_BEFORE = UNREAD_BOUND - 1;

const OUTCOME_TIMEOUT_MS = 10_000;
// The tolerance `issue196-preview-scroll-preserve` uses for "the viewport did
// not move": sub-pixel geometry, not a budget for a jump.
const SCROLL_TOLERANCE_PX = 3;

const scrollGeometry = (page: import("@playwright/test").Page) =>
  page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (el === null) throw new Error("#1229 spec: scrollback container missing");
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });

test.describe("#1229 — the unread retention bound", () => {
  test.use({ viewport: { width: 800, height: 400 } });

  test("crossing one page of unread prunes from the divider and raises the far-behind bar", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = specUser();
    const admin = getSeededAdmin();

    await resetSubject(
      admin.token,
      vjt.name,
      { [NETWORK_SLUG]: AUTOJOIN_CHANNELS },
      { [NETWORK_SLUG]: [{ name: CHANNEL, seedCount: SEED_COUNT, seedSender: SEED_SENDER }] },
    );

    const rows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(rows.length).toBeGreaterThan(UNREAD_BEFORE + 20);

    const cursorRow = rows[rows.length - 1 - UNREAD_BEFORE];
    const oldestUnread = rows[rows.length - UNREAD_BEFORE];
    const readContextRow = rows[rows.length - 1 - UNREAD_BEFORE - 10];
    if (!cursorRow || !oldestUnread || !readContextRow) {
      throw new Error("#1229 spec: seeded rows missing an index");
    }
    // Precondition, guarded rather than assumed: exactly one short of the
    // ceiling. One row above and the pane would already be far behind on load.
    expect(rows.filter((r) => r.id > cursorRow.id).length).toBe(UNREAD_BEFORE);

    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, cursorRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL);

    const bar = page.locator('[data-testid="far-behind-bar"]');
    const marker = page.locator('[data-testid="unread-marker"]');
    await expect(marker).toBeAttached({ timeout: OUTCOME_TIMEOUT_MS });
    await expect(bar).toHaveCount(0);

    // Scroll up into the read context. Not to the very top: that is the
    // `loadMore` trigger, and a prepend would move `scrollTop` for reasons
    // that have nothing to do with the bound.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
      if (el === null) throw new Error("#1229 spec: scrollback container missing");
      el.scrollTop = Math.floor(el.scrollHeight * 0.25);
    });
    const before = await scrollGeometry(page);
    expect(before.scrollTop).toBeGreaterThan(0);
    expect(before.scrollHeight - before.scrollTop - before.clientHeight).toBeGreaterThan(
      SCROLL_TOLERANCE_PX,
    );

    // The settle writer runs on a debounce; give it its window and then prove
    // it did NOT move the cursor. Forward-only refusal is what holds the
    // precondition, so it is asserted, not assumed.
    await expect
      .poll(() => getReadCursor(vjt.token, NETWORK_SLUG, CHANNEL), {
        timeout: OUTCOME_TIMEOUT_MS,
      })
      .toBe(cursorRow.id);

    const oldestUnreadLine = page.locator(
      `.scrollback-line:has-text(${JSON.stringify(oldestUnread.body)})`,
    );
    const readContextLine = page.locator(
      `.scrollback-line:has-text(${JSON.stringify(readContextRow.body)})`,
    );
    await expect(oldestUnreadLine).toHaveCount(1);
    await expect(readContextLine).toHaveCount(1);

    // ── The gesture: one live row, which makes the protected region one past
    // the ceiling.
    const peer = await IrcPeer.connect({ nick: "bound1229" });
    try {
      await peer.join(CHANNEL);
      peer.privmsg(CHANNEL, "the row that crosses the ceiling");

      // (2) the state transition, seen from outside
      await expect(bar).toBeVisible({ timeout: OUTCOME_TIMEOUT_MS });
      await expect(bar).toContainText(String(UNREAD_BOUND));
      await expect(marker).toHaveCount(0);

      // (3) pruned from the divider, not from the screen
      await expect(oldestUnreadLine).toHaveCount(0);
      await expect(readContextLine).toHaveCount(1);
      await expect(
        page.locator('.scrollback-line:has-text("the row that crosses the ceiling")'),
      ).toHaveCount(1);

      // (4) the viewport did not move
      const after = await scrollGeometry(page);
      expect(Math.abs(after.scrollTop - before.scrollTop)).toBeLessThanOrEqual(SCROLL_TOLERANCE_PX);
    } finally {
      await peer.part(CHANNEL, "done");
    }
  });
});
