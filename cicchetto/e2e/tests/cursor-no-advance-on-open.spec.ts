// BUGHUNT-2 bucket B sentinel 1: cursor does NOT advance on bare
// window open.
//
// Pins the contract from
// docs/superpowers/specs/2026-05-24-bughunt-2-cursor-design.md:
// activation routine fires programmatic `scrollIntoView` which emits
// a real DOM scroll event. The input-event gate (BUGHUNT-2 A2) must
// see no preceding pointerdown/wheel/touchmove/keydown and SKIP arming
// the 500ms settle timer. Cursor and marker stay where the server says.

import { expect, test } from "../fixtures/test";
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
// Past the debounce + rAF + POST + WS round-trip slop.
const SETTLE_WAIT_MS = SETTLE_DEBOUNCE_MS + 1000;

async function fetchCursor(token: string, channel: string): Promise<number | null> {
  const res = await fetch("http://grappa-test:4000/me", {
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

test.describe("BUGHUNT-2: bare window open does NOT advance cursor", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  // BUGHUNT-3 cascade fix (2026-05-25) — `cursorBaseline` setup advances
  // the cursor mid-pane via real-wheel-up + settle. Restore to tail so
  // downstream specs inheriting `vjt @ bahamut-test/#bofh` see a
  // fully-read channel and don't inject a stale unread-marker.
  test.afterAll(async () => {
    if (!CHANNEL) return;
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("opening a window with known unreads leaves cursor unchanged", async ({ page }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
    const vjt = getSeededVjt();
    await loginAs(page, vjt);

    // First, force-set a known cursor to a mid-list id by selecting
    // the channel, scrolling up to expose mid-list, real-wheeling, and
    // letting scroll-settle POST the cursor. Then SWITCH AWAY and back
    // — the leave-arm cursor write may also have fired, but the
    // critical assertion is "no further write happens on bare RE-open".
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    // Real wheel scroll up to expose mid-list rows in the viewport.
    // page.mouse.wheel fires PointerEvents on the underlying element
    // so the BUGHUNT-2 input-event gate sees a real input.
    const box = await page.locator('[data-testid="scrollback"]').boundingBox();
    if (!box) throw new Error("scrollback bounding box null");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const cursorBaseline = await fetchCursor(vjt.token, CHANNEL);
    expect(cursorBaseline).not.toBeNull();

    // Switch away to home, then back to CHANNEL. Bare open — no
    // operator scroll, no input event. The activation routine fires
    // programmatic scrollIntoView which MUST NOT advance the cursor.
    //
    // Note: `selectChannel` is channel/DM-specific (waits for self-JOIN
    // line) and not applicable to the Home pane — click the sidebar
    // Home button directly.
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page.waitForTimeout(200);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // Wait LONGER than the settle window. If the bug regresses, the
    // programmatic scrollIntoView in scrollToActivation fires scroll
    // → settle arms → 500ms later POSTs visible-tail (which is the
    // store-tail after the scroll snap) → cursor advances past
    // baseline.
    await page.waitForTimeout(SETTLE_WAIT_MS);

    const cursorAfterReopen = await fetchCursor(vjt.token, CHANNEL);
    expect(cursorAfterReopen).toBe(cursorBaseline);
  });
});
