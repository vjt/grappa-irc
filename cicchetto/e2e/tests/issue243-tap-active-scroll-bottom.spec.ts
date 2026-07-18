// #243 — tapping the ALREADY-active channel jumps its scrollback to the
// bottom (newest message). irssi-parity "jump to latest": when the
// operator has scrolled up into history, re-selecting the window they're
// already on returns them to the newest line.
//
// Two axes, one behaviour (issue scope):
//   * DESKTOP (chromium): re-click the already-selected LEFT SIDEBAR row.
//   * MOBILE (@webkit): re-tap the already-active BOTTOM BAR entry.
//
// jsdom is blind to scroll geometry (issue168 / the scroll-to-bottom
// button contamination spec live here for the same reason) — this real-
// browser spec is the authoritative proof of the actual scroll. The unit
// tests pin the seam up to the command nonce; this pins nonce → scroll.
//
// Why this is NOT a visitor/registered parity-matrix spec: the gesture is
// a client-side scroll on the already-selected window — identical across
// every user class (since #310 it ALSO advances the read cursor via a
// forward-only POST, but that reached-bottom behaviour is user-class-agnostic;
// no window-state change, no focus steal). The read-cursor persist is pinned
// by issue310-scroll-to-bottom-btn-cursor.spec.ts; this spec asserts the
// re-tap SCROLL geometry only.
// The parity matrix is for IRC FUNCTIONS whose behaviour differs by class;
// this rides the scroll-spec precedent (issue168, contamination, cp14-b1),
// which assert scroll geometry only.

import { type Page } from "@playwright/test";
import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0]!;
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

async function distFromBottom(page: Page): Promise<number | null> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) return null;
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
  });
}

// Scroll to the top and fire a synthetic scroll so the Solid handler runs
// loadMore (pulls older history, leaving the pane parked near the top).
async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement;
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
}

// Focus CHANNEL, exhaust loadMore so the pane is scrolled UP and NOT at
// bottom, then re-select the same window and assert it lands at the bottom.
// Layout-agnostic: `selectChannel` clicks the sidebar row on desktop and
// taps the bottom-bar entry on mobile, so the ONE helper exercises both
// re-tap surfaces.
async function scrollUpThenRetapLandsAtBottom(page: Page): Promise<void> {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect
    .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(50);
  // Starts at the bottom (fresh focus of a fully-read channel).
  await expect
    .poll(async () => (await distFromBottom(page)) ?? 999, { timeout: 5_000 })
    .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);

  // Scroll up, loading history, until the row count stops growing.
  let prev = -1;
  for (let i = 0; i < 8; i++) {
    const c = await scrollbackLines(page).count();
    if (c === prev) break;
    prev = c;
    await scrollToTop(page);
    await page.waitForTimeout(600);
  }
  await scrollToTop(page);

  // Precondition: we are genuinely scrolled UP (not at bottom), and the
  // floating "scroll to bottom" affordance is showing.
  await expect
    .poll(async () => (await distFromBottom(page)) ?? 0, { timeout: 5_000 })
    .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
  await expect(page.locator('[data-testid="scroll-to-bottom"]')).toBeVisible({ timeout: 5_000 });

  // THE GESTURE: re-select the window that is ALREADY active. No ownNick —
  // the channel is already WS-ready, so this is a bare re-tap of the active
  // row/tab (not a switch), which is exactly what #243 turns into a jump.
  await selectChannel(page, NETWORK_SLUG, CHANNEL);

  // Contract: the re-tap jumped the scrollback to the newest message.
  await expect
    .poll(async () => (await distFromBottom(page)) ?? 999, { timeout: 5_000 })
    .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
  // The floating button hides once atBottom is re-asserted.
  await expect(page.locator('[data-testid="scroll-to-bottom"]')).toBeHidden({ timeout: 5_000 });
}

test.beforeEach(async () => {
  const vjt = getSeededVjt();
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
});

// Leave the shared stack clean: the test jumps to bottom (== tail) on
// success, so the cursor is already at tail — but restore explicitly so a
// mid-scroll FAILURE can't strand a later spec at a mid-history cursor.
test.afterEach(async () => {
  const vjt = getSeededVjt();
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
});

test.describe("#243 — re-tap active channel jumps scrollback to bottom", () => {
  test("desktop: re-clicking the active sidebar row jumps to the newest message", async ({
    page,
  }) => {
    await scrollUpThenRetapLandsAtBottom(page);
  });

  test("@webkit mobile: re-tapping the active bottom-bar entry jumps to the newest message", async ({
    page,
  }) => {
    await scrollUpThenRetapLandsAtBottom(page);
  });
});
