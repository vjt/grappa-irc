// Issue #580 — own-send scroll authority must be INDEPENDENT of the POST.
//
// ## The field report (P0, intermittent)
//
// "own send sometimes does not scroll the list — the bottom-snap is gated on
// the POST resolving, not on the send." Pre-fix, `scrollback.sendMessage`
// published the ONLY scroll signal (`lastOwnSend`) AFTER `await
// apiSendMessage(...)`. That single signal drove BOTH the network-dependent
// work (divider re-latch + cursor advance, which genuinely need the persisted
// row id) AND the network-INDEPENDENT bottom-snap. So a slow / failed POST
// left the pane parked while the WS echo rendered the row.
//
// ## The fix (#580)
//
// Split the two concerns. `ownSendSubmitted` is published SYNCHRONOUSLY at
// submit time (before the await) and drives the bottom-snap + follow-state
// reset — the response to the operator pressing enter, independent of the
// network outcome. `lastOwnSend` stays post-resolve for the divider re-latch.
//
// ## What this spec pins (the discriminating RENDER proof)
//
// The vitest suite proves the TRIGGER fires before the POST. This proves the
// RENDER: even when the send POST FAILS at the client (case 1 — the server
// accepted it, so the row still arrives over WS), the pane SNAPS to the
// bottom and the just-sent line is visible.
//
// A fetch wrapper (addInitScript) forwards the send POST to the server —
// which persists + WS-broadcasts the row — then rejects, so the client's
// `apiSendMessage` sees a failure. RED pre-fix: `setLastOwnSend` sits after
// the throwing await, never runs, the pane stays parked on the unread marker
// (distance-to-tail stays above threshold) while the WS-echoed line renders
// off-screen. GREEN post-fix: `setOwnSendSubmitted` fired before the await, so
// the pane snaps to the tail regardless of the POST outcome.
//
// ## Case 2 — #778: the failure banner must not push the row back under
//
// Case 1 was intermittently red (~2 in 60) with a shape no rate could explain:
// the pane WAS at the bottom by the 50px threshold, yet the just-sent row was
// clipped. Measured cause: the `.compose-box-error` "send failed" line mounts
// BELOW the pane and shrinks the scroll container by its own 25px. When it
// lands AFTER the tail-follow write, the pane is left short of the tail by the
// shrink — under the 50px threshold, but more than a 21px row — so the newest
// row falls under the fold. Case 1 only ever saw it when the banner happened to
// lose the race; case 2 PINS the ordering (the send POST is held until the
// pane has tail-followed the WS echo) so the geometry is deterministic, and
// asserts on the state the operator actually ends up looking at.
//
// Harness mirrors issue168-scroll-authority (DB-seeded 200-row `#bofh`; tiny
// 800×300 viewport so the REST page overflows and scroll geometry is
// measurable; mid-page cursor so cold-mount lands on the marker, above the
// fold).

import { test, expect } from "../fixtures/test";
import { type Locator, type Page } from "@playwright/test";
import {
  composeTextarea,
  loginAs,
  scrollbackLines,
  selectChannel,
  waitForScrollbackRefreshed,
} from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail, setReadCursorToId } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX = 50 (not exported;
// kept in lockstep by hand — same as issue168 / cp14-b1).
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

// REST default page size (Grappa.Web.MessagesController.@default_limit).
const REST_PAGE_SIZE = 50;

async function distanceToBottom(page: Page): Promise<number> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  });
}

// Latest REST page in wire shape (DESC by server_time) — used to pick a known
// message id for the mid-page cursor seed (mirror of issue168).
async function fetchScrollbackPage(
  token: string,
  channel: string,
): Promise<Array<{ id: number }>> {
  const url = `http://grappa-test:4000/networks/${encodeURIComponent(
    NETWORK_SLUG,
  )}/channels/${encodeURIComponent(channel)}/messages`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    throw new Error(`fetchScrollbackPage: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Array<{ id: number }>;
}

// Test-only force endpoint (ReadCursor.force_set/4) — the production endpoint
// is advance-only (#233), so a backward mid-page seed must go through force.
async function seedCursor(channel: string, messageId: number): Promise<void> {
  const vjt = getSeededVjt();
  await setReadCursorToId(vjt.token, NETWORK_SLUG, channel, messageId);
}

// Fetch-wrap: the send POST reaches the server (which persists + WS-broadcasts
// the row) but the CLIENT sees a failure — the #580 "server accepted, client
// POST dropped" shape. Only the send POST is intercepted; every other request
// (login, REST GETs, read-cursor POST) passes through untouched.
//
// `hold` gates WHEN the client-side failure surfaces: false rejects as soon as
// the forward returns (case 1), true parks the rejection until the test calls
// `__grappa778ReleaseSend()` — so the "send failed" banner, and the container
// shrink it causes, land AFTER the pane has tail-followed the WS echo (case 2,
// #778). A released signal, not a delay: nothing here waits on wall-clock.
async function installFailingSendPost(page: Page, hold: boolean): Promise<void> {
  await page.addInitScript((holdUntilReleased: boolean) => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    window.__grappa778ReleaseSend = release;
    const orig = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (
        init?.method ?? (input instanceof Request ? input.method : "GET")
      ).toUpperCase();
      if (method === "POST" && /\/channels\/[^/]+\/messages(\?|$)/.test(url)) {
        try {
          await orig(input, init);
        } catch {
          // even a genuinely failed forward still simulates the client
          // failure — swallow and reject below.
        }
        if (holdUntilReleased) await gate;
        throw new TypeError("#580 simulated send POST failure");
      }
      return orig(input, init);
    };
  }, hold);
}

// Land on the unread marker with a mid-page cursor → cold-mount parks the view
// ABOVE the fold, so distance-to-tail starts above threshold (mirror of
// issue168) and a later "we are at the bottom" assert means something.
async function arriveParkedOnMarker(page: Page, channel: string): Promise<void> {
  const vjt = getSeededVjt();
  const page0 = await fetchScrollbackPage(vjt.token, channel);
  expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
  const cursorRow = page0[25];
  if (!cursorRow) throw new Error("seeded page too short for cursor placement");
  await seedCursor(channel, cursorRow.id);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });
  await waitForScrollbackRefreshed(page, NETWORK_SLUG, channel);

  await expect
    .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
  await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(1);
  await expect
    .poll(async () => await distanceToBottom(page))
    .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
}

// Send manually — `composeSend` awaits a draft-clear that a failed POST never
// produces. We assert on scroll geometry + the WS-echoed line, not the textarea.
async function sendAndAwaitEcho(page: Page, marker: string): Promise<Locator> {
  const ta = composeTextarea(page);
  await ta.fill(marker);
  await ta.press("Enter");
  const sentLine = scrollbackLines(page).filter({ hasText: marker });
  await expect(sentLine).toHaveCount(1, { timeout: 10_000 });
  return sentLine;
}

test.describe("issue #580 — own send snaps to the bottom independent of the POST", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  // The mid-page cursor persists on the shared seeded vjt across spec
  // boundaries (last-write-wins). Restore to the tail so downstream #bofh
  // specs inherit a fully-read channel (mirror of issue168).
  test.afterAll(async () => {
    const vjt = getSeededVjt();
    if (!CHANNEL) return;
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("send whose POST fails still snaps to the bottom (case 1)", async ({ page }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    await installFailingSendPost(page, false);
    await arriveParkedOnMarker(page, CHANNEL);

    // SEND — the POST will fail client-side, but the server broadcasts the row
    // over WS, so the echo renders it.
    const sentLine = await sendAndAwaitEcho(page, `#580 snap-on-fail ${Date.now()}`);

    // The pane snapped to the BOTTOM at submit time — NOT hostage to the POST.
    // RED pre-fix: the snap sat after the throwing await, so the view stayed
    // parked on the marker and distance-to-tail stayed above threshold.
    await expect.poll(async () => await distanceToBottom(page)).toBeLessThanOrEqual(
      SCROLL_BOTTOM_THRESHOLD_PX,
    );
    await expect(sentLine).toBeInViewport();
  });

  test("the send-failure banner does not push the sent row under the fold (case 2, #778)", async ({
    page,
  }) => {
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    await installFailingSendPost(page, true);
    await arriveParkedOnMarker(page, CHANNEL);

    const sentLine = await sendAndAwaitEcho(page, `#778 snap-under-banner ${Date.now()}`);

    // The pane has tail-followed the echo; the failure is still parked.
    await expect.poll(async () => await distanceToBottom(page)).toBeLessThanOrEqual(
      SCROLL_BOTTOM_THRESHOLD_PX,
    );
    await expect(sentLine).toBeInViewport();

    // NOW let the POST fail. The `.compose-box-error` line mounts below the pane
    // and shrinks the scroll container by its own height — moving the fold up
    // over the row we just proved visible.
    await page.evaluate(() => window.__grappa778ReleaseSend?.());
    await expect(page.locator(".compose-box-error")).toBeVisible();

    // RED pre-#778: the tail re-anchor lived only on window/visualViewport
    // `resize`, which a shell-internal box change never fires, so the pane
    // stayed short of the tail by the banner's height and the row was clipped —
    // while distance-to-tail still read "at the bottom" (the shrink is under the
    // 50px threshold but taller than a row). GREEN: the container ResizeObserver
    // re-pins a follower to the tail on any box change.
    await expect(sentLine).toBeInViewport();
    await expect.poll(async () => await distanceToBottom(page)).toBeLessThanOrEqual(
      SCROLL_BOTTOM_THRESHOLD_PX,
    );
  });
});

declare global {
  interface Window {
    __grappa778ReleaseSend?: () => void;
  }
}
