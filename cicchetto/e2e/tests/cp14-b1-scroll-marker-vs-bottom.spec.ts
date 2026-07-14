// CP14 B1 — initial scroll position: marker vs. bottom.
//
// Locks the contract that the handoff filed B1 against, after re-
// reading the production code revealed the existing implementation
// already satisfies the spec. The handoff's stated root cause didn't
// survive inspection of `cicchetto/src/ScrollbackPane.tsx:475-509` —
// the `injectMarker` gate already requires `unreadCount > 0`, so the
// marker only renders when there's actually something to mark. This
// spec pins the behavior so a future regression (e.g. someone "fixing"
// the marker logic by removing the unreadCount gate, or breaking the
// length-effect that selects between scrollIntoView and tail-follow)
// surfaces as a red e2e instead of a silent UX regression.
//
// ## Why DB-seeded scrollback (not IRC peer)
//
// Earlier iterations drove an IrcPeer flooding `#bofh` to build a
// scrollable pane. bahamut-test's fakelag throttles fresh-registered
// clients to ~1 msg/s under burst, making any seed > ~5 msgs non-
// deterministic (msgs lost or arriving across spec boundaries). The
// `mix grappa.seed_scrollback` task (run by the e2e seeder sidecar
// before grappa-test boots — see `cicchetto/e2e/compose.yaml`) writes
// 200 synthetic `:privmsg` rows on `(vjt, bahamut-test, #bofh)` via
// `Grappa.Scrollback.persist_event/1`. Same persistence path the
// production code uses; deterministic; instant. Each row's
// `server_time` is monotonically spaced 100ms apart so the test can
// place a read cursor at a known position inside the timeline.
//
// ## Two scenarios
//
//   Scenario 1 — no unreads → scroll lands at bottom, no marker.
//     Setup: spec fetches the seeded rows via REST, identifies the
//     server_time of the last row, writes `rc:bahamut-test:#bofh = T_last`
//     into localStorage BEFORE page load. cicchetto boots, REST loads
//     the latest 50 rows, `getReadCursor` returns T_last, the `rows`
//     createMemo computes `unreadCount = msgs.filter(m => m.server_time > T_last).length = 0`,
//     `injectMarker = false`, marker JSX absent, length-effect's
//     `markerRef` undefined → falls to `atBottom() === true` (default)
//     branch → tail-follow.
//
//   Scenario 2 — unreads exist → marker rendered (frozen DISPLAY), cold-mount
//     JUMPS TO THE MARKER (#168 completion, 2026-07-03b).
//     Setup: cursor written to the server_time of row 175 of 200 → cic
//     loads latest 50 (rows 151..200) → 25 rows have server_time > cursor
//     → `unreadCount = 25`, marker injected before row 176.
//     #168's 2026-07-02 collapse landed cold-mount at the TAIL (#46 wontfix);
//     vjt point-2 (2026-07-03b) reversed that — cold-mount / app-startup into
//     an unread channel now jumps to the frozen divider, SAME as a switch,
//     re-asserted across rows recreations by the `markerActivationPending`
//     latch. So the divider is a scroll ANCHOR again: on-screen near the top,
//     distance-to-bottom ABOVE threshold. (It still renders from the frozen
//     snapshot — freeze-display contract, DESIGN_NOTES 2026-06-08.)
//
// Both scenarios use a deliberately tiny viewport (800×300) so the
// 50-row REST page reliably overflows the scrollback area. Without
// this, the entire content fits on-screen and "is the tail at the bottom"
// becomes unmeasurable.

import { test, expect } from "../fixtures/test";
import { type Page } from "@playwright/test";
import {
  loginAs,
  scrollbackLines,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail, setReadCursorToId } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX = 50. Re-declared
// here because the const isn't exported; if it changes, both sides need
// to update — test stays in lockstep.
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

// REST default page size (Grappa.Web.MessagesController.@default_limit).
// 50 rows on the latest page; the seeder writes 200 rows total so cic
// loads rows 151..200 on first focus.
const REST_PAGE_SIZE = 50;

// Read the live geometry of the `[data-testid="scrollback"]` container.
// Used by the "near bottom" / "not near bottom" assertions instead of
// toBeInViewport — toBeInViewport is unreliable when scrollback content
// fits entirely within the visible region (both first and last rows
// can be "in viewport" simultaneously, defeating the contract).
async function scrollbackGeometry(
  page: Page,
): Promise<{ scrollTop: number; scrollHeight: number; clientHeight: number }> {
  return await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
    if (!el) throw new Error("scrollback container not found");
    return {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    };
  });
}

// Fetch the latest scrollback page via the REST surface using the spec's
// own bearer (same shape grappaApi.assertMessagePersisted uses). Returns
// rows in the wire shape (descending server_time per
// Grappa.Web.MessagesController.index/2). The spec uses these to compute
// localStorage cursor values that pin the marker to a known position.
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
  return (await response.json()) as Array<{
    id: number;
    server_time: number;
    sender: string;
  }>;
}

// Pre-seed the SERVER-side read cursor for `(NETWORK_SLUG, channel)` at
// the given message id. Post-CP29 R-1..R-4 the cursor is server-owned;
// cic hydrates from the `/me` envelope at cold load + per-channel join
// reply on subscribe. localStorage `rc:` keys are nuked on cic boot
// (R-4 migration), so the pre-CP29 seedCursor-via-localStorage shape
// no longer worked.
//
// Mirrors `cicchetto/src/lib/readCursor.ts`'s `advanceReadCursor` POST
// (forward-only via `Grappa.ReadCursor.advance/4` — sending the same
// id twice is idempotent). Server-side broadcast falls back to a no-op
// for cross-device fanout because no other WS subscriber exists at
// seed time; the cold-load `/me` envelope picks the value up when
// `loginAs` triggers cic boot.
async function seedCursor(page: Page, channel: string, messageId: number): Promise<void> {
  const vjt = getSeededVjt();
  // Delegates to the shared `setReadCursorToId` (test-only force endpoint,
  // `ReadCursor.force_set/4`) so the mid-page seed lands regardless of
  // prior cursor state — the production endpoint is advance-only since
  // #233 and would clamp a backward seed to whatever tail a prior spec
  // left behind (order-dependent flake).
  await setReadCursorToId(vjt.token, NETWORK_SLUG, channel, messageId);
  // `page` retained as a parameter for symmetry with the prior helper
  // shape; not currently used (server is the source of truth post-R-4).
  void page;
}

test.describe("CP14 B1 — divider present vs absent: scroll always lands at bottom on window open", () => {
  // Force a tiny viewport so the seeded 50-row REST page reliably
  // overflows the scrollback area. Without this, chromium's default
  // 1280×720 leaves the scrollback area large enough that 50 short
  // rows fit on-screen, and "is the tail at the bottom" /
  // "is the marker mid-pane" become unmeasurable.
  test.use({ viewport: { width: 800, height: 300 } });

  // BUGHUNT-3 cascade fix (2026-05-25) — `seedCursor` calls
  // `ReadCursor.set/4`, which is last-write-wins with direction NOT
  // enforced (see lib/grappa/read_cursor.ex:113-119). Scenario 2's
  // mid-pane cursor on `vjt @ bahamut-test/#bofh` persists across spec
  // boundaries on the shared seeded user. Downstream specs that focus
  // `#bofh` (marker-target-window-regression T2, r6-own-action,
  // cursor-forward-only, ux-5-bk, ux-6-k, p0e-invite-ack) assume a
  // "fully-read" cursor at the tail — the persisted mid-pane cursor
  // injects an unread-marker into the pane. Post-#168 the pane still lands
  // at the tail (the divider is display-only, not a scroll anchor) so the
  // scroll cascade no longer fires, but the stray divider would still trip
  // a downstream marker-count assertion — restore to the tail for hygiene.
  // afterAll restores the cursor to the current tail so the channel
  // reads as "fully read" for whoever inherits the seeded user next.
  test.afterAll(async () => {
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("no unreads → scroll lands at bottom, no unread-marker in DOM", async ({ page }) => {
    const vjt = getSeededVjt();

    // Fetch seeded rows from grappa-test BEFORE we boot the page so we
    // know the server_time of the tail row. Pre-seed cursor at the
    // tail → unreadCount=0 on first render.
    const page0 = await fetchScrollbackPage(vjt.token, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    // Wire shape is DESC, so rows[0] is the newest (highest id).
    const tail = page0[0];
    if (!tail) throw new Error("no seeded rows");
    await seedCursor(page, CHANNEL, tail.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // Wait for the REST page to land in the DOM. ≥ REST_PAGE_SIZE
    // because the autojoined own-nick JOIN row pushes the count above
    // the seed total.
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    // Contract assertion 1: no marker rendered.
    await expect(page.locator('[data-testid="unread-marker"]')).toHaveCount(0);

    // Sanity: scrollback IS taller than the viewport (otherwise the
    // assertion below is vacuously true).
    const g = await scrollbackGeometry(page);
    expect(g.scrollHeight).toBeGreaterThan(g.clientHeight);

    // Contract assertion 2: scroll position is at (or within
    // SCROLL_BOTTOM_THRESHOLD_PX of) the bottom. Direct geometry
    // assertion mirrors the production code's own threshold check
    // in ScrollbackPane.tsx:613-614.
    await expect
      .poll(async () => {
        const cur = await scrollbackGeometry(page);
        return cur.scrollHeight - cur.scrollTop - cur.clientHeight;
      })
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
  });

  test("unreads exist → marker rendered (frozen), cold-mount jumps to the marker (#168 completion)", async ({
    page,
  }) => {
    const vjt = getSeededVjt();

    // Fetch the latest REST page. Set the cursor at the row 25 from
    // the bottom → 25 rows are "unread" → marker injected mid-page.
    // 25 unreads is enough to push the marker well into the middle of
    // the visible area without being right at the tail.
    const page0 = await fetchScrollbackPage(vjt.token, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    // DESC-ordered, so index 25 is the 26th-newest row. Cursor placed
    // there means rows 0..24 (the newest 25) all satisfy `id > cursor`
    // → unreadCount = 25.
    const cursorRow = page0[25];
    if (!cursorRow) throw new Error("seeded page too short for cursor placement");
    await seedCursor(page, CHANNEL, cursorRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // Wait for REST page + marker. Marker injection happens reactively
    // when the page lands and the `rows` createMemo re-evaluates with
    // the cursor in place.
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const marker = page.locator('[data-testid="unread-marker"]');
    await expect(marker).toHaveCount(1);

    // Sanity: scrollback overflows.
    const g = await scrollbackGeometry(page);
    expect(g.scrollHeight).toBeGreaterThan(g.clientHeight);

    // Contract assertion 1 (#168 completion, 2026-07-03b): cold-mount into an
    // unread channel JUMPS TO THE MARKER (vjt point-2 reversed the #46
    // cold-mount-tail wontfix). The divider is a scroll anchor again — on-screen
    // near the top of the viewport, NOT above the fold.
    await expect(marker).toBeInViewport();

    // Contract assertion 2 (#168 completion): scroll position lands on the
    // MARKER, not the tail — distance-to-bottom is ABOVE threshold. Mirror of
    // the SCROLL_BOTTOM_THRESHOLD_PX gate from ScrollbackPane.tsx.
    await expect
      .poll(async () => {
        const cur = await scrollbackGeometry(page);
        return cur.scrollHeight - cur.scrollTop - cur.clientHeight;
      })
      .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
  });
});
