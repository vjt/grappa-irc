// #947 — the in-pane unread divider labels itself with the page size.
//
// This is the notch AFTER #693. That change suppressed the divider for a pane
// sitting far behind, because a count taken from the loaded rows would have
// described the tail page rather than the abandoned region — "a confident
// wrong number in the one place the operator reads to decide where they left
// off" — and handed the true, server-measured count to the pinned
// "N unread — jump back" bar instead (see `issue161-forward-paging.spec.ts`,
// which pins that state).
//
// Taking the jump was the case nobody followed through on. `jumpToUnread`
// refetches `after(resumeFrom, PAGE_LIMIT)` — ONE page out of a gap that is
// > 200 by the very definition of far-behind — REPLACES the pane with it, and
// clears the far-behind flag. Clearing the flag un-suppresses the divider,
// whose count is recomputed from the rows now loaded: exactly 200, every
// time, for every window in this state. The operator taps a bar reading
// "239 unread" and lands two hundred milliseconds later on
// "── 200 unread messages ──". The fetch cap, surfacing as a fact about the
// conversation.
//
// The fix keeps loaded-row math for the divider's PLACEMENT (it must sit
// between the last read row and the first unread row actually in the pane —
// no server count knows where that is) and takes the LABEL from the
// measurement the jump already had in hand: the same `missed` number the bar
// advertised, stamped with the cursor it was measured after so it expires by
// itself once the frozen divider re-latches somewhere else.
//
// The discriminating assertion is therefore NOT "the divider is present" but
// "the number you tapped is the number you land on". Against the unfixed
// client the divider reads exactly `MAX_HTTP_LIMIT`; the bar's count and the
// divider's count disagree, and the spec is RED on both halves.
//
// Seeding mirrors the #693 spec: the shared seeder plants 200 rows in #bofh
// and this needs unread > 200, so it re-seeds via the admin
// `resetSubject(baselineSeed)` surface. The wrapped `test` fixture's afterEach
// truncates #bofh back to the baseline, so no manual row cleanup is needed;
// `restoreReadCursorToTail` in afterAll undoes the early cursor (BUGHUNT-3
// cascade rule — a spec that leaves a mid-list cursor behind makes every
// downstream spec open its pane at a divider instead of at the tail).

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
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

// The server's `@max_http_limit` and the client's `PAGE_LIMIT`. The number the
// unfixed divider reports, and therefore the number this spec must see the
// divider NOT report.
const MAX_HTTP_LIMIT = 200;

// Rows left after the planted cursor. Above the cap (so the pane goes far
// behind and the jump's after-page comes back FULL), and close enough to it
// that a saturated label and an honest one are plainly different numbers.
const UNREAD_TARGET = 240;

const countIn = (label: string, what: string): number => {
  const match = label.match(/(\d+)/);
  if (!match?.[1]) {
    throw new Error(`#947 spec: ${what} carries no count: ${JSON.stringify(label)}`);
  }
  return Number(match[1]);
};

test.describe("#947 — the unread divider counts the conversation, not the page", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("jumping back into the unread region keeps the count the affordance advertised", async ({
    page,
  }) => {
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
    if (!lastReadRow) throw new Error("#947 spec: seeded #bofh rows missing cursor index");
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
    const jumpButton = page.locator('[data-testid="far-behind-jump"]');
    await expect(jumpButton).toBeAttached({ timeout: 10_000 });

    // The number the operator is about to tap. Uncapped (#693), so strictly
    // above the page limit — otherwise the two numbers could agree by
    // coincidence and the assertion below would prove nothing.
    const advertised = countIn(await jumpButton.innerText(), "the jump-back bar");
    expect(advertised).toBeGreaterThan(MAX_HTTP_LIMIT);
    expect(advertised).toBeLessThanOrEqual(rowsAfterCursor);

    await jumpButton.click();

    // The swap landed: the bar is gone and the divider is back, now that the
    // pane is anchored at the read position again.
    await expect(page.locator('[data-testid="far-behind-bar"]')).toHaveCount(0);
    const marker = page.locator('[data-testid="unread-marker"]');
    await expect(marker).toBeVisible({ timeout: 10_000 });

    // THE assertion. The unfixed client reads exactly MAX_HTTP_LIMIT here,
    // because it recounted the one page the jump could carry.
    const shown = countIn(await marker.innerText(), "the unread divider");
    expect(shown).toBe(advertised);
    expect(shown).toBeGreaterThan(MAX_HTTP_LIMIT);

    // Placement is still loaded-row math, and must not have moved: the last
    // read row sits ABOVE the divider, the first unread row BELOW it. A label
    // fix that relocated the divider would be a worse bug than the label.
    // Day separators are not in this selector, so adjacency here is exactly
    // "the row before / after the divider" in the message flow.
    const flow = await page
      .locator('[data-testid="unread-marker"], [data-testid="scrollback-line"]')
      .evaluateAll((nodes) =>
        nodes.map((n) =>
          n.getAttribute("data-testid") === "unread-marker" ? "MARKER" : n.getAttribute("data-msg-id"),
        ),
      );
    const markerAt = flow.indexOf("MARKER");
    expect(markerAt).toBeGreaterThan(0); // read context above it
    expect(flow[markerAt - 1]).toBe(String(lastReadRow.id));
    const firstUnread = rows.find((r) => r.id > lastReadRow.id);
    if (!firstUnread) throw new Error("#947 spec: no row after the planted cursor");
    expect(flow[markerAt + 1]).toBe(String(firstUnread.id));
  });
});
