// #1019 — leaving a far-behind window IS the bar's ×.
//
// vjt, on IRC: *"il focus out su una finestra con molto scrollback e con la
// top bar dovrebbe fare mark as read, come se avessimo premuto la X"*. The
// far-behind bar (#693/#888) had two exits and both cost a deliberate click;
// an operator who simply moves on to another window used to carry a frozen
// badge that no amount of reading could clear, because #693 freezes the read
// cursor on purpose and the leave writer is one of the four the freeze holds
// back.
//
// The fix ROUTES the leave writer to `dismissFarBehind` instead of thawing
// `setCursorIfAdvances` for it. That distinction is invisible from the
// outside, so what this spec pins is the OUTCOME, three ways:
//
//   * the sidebar badge falls once the operator selects another window —
//     the thing they could not achieve without finding the × at the top edge;
//   * the SERVER-side cursor lands at (or past) the tail — the same
//     `setReadCursor` fan-out the × performs, which is what "identical in
//     effect to clicking ×" in the Acceptance clause actually means. A purely
//     local badge clear would satisfy the first assertion and leave every
//     other device still far behind;
//   * coming BACK shows no bar and no phantom count — the second Acceptance
//     clause, and the one that would catch a dismiss that cleared the badge
//     without moving the cursor the resume re-reads.
//
// Measured RED on the parent commit (`dbdefa6b`, the fix absent): the run
// reached assertion 1 and stopped there —
//   `expect(locator).toHaveCount(expected) failed / Expected: 0 / Received: 1`
//   `14 × locator resolved to 1 element - unexpected value "1"`
// i.e. every precondition held (bar attached, badge far-behind, cursor still
// where it was planted) and only the outcome was missing. The failure lands on
// the outcome, not on a locator and not in setup, which is what makes this a
// guard rather than a mirror.
//
// ── What this file does NOT cover, and why it is absent rather than faked ──
//
// Q1 was ruled by vjt on the issue: only (a), a window switch INSIDE cic,
// dismisses; (b) tab backgrounding and (c) OS window blur must NOT. Those two
// negatives are NOT asserted here. A test that drove them via a second tab and
// `page.bringToFront()` was written, run, and REMOVED after measurement: on
// both the local host and the CI runner the polled precondition
// `document.visibilityState === "visible" && document.hasFocus()` stayed
// **true** for the full 10s budget on the supposedly backgrounded page. Both
// conjuncts true means neither the visibility edge nor the focus edge ever
// fired, so `documentVisibility.ts`'s `computeVisible()` never changed value
// and the `on(isDocumentVisible)` arm in `ScrollbackPane` was never asked the
// question. The spec proved nothing about the product — it could not even
// establish its own premise — and a negative that cannot fail is worse than an
// absent one.
//
// The honest place for those two negatives is the vitest guardrail in
// `ScrollbackPane.test.tsx`, which drives the visibility-hide writer directly
// and was mutation-measured (routing `settleCursorToVisibleTail` to the
// dismiss turns it red). Synthesising a `visibilitychange` from
// `page.evaluate` would have produced a green here, but it would mean
// asserting against a stubbed browser API inside a real browser — the one
// place a stub buys nothing.
//
// Also NOT covered, for a product reason rather than a harness one: the pane
// unmounts for any window whose kind `kindHasScrollback` rejects, so a switch
// to one lands in `onCleanup` and not in the key arm that dismisses. That
// switch leaves the far-behind state STANDING (the safe side — the region
// stays recoverable) and the call site says so. Since issue 2613 the reason is
// no longer that the leaving window cannot be named: `shownKey` names it.
// This spec therefore leaves for the SERVER window, which
// shares the `kindHasScrollback` Match with channels and so keeps the pane
// mounted and fires the key arm — the same gesture
// `cursor-forward-only.spec.ts` uses to drive the leave writer, and one that
// introduces no new name into the shared testnet namespace.
//
// ── Mechanics ──
//
// Seeding mirrors `issue1062-far-behind-float-stack.spec.ts` (same bar, same
// precondition): the shared seeder plants 200 rows in #bofh and this needs a
// gap ABOVE the 200-row page cap, so it re-seeds via the admin
// `resetSubject(baselineSeed)` surface. Nothing has to be undone afterwards:
// #1078 destroys the whole subject at teardown, rows and cursor with it.
//
// No sleep is used as synchronisation: every step waits on an observable
// condition (the bar attaching, the badge reaching count 0, the server cursor
// reaching the tail). The cursor is written server-side at SETTLE cadence, so
// the timeouts here are WAIT BUDGETS on those conditions, never the thing
// being measured.
//
// Desktop viewport on purpose, matching #997: the sidebar badge is the clearer
// read of "the badge fell" than the mobile tab treatment.

import { loginAs, selectChannel, sidebarMessageBadge } from "../fixtures/cicchettoPage";
import {
  fetchAllMessagesAsc,
  getReadCursor,
  resetSubject,
  setReadCursorToId,
} from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededAdmin, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Larger than the 200-row server cap, so a cursor planted early leaves a gap
// the resume cannot drain in one page — the far-behind precondition.
const LARGE_SEED_COUNT = 260;
const SEED_SENDER = "seed-bot";

// The server's `@max_http_limit` and the client's `PAGE_LIMIT`. A gap above
// this is what "far behind" means.
const MAX_HTTP_LIMIT = 200;

// Rows left after the planted cursor — above the cap, so the pane anchors at
// the tail and freezes.
const UNREAD_TARGET = 240;

// Wait budget for the settle-cadence server write to land and fan back. Not a
// sleep: it bounds an `expect.poll` / `toHaveCount` CONDITION.
const OUTCOME_TIMEOUT_MS = 10_000;

test.describe("#1019 — leaving a far-behind window marks it read", () => {
  test.use({ viewport: { width: 800, height: 400 } });

  test("selecting another window drops the frozen badge and advances the server cursor", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = specUser();
    const admin = getSeededAdmin();

    await resetSubject(
      admin.token,
      specUser().name,
      { [NETWORK_SLUG]: AUTOJOIN_CHANNELS },
      { [NETWORK_SLUG]: [{ name: CHANNEL, seedCount: LARGE_SEED_COUNT, seedSender: SEED_SENDER }] },
    );

    const rows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(rows.length).toBeGreaterThan(UNREAD_TARGET);

    const lastReadRow = rows[rows.length - UNREAD_TARGET];
    const tailRow = rows[rows.length - 1];
    if (!lastReadRow || !tailRow)
      throw new Error("#1019 spec: seeded #spec-wN rows missing an index");

    // Guard the precondition: below this the pane never goes far behind and
    // the spec would pass by testing nothing.
    const rowsAfterCursor = rows.filter((r) => r.id > lastReadRow.id).length;
    expect(rowsAfterCursor).toBeGreaterThan(MAX_HTTP_LIMIT);

    // Plant the cursor BEFORE login so the channel hydrates with it and takes
    // the cursor-present fetch arm.
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, lastReadRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL);

    // The bar renders only once the resume has probed the count and decided
    // the gap is undrainable — the readiness signal for the far-behind arm,
    // and the gate that says the freeze is actually in force.
    const bar = page.locator('[data-testid="far-behind-bar"]');
    await expect(bar).toBeAttached({ timeout: OUTCOME_TIMEOUT_MS });

    const badge = sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL);
    await expect(badge).toBeVisible({ timeout: OUTCOME_TIMEOUT_MS });
    await expect(badge).toHaveClass(/far-behind/);

    // Nothing has moved it yet: the pane has been open and rendered, and the
    // cursor is still exactly where it was planted. Without this the next
    // assertion could be satisfied by a write that had already happened.
    expect(await getReadCursor(vjt.token, NETWORK_SLUG, CHANNEL)).toBe(lastReadRow.id);

    // THE gesture. The server window shares the `kindHasScrollback` Match with
    // channels, so the pane stays mounted and the key arm fires with #spec-wN as
    // the LEAVING key — a real selection change through the sidebar, not a
    // direct call to the dismiss.
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });

    // Outcome 1 — the badge fell. This is the operator-visible result, the
    // whole point of the issue, and the assertion the parent commit fails.
    await expect(badge).toHaveCount(0, { timeout: OUTCOME_TIMEOUT_MS });

    // Outcome 2 — the SERVER cursor moved to the tail, i.e. the same
    // `setReadCursor` fan-out the × performs. `toBeGreaterThanOrEqual` rather
    // than `toBe`: the dismiss marks the newest LOCAL row, and a presence row
    // (a peer JOIN on the shared testnet) can land after the seed snapshot and
    // legitimately push the tail past `tailRow.id`. The load-bearing claim is
    // that it crossed the whole abandoned region, which the next line pins.
    await expect
      .poll(async () => await getReadCursor(vjt.token, NETWORK_SLUG, CHANNEL), {
        timeout: OUTCOME_TIMEOUT_MS,
      })
      .toBeGreaterThanOrEqual(tailRow.id);
    expect(tailRow.id).toBeGreaterThan(lastReadRow.id);

    // Outcome 3 — coming back shows no bar and no phantom count. The resume
    // re-reads the cursor this dismiss advanced, so a dismiss that cleared the
    // badge locally without persisting would rebuild the bar right here.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { awaitWsReady: false });
    await expect(bar).toHaveCount(0, { timeout: OUTCOME_TIMEOUT_MS });
    await expect(badge).toHaveCount(0);
  });
});
