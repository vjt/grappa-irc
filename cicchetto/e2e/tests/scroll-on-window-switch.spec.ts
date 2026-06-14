// Scroll-on-window-switch — bug fix verification.
//
// Reported: opening an empty query window leaves scrollTop=0; switching
// back to a populated channel keeps the scroll pinned to the top because
// the underlying `[data-testid="scrollback"]` <div> is reused across
// `selectedChannel` changes (Solid's `<Show>` without `keyed` preserves
// the DOM). The pre-fix length-effect in ScrollbackPane.tsx only fires
// when `messages().length` changes, so re-selecting a previously-loaded
// channel never re-snaps to the tail.
//
// Fix: on every `key()` change in the channel-switch effect, branch on
// the presence of an unread-marker:
//   * marker exists → scrollIntoView({ block: "center" }) — same UX as
//     the length-effect's marker branch (which also moved from "start"
//     to "center" so a window opened with unreads always centers the
//     boundary regardless of mount path: fresh selection vs switch-back).
//   * no marker → snap scrollTop to scrollHeight (tail). Auto-follow
//     takes over after the first append.
//
// ## Two scenarios
//
//   Scenario 1 — channel → empty query → channel-back (no marker):
//     Tall channel, focus → lands at bottom. Open empty query via
//     `/query <peer-without-history>`, scrollTop=0 (fallback "no
//     messages yet"). Switch back via sidebar → expect: lands at
//     bottom again. Pre-fix: pinned at scrollTop=0.
//
//   Scenario 2 — channel → another channel-with-unreads (marker centered):
//     Pre-seed a read cursor for #bofh placing the marker mid-page (25
//     unreads), open #cicchetto first to flush the focus path, then
//     switch to #bofh. Marker should land in viewport AND mid-pane,
//     NOT at the top edge of the viewport (which would be the old
//     `block: "start"` behavior). Geometry assertion: distance from
//     marker top to viewport top is between 25% and 75% of viewport
//     height, the canonical "center" band.
//
// ## Why DB-seeded scrollback (matches cp14-b1)
//
// 200 rows on (vjt, bahamut-test, #bofh) seeded by `mix
// grappa.seed_scrollback` so the channel reliably overflows the
// viewport. See cp14-b1 spec for full rationale (fakelag throttles
// IRC-driven seeds, DB seed is deterministic + instant).
//
// ## Tiny viewport
//
// Same 800×300 viewport cp14-b1 uses so the 50-row REST page reliably
// overflows the scrollback area; without overflow, "lands at bottom"
// is vacuously true and "marker centered" is unmeasurable.

import { expect, test } from "../fixtures/test";
import { type Page } from "@playwright/test";
import {
  composeSend,
  loginAs,
  scrollbackLines,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import {
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX = 50. Re-declared
// here for the same reason as cp14-b1: the const isn't exported; if it
// changes both sides need to update — test stays in lockstep.
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

const REST_PAGE_SIZE = 50;

// A peer nick that has NO DM history with vjt — `/query` opens an empty
// window. Doesn't matter who the peer is; just must not collide with
// any seeded sender. Using a deliberately-synthetic nick keeps the
// fixture decoupled from any future seed expansion.
const EMPTY_QUERY_PEER = "no-dm-peer-bnda3";

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

// Pre-seed the SERVER-side read cursor for `(NETWORK_SLUG, channel)` at
// the given message id. Post-CP29 R-1..R-4 the cursor is server-owned;
// cic hydrates from the `/me` envelope at cold load + per-channel join
// reply on subscribe. localStorage `rc:` keys are nuked on cic boot
// (R-4 migration), so the pre-CP29 seedCursor-via-localStorage shape
// no longer worked. Same shape cp14-b1 uses.
async function seedCursor(page: Page, channel: string, messageId: number): Promise<void> {
  const vjt = getSeededVjt();
  const url = `http://grappa-test:4000/networks/${encodeURIComponent(NETWORK_SLUG)}/channels/${encodeURIComponent(channel)}/read-cursor`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${vjt.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ message_id: messageId }),
  });
  if (!res.ok) {
    throw new Error(`seedCursor: ${res.status} ${await res.text()}`);
  }
  void page;
}

// Fetch the latest scrollback page via REST. Used in scenario 2 to
// compute the cursor server_time placing the marker mid-pane. Same
// shape cp14-b1 uses.
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

test.describe("scroll-on-window-switch — re-selecting a window snaps correctly", () => {
  test.use({ viewport: { width: 800, height: 300 } });

  test("channel → empty query → channel-back: scroll lands at bottom-or-marker on return", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Step 1 — focus the seeded channel and confirm scroll lands at the
    // bottom: the "no marker" path this scenario (Scenario 1) is named
    // for. Pre-fix bug: scrollTop stayed at 0 — the operator saw the
    // very first row of history, not the recent context.
    //
    // Precondition: mark #bofh fully read BEFORE login. The auto-reset
    // (_vjtReset, fixtures/test.ts) re-seeds #bofh with freshly-
    // timestamped rows and clears the read cursor; with no cursor
    // hydrated, cic counts those recent rows as live-unread and pins the
    // unread-marker to the very first row (scrollTop=0). That state is
    // ORDER-DEPENDENT — absent in isolation (the seeder's rows are old
    // by test time, so read), present after a prior spec's afterEach
    // reset (rows seconds old, so unread) — which is why this spec
    // passed solo (3/3) yet failed mid-suite: a marker pinned to the top
    // breaks BOTH the "at bottom" and the "marker mid-pane" branches
    // asserted below. Seeding the cursor to HEAD makes the documented
    // "(no marker)" scenario deterministic. Sibling :226 symmetrically
    // seeds its OWN mid-page cursor for the marker-centered scenario;
    // this is the read-to-tail counterpart, not a workaround.
    const headPage = await fetchScrollbackPage(vjt.token, CHANNEL);
    expect(headPage.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const headId = headPage[0]?.id;
    if (!headId) throw new Error("#bofh seed page empty — cannot seed read cursor to head");
    await seedCursor(page, CHANNEL, headId);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    const g1 = await scrollbackGeometry(page);
    expect(g1.scrollHeight).toBeGreaterThan(g1.clientHeight);
    // Either at the bottom OR marker is anchored mid-pane. Both pass
    // the "didn't stick to scrollTop=0" check.
    await expect
      .poll(async () => {
        const cur = await scrollbackGeometry(page);
        const distance = cur.scrollHeight - cur.scrollTop - cur.clientHeight;
        const hasMarker = (await page.locator('[data-testid="unread-marker"]').count()) > 0;
        return distance <= SCROLL_BOTTOM_THRESHOLD_PX || (hasMarker && cur.scrollTop > 0);
      })
      .toBe(true);

    // Step 2 — open an empty query via /query. compose.ts dispatches:
    //   openQueryWindowState(nid, peer, _) + setSelectedChannel(...)
    // so the pane re-renders with kind:"query", channelName=peer.
    // Empty scrollback → "no messages yet" fallback → scrollTop=0.
    await composeSend(page, `/query ${EMPTY_QUERY_PEER}`);

    // The query window now appears in the sidebar; wait for the focus
    // to actually flip (the visible scrollback shows the empty fallback).
    await expect(page.locator(".scrollback-empty")).toBeVisible({ timeout: 5_000 });

    const g2 = await scrollbackGeometry(page);
    // Empty scrollback contains only the "no messages yet" placeholder
    // — scrollHeight ≈ clientHeight, scrollTop=0.
    expect(g2.scrollTop).toBe(0);

    // Step 3 — switch back to the channel via the sidebar. THIS is the
    // bug-under-fix: pre-fix the length-effect doesn't fire (length
    // unchanged from last time we visited this channel), and the bare
    // <div> ref keeps scrollTop=0 from the query window's render. The
    // user sees the channel pinned to the top of its history.
    await sidebarWindow(page, NETWORK_SLUG, CHANNEL).locator(".sidebar-window-btn").click();

    // Wait for the channel scrollback to mount (rows reappear).
    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    // Contract: scroll position is at bottom OR marker-centered on
    // re-selection — same shape as step 1. Pre-fix this fails — scrollTop
    // stays at 0 (or whatever value the query left behind).
    await expect
      .poll(
        async () => {
          const cur = await scrollbackGeometry(page);
          const distance = cur.scrollHeight - cur.scrollTop - cur.clientHeight;
          const hasMarker = (await page.locator('[data-testid="unread-marker"]').count()) > 0;
          return distance <= SCROLL_BOTTOM_THRESHOLD_PX || (hasMarker && cur.scrollTop > 0);
        },
        { timeout: 5_000 },
      )
      .toBe(true);
  });

  test("fresh focus into channel-with-unreads: marker centered, NOT pinned to top", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Pre-seed a cursor 25 rows from the tail of #bofh so the marker
    // injection points mid-page. Same shape cp14-b1 scenario 2 uses.
    // cp14-b1's own assertion is `toBeInViewport()` — agnostic to start
    // vs center placement. THIS spec pins the stronger contract: the
    // marker is CENTERED, not pinned to the top edge. Pre-fix the
    // length-effect called `scrollIntoView({ block: "start" })` which
    // landed the marker at the very top of the viewport — usable but
    // showed no context above it. Post-fix uses `block: "center"` so
    // the user sees both context-above and unread-below at a glance.
    const page0 = await fetchScrollbackPage(vjt.token, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const cursorRow = page0[25];
    if (!cursorRow) throw new Error("seeded page too short for cursor placement");
    await seedCursor(page, CHANNEL, cursorRow.id);

    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    const marker = page.locator('[data-testid="unread-marker"]');
    await expect(marker).toHaveCount(1);

    // Sanity: scrollback overflows.
    const g = await scrollbackGeometry(page);
    expect(g.scrollHeight).toBeGreaterThan(g.clientHeight);

    // Contract assertion 1: marker is in the viewport (cp14-b1 pin).
    await expect(marker).toBeInViewport();

    // Contract assertion 2: marker is CENTERED, not pinned to the top
    // edge. Bounding-box probe — distance from marker top to scrollback
    // container top, normalized by container height. Center band
    // (0.20..0.80) is wide enough to absorb sub-pixel rounding +
    // browser-specific anchor offsets but excludes both top-pinned
    // (block: "start") and bottom-pinned (block: "end") behaviors.
    // Polled because scrollIntoView's effect lands asynchronously
    // relative to the layout commit (browser quirk; cp14-b1 polls
    // similarly for its threshold geometry).
    await expect
      .poll(
        async () => {
          const probe = await page.evaluate(() => {
            const list = document.querySelector(
              '[data-testid="scrollback"]',
            ) as HTMLDivElement | null;
            const m = document.querySelector(
              '[data-testid="unread-marker"]',
            ) as HTMLElement | null;
            if (!list || !m) return -1;
            const lr = list.getBoundingClientRect();
            const mr = m.getBoundingClientRect();
            return (mr.top - lr.top) / lr.height;
          });
          return probe;
        },
        { timeout: 5_000 },
      )
      .toBeGreaterThan(0.2);

    const finalRatio = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="scrollback"]') as HTMLDivElement | null;
      const m = document.querySelector('[data-testid="unread-marker"]') as HTMLElement | null;
      if (!list || !m) throw new Error("missing list or marker for geometry probe");
      const lr = list.getBoundingClientRect();
      const mr = m.getBoundingClientRect();
      return (mr.top - lr.top) / lr.height;
    });
    expect(finalRatio).toBeLessThan(0.8);
  });
});

