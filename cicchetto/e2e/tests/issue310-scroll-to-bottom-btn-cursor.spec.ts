// #310 — the floating scroll-to-bottom BUTTON must persist the read cursor and
// must NOT snap back to the unread divider ~2s later. Regression of #233.
//
// ## The bug (vjt prod report, recurring on Libera #libera)
//
// Tapping the floating scroll-to-bottom button jumped the view to the newest
// message, then ~2s later the view SNAPPED BACK up to the read marker — the read
// cursor was not persisted at the bottom. A MANUAL scroll to the bottom persists
// fine; only the button was affected.
//
// ## Root cause (cicchetto-side, two coupled defects)
//
// The button's onClick (and the #243 re-tap) funnelled through the pure
// `scrollToBottom()` helper, which only scrolls + sets `atBottom(true)`. Unlike a
// manual scroll it did NOT:
//   (a) POST a read-cursor advance — the manual path advances via the input-gated
//       scroll-settle, and a button tap never arms that gate (the button is a
//       sibling OUTSIDE `.scrollback`, so no pointerdown/wheel/touchmove lands on
//       the listRef). So "read to newest" never persisted (candidate a).
//   (b) release the marker-activation latch — a channel activation into an unread
//       window leaves `markerActivationPending` set; only operator INPUT or an own
//       send cleared it. With it still set, the NEXT rows() recreation (a live
//       message, or the switch-time refreshScrollback) re-asserted the marker jump
//       → the ~2s snap-back.
//
// #310 routes the button + re-tap through `scrollToBottomGesture`, which does both:
// clears the latch and advances the cursor to the newest rendered id (read AFTER
// the instant scroll via the shared forward-only setCursorIfAdvances path).
//
// ## What this spec pins (RED pre-#310, GREEN post)
//
//   (1) PERSISTENCE — the core "POST fired with the newest id": after the tap the
//       SERVER read cursor advances from the mid seed to the tail. Deterministic,
//       peer-free. RED pre-#310: the button never POSTed → the cursor stays at the
//       seed → the poll times out.
//   (2) NO SNAP-BACK — the visible symptom: a peer line arriving AFTER the tap
//       recreates rows() (the exact ~2s trigger on a busy channel). With the latch
//       released the pane tail-follows and STAYS at the bottom. RED pre-#310: the
//       latch was still set → the length-effect re-jumped to the divider.
//
// Two axes, one behaviour (mirror #243): DESKTOP (chromium, re-uses the #168
// 800×300 harness so the 50-row REST page overflows) + MOBILE (@webkit, iPhone 15
// device viewport). Playwright WebKit ≠ real iOS scroll physics
// (feedback_playwright_webkit_not_ios_scroll), so the @webkit run is the layout/
// touch CONTRACT, not a device-physics repro; the deterministic cursor-persist
// assertion is the authoritative mechanism proof on both.

import { type Page } from "@playwright/test";
import { loginAs, scrollbackLines, selectChannel } from "../fixtures/cicchettoPage";
import { getReadCursor, restoreReadCursorToTail, setReadCursorToId } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX = 50 (not exported; kept in
// lockstep by hand — same as #168 / cp14-b1).
const SCROLL_BOTTOM_THRESHOLD_PX = 50;
// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

async function distFromBottom(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) return 999;
    return Math.round(el.scrollHeight - el.scrollTop - el.clientHeight);
  });
}

// Latest REST page (DESC by server_time; rows[0] is the newest) — used to pick a
// known message id for the mid-page cursor seed + the tail id we expect the tap
// to advance to. Mirror of the #168 local helper.
async function fetchScrollbackPage(
  token: string,
  channel: string,
): Promise<Array<{ id: number }>> {
  const url = `http://grappa-test:4000/networks/${encodeURIComponent(
    NETWORK_SLUG,
  )}/channels/${encodeURIComponent(channel)}/messages`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`fetchScrollbackPage: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Array<{ id: number }>;
}

// Shared body: focus an unread #bofh, tap the floating button, assert the cursor
// persists to the tail AND a subsequent peer line does not snap the view back.
// `peerNick` is passed distinct per project so the two runs never collide on a
// bahamut ghost-nick linger window (per-run-unique peer nicks, TESTING.md).
async function tapButtonPersistsCursorAndHolds(page: Page, peerNick: string): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();

  // Seed a cursor 25 rows from the tail → an unread divider is injected on first
  // focus and the activation parks ABOVE the fold (button shows). Same shape as
  // #168. `setReadCursorToId` hits the test-only force endpoint (the production
  // POST is advance-only since #233, so a backward seed through it would clamp).
  const page0 = await fetchScrollbackPage(vjt.token, CHANNEL);
  expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
  const tailRow = page0[0];
  const cursorRow = page0[25];
  if (!tailRow || !cursorRow) throw new Error("seeded page too short for cursor placement");
  await setReadCursorToId(vjt.token, NETWORK_SLUG, CHANNEL, cursorRow.id);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect
    .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

  // Divider present, activation parked above the fold, floating button visible.
  await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(1);
  await expect
    .poll(async () => await distFromBottom(page), { timeout: 5_000 })
    .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
  const btn = page.locator('[data-testid="scroll-to-bottom"]');
  await expect(btn).toBeVisible({ timeout: 5_000 });

  // Pre-tap: the server cursor is still at the mid seed (a bare open does NOT
  // advance it — the BUGHUNT-2 programmatic-scroll contract).
  await expect
    .poll(async () => await getReadCursor(vjt.token, NETWORK_SLUG, CHANNEL), { timeout: 3_000 })
    .toBe(cursorRow.id);

  // TAP the floating scroll-to-bottom button. `.click()` works on both the touch
  // (@webkit) and non-touch (chromium) contexts; `.tap()` would throw on desktop.
  await btn.click();

  // (1) PERSISTENCE — the core fix. RED pre-#310: the button never POSTed, so the
  // cursor stays at the mid seed and this poll times out.
  await expect
    .poll(async () => await getReadCursor(vjt.token, NETWORK_SLUG, CHANNEL), { timeout: 5_000 })
    .toBe(tailRow.id);

  // View is at the bottom; the floating button hides.
  await expect
    .poll(async () => await distFromBottom(page), { timeout: 5_000 })
    .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
  await expect(btn).toBeHidden({ timeout: 5_000 });

  // (2) NO SNAP-BACK. A peer line arriving AFTER the tap recreates rows() (the
  // exact ~2s trigger that re-asserted the marker jump on #libera). With the
  // latch released the pane tail-follows and STAYS at the bottom. RED pre-#310:
  // the latch was still set → the length-effect re-jumped to the divider.
  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    await peer.join(CHANNEL);
    const marker = `btn310-after-tap-${Date.now()}`;
    peer.privmsg(CHANNEL, marker);
    // Wait for the row to land (fakelag can delay arrival) so the rows()
    // recreation has happened before we measure.
    await expect(page.getByText(marker)).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(700); // past the 500ms settle + any re-assert window
    await expect
      .poll(async () => await distFromBottom(page), { timeout: 5_000 })
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
  } finally {
    await peer.disconnect("#310 done");
  }
}

// The mid-page cursor + the tap advance the shared seeded vjt's cursor across
// spec boundaries; restore to the tail after EACH run so a downstream #bofh spec
// inherits a fully-read channel (cascade hygiene — feedback_cascade_poisoner_pattern).
test.describe("#310 — scroll-to-bottom button persists the read cursor (desktop)", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test.afterEach(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("tapping the button advances the cursor to the tail and does not snap back", async ({
    page,
  }) => {
    await tapButtonPersistsCursorAndHolds(page, `btn310-c${Date.now() % 100000}`);
  });
});

test.describe("#310 — scroll-to-bottom button persists the read cursor (mobile)", () => {
  test.afterEach(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("@webkit tapping the button advances the cursor to the tail and does not snap back", async ({
    page,
  }) => {
    await tapButtonPersistsCursorAndHolds(page, `btn310-w${Date.now() % 100000}`);
  });
});
