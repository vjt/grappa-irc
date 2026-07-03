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
// former marker-branch (marker present → scrollIntoView) was a second
// scrollTop authority that raced the tail-follow and yanked the view up on
// SEND — removed from the post-send / cold-mount / length-effect paths.
//
// #168 regression fix (2026-07-03a): that collapse OVER-REACHED — it also
// killed the jump-to-marker on a deliberate channel-SWITCH.
//
// #168 completion (2026-07-03b, vjt point-2): marker-jump extended to ALL
// channel activation, and made RESET-PROOF. The `<For each={rows()}>` is
// ref-keyed and the `rows()` memo rebuilds fresh wrappers each recompute, so
// every rows change re-creates the list DOM and resets scrollTop to 0; a
// one-shot marker jump did not survive the post-activation catch-up refresh /
// late cursor hydration (the deterministic +1048 "307 race"). A
// `markerActivationPending` latch now re-asserts marker-or-tail on every rows
// recreation until the operator takes over. The activation triggers:
//   * channel-SWITCH into a channel WITH an unread divider → jump to the
//     MARKER (scrollIntoView({block:"start"}), atBottom=false), re-asserted;
//   * COLD-MOUNT / app-startup into an unread channel → ALSO the MARKER (vjt
//     point-2, reverses the #46 cold-mount-tail wontfix); no unread → tail;
//   * visibility-return / resize → TAIL (#46 resume family, one-shot);
//   * post-send / live-append → BOTTOM (#168; the send clears the latch first).
// The divider still renders at its frozen position (freeze-display contract,
// DESIGN_NOTES 2026-06-08) regardless.
//
// ## Four scenarios
//
//   Scenario 1 — channel → empty query → channel-back (no marker):
//     Tall channel, focus → lands at bottom. Open empty query via
//     `/query <peer-without-history>`, scrollTop=0 (fallback "no
//     messages yet"). Switch back via sidebar → expect: lands at
//     bottom again (no unread → tail). Pre-fix: pinned at scrollTop=0.
//
//   Scenario 2 — COLD-MOUNT into channel-with-unreads (#168 completion):
//     Pre-seed a read cursor for #bofh placing the divider mid-page (25
//     unreads), then FIRST-focus #bofh straight after login (a cold mount —
//     the key-effect is `defer`-skipped, so onMount owns the first snap).
//     Jumps to the MARKER (near the top, distance-to-bottom ABOVE threshold),
//     NOT the tail — the #46 cold-mount-tail wontfix reversed. A follow-on
//     SEND must still snap to the BOTTOM (the gate). A sibling test repeats
//     this after a full `page.reload()` (genuine app-startup).
//
//   Scenario 3 — SWITCH into channel-with-unreads (#168 regression fix):
//     Focus the $server window first (mounts ScrollbackPane), let #bofh warm
//     in the background (eager join-ok refresh loads all 200 rows), THEN
//     click #bofh in the sidebar — a real key-change SWITCH. The pane must
//     jump to the MARKER (marker visible near the top, distance-to-bottom
//     ABOVE threshold — NOT the tail). Pre-fix (307 race) this stranded at
//     scrollTop 0 (marker +1048) once the catch-up refresh recreated the DOM;
//     the latch's re-assert makes it deterministic. A follow-on SEND must
//     still snap to the BOTTOM (both directions).
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

  test("fresh focus / cold-mount into channel-with-unreads: jumps to the marker, then a send snaps to bottom (#168)", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Pre-seed a cursor 25 rows from the tail of #bofh so the divider injects
    // mid-page. Same shape cp14-b1 scenario 2 uses.
    //
    // #168 completion (2026-07-03b, vjt point-2): the FIRST focus after login
    // is a COLD MOUNT (the channel-switch key-effect is `defer`-skipped, so
    // onMount owns the first snap). It USED to land at the TAIL (#46
    // cold-mount-tail wontfix — the assertion this test previously encoded).
    // vjt reversed that: cold-mount now jumps to the frozen divider, SAME as a
    // deliberate switch. This test therefore now mirrors scenario 3's marker
    // contract, reached via cold-mount instead of a switch.
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

    // Sanity: scrollback overflows (else "not at the tail" is vacuous).
    const g = await scrollbackGeometry(page);
    expect(g.scrollHeight).toBeGreaterThan(g.clientHeight);

    // Contract 1 (#168 completion): cold-mount lands on the MARKER, not the
    // tail — distance-to-bottom is ABOVE threshold. The `markerActivationPending`
    // latch re-asserts the jump across the post-mount catch-up refresh + late
    // cursor hydration, so this is deterministic (the 307 race fix).
    await expect
      .poll(async () => {
        const cur = await scrollbackGeometry(page);
        return cur.scrollHeight - cur.scrollTop - cur.clientHeight;
      })
      .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);

    // Contract 2: the marker sits near the TOP of the viewport (block:"start")
    // and is on-screen — the operator sees the unread messages that follow it.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-testid="scrollback"]') as HTMLElement | null;
          const m = document.querySelector('[data-testid="unread-marker"]') as HTMLElement | null;
          if (!el || !m) return Number.NaN;
          return m.getBoundingClientRect().top - el.getBoundingClientRect().top;
        }),
      )
      .toBeLessThan(g.clientHeight / 2);
    const markerOffset = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="scrollback"]') as HTMLElement | null;
      const m = document.querySelector('[data-testid="unread-marker"]') as HTMLElement | null;
      if (!el || !m) throw new Error("scrollback/marker not found");
      return m.getBoundingClientRect().top - el.getBoundingClientRect().top;
    });
    expect(markerOffset).toBeGreaterThanOrEqual(-5);
    await expect(marker).toBeInViewport();

    // Contract 3 (gate): a SEND from the cold-mounted marker-parked pane still
    // snaps to the BOTTOM — the own-send clears the latch first, then
    // scrollToBottom owns the scroll (#168 post-send authority; do NOT re-open
    // the send-jump). The divider clears.
    const sent = `coldmount-then-send ${Date.now()}`;
    await composeSend(page, sent);

    const sentLine = scrollbackLines(page).filter({ hasText: sent });
    await expect(sentLine).toHaveCount(1, { timeout: 10_000 });
    await expect
      .poll(async () => {
        const cur = await scrollbackGeometry(page);
        return cur.scrollHeight - cur.scrollTop - cur.clientHeight;
      })
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
    await expect(sentLine).toBeInViewport();
    await expect(marker).toHaveCount(0, { timeout: 5_000 });
  });

  test("app-startup: cold-mount into a selected unread channel after a full reload jumps to the marker (#168)", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // The genuine app-startup path: a full PWA reload re-boots the SPA, so the
    // FIRST window focus after the reload cold-mounts the ScrollbackPane fresh
    // (onMount, key-effect defer-skipped) — the same lifecycle as launching the
    // installed PWA. #bofh is never focused before the reload, so its seeded
    // read cursor is never advanced and the unread divider survives the reboot.
    const page0 = await fetchScrollbackPage(vjt.token, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const cursorRow = page0[25];
    if (!cursorRow) throw new Error("seeded page too short for cursor placement");
    await seedCursor(page, CHANNEL, cursorRow.id);

    await loginAs(page, vjt);
    // Reboot the app BEFORE any window focus, then focus #bofh — a cold mount
    // on a freshly-booted SPA.
    await page.reload();
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    const marker = page.locator('[data-testid="unread-marker"]');
    await expect(marker).toHaveCount(1);

    const g = await scrollbackGeometry(page);
    expect(g.scrollHeight).toBeGreaterThan(g.clientHeight);

    // Cold-mount after reboot lands on the MARKER (not the tail), near the top
    // of the viewport, on-screen.
    await expect
      .poll(async () => {
        const cur = await scrollbackGeometry(page);
        return cur.scrollHeight - cur.scrollTop - cur.clientHeight;
      })
      .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
    const markerOffset = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="scrollback"]') as HTMLElement | null;
      const m = document.querySelector('[data-testid="unread-marker"]') as HTMLElement | null;
      if (!el || !m) throw new Error("scrollback/marker not found");
      return m.getBoundingClientRect().top - el.getBoundingClientRect().top;
    });
    expect(markerOffset).toBeGreaterThanOrEqual(-5);
    expect(markerOffset).toBeLessThan(g.clientHeight / 2);
    await expect(marker).toBeInViewport();
  });

  test("SWITCH into channel-with-unreads: jumps to the marker, then a send snaps to bottom", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

    // Seed a cursor 25 rows from the tail so an unread divider injects
    // mid-page (same shape as scenario 2 / issue168), but here we reach
    // #bofh via a deliberate SWITCH, not a cold mount.
    const page0 = await fetchScrollbackPage(vjt.token, CHANNEL);
    expect(page0.length).toBeGreaterThanOrEqual(REST_PAGE_SIZE);
    const cursorRow = page0[25];
    if (!cursorRow) throw new Error("seeded page too short for cursor placement");
    await seedCursor(page, CHANNEL, cursorRow.id);

    // Deterministic warmth gate: cic eagerly `refreshScrollback`es every
    // joined channel on its Phoenix join-ok (subscribe.ts) — REFRESH_LIMIT
    // (200) == the seed size, so #bofh loads ALL rows in the background
    // WITHOUT us focusing it. Register the waiter BEFORE loginAs so the
    // post-boot fetch can't slip past us; awaiting it proves #bofh is warm
    // (rows in the store) before we switch into it. Without warmth the
    // switch's scrollToActivation early-returns on an empty pane and the
    // length-effect tails — the marker jump only fires against a settled,
    // populated pane. The URL is `.../channels/%23bofh/messages?after=…`
    // (encodeURIComponent("#bofh") === "%23bofh").
    const bofhWarm = page.waitForResponse(
      (r) => r.url().includes(`/channels/%23bofh/messages`) && r.status() === 200,
      { timeout: 20_000 },
    );

    await loginAs(page, vjt);

    // FROM-window: the always-present $server window mounts ScrollbackPane
    // WITHOUT touching #bofh's read cursor (focusing #bofh first would fire
    // the leave-arm on the way out and advance its cursor to the tail,
    // erasing the unread we need). `windowName === NETWORK_SLUG` resolves to
    // the $server tab; awaitWsReady:false — no auto-join echo to wait on.
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
    await expect(page.locator('[data-testid="scrollback"]')).toBeVisible({ timeout: 10_000 });

    // #bofh scrollback fetched → warm. Only now is the switch a warm one.
    await bofhWarm;

    // THE SWITCH — click #bofh in the sidebar. key() changes $server→#bofh,
    // firing the channel-switch key-effect (prevKey defined, so NOT the
    // defer-skipped mount run). This is the trigger the #168 collapse
    // over-reached into.
    await sidebarWindow(page, NETWORK_SLUG, CHANNEL).locator(".sidebar-window-btn").click();

    await expect
      .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
      .toBeGreaterThanOrEqual(REST_PAGE_SIZE);

    const marker = page.locator('[data-testid="unread-marker"]');
    await expect(marker).toHaveCount(1);

    // Sanity: the pane overflows (else "not at the tail" is vacuous).
    const g = await scrollbackGeometry(page);
    expect(g.scrollHeight).toBeGreaterThan(g.clientHeight);

    // Contract assertion 1 (regression): the switch landed on the MARKER,
    // NOT the tail — distance-to-bottom is ABOVE threshold. RED pre-fix:
    // the #168 always-tail authority leaked into the switch and this was
    // <= threshold (pinned at the bottom, divider off-screen above).
    await expect
      .poll(async () => {
        const cur = await scrollbackGeometry(page);
        return cur.scrollHeight - cur.scrollTop - cur.clientHeight;
      })
      .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);

    // Contract assertion 2: the marker sits near the TOP of the viewport
    // (block:"start"), i.e. it is on-screen and in the upper region — the
    // operator sees the unread messages that follow it. Measured as the
    // marker's top offset from the scroll container's visible top.
    await expect
      .poll(async () =>
        page.evaluate(() => {
          const el = document.querySelector('[data-testid="scrollback"]') as HTMLElement | null;
          const m = document.querySelector('[data-testid="unread-marker"]') as HTMLElement | null;
          if (!el || !m) return Number.NaN;
          return m.getBoundingClientRect().top - el.getBoundingClientRect().top;
        }),
      )
      .toBeLessThan(g.clientHeight / 2);
    const markerOffset = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="scrollback"]') as HTMLElement | null;
      const m = document.querySelector('[data-testid="unread-marker"]') as HTMLElement | null;
      if (!el || !m) throw new Error("scrollback/marker not found");
      return m.getBoundingClientRect().top - el.getBoundingClientRect().top;
    });
    expect(markerOffset).toBeGreaterThanOrEqual(-5);
    await expect(marker).toBeInViewport();

    // BOTH DIRECTIONS: a SEND from the marker-parked pane must still snap to
    // the BOTTOM (#168 post-send authority preserved — the scope fix must
    // not re-break it). The sent line lands in the viewport, divider clears.
    const sent = `switch-then-send ${Date.now()}`;
    await composeSend(page, sent);

    const sentLine = scrollbackLines(page).filter({ hasText: sent });
    await expect(sentLine).toHaveCount(1, { timeout: 10_000 });
    await expect
      .poll(async () => {
        const cur = await scrollbackGeometry(page);
        return cur.scrollHeight - cur.scrollTop - cur.clientHeight;
      })
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
    await expect(sentLine).toBeInViewport();
    await expect(marker).toHaveCount(0, { timeout: 5_000 });
  });
});

