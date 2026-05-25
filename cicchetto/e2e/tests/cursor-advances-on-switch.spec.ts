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

    // E2E-ROBUSTNESS bucket D (2026-05-26 iteration) — scroll FIRST,
    // observe visible-tail, THEN seed baseline = visible_id + buffer.
    // The old shape (seed by REST-page index, then scroll) coupled
    // baseline to per-row pixel height and seeded backlog density —
    // full-suite seed growth pushed visible-tail ABOVE the static
    // baseline (assertion 920 ≤ 901 with index=15 at HEAD `1458942`).
    // Computing baseline from observed visible makes the gate semantics
    // robust regardless of seed size + viewport row density.
    const box = await page.locator('[data-testid="scrollback"]').boundingBox();
    if (!box) throw new Error("scrollback box null");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -400);
    // Wait LONGER than the settle window so the scroll-settle POST
    // from this wheel-up lands BEFORE we snapshot cursor + visible.
    // Settle POSTs `visible` which advances cursor; we override below
    // with seedCursor at baseline = visible + buffer, so the
    // post-switch leave-arm's visible POST will be < baseline and
    // dropped by the forward-only gate.
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const visible = await visibleTailId(page);
    const store = await storeTailId(page);
    expect(visible).not.toBeNull();
    expect(store).not.toBeNull();
    // Sanity: scroll worked, visible-tail is NOT store-tail.
    expect(visible).toBeLessThan(store as number);

    // Seed baseline above visible-tail so the forward-only gate drops
    // the leave-arm's `visible` POST. Pick a row strictly between
    // `visible` and `store` (mid-pane) — any row ID in that range
    // satisfies `visible < baseline ≤ store`. Compute from the REST
    // page so we land on a real message id (not visible+1 which may
    // not exist if rows are not contiguous).
    const page0 = await fetchScrollbackPage(vjt.token, CHANNEL_A);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    // page0 is DESC-ordered (tail first). Find an id strictly greater
    // than `visible` and ≤ `store`. The middle of that range is the
    // safest baseline — far enough above visible that wheel jitter
    // won't land at-or-above baseline, far enough below store that
    // bug-impl's store POST would clearly advance past baseline.
    const candidates = page0.filter(
      (r) => r.id > (visible as number) && r.id <= (store as number),
    );
    if (candidates.length === 0) {
      throw new Error(
        `no baseline candidate between visible=${visible} and store=${store}; ` +
          `wheel scroll may have been too shallow or seed too sparse`,
      );
    }
    const baselineRow = candidates[Math.floor(candidates.length / 2)];
    if (!baselineRow) {
      throw new Error("baselineRow not found in candidate window");
    }
    await seedCursor(vjt.token, CHANNEL_A, baselineRow.id);
    // Wait for cic to observe the cursor via the WS broadcast
    // (cic's selection.ts subscribes to read_cursor_set events and
    // updates its in-memory state). Without this, cic's local cursor
    // signal may still hold the pre-seed value, and setCursorIfAdvances
    // would evaluate the forward-only gate against the stale local
    // value rather than the server's.
    await expect
      .poll(async () => await fetchCursor(vjt.token, CHANNEL_A), { timeout: 2_000 })
      .toBe(baselineRow.id);

    // Sanity: visible is strictly below the baseline we seeded —
    // proves the forward-only gate will drop the visible POST (gate
    // drops candidate <= current).
    expect(visible).toBeLessThan(baselineRow.id);

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
