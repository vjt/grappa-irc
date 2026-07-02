// Issue #168 — scroll authority: after a SEND the pane must stay pinned
// at the BOTTOM, never yank up to the unread divider.
//
// ## The regression (P0)
//
// The #163/#161/#156 unread-anchor cluster left TWO scrollTop authorities
// racing: the always-bottom follow AND a scroll-to-unread-marker anchor
// (`scrollToActivation`'s marker branch + the length-effect's
// `!markerScrolled` branch). On activation into a channel with unread the
// marker anchor won and parked the viewport mid-pane (atBottom=false), so a
// subsequent SEND did NOT follow to the tail — the just-sent line landed
// off-screen at the bottom while the view stayed stuck on the divider.
//
// ## Final scope (vjt + Mez, #168)
//
// ALWAYS scroll-to-bottom. No event-type branching. irssi-shape: new
// content lands at the bottom, the operator PAGES UP MANUALLY to re-read.
// The unread DIVIDER still renders (frozen-display contract, DESIGN_NOTES
// 2026-06-08) but is NO LONGER a scroll anchor. mark-all-read falls out for
// free — reaching the tail on send advances the cursor via the existing
// send-optimistic path, collapsing the divider.
//
// ## What this spec pins
//
// Seed a mid-page read cursor on `#bofh` (25 rows from the tail) so an
// unread divider is present on first focus. Then SEND a line and assert:
//   (a) the pane is pinned at the BOTTOM (distance-to-tail <= threshold),
//   (b) the just-sent line is IN the viewport (did NOT jump to the marker),
//   (c) unread clears — the divider collapses (cursor advanced to the tail).
//
// RED pre-fix: the marker anchor parked the view mid-pane; after the send
// the distance-to-tail stays well above threshold and the sent line is
// off-screen. GREEN post-fix: activation lands at the tail, the send
// follows, the sent line is visible at the bottom, the divider is gone.
//
// Harness mirrors cp14-b1-scroll-marker-vs-bottom (DB-seeded 200-row
// `#bofh` via the e2e seeder sidecar; tiny 800×300 viewport so the 50-row
// REST page overflows and scroll geometry is measurable).

import { test, expect } from "../fixtures/test";
import { type Page } from "@playwright/test";
import {
  composeSend,
  loginAs,
  scrollbackLines,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX = 50 (not exported;
// kept in lockstep by hand — same as cp14-b1).
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

async function scrollbackGeometry(
  page: Page,
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  });
}

async function distanceToBottom(page: Page): Promise<number> {
  const g = await scrollbackGeometry(page);
  return g.scrollHeight - g.scrollTop - g.clientHeight;
}

// Latest REST page in wire shape (DESC by server_time) — used to pick a
// known message id for the mid-page cursor seed.
async function fetchScrollbackPage(
  token: string,
  channel: string,
): Promise<Array<{ id: number; server_time: number; sender: string }>> {
  const url = `http://grappa-test:4000/networks/${encodeURIComponent(
    NETWORK_SLUG,
  )}/channels/${encodeURIComponent(channel)}/messages`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`fetchScrollbackPage: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Array<{ id: number; server_time: number; sender: string }>;
}

// Seed the SERVER-side read cursor at the given message id (server-owned
// post-CP29 R-1..R-4; cic hydrates from the `/me` envelope on cold load).
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

test.describe("issue #168 — send pins to bottom, never jumps to the unread marker", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  // The mid-page cursor persists on the shared seeded vjt across spec
  // boundaries (ReadCursor.set is last-write-wins). Restore to the tail so
  // downstream #bofh specs inherit a fully-read channel (mirror of cp14-b1).
  test.afterAll(async () => {
    const vjt = getSeededVjt();
    if (!CHANNEL) return;
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("unread divider present → send stays at bottom, divider clears", async ({ page }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Seed a cursor 25 rows from the tail → an unread divider is injected
    // mid-page on first focus (25 unread rows, same shape as cp14-b1 sc.2).
    const page0 = await fetchScrollbackPage(vjt.token, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const cursorRow = page0[25];
    if (!cursorRow) throw new Error("seeded page too short for cursor placement");
    await seedCursor(CHANNEL, cursorRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // REST page landed + the divider rendered (frozen-display contract).
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(1);

    // Sanity: the pane overflows (else the bottom assertions are vacuous).
    const g = await scrollbackGeometry(page);
    expect(g.scrollHeight).toBeGreaterThan(g.clientHeight);

    // SEND a uniquely-identifiable line to THIS channel.
    const marker = `#168 pin-to-bottom ${Date.now()}`;
    await composeSend(page, marker);

    const sentLine = scrollbackLines(page).filter({ hasText: marker });
    await expect(sentLine).toHaveCount(1, { timeout: 10_000 });

    // (a) Pane is pinned at the BOTTOM after the send. RED pre-fix: the
    // marker anchor parked the view mid-pane and the send did not follow,
    // so distance-to-tail stayed well above threshold.
    await expect.poll(async () => await distanceToBottom(page)).toBeLessThanOrEqual(
      SCROLL_BOTTOM_THRESHOLD_PX,
    );

    // (b) The just-sent line is visible — the view did NOT jump to / stay
    // stuck at the unread divider (which sits above the fold). RED pre-fix:
    // the sent line rendered off-screen at the bottom, not in the viewport.
    await expect(sentLine).toBeInViewport();

    // (c) Unread clears as a free consequence of reaching the tail — the
    // send-optimistic cursor advance collapses the divider (no separate
    // "mark read" write). Divider gone from the DOM.
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0, { timeout: 5_000 });
  });

  test("operator paged UP → send snaps back to the bottom (unconditional)", async ({ page }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Mid-page cursor → divider present, pane overflows.
    const page0 = await fetchScrollbackPage(vjt.token, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const cursorRow = page0[25];
    if (!cursorRow) throw new Error("seeded page too short for cursor placement");
    await seedCursor(CHANNEL, cursorRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    // Activation landed at the bottom (#168 always-bottom).
    await expect.poll(async () => await distanceToBottom(page)).toBeLessThanOrEqual(
      SCROLL_BOTTOM_THRESHOLD_PX,
    );

    // Operator PAGES UP with a real wheel gesture (a programmatic scrollTop
    // set would not arm the operator-input gate, so the pane would re-snap;
    // the wheel event marks a genuine operator scroll — following() → false).
    await page.locator('[data-testid="scrollback"]').hover();
    await expect
      .poll(async () => {
        await page.mouse.wheel(0, -4000);
        return await distanceToBottom(page);
      })
      .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);

    // SEND — must snap back to the bottom UNCONDITIONALLY (issue #168 asks:
    // "on sending a message the list must scroll to the bottom
    // unconditionally"), even though the operator had paged up.
    const marker = `#168 unconditional ${Date.now()}`;
    await composeSend(page, marker);

    const sentLine = scrollbackLines(page).filter({ hasText: marker });
    await expect(sentLine).toHaveCount(1, { timeout: 10_000 });
    await expect.poll(async () => await distanceToBottom(page)).toBeLessThanOrEqual(
      SCROLL_BOTTOM_THRESHOLD_PX,
    );
    await expect(sentLine).toBeInViewport();
  });
});
