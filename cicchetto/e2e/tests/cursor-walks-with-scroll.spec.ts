// BUGHUNT-2 bucket B sentinel 3: real operator scroll advances the
// cursor + walks the marker down with the operator.
//
// Combines the input-event gate (B1) + visible-tail measurement (B2):
// the operator performs a real wheel scroll DOWN (WheelEvent fires
// → gate passes), the 500ms settle fires, cursor POSTs visible-tail
// at the new scroll position, server broadcasts `read_cursor_set`,
// cic re-renders the marker AT that row.
//
// This is the inverse of the bare-open sentinel: gate must PASS on
// real scroll AND cursor must advance forward.

import { expect, test } from "../fixtures/test";
import { type Page } from "@playwright/test";
import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import {
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const REST_PAGE_SIZE = 50;
const SETTLE_DEBOUNCE_MS = 500;
const SETTLE_WAIT_MS = SETTLE_DEBOUNCE_MS + 500;

async function visibleTailId(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) return null;
    const viewportBottom = el.scrollTop + el.clientHeight;
    let candidate: number | null = null;
    for (const row of el.querySelectorAll<HTMLElement>(".scrollback-line")) {
      if (row.offsetTop + row.offsetHeight > viewportBottom) break;
      const id = row.dataset.msgId;
      if (id) candidate = Number.parseInt(id, 10);
    }
    return candidate;
  });
}

async function fetchCursor(token: string, channel: string): Promise<number | null> {
  const res = await fetch("http://grappa-test:4000/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`fetchCursor: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    read_cursors?: Record<string, Record<string, number>>;
  };
  return body.read_cursors?.[NETWORK_SLUG]?.[channel] ?? null;
}

test.describe("BUGHUNT-2: scroll walks cursor down with real input", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  // BUGHUNT-3 cascade fix (2026-05-25) — scroll-settle advances the
  // server-side cursor mid-pane; restore to tail so downstream specs
  // inheriting `vjt @ bahamut-test/#bofh` see a fully-read channel.
  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("real wheel-down advances cursor to new visible-tail", async ({ page }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    // Pin cursor mid-list: real wheel up first.
    const box = await page.locator('[data-testid="scrollback"]').boundingBox();
    if (!box) throw new Error("scrollback box null");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const cursorAfterUp = await fetchCursor(vjt.token, CHANNEL);
    expect(cursorAfterUp).not.toBeNull();
    const visibleAtMidList = await visibleTailId(page);
    expect(visibleAtMidList).not.toBeNull();
    // Forward-only: scroll up does NOT retreat the cursor below the
    // visible-tail at this position (we may have started with a
    // higher cursor from a prior settle/leave; the gate just ensures
    // we don't go BACKWARDS).
    // No assertion here; the meaningful check is the down-scroll
    // below.

    // Now real wheel DOWN by a moderate amount. WheelEvent fires,
    // input-event gate passes, settle arms, cursor advances forward.
    await page.mouse.wheel(0, 150);
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const cursorAfterDown = await fetchCursor(vjt.token, CHANNEL);
    const visibleAfterDown = await visibleTailId(page);
    expect(cursorAfterDown).not.toBeNull();
    expect(visibleAfterDown).not.toBeNull();
    // Cursor MOVED forward — past the mid-list position.
    expect(cursorAfterDown).toBeGreaterThan(visibleAtMidList as number);
    // The new cursor equals `max(cursorAfterUp, visibleAfterDown)` —
    // forward-only: cic POSTed `visibleAfterDown`, but
    // setCursorIfAdvances (cic) + ReadCursor.set/4 (server) drop a
    // candidate <= current. Stack-persistence across specs means
    // `cursorAfterUp` may already be ahead of the new visible-tail;
    // the load-bearing claim is the strict forward step above.
    const expectedFloor = Math.max(cursorAfterUp ?? 0, visibleAfterDown as number);
    expect(cursorAfterDown).toBe(expectedFloor);
  });
});
