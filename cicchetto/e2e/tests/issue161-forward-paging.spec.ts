// #161 — the NEWEST messages become unreachable after the #156 anchored
// fetch when unread exceeds the 200-row server cap.
//
// Original root cause: `loadInitialScrollback` (scrollback.ts) cursor-present
// arm fetched the region AROUND the read cursor — `listMessagesAfter(cursor,
// 200)` (capped at the server `@max_http_limit`) + `listMessages(cursor + 1)`
// for before-context. With true unread > 200 the after-page stopped at
// `cursor + 200`, so the newest rows were never loaded, and the WS join-ok
// `refreshScrollback` capped from the same cursor so it never reached the tail
// either. #161's answer was `loadNewer`: forward paging on scroll-to-bottom,
// walking [cursor+200 .. tail] one 200-row page per gesture.
//
// #693 SUPERSEDED THAT MECHANISM FOR THIS SCENARIO, and this spec is rewritten
// to the contract that replaced it. The observation behind #693 is that
// forward-paging out of a day-sized gap is not a fix an operator can feel: it
// still opens the pane at the OLDEST end of the gap and asks for one scroll
// gesture per 200 rows. So when the gap exceeds one page, the resume no longer
// anchors at the cursor at all — it probes the true (uncapped) unread count via
// `GET /networks/:slug/channels/:chan/messages/count?after=<id>`, REPLACES the
// pane with the newest page, and surfaces the abandoned region as a pinned
// "N unread — jump back" bar. The in-pane divider is deliberately SUPPRESSED
// while far behind (`ScrollbackPane` gates `injectMarker` on
// `farBehindByChannel()[key()] === undefined`), because its count would
// describe the ~50 loaded rows rather than the thousands missing.
//
// So #161's user-facing guarantee — "the newest message is reachable" — is now
// satisfied by construction rather than by scrolling, and this spec asserts
// that instead: with unread > 200 the tail is already rendered on arrival, the
// jump-back bar carries the UNCAPPED count, and the divider is absent. The old
// assertions were the exact inverse (wait for the unread-marker, then scroll
// repeatedly to reach the tail) and went red on #693 precisely because they
// encoded the superseded contract.
//
// `loadNewer` itself still exists and still pages forward on scroll for gaps
// the tail-anchor does not claim; its no-storm / growing-tail-latch mechanics
// stay deterministically covered in `src/__tests__/scrollback.test.ts`, which
// is where they belong (asserting them here would depend on distinguishing
// loadNewer's `?after=` from refreshScrollback's identical request shape).
//
// Seeding: the shared seeder plants 200 rows in #bofh, but this spec needs
// unread > 200, so it re-seeds #bofh with a LARGER corpus via the admin
// `resetSubject(baselineSeed)` surface (the same verb the wrapped `test`
// fixture uses for its per-test baseline). The wrapped fixture's afterEach
// truncates #bofh back to the 200-row baseline, so no manual row cleanup is
// needed; `restoreReadCursorToTail` in afterAll undoes the early cursor
// (BUGHUNT-3 cascade rule).

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

// Re-seed #bofh with a corpus LARGER than the 200-row server cap so the
// planted early cursor leaves > 200 unread — the exact condition under which
// #693 abandons the cursor anchor and lands at the tail instead.
const LARGE_SEED_COUNT = 260;
const SEED_SENDER = "seed-bot";

// Server `@max_http_limit`, and the client's `PAGE_LIMIT`. Both are 200: it is
// the page size the old anchored fetch capped at AND the gap size above which
// #693 switches to the tail anchor. The newest row must sit beyond
// `cursor + this` for either behaviour to be under test.
const MAX_HTTP_LIMIT = 200;

test.describe("#161/#693 — a gap larger than one page opens at the tail, not the cursor", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("unread > 200: the newest row is rendered on arrival, with an uncapped jump-back count and no divider", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    const admin = getSeededAdmin();

    // Re-seed #bofh with > 200 rows. resetSubject truncates then re-seeds
    // `seedCount` synthetic privmsgs and re-JOINs the channel (own-nick JOIN
    // lands as the max id row after the seed).
    await resetSubject(
      admin.token,
      VJT_USER,
      { [NETWORK_SLUG]: AUTOJOIN_CHANNELS },
      { [NETWORK_SLUG]: [{ name: CHANNEL, seedCount: LARGE_SEED_COUNT, seedSender: SEED_SENDER }] },
    );

    // Learn the fresh id range oldest-first.
    const rows = await fetchAllMessagesAsc(vjt.token, NETWORK_SLUG, CHANNEL);
    // The corpus must dwarf the 200-row cap for the gap to exist.
    expect(rows.length).toBeGreaterThan(MAX_HTTP_LIMIT + 40);

    // Plant the cursor early enough that unread ≫ 200: at least 240 rows sit
    // after it, so the OLD anchored after(cursor, 200) would have stopped well
    // short of the newest row, and #693's probe sees a gap it cannot drain in
    // one page.
    const cursorIndex = rows.length - 240;
    const lastReadRow = rows[cursorIndex];
    if (!lastReadRow) throw new Error("#161 spec: seeded #bofh rows missing cursor index");
    const rowsAfterCursor = rows.filter((r) => r.id > lastReadRow.id).length;
    // Guard the condition under test.
    expect(rowsAfterCursor).toBeGreaterThan(MAX_HTTP_LIMIT);

    // The TRUE newest content row — the highest-id seed-bot privmsg (rows are
    // ASC by id). This is the row #161 made unreachable and #693 puts on
    // screen without a gesture.
    const privmsgs = rows.filter((r) => r.kind === "privmsg" && r.sender === SEED_SENDER);
    const newestPrivmsg = privmsgs[privmsgs.length - 1];
    if (!newestPrivmsg) throw new Error("#161 spec: no seeded privmsg rows found");
    // Sanity: the newest row really is past the anchored window.
    expect(newestPrivmsg.id).toBeGreaterThan(lastReadRow.id + MAX_HTTP_LIMIT);

    // Plant the early cursor BEFORE login so the channel hydrates with it and
    // takes the cursor-present fetch arm — the arm #693 reroutes.
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, lastReadRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL);

    // Readiness signal for the far-behind arm, the structural replacement for
    // the unread-marker this spec used to wait on: the pinned bar renders only
    // once `loadInitialScrollback` has probed the count, decided the gap is
    // undrainable, and replaced the pane with the newest page.
    const farBehindBar = page.locator('[data-testid="far-behind-bar"]');
    await expect(farBehindBar).toBeAttached({ timeout: 10_000 });

    // 1. The tail is ALREADY here — no scrolling, no forward paging. This is
    //    #161's guarantee, now satisfied on arrival.
    await expect(
      page.locator(`[data-testid="scrollback-line"][data-msg-id="${newestPrivmsg.id}"]`),
    ).toBeVisible();

    // 2. The jump-back count is the TRUE gap, not a page-capped one. A capped
    //    count would read exactly 200 — the discriminating assertion is
    //    "greater than the page limit", which is only answerable because the
    //    resume probes the uncapped `.../messages/count?after=` door. Bounded
    //    above by the real number of rows after the cursor so an inflated
    //    count fails too. (Not pinned to an exact equality: the count honours
    //    the subject's hide-presence preference, while `fetchAllMessagesAsc`
    //    returns every row.)
    const jumpLabel = await page.locator('[data-testid="far-behind-jump"]').innerText();
    const missedMatch = jumpLabel.match(/(\d+)/);
    if (!missedMatch?.[1]) {
      throw new Error(`#693 spec: jump-back label carries no count: ${JSON.stringify(jumpLabel)}`);
    }
    const missed = Number(missedMatch[1]);
    expect(missed).toBeGreaterThan(MAX_HTTP_LIMIT);
    expect(missed).toBeLessThanOrEqual(rowsAfterCursor);

    // 3. The in-pane divider is deliberately absent while far behind: its
    //    count would describe the loaded page, not the abandoned region, so
    //    the pinned bar is the single honest unread affordance here. This is
    //    the assertion that inverts the pre-#693 spec.
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0);
  });
});
