// #997 — the far-behind dismiss was out of thumb reach.
//
// Reported from IRC. An operator sat at the tail of a channel under a frozen
// `(199)` badge and could not make it fall. The diagnosis was the intended
// one — the window is far behind, so #693 freezes the read cursor on purpose
// and #888 marks the badge as a DISTANCE rather than a counter — but the
// dismiss is the only gesture that unfreezes that cursor, and it lived pinned
// to the TOP edge of the pane. They never looked up, so for the whole session
// the badge read as a broken counter.
//
// The bar keeps the label; the gesture now also sits in the #280 float stack
// at the lower right, where the thumb and the attention already are. This
// spec pins the OUTCOME the operator could not reach: with the window far
// behind, a tap on the corner affordance drops the badge.
//
// Three things are measured here rather than asserted by class name:
//   * the control's box is at least 44×44 CSS px (the tap floor; the root
//     font-size is 14px, so a rem-based target silently comes out short),
//   * its centre sits in the lower-right quadrant of the scrollback pane —
//     the placement claim itself, and the thing that was wrong,
//   * the badge is gone afterwards, i.e. the cursor actually unfroze. A
//     corner control that merely navigated would satisfy the first two and
//     leave the operator exactly where they were.
//
// Against the unfixed client the corner control does not exist at all, so
// the spec is RED at the locator.
//
// Seeding mirrors `issue947-unread-divider-count.spec.ts` (itself mirroring
// the #693 spec): the shared seeder plants 200 rows in #bofh and this needs
// unread > 200, so it re-seeds via the admin `resetSubject(baselineSeed)`
// surface. The wrapped `test` fixture's afterEach truncates #bofh back to the
// baseline; `restoreReadCursorToTail` in afterAll undoes the early cursor
// (BUGHUNT-3 cascade rule — a spec that leaves a mid-list cursor behind makes
// every downstream spec open its pane at a divider instead of at the tail).
//
// Desktop viewport on purpose. The mobile stack renders this control LARGER
// (3.5rem / 48px floor, matching its siblings), so measuring the desktop box
// measures the worst case of the tap floor, and the sidebar badge is the
// clearer read of "the badge fell".

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarMessageBadge } from "../fixtures/cicchettoPage";
import {
  fetchAllMessagesAsc,
  resetSubject,
  restoreReadCursorToTail,
  setReadCursorToId,
} from "../fixtures/grappaApi";
import {
  AUTOJOIN_CHANNELS,
  getSeededAdmin,
  getSeededVjt,
  NETWORK_SLUG,
  VJT_USER,
} from "../fixtures/seedData";

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

// Apple HIG, in ABSOLUTE px. Not `2.75rem`: the root font-size is 14px here
// and user-configurable down to 12px, so a rem target renders 38.5px / 33px.
const TAP_FLOOR_PX = 44;

const countIn = (label: string, what: string): number => {
  const match = label.match(/(\d+)/);
  if (!match?.[1]) {
    throw new Error(`#997 spec: ${what} carries no count: ${JSON.stringify(label)}`);
  }
  return Number(match[1]);
};

test.describe("#997 — the far-behind dismiss is in thumb reach", () => {
  test.use({ viewport: { width: 800, height: 400 } });

  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("tapping the corner affordance drops the frozen badge", async ({ page }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    const admin = getSeededAdmin();

    await resetSubject(
      admin.token,
      VJT_USER,
      { [NETWORK_SLUG]: AUTOJOIN_CHANNELS },
      { [NETWORK_SLUG]: [{ name: CHANNEL, seedCount: LARGE_SEED_COUNT, seedSender: SEED_SENDER }] },
    );

    const rows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
    expect(rows.length).toBeGreaterThan(UNREAD_TARGET);

    const lastReadRow = rows[rows.length - UNREAD_TARGET];
    if (!lastReadRow) throw new Error("#997 spec: seeded #bofh rows missing cursor index");
    const rowsAfterCursor = rows.filter((r) => r.id > lastReadRow.id).length;
    // Guard the precondition: below this the pane never goes far behind and
    // the spec would pass by testing nothing.
    expect(rowsAfterCursor).toBeGreaterThan(MAX_HTTP_LIMIT);

    // Plant the cursor BEFORE login so the channel hydrates with it and takes
    // the cursor-present fetch arm.
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, lastReadRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL);

    // The bar renders only once the resume has probed the count and decided
    // the gap is undrainable — the readiness signal for the far-behind arm.
    const bar = page.locator('[data-testid="far-behind-bar"]');
    await expect(bar).toBeAttached({ timeout: 10_000 });
    const advertised = countIn(
      await page.locator('[data-testid="far-behind-jump"]').innerText(),
      "the jump-back bar",
    );
    expect(advertised).toBeGreaterThan(MAX_HTTP_LIMIT);

    // The state the operator was stuck in: a badge carrying the #888
    // far-behind treatment, frozen, with no amount of reading able to move it.
    const badge = sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL);
    await expect(badge).toBeVisible({ timeout: 10_000 });
    await expect(badge).toHaveClass(/far-behind/);

    const corner = page.locator('[data-testid="far-behind-float-dismiss"]');
    await expect(corner).toBeVisible();

    // MEASURED, not asserted on the class name. A rem-sized target passes a
    // class-name check and still comes out at 38.5px under the 14px root.
    const box = await corner.boundingBox();
    if (!box) throw new Error("#997 spec: the corner affordance has no layout box");
    expect(box.width).toBeGreaterThanOrEqual(TAP_FLOOR_PX);
    expect(box.height).toBeGreaterThanOrEqual(TAP_FLOOR_PX);

    // The placement claim. The defect was not "the control is missing", it was
    // "the control is at the top edge and nobody looks there": pin the corner
    // it now has to be in, relative to the pane it is anchored to.
    const paneBox = await page.locator(".scrollback-pane").boundingBox();
    if (!paneBox) throw new Error("#997 spec: the scrollback pane has no layout box");
    expect(box.x + box.width / 2).toBeGreaterThan(paneBox.x + paneBox.width / 2);
    expect(box.y + box.height / 2).toBeGreaterThan(paneBox.y + paneBox.height / 2);

    await corner.click();

    // THE outcome. The cursor unfroze, so the badge fell — the thing the
    // operator could not achieve. Both halves matter: a corner control that
    // only scrolled would clear neither.
    await expect(badge).toHaveCount(0, { timeout: 10_000 });
    await expect(bar).toHaveCount(0);
    await expect(corner).toHaveCount(0);
  });
});
