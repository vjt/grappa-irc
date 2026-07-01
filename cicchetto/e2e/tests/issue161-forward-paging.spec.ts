// #161 — the NEWEST messages become unreachable after the #156 anchored
// fetch when unread exceeds the 200-row server cap.
//
// Root cause this pins: `loadInitialScrollback` (scrollback.ts) cursor-
// present arm fetches the region AROUND the read cursor —
// `listMessagesAfter(cursor, 200)` (the unread region, capped at the
// server `@max_http_limit` = 200) + `listMessages(cursor + 1)` (before-
// context). When true unread > 200 the after-page stops at `cursor + 200`,
// so the very newest rows are NOT loaded. #156 assumed they "stream in via
// the WS join-ok refreshScrollback" — but that path ALSO caps at 200 from
// the same resume cursor, so it never reaches the tail either. And there
// was NO forward-paging handler: `loadMore` pages OLDER rows on scroll-to-
// TOP; nothing paged NEWER rows on scroll-to-BOTTOM. The gap
// [cursor+200 .. true newest] was unreachable — the latest messages
// inaccessible.
//
// The fix: a forward-paging verb (`loadNewer`) symmetric to `loadMore`,
// fired from `ScrollbackPane.onScroll` when the pane nears the bottom of
// the loaded content. It pulls `listMessagesAfter(highestLoadedId, 200)`
// and merges via `mergeIntoScrollback`, page-by-page, until the true
// server tail is reachable. (The no-storm / growing-tail-latch guarantee
// is covered deterministically in scrollback.test.ts — asserting it here
// would depend on distinguishing loadNewer's `?after=` from
// refreshScrollback's identical request shape, which is flaky.)
//
// This spec is RED against the unmodified anchored-fetch code: the newest
// row (well past cursor+200) never appears in the DOM no matter how far
// the operator scrolls down. GREEN once forward-paging lands.
//
// Seeding: the shared seeder plants 200 rows in #bofh, but #161 needs
// unread > 200, so this spec re-seeds #bofh with a LARGER corpus via the
// admin `resetSubject(baselineSeed)` surface (the same verb the wrapped
// `test` fixture uses for its per-test baseline). The wrapped fixture's
// afterEach truncates #bofh back to the 200-row baseline, so no manual
// row cleanup is needed; `restoreReadCursorToTail` in afterAll undoes the
// early cursor (BUGHUNT-3 cascade rule).

import { expect, test } from "../fixtures/test";
import { type Page } from "@playwright/test";
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
// planted early cursor leaves > 200 unread — the exact condition under
// which the anchored fetch + capped refresh both stop short of the tail.
const LARGE_SEED_COUNT = 260;
const SEED_SENDER = "seed-bot";

// Server `@max_http_limit` — the anchored after-page cap. The newest row
// must sit beyond `cursor + this` for the bug to bite.
const MAX_HTTP_LIMIT = 200;

// Scroll to the very bottom of the CURRENT loaded content (scrollHeight is
// re-read each call so it tracks the growing list as forward pages merge),
// and fire a synthetic `scroll` event so the Solid handler runs (mirrors
// cp14-b2's helper — setting scrollTop fires `scroll` in real browsers, but
// the harness can race the dispatch, so dispatchEvent is belt + braces).
async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
}

test.describe("#161 forward-paging — newest messages reachable via scroll-to-bottom", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("scroll-to-bottom pages forward to the true newest row (unread > 200)", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    const admin = getSeededAdmin();

    // Re-seed #bofh with > 200 rows so the anchored 200-cap can't reach
    // the tail. resetSubject truncates then re-seeds `seedCount` synthetic
    // privmsgs and re-JOINs the channel (own-nick JOIN lands as the max id
    // row after the seed).
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

    // Plant the cursor early enough that unread ≫ 200: at least 240 rows
    // sit after it, so the anchored after(cursor, 200) stops well short of
    // the newest row.
    const cursorIndex = rows.length - 240;
    const lastReadRow = rows[cursorIndex];
    if (!lastReadRow) throw new Error("#161 spec: seeded #bofh rows missing cursor index");
    const rowsAfterCursor = rows.filter((r) => r.id > lastReadRow.id).length;
    // Guard the condition under test: the newest row is beyond cursor+200,
    // so it is NOT in the anchored initial load.
    expect(rowsAfterCursor).toBeGreaterThan(MAX_HTTP_LIMIT);

    // The TRUE newest content row — the highest-id seed-bot privmsg (rows
    // are ASC by id). This is the row that #161 makes unreachable; forward
    // paging must bring it into the DOM.
    const privmsgs = rows.filter((r) => r.kind === "privmsg" && r.sender === SEED_SENDER);
    const newestPrivmsg = privmsgs[privmsgs.length - 1];
    if (!newestPrivmsg) throw new Error("#161 spec: no seeded privmsg rows found");
    // Sanity: the newest row really is past the anchored window.
    expect(newestPrivmsg.id).toBeGreaterThan(lastReadRow.id + MAX_HTTP_LIMIT);

    // Plant the early cursor BEFORE login so the channel hydrates with it
    // and takes the anchored (cursor-present) fetch arm.
    await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, lastReadRow.id);

    await loginAs(page, vjt);
    // Select WITHOUT the own-nick JOIN-line wait: with unread > 200 the
    // self-JOIN is the TAIL row, which is exactly what #161 makes
    // unreachable — the anchored fetch never loads it, so selectChannel's
    // `ownNick` readiness probe would time out (pre-fix) AND stay
    // unreachable until the operator scrolls down (post-fix, since forward
    // paging only fires on scroll). Instead wait on the anchored fetch's
    // own signal: the unread-marker, which requires the cursor-region rows
    // to be loaded and is injected only by the cursor-present arm.
    await selectChannel(page, NETWORK_SLUG, CHANNEL);
    await expect(page.locator('[data-testid="unread-marker"]')).toBeAttached({ timeout: 10_000 });

    const newestLine = page.locator(
      `[data-testid="scrollback-line"][data-msg-id="${newestPrivmsg.id}"]`,
    );

    // The anchored fetch scrolled the pane to the unread marker (top of the
    // unread block), NOT the tail — the newest row is neither loaded nor in
    // view. Scroll to the bottom of the loaded content repeatedly; each
    // scroll-to-bottom must page forward until the true newest row is
    // reachable and rendered.
    //
    // RED (pre-fix): no forward-paging handler exists, so no scroll-to-
    // bottom ever fetches the gap — `newestLine` never attaches. GREEN
    // (post-fix): forward paging pulls [cursor+200 .. tail] and the newest
    // row renders.
    await expect(async () => {
      await scrollToBottom(page);
      await expect(newestLine).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
  });
});
