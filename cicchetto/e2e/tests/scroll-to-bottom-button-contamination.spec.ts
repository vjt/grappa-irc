// Scroll-to-bottom BUTTON contamination across windows — MOBILE (iOS).
//
// vjt prod report (2026-06-02, on an iOS device): "I STILL see scroll
// contamination across windows when tapping the 'scroll to bottom'
// button. Load 5-6 pages of history, tap scroll-to-bottom, switch to
// another window, switch back — the previous window is now blank and only
// restorable by scrolling manually. ONLY the scroll-to-bottom button is
// problematic."
//
// Root cause: `scrollToBottom` (ScrollbackPane.tsx) was the ONLY scroll
// path in the file using `behavior: "smooth"`. A smooth scroll is an
// ASYNCHRONOUS animation; the `[data-testid="scrollback"]` <div> is the
// SAME DOM node across selectedChannel changes (Shell.tsx bundles
// channel|query|server into one non-keyed Match), so the in-flight
// animation survives the window swap. On iOS WebKit (`-webkit-overflow-
// scrolling: touch` + momentum) the surviving animation does not reconcile
// with `scrollToActivation`'s snap on return and the pane is left at a
// stale/overshot offset (blank; restored only by a manual scroll).
//
// Fix: snap instantly (`tail.scrollIntoView({block:"end"})`), mirroring
// scrollToActivation's no-marker branch. Every other scroll path in the
// file is instant for exactly this reason — nothing async survives a swap.
//
// ⚠️ COVERAGE CAVEAT (2026-06-02 investigation): this spec does NOT
// reproduce the prod bug. Instrumented runs pre-fix (smooth) on BOTH
// chromium-desktop AND webkit-iphone-15 — full 200-line history loaded,
// the smooth animation confirmed in flight at tap time (scrollTop≈2), an
// immediate window roundtrip — land at the bottom every time (dist≈8).
// Playwright's bundled WebKit does not emulate real iOS Safari scroll
// physics (`-webkit-overflow-scrolling: touch`, momentum, smooth-scroll
// interruption), which is the layer the bug lives in. So this is a
// CONTRACT guard ("a button-tap + window roundtrip lands at bottom"), not
// a proof the fix addresses the prod report — that needs a real iOS
// device. Kept @webkit-only since the bug is iOS-shaped.

import { type Page } from "@playwright/test";
import { composeSend, loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { expect, test } from "../fixtures/test";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0]!;
const SCROLL_BOTTOM_THRESHOLD_PX = 50;
const EMPTY_QUERY_PEER = "no-dm-peer-btn";

async function distFromBottom(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) return null;
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
  });
}

// Scroll to the top and fire a synthetic scroll so the Solid handler runs
// loadMore. Returns once the event is dispatched.
async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement;
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
}

test.beforeEach(async () => {
  const vjt = getSeededVjt();
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
});

test.describe("scroll-to-bottom button (iOS) — tap then window roundtrip lands at bottom", () => {
  test("@webkit tap scroll-to-bottom, bounce to empty query and back, lands at bottom", async ({ page }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // Focus #bofh, confirm the first REST page is in.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect.poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(50);

    // Open an empty query (the "other" window) so it exists to switch to,
    // then return to #bofh. Done up front so the loadMore + tap below all
    // happen inside #bofh with no intervening switch (avoids racing
    // scrollToActivation's re-snap).
    await composeSend(page, `/query ${EMPTY_QUERY_PEER}`);
    await expect(page.locator(".scrollback-empty")).toBeVisible({ timeout: 5_000 });
    await selectChannel(page, NETWORK_SLUG, CHANNEL);
    await expect.poll(async () => (await distFromBottom(page)) ?? 999, { timeout: 5_000 }).toBeLessThanOrEqual(
      SCROLL_BOTTOM_THRESHOLD_PX,
    );

    // Exhaust loadMore: scroll to top until the row count stops growing —
    // "load 5-6 pages of history". Leaves the pane near the top, so the
    // floating scroll-to-bottom button is visible and the smooth scroll
    // would span the full height.
    let prev = -1;
    for (let i = 0; i < 8; i++) {
      const c = await scrollbackLines(page).count();
      if (c === prev) break;
      prev = c;
      await scrollToTop(page);
      await page.waitForTimeout(600);
    }
    await scrollToTop(page);

    const btn = page.locator('[data-testid="scroll-to-bottom"]');
    await expect(btn).toBeVisible({ timeout: 5_000 });

    // TAP the button (real touch on iOS). Pre-fix this starts an async
    // smooth-scroll animation on the shared scrollback node.
    await btn.tap();

    // Bounce away and back immediately — no settle wait. The query tab and
    // the channel tab are tapped directly (mobile tablist).
    await selectChannel(page, NETWORK_SLUG, EMPTY_QUERY_PEER);
    await selectChannel(page, NETWORK_SLUG, CHANNEL);
    await expect.poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(50);

    // Contract: #bofh lands at the bottom after the roundtrip — NOT blank.
    await expect
      .poll(async () => (await distFromBottom(page)) ?? 999, { timeout: 5_000 })
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
  });
});
