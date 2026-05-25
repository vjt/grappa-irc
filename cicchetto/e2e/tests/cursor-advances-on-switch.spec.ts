// BUGHUNT-2 bucket B sentinel 2: switching away from a scrolled-up
// pane writes the visible-tail cursor, NOT the store-tail.
//
// Pre-BUGHUNT-2 contract: selection.ts's leave-arm POSTed
// store-tail (last row in scrollbackByChannel). That ignored the
// fact that the operator scrolled up to read history — next visit
// showed no marker even for rows the operator did not see.
//
// Post-BUGHUNT-2 contract: ScrollbackPane's on(key) effect reads
// lastFullyVisibleRowId(listRef) — the honest "last row the operator
// actually saw" — and POSTs that. Cursor reflects what was read,
// not what's stored.

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

const CHANNEL_A = AUTOJOIN_CHANNELS[0];
// Switch target: the network's `$server` window is always present (the
// network-header tab maps to it). Use that instead of a second channel
// — the seed only autojoins `#bofh`, and the leave-arm contract fires
// on any key change regardless of destination kind.
const REST_PAGE_SIZE = 50;
const SETTLE_DEBOUNCE_MS = 500;
const SETTLE_WAIT_MS = SETTLE_DEBOUNCE_MS + 500;

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

async function storeTailId(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) return null;
    const rows = el.querySelectorAll<HTMLElement>(".scrollback-line");
    const tail = rows[rows.length - 1];
    if (!tail) return null;
    const id = tail.dataset.msgId;
    return id ? Number.parseInt(id, 10) : null;
  });
}

test.describe("BUGHUNT-2: switch-away cursor uses visible-tail, not store-tail", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  // BUGHUNT-3 cascade fix (2026-05-25) — the leave-arm POSTs visible-tail
  // mid-pane and persists across spec boundaries on the shared seeded
  // vjt. Downstream specs focusing `#bofh` (marker-target T2,
  // r6-own-action, scroll-settle-cursor, ux-5-bk, ux-6-k,
  // p0e-invite-ack) assume a "fully-read" cursor; restore here.
  test.afterAll(async () => {
    if (!CHANNEL_A) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL_A);
  });

  test("scrolled-up pane writes visible-tail on switch, not store-tail", async ({ page }) => {
    if (!CHANNEL_A) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL_A, { ownNick: NETWORK_NICK });

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    // Real-wheel scroll up to expose mid-list rows in the viewport.
    const box = await page.locator('[data-testid="scrollback"]').boundingBox();
    if (!box) throw new Error("scrollback box null");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -200);
    // Wait LONGER than the settle window so the scroll-settle POST
    // from this wheel-up lands BEFORE we snapshot cursor + visible.
    // Without this, two POSTs race the leave-arm (the settle-arm POST
    // from the wheel-up + the leave-arm POST from the switch) and the
    // expected `max(cursorBeforeSwitch, visible)` is wrong because
    // `cursorBeforeSwitch` is read BEFORE the settle POST lands.
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const visible = await visibleTailId(page);
    const store = await storeTailId(page);
    expect(visible).not.toBeNull();
    expect(store).not.toBeNull();
    // Sanity: scroll worked, visible-tail is NOT store-tail.
    expect(visible).toBeLessThan(store as number);

    // Switch to the network's $server window. The BUGHUNT-2 leave-arm
    // fires setCursorIfAdvances for CHANNEL_A with `visible` (the
    // visible-tail at scroll-up position), NOT `store` (the actual
    // tail). Server's last-write-wins absorbs the POST. Pass
    // `awaitWsReady: false` because $server has no self-JOIN line.
    //
    // Capture the cursor baseline BEFORE the switch so we can express
    // the forward-only contract: the post-switch cursor equals
    // `max(baseline, visible)` — the leave-arm POSTed `visible` but
    // setCursorIfAdvances (cic) + ReadCursor.set/4 (server) drop any
    // candidate <= current. Stack-persistence across specs means
    // `baseline` may already be past `visible`; the contract still
    // holds: cic POSTed visible (NOT store), the gate did the rest.
    const cursorBeforeSwitch = await fetchCursor(vjt.token, CHANNEL_A);
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const cursorForA = await fetchCursor(vjt.token, CHANNEL_A);
    const expected = Math.max(cursorBeforeSwitch ?? 0, visible as number);
    expect(cursorForA).toBe(expected);
    // Critical: leave-arm did NOT write store-tail. If it had, the
    // forward-only gate would have advanced cursor to `store` regardless
    // of baseline (store > baseline by construction since seed-bot keeps
    // appending).
    expect(cursorForA).not.toBe(store);
  });
});
