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
//
// E2E-ROBUSTNESS bucket D (2026-05-25) — pin a mid-pane baseline
// BEFORE the wheel scroll so the forward-only gate doesn't hide the
// leave-arm's write. Without this, cic's mount-time POST (cursor =
// store-tail at initial scroll-to-bottom) races our wheel-scroll: in
// most iso runs cursorBeforeSwitch == store-tail, then the leave-arm's
// visible POST is dropped (visible < current) AND the buggy store
// POST is dropped (forward-only no-op). The test couldn't tell
// good-impl from bug-impl. New baseline shape: seed cursor at
// mid-pane (id of row 5 from tail), wheel scroll exposes visible at
// row ~25, so visible < baseline. Good code: leave-arm posts visible
// → dropped → cursor stays at baseline. Bug code: leave-arm posts
// store → advances → cursor jumps to store. Test discriminates.

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
// Baseline cursor row index from the bottom of the REST page (DESC-
// ordered, so index 15 = the 16th-newest row). Picked so visible-tail
// after wheel-up (typically row 6-10 from bottom for a 200px scroll
// on the 300px-tall viewport) lands strictly above store-tail AND
// at-or-above baseline, guaranteeing the forward-only gate drops the
// visible POST in good-impl. The earlier index 5 was too tight: full-
// suite seeded backlog made the per-row pixel height differ, and
// visible occasionally landed AT exactly row 5 → off-by-one fail.
const BASELINE_ROW_FROM_TAIL = 15;

async function fetchScrollbackPage(
  token: string,
  channel: string,
): Promise<Array<{ id: number }>> {
  const url = `http://grappa-test:4000/networks/${encodeURIComponent(NETWORK_SLUG)}/channels/${encodeURIComponent(channel)}/messages`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`fetchScrollbackPage: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Array<{ id: number }>;
}

// Pre-seed the SERVER-side read cursor for `(NETWORK_SLUG, channel)`
// at the given message id via the same endpoint cic's cursor-advance
// path uses. Backed by `ReadCursor.set/4` (last-write-wins), so this
// OVERRIDES any prior cursor regardless of value — necessary because
// cic's mount-time POST may already have landed at store-tail by the
// time this fires.
async function seedCursor(token: string, channel: string, messageId: number): Promise<void> {
  const url = `http://grappa-test:4000/networks/${encodeURIComponent(NETWORK_SLUG)}/channels/${encodeURIComponent(channel)}/read-cursor`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ message_id: messageId }),
  });
  if (!res.ok) {
    throw new Error(`seedCursor: ${res.status} ${await res.text()}`);
  }
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

    // Pin a known mid-pane baseline AFTER selectChannel so cic's
    // mount-time POST (which races our wheel scroll) is overridden by
    // the last-write-wins behavior of ReadCursor.set/4. Choose a row
    // close to the tail (index 5 DESC = 6th-newest) so visible-tail
    // after the wheel-up below is strictly LESS than baseline → the
    // forward-only gate drops the leave-arm's visible POST in
    // good-impl, leaving cursor at baseline. Bug-impl would POST
    // store, which is > baseline, advancing the cursor.
    const page0 = await fetchScrollbackPage(vjt.token, CHANNEL_A);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const baselineRow = page0[BASELINE_ROW_FROM_TAIL];
    if (!baselineRow) {
      throw new Error(`baselineRow not found at index ${BASELINE_ROW_FROM_TAIL}`);
    }
    await seedCursor(vjt.token, CHANNEL_A, baselineRow.id);
    // Wait briefly for cic to observe the cursor via the WS broadcast
    // (cic's selection.ts subscribes to read_cursor_set events and
    // updates its in-memory state). Without this, cic's local cursor
    // signal may still hold the pre-seed value, and setCursorIfAdvances
    // would evaluate the forward-only gate against the stale local
    // value rather than the server's.
    await expect
      .poll(async () => await fetchCursor(vjt.token, CHANNEL_A), { timeout: 2_000 })
      .toBe(baselineRow.id);

    // Real-wheel scroll up to expose mid-list rows in the viewport.
    const box = await page.locator('[data-testid="scrollback"]').boundingBox();
    if (!box) throw new Error("scrollback box null");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -200);
    // Wait LONGER than the settle window so the scroll-settle POST
    // from this wheel-up lands BEFORE we snapshot cursor + visible.
    // The settle POSTs `visible` which is < baseline → forward-only
    // gate drops it → cursor stays at baseline.
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const visible = await visibleTailId(page);
    const store = await storeTailId(page);
    expect(visible).not.toBeNull();
    expect(store).not.toBeNull();
    // Sanity: scroll worked, visible-tail is NOT store-tail.
    expect(visible).toBeLessThan(store as number);
    // Sanity: visible is at-or-below the baseline we seeded — proves
    // the forward-only gate will drop the visible POST (gate drops
    // candidate <= current). ≤ not strict-< handles the off-by-one
    // when wheel scroll lands viewport AT the baseline row.
    expect(visible).toBeLessThanOrEqual(baselineRow.id);

    // Switch to the network's $server window. The BUGHUNT-2 leave-arm
    // fires setCursorIfAdvances for CHANNEL_A with `visible` (the
    // visible-tail at scroll-up position), NOT `store` (the actual
    // tail). Pass `awaitWsReady: false` because $server has no
    // self-JOIN line.
    const cursorBeforeSwitch = await fetchCursor(vjt.token, CHANNEL_A);
    // Baseline must still be in place; if mount-time POSTs or settle
    // POSTs raced the seed, we'd see a higher value here and the
    // assertion below would be moot. Guard explicitly.
    expect(cursorBeforeSwitch).toBe(baselineRow.id);
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const cursorForA = await fetchCursor(vjt.token, CHANNEL_A);
    // Good impl: leave-arm POSTed visible (< baseline) → dropped by
    // forward-only gate → cursor stays at baseline.
    expect(cursorForA).toBe(baselineRow.id);
    // Bug impl (pre-BUGHUNT-2): leave-arm POSTed store (> baseline) →
    // advances → cursor jumps to store. This is the load-bearing
    // assertion — proves the leave-arm did NOT write store-tail.
    expect(cursorForA).not.toBe(store);
  });
});
