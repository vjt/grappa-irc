// Issue #230 — desktop: scrollback non scrollabile quando il contenuto non
// riempie il container.
//
// ## The bug (P0, desktop)
//
// When the loaded scrollback window is SHORTER than the container
// (`scrollHeight <= clientHeight`), `.scrollback` is not natively
// scrollable — a mouse wheel produces NO native `scroll` event, so
// `ScrollbackPane.onScroll` never fires and the CP14-B2 scroll-to-top
// `loadMore` never triggers. The operator is stuck: there is no way to
// wheel UP into older history on a short channel. The pre-#230 `onWheel`
// handler only stamped the BUGHUNT-2 real-input marker — it did NOT
// trigger loadMore.
//
// ## The fix
//
// `onWheel` now reacts to a wheel-UP (deltaY < 0) by firing the SAME
// top-of-buffer `loadMore` the onScroll block uses (shared via the
// `maybeLoadOlder` closure). The `scrollTop <= threshold` gate is
// trivially satisfied when content underfills (scrollTop is 0). No
// preventDefault: `.scrollback` is the sole scroll container, so an
// unconsumed wheel has nothing to chain-scroll.
//
// ## Why this is the anti-hollow-green proof
//
// This spec drives a REAL Chromium wheel gesture (`mouse.wheel`), which
// dispatches a genuine `wheel` event to the element regardless of
// scrollability — exactly the input the bug loses. RED pre-fix: the wheel
// only stamped the marker, the row count never grows. GREEN post-fix: the
// wheel-up loads the older page and the row count grows.
//
// ## The underfill precondition (guards against a vacuous green)
//
// The whole bug hinges on `scrollHeight <= clientHeight`. This spec ASSERTS
// that precondition before wheeling — if a future row-height / layout change
// made the 50-row load overflow a tall viewport, the assertion fails LOUDLY
// rather than green-washing (the wheel would then produce a native scroll
// and the old code path would rescue it, masking the regression).
//
// ## Setup (mirrors cp14-b2 + scroll-on-window-switch scenario 1)
//
// Reuses the DB-seeded 200-row corpus on `(vjt, bahamut-test, #bofh)`. The
// read cursor is seeded to the HEAD (newest) row so cic's cold load takes
// the no-divider tail-only branch (~50 rows) — deterministic regardless of
// what a prior spec left behind (the order-dependence scroll-on-window-
// switch documents). A TALL viewport (2000px) makes those ~50 rows underfill
// the container; the server still holds 150 older rows for loadMore to fetch.

import { expect, test } from "../fixtures/test";
import { type Page } from "@playwright/test";
import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

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

// Latest REST page (DESC by server_time) — used to pick the HEAD id for the
// read-cursor seed. Same shape cp14-b1 / issue168 / scroll-on-window-switch use.
async function fetchScrollbackPage(
  token: string,
  channel: string,
): Promise<Array<{ id: number }>> {
  const url = `http://grappa-test:4000/networks/${encodeURIComponent(
    NETWORK_SLUG,
  )}/channels/${encodeURIComponent(channel)}/messages`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`fetchScrollbackPage: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Array<{ id: number }>;
}

// Seed the SERVER-side read cursor at the given message id (server-owned
// post-CP29; cic hydrates from the `/me` envelope on cold load).
async function seedCursor(channel: string, messageId: number): Promise<void> {
  const vjt = getSeededVjt();
  const url = `http://grappa-test:4000/networks/${encodeURIComponent(NETWORK_SLUG)}/channels/${encodeURIComponent(channel)}/read-cursor`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${vjt.token}`, "content-type": "application/json" },
    body: JSON.stringify({ message_id: messageId }),
  });
  if (!res.ok) throw new Error(`seedCursor: ${res.status} ${await res.text()}`);
}

test.describe("issue #230 — wheel-up loads older history when content underfills", () => {
  // TALL viewport: the ~50-row tail load must be SHORTER than the container
  // so `.scrollback` is not natively scrollable (the bug's precondition).
  // 800×2000 leaves ~1850px of scroll area for ~1000px of content.
  test.use({ viewport: { width: 800, height: 2000 } });

  // The head cursor persists on the shared seeded vjt across spec
  // boundaries (last-write-wins). Restore to the tail so downstream #bofh
  // specs inherit a fully-read channel (mirror of issue168 / cp14-b1).
  test.afterAll(async () => {
    const vjt = getSeededVjt();
    if (!CHANNEL) return;
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("wheel-UP on an underfilled pane fetches older rows", async ({ page }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Seed the cursor to HEAD → no unread divider → cic's cold load is the
    // tail-only ~50-row branch (deterministic, order-independent).
    const headPage = await fetchScrollbackPage(vjt.token, CHANNEL);
    expect(headPage.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const headId = headPage[0]?.id;
    if (!headId) throw new Error("#bofh seed page empty — cannot seed read cursor to head");
    await seedCursor(CHANNEL, headId);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // Initial REST page landed (~50 rows).
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    const initialCount = await scrollbackLines(page).count();

    // THE PRECONDITION (anti-hollow-green): the pane UNDERFILLS — content is
    // shorter than the container, so it is NOT natively scrollable. This is
    // the exact state where a wheel produces no native `scroll` event. If
    // this fails, the viewport isn't tall enough (or row height changed) and
    // the test would be vacuous — fail loudly instead.
    await expect
      .poll(async () => {
        const g = await scrollbackGeometry(page);
        return g.scrollHeight - g.clientHeight;
      })
      .toBeLessThanOrEqual(0);

    // A real desktop wheel-UP over the underfilled pane. `mouse.wheel`
    // dispatches a genuine `wheel` event regardless of scrollability —
    // the input the bug loses (no native scroll → onScroll never fires).
    await page.locator('[data-testid="scrollback"]').hover();
    await page.mouse.wheel(0, -600);

    // GREEN post-fix: the wheel-up fired loadMore → the older page (rows
    // 101..150) merged → row count grew past the initial tail page. RED
    // pre-fix: onWheel only stamped the input marker, so the count never
    // grew and this poll times out.
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThan(initialCount);
  });
});
