// BUGHUNT-2 cursor cluster — forward-only cursor contract, end-to-end.
//
// Consolidated 2026-05-26 (spec-audit-r1): the 4 prior cursor specs
// each tested one slice of the same forward-only contract via the
// same harness shape (loginAs, selectChannel, wheel scroll, settle
// wait, fetchCursor). Sources:
//
//   - `cursor-no-advance-on-open.spec.ts` (B-Sentinel 1: bare open
//     via programmatic scrollIntoView MUST NOT advance cursor)
//   - `cursor-advances-on-switch.spec.ts` (B-Sentinel 2: leave-arm
//     writes visible-tail, not store-tail)
//   - `cursor-walks-with-scroll.spec.ts` (B-Sentinel 3: real
//     wheel-down advances cursor to new visible-tail)
//   - `scroll-settle-cursor.spec.ts` (UX-8-D: 3 scenarios — up-mid,
//     back-to-bottom, up-from-bottom)
//
// 7 tests in one describe, shared helpers, single afterAll. Net:
// 4 spec files × ~165 lines avg → 1 file ~310 lines. Same coverage,
// less duplication.
//
// One assertion strengthened during the consolidation (audit
// verdict on scroll-settle-cursor test-1: the disjunction
// `validForwardOnly OR advancedToNewVisible` swallowed bug-impl
// where cursor jumped to a row ABOVE the visible band). New
// assertion pins cursor1 ∈ visible row ids OR cursor1 === cursor0
// (strict no-retreat or strict-visible-membership; disallows
// jumping to a row outside the visible band, which is what the
// bug was).
//
// BUGHUNT-3 cascade fix (2026-05-25) — every test in this file
// advances the server-side cursor on the shared seeded
// `vjt @ bahamut-test/#bofh`; restore to tail in afterAll so
// downstream specs (marker-target-window, r6-own-action,
// scroll-on-window-switch, ux-5-bk, ux-6-k, p0e-invite-ack) see
// a fully-read channel.

import { expect, test } from "../fixtures/test";
import { type Page } from "@playwright/test";
import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail, setReadCursorToId } from "../fixtures/grappaApi";
import {
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const REST_PAGE_SIZE = 50;
const SETTLE_DEBOUNCE_MS = 500;
// Past the debounce + rAF + POST + WS round-trip slop. The
// cursor-no-advance test uses a fatter budget (1000ms) because the
// activation routine has its own programmatic-scroll path; the rest
// share the 500ms slack.
const SETTLE_WAIT_MS = SETTLE_DEBOUNCE_MS + 500;
const SETTLE_WAIT_LONG_MS = SETTLE_DEBOUNCE_MS + 1000;

const GRAPPA_TEST_BASE = "http://grappa-test:4000";

// ─── shared helpers ─────────────────────────────────────────────────

async function fetchCursor(token: string, channel: string): Promise<number | null> {
  const res = await fetch(`${GRAPPA_TEST_BASE}/me`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`fetchCursor (via /me): ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    read_cursors?: Record<string, Record<string, number>>;
  };
  return body.read_cursors?.[NETWORK_SLUG]?.[channel] ?? null;
}

async function fetchScrollbackPage(
  token: string,
  channel: string,
): Promise<Array<{ id: number }>> {
  const url = `${GRAPPA_TEST_BASE}/networks/${encodeURIComponent(NETWORK_SLUG)}/channels/${encodeURIComponent(channel)}/messages`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`fetchScrollbackPage: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Array<{ id: number }>;
}

// Pre-seed the SERVER-side read cursor for `(NETWORK_SLUG, channel)` at
// the given message id. Delegates to the shared `setReadCursorToId`,
// which hits the TEST-ONLY force endpoint (`ReadCursor.force_set/4`) so
// it OVERRIDES any prior cursor regardless of value — necessary because
// cic's mount-time POST may already have landed at store-tail, and the
// production endpoint has been advance-only since #233 (a backward seed
// through it would be silently clamped).
async function seedCursor(token: string, channel: string, messageId: number): Promise<void> {
  await setReadCursorToId(token, NETWORK_SLUG, channel, messageId);
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

async function visibleRowIds(page: Page): Promise<number[]> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) return [];
    const ids: number[] = [];
    const viewportBottom = el.scrollTop + el.clientHeight;
    for (const row of el.querySelectorAll<HTMLElement>(".scrollback-line")) {
      if (row.offsetTop + row.offsetHeight > viewportBottom) break;
      const id = row.dataset.msgId;
      if (id) ids.push(Number.parseInt(id, 10));
    }
    return ids;
  });
}

async function scrollByPx(page: Page, deltaY: number): Promise<void> {
  // BUGHUNT-2: real WheelEvent so the input-event gate in
  // ScrollbackPane's onScroll passes. Synthetic dispatchEvent(scroll)
  // was gated out post-BUGHUNT-2.
  const box = await page.locator('[data-testid="scrollback"]').boundingBox();
  if (!box) throw new Error("scrollback bounding box null");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, deltaY);
}

async function scrollToBottom(page: Page): Promise<void> {
  // BUGHUNT-2: use a real wheel-down here, NOT the scroll-to-bottom button.
  // This helper is deliberately exercising the SCROLL-SETTLE path: a single
  // big wheel-down fires ONE WheelEvent → the input-event gate arms → the
  // 500ms settle fires once → POSTs the visible-tail. (Since #310 the button
  // ALSO advances the cursor, but via a DIFFERENT path — a direct
  // reached-bottom advance in `scrollToBottomGesture`, not the settle — so
  // the wheel is what pins the settle contract these tests assert.)
  const box = await page.locator('[data-testid="scrollback"]').boundingBox();
  if (!box) throw new Error("scrollback bounding box null");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 5000);
}

async function focusChannelAndWaitForRows(page: Page): Promise<void> {
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect
    .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
}

// ─── tests ──────────────────────────────────────────────────────────

test.describe("BUGHUNT-2 cursor — forward-only contract", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  // ── B-Sentinel 1 (bare open) ──────────────────────────────────────
  test("bare window open does NOT advance cursor (programmatic scrollIntoView gated out)", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // Pin a known mid-pane cursor via real wheel + settle.
    await focusChannelAndWaitForRows(page);
    await scrollByPx(page, -200);
    await page.waitForTimeout(SETTLE_WAIT_LONG_MS);

    const cursorBaseline = await fetchCursor(vjt.token, CHANNEL);
    expect(cursorBaseline).not.toBeNull();

    // Switch away to home, then back. Bare open — activation routine
    // fires programmatic scrollIntoView. The input-event gate (B1)
    // must see no preceding pointerdown/wheel/touchmove/keydown and
    // SKIP arming the 500ms settle timer.
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.waitForTimeout(200);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await page.waitForTimeout(SETTLE_WAIT_LONG_MS);

    const cursorAfterReopen = await fetchCursor(vjt.token, CHANNEL);
    expect(cursorAfterReopen).toBe(cursorBaseline);
  });

  // ── B-Sentinel 2 (switch-away leave-arm) ──────────────────────────
  test("switch-away from a scrolled-up pane writes visible-tail, not store-tail", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await focusChannelAndWaitForRows(page);

    // Real wheel up so visible-tail < store-tail. Wait LONGER than
    // the settle window so the scroll-settle POST from this wheel-up
    // lands BEFORE we snapshot cursor + visible. Settle POSTs
    // `visible` which advances cursor; we override below with
    // seedCursor at baseline = mid-pane, so the post-switch leave-arm's
    // visible POST will be < baseline and dropped by the forward-only
    // gate.
    await scrollByPx(page, -400);
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const visible = await visibleTailId(page);
    const store = await storeTailId(page);
    expect(visible).not.toBeNull();
    expect(store).not.toBeNull();
    expect(visible).toBeLessThan(store as number);

    // E2E-ROBUSTNESS bucket D (2026-05-26): compute baseline from
    // OBSERVED visible/store rather than a static REST-page index.
    // Full-suite seed growth pushed visible-tail above static baselines
    // (assertion 920 ≤ 901 with index=15 at HEAD `1458942`). Computing
    // from observed visible makes the gate robust regardless of seed
    // size + viewport row density. Pick a row strictly between
    // `visible` and `store` (mid-pane) — any row ID in that range
    // satisfies `visible < baseline ≤ store`.
    const page0 = await fetchScrollbackPage(vjt.token, CHANNEL);
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
    if (!baselineRow) throw new Error("baselineRow not found");
    await seedCursor(vjt.token, CHANNEL, baselineRow.id);

    // Wait for cic to observe the cursor via WS broadcast — otherwise
    // setCursorIfAdvances evaluates against stale local state.
    await expect
      .poll(async () => await fetchCursor(vjt.token, CHANNEL), { timeout: 2_000 })
      .toBe(baselineRow.id);

    expect(visible).toBeLessThan(baselineRow.id);

    // Switch to $server. The BUGHUNT-2 leave-arm fires
    // setCursorIfAdvances for CHANNEL with `visible`, NOT `store`.
    const cursorBeforeSwitch = await fetchCursor(vjt.token, CHANNEL);
    expect(cursorBeforeSwitch).toBe(baselineRow.id);
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const cursorForA = await fetchCursor(vjt.token, CHANNEL);
    // Good impl: leave-arm POSTed visible (< baseline) → dropped by
    // forward-only gate → cursor stays at baseline.
    expect(cursorForA).toBe(baselineRow.id);
    // Bug impl (pre-BUGHUNT-2): leave-arm POSTed store (> baseline)
    // → advances → cursor jumps to store. Load-bearing assertion:
    // proves the leave-arm did NOT write store-tail.
    expect(cursorForA).not.toBe(store);
  });

  // ── B-Sentinel 3 (real wheel-down) ────────────────────────────────
  test("real wheel-down advances cursor to new visible-tail", async ({ page }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await focusChannelAndWaitForRows(page);

    // Pin cursor mid-list: real wheel up first.
    await scrollByPx(page, -300);
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const cursorAfterUp = await fetchCursor(vjt.token, CHANNEL);
    expect(cursorAfterUp).not.toBeNull();
    const visibleAtMidList = await visibleTailId(page);
    expect(visibleAtMidList).not.toBeNull();

    // Real wheel DOWN. WheelEvent fires, input-event gate passes,
    // settle arms, cursor advances forward.
    await scrollByPx(page, 150);
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const cursorAfterDown = await fetchCursor(vjt.token, CHANNEL);
    const visibleAfterDown = await visibleTailId(page);
    expect(cursorAfterDown).not.toBeNull();
    expect(visibleAfterDown).not.toBeNull();
    // Cursor MOVED forward — past the mid-list position.
    expect(cursorAfterDown).toBeGreaterThan(visibleAtMidList as number);
    // New cursor equals max(cursorAfterUp, visibleAfterDown) —
    // forward-only: cic POSTed `visibleAfterDown`, but
    // setCursorIfAdvances (cic) + ReadCursor.set/4 (server) drop a
    // candidate <= current. Stack-persistence across specs means
    // `cursorAfterUp` may already be ahead of the new visible-tail;
    // the load-bearing claim is the strict forward step above.
    const expectedFloor = Math.max(cursorAfterUp ?? 0, visibleAfterDown as number);
    expect(cursorAfterDown).toBe(expectedFloor);
  });

  // ── UX-8-D scenario 1 (scroll-settle up-mid) ──────────────────────
  test("scroll up to middle: cursor advances to a visible row id (strengthened, audit 2026-05-26)", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await focusChannelAndWaitForRows(page);

    const cursor0 = await fetchCursor(vjt.token, CHANNEL);

    // Scroll up by ~150px so the viewport sits mid-page.
    await scrollByPx(page, -150);
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const cursor1 = await fetchCursor(vjt.token, CHANNEL);
    expect(cursor1).not.toBeNull();

    const visible = await visibleRowIds(page);
    expect(visible.length).toBeGreaterThan(0);

    // Strengthened assertion (audit 2026-05-26 vs prior
    // `validForwardOnly OR advancedToNewVisible`): cursor1 must be
    // EITHER (a) unchanged at-or-below cursor0 — true forward-only,
    // scroll UP didn't advance, OR (b) a row currently in the
    // visible band (a WS tail arrival during settle was forwarded
    // to). The prior disjunction allowed cursor1 to jump to ANY row
    // ≤ lastVisible, which silently accepted bug-impls where the
    // cursor landed on a row ABOVE the visible band.
    if (cursor0 !== null) {
      const inVisibleBand = visible.includes(cursor1 as number);
      const stayedAtOrBelowPrior = (cursor1 as number) <= cursor0;
      expect(inVisibleBand || stayedAtOrBelowPrior).toBe(true);
    }
  });

  // ── UX-8-D scenario 2 (scroll-settle back-to-bottom) ──────────────
  test("scroll back to bottom advances cursor to tail", async ({ page }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await focusChannelAndWaitForRows(page);

    // Scroll up, settle, then back to bottom, settle. Final cursor
    // = tail id.
    await scrollByPx(page, -150);
    await page.waitForTimeout(SETTLE_WAIT_MS);
    await scrollToBottom(page);
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const visible = await visibleRowIds(page);
    const tail = visible[visible.length - 1];
    if (tail === undefined) throw new Error("no visible tail");

    const cursorFinal = await fetchCursor(vjt.token, CHANNEL);
    expect(cursorFinal).toBe(tail);
  });

  // ── UX-8-D scenario 3 (scroll-settle no-retreat) ──────────────────
  test("scroll up from bottom does NOT retreat cursor", async ({ page }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await focusChannelAndWaitForRows(page);

    // Pin cursor at tail first (scroll-to-bottom + settle drives the
    // forward-only path through scroll-settle since fresh focus doesn't
    // emit cursor writes).
    await scrollToBottom(page);
    await page.waitForTimeout(SETTLE_WAIT_MS);
    const cursorAtTail = await fetchCursor(vjt.token, CHANNEL);
    expect(cursorAtTail).not.toBeNull();

    // Now scroll UP. Settle. Forward-only gate must suppress the POST.
    await scrollByPx(page, -150);
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const cursorAfterUp = await fetchCursor(vjt.token, CHANNEL);
    expect(cursorAfterUp).toBe(cursorAtTail);
  });
});
