// CP14 B2 — scroll-up triggers loadMore on the focused channel.
//
// Production bug: server has 200 rows for #bofh, cic loads latest 50,
// user scrolls to top, NOTHING happens — the older 150 rows are never
// fetched. Root cause: `ScrollbackPane.tsx` `onScroll` only updates
// the `atBottom` signal, never calls `loadMore` (which exists at
// `lib/scrollback.ts` and works fine in isolation, see scrollback.test.ts).
//
// Fix landed alongside this spec:
//   - `lib/scrollback.ts`: in-flight Set + exhausted Set; `loadMore`
//     gates on both. (Concurrency guard long-deferred from S22 review C5.)
//   - `ScrollbackPane.tsx`: extend `onScroll` to call `loadMore` when
//     `scrollTop ≤ 200px`, capture scroll-position before the await,
//     restore as `newScrollHeight - oldScrollHeight + oldScrollTop`
//     after merge so the user's view doesn't yank.
//
// Reuses the seeded 200-row corpus on `(vjt, bahamut-test, #bofh)`
// from the e2e seeder sidecar (cicchetto/e2e/compose.yaml lines
// 123-124). Same tiny-viewport (800×300) trick as B1 so the latest
// REST page reliably overflows and "is the scrollback longer than
// the viewport" is measurable.

import { test, expect, type Page } from "@playwright/test";
import {
  loginAs,
  scrollbackLines,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

// Mirror of ScrollbackPane.LOAD_MORE_THRESHOLD_PX. Re-declared here
// because the const isn't exported; if it changes, both sides need to
// update — test stays in lockstep with the production threshold.
const LOAD_MORE_THRESHOLD_PX = 200;

async function scrollbackGeometry(
  page: Page,
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
}

// Programmatically scroll the scrollback to the given scrollTop and
// fire a synthetic `scroll` event so the Solid handler runs. Setting
// scrollTop alone DOES fire `scroll` in real browsers, but the test
// harness can race the dispatch — explicit dispatchEvent is belt+
// braces.
async function scrollScrollbackTo(page: Page, scrollTop: number): Promise<void> {
  await page.evaluate((t) => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    el.scrollTop = t;
    el.dispatchEvent(new Event("scroll"));
  }, scrollTop);
}

test.describe("CP14 B2 — scroll-up triggers loadMore (no end-of-history bounce)", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test("scroll-to-top fetches older rows and preserves user's scroll position", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // Wait for initial REST page (≥50 rows + the auto-joined own-nick
    // JOIN line that selectChannel waits for already).
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    const initialCount = await scrollbackLines(page).count();
    const g0 = await scrollbackGeometry(page);
    expect(g0.scrollHeight).toBeGreaterThan(g0.clientHeight);

    // Scroll to the top — well within LOAD_MORE_THRESHOLD_PX.
    await scrollScrollbackTo(page, 0);

    // The fetch is async; poll for the row count to grow past the
    // initial REST page. With 200 seeded rows and PAGE_SIZE=50, one
    // loadMore should land an additional 50 (rows 101..150).
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThan(initialCount);

    // After the merge + position-restore, the user's view should be
    // near the top of the (now larger) scrollback — NOT bounced to the
    // bottom (the bug we're fixing) and NOT bounced to the previous
    // tail-relative position. Specifically: scrollTop should still be
    // a smallish value (the previously-visible rows are now further
    // down the merged list — old scrollTop was 0, so new scrollTop
    // should equal `newScrollHeight - oldScrollHeight + 0` which keeps
    // those same rows pinned in the viewport).
    const g1 = await scrollbackGeometry(page);
    // The old top is now further down by exactly the height of the
    // new (older) rows that got prepended. Old scrollTop was 0 and
    // we want the rows the user was looking at to still be in view —
    // restored scrollTop = newH - oldH (since oldScrollTop was 0).
    // So new scrollTop > 0 by exactly the prepended-rows height.
    expect(g1.scrollTop).toBeGreaterThan(0);
    // And nowhere near the bottom — we did NOT auto-scroll-to-tail.
    const distanceFromBottom = g1.scrollHeight - g1.scrollTop - g1.clientHeight;
    expect(distanceFromBottom).toBeGreaterThan(LOAD_MORE_THRESHOLD_PX);
  });

  test("repeated scroll-up loads progressively older rows until exhausted", async ({ page }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    // 200 seeded rows + auto-join JOIN line. Initial REST page = 50.
    // Drain the corpus by repeatedly scrolling-to-top and waiting for
    // strict growth. `toBeGreaterThan(prev)` (strict) is the key —
    // `toBeGreaterThanOrEqual` resolves immediately and races the
    // async loadMore round-trip, breaking the loop early. Cap rounds
    // at 10 so a regression that breaks loadMore doesn't hang the
    // test until the suite-wide 10-min Playwright kill.
    for (let round = 0; round < 10; round++) {
      const before = await scrollbackLines(page).count();
      if (before >= 200) break;
      await scrollScrollbackTo(page, 0);
      try {
        await expect
          .poll(async () => await scrollbackLines(page).count(), { timeout: 5_000 })
          .toBeGreaterThan(before);
      } catch {
        // Strict growth timed out — channel exhausted or stuck. Break
        // out and let the final assertion decide whether we made it.
        break;
      }
    }

    const finalCount = await scrollbackLines(page).count();
    expect(finalCount).toBeGreaterThanOrEqual(200);
  });
});
