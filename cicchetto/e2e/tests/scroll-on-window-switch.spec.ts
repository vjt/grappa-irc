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
// Fix: on every `key()` change in the channel-switch effect, snap the
// pane to the tail (auto-follow takes over after the first append).
//
// #168 (2026-07-02): scroll collapsed to ONE always-bottom authority. The
// former marker-branch (marker present → scrollIntoView({block:"center"}))
// was a second scrollTop authority that raced the tail-follow and yanked
// the view up on send — removed. Activation ALWAYS lands at the tail; the
// unread divider still renders (frozen-display contract, DESIGN_NOTES
// 2026-06-08) but is never scrolled-to. The scenarios below assert the
// new contract.
//
// ## Two scenarios
//
//   Scenario 1 — channel → empty query → channel-back (no marker):
//     Tall channel, focus → lands at bottom. Open empty query via
//     `/query <peer-without-history>`, scrollTop=0 (fallback "no
//     messages yet"). Switch back via sidebar → expect: lands at
//     bottom again. Pre-fix: pinned at scrollTop=0.
//
//   Scenario 2 — fresh focus into channel-with-unreads (#168 always-bottom):
//     Pre-seed a read cursor for #bofh placing the divider mid-page (25
//     unreads), then focus #bofh. Post-#168 the pane lands at the TAIL
//     (distance-to-bottom <= threshold); the divider still renders (frozen
//     display) but sits ABOVE the fold, out of the viewport — it is no
//     longer a scroll anchor. The pane must NOT stay pinned to the top
//     (scrollTop > 0) either — that is the #130 bug this scenario guards.
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
// is vacuously true and "divider above the fold" is unmeasurable.

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
    // "(no marker)" scenario deterministic. Sibling test 2 seeds its OWN
    // mid-page cursor for the divider-present-lands-at-bottom scenario
    // (#168); this is the read-to-tail counterpart, not a workaround.
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
    // #168: cursor seeded to HEAD → no divider → lands at the bottom.
    await expect
      .poll(async () => {
        const cur = await scrollbackGeometry(page);
        return cur.scrollHeight - cur.scrollTop - cur.clientHeight;
      })
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);

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

    // Contract (#168): scroll position lands at the bottom on re-selection
    // — same shape as step 1. Pre-fix this failed — scrollTop stayed at 0
    // (or whatever value the query left behind).
    await expect
      .poll(
        async () => {
          const cur = await scrollbackGeometry(page);
          return cur.scrollHeight - cur.scrollTop - cur.clientHeight;
        },
        { timeout: 5_000 },
      )
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
  });

  test("fresh focus into channel-with-unreads: lands at bottom, divider frozen above (#168)", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Pre-seed a cursor 25 rows from the tail of #bofh so the divider
    // injects mid-page. Same shape cp14-b1 scenario 2 uses.
    //
    // #168 (2026-07-02) collapsed scroll to ONE always-bottom authority.
    // This test previously pinned "marker CENTERED in the viewport" — that
    // was the scroll-to-marker anchor that #168 removed. New contract:
    // fresh focus lands at the TAIL; the divider still renders (frozen-
    // display contract) but sits ABOVE the fold. The operator pages up
    // manually to re-read. The pane must NOT stay pinned to the top
    // (scrollTop=0) either — that is the #130 bug this spec also guards.
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

    // Contract assertion 1 (#168): the pane lands at the BOTTOM. The
    // scroll-to-marker anchor was collapsed into the single always-bottom
    // authority — activation snaps to the tail.
    await expect
      .poll(async () => {
        const cur = await scrollbackGeometry(page);
        return cur.scrollHeight - cur.scrollTop - cur.clientHeight;
      })
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);

    // Contract assertion 2 (#168): the divider is present in the DOM
    // (frozen-display contract preserved) but sits ABOVE the fold — it is
    // no longer a scroll anchor, so it is NOT in the viewport.
    await expect(marker).not.toBeInViewport();

    // Contract assertion 3 (#130 guard): the pane did NOT stay pinned to
    // the top — a real bottom-anchored scroll moved scrollTop off zero.
    const g2 = await scrollbackGeometry(page);
    expect(g2.scrollTop).toBeGreaterThan(0);
  });
});

