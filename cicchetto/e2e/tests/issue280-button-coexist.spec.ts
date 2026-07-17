// #280 (bug, P1) — the mobile "jump to next active window" affordance
// (`NextActiveButton` variant="mobile") and the scroll-to-bottom button
// (`ScrollbackPane` `.scroll-to-bottom-btn`) must COEXIST cleanly. Before
// the fix they were owned + anchored by two DIFFERENT components off two
// DIFFERENT reference frames:
//   * scroll-to-bottom — `position: absolute` inside `.scrollback-pane`
//     (the message container), `bottom: 0.75rem`, 2rem square.
//   * next-active     — `position: fixed` to the visual viewport,
//     `top: viewport-height - 3.5rem - --nab-lift`, 3.5rem circle, with a
//     DISCRETE `--nab-lift: 8rem` bump when a text field is focused
//     (`:has(textarea:focus)`).
// Keyboard-open → the 8rem lift shoved next-active UP into scroll-to-
// bottom's band on the shared right edge → OVERLAP; the two sizes also
// diverged (2rem vs 3.5rem).
//
// Fix (root cause): both buttons render into ONE container-anchored,
// evenly-spaced, same-size stacked pair (`.scrollback-float-stack`, owned
// by ScrollbackPane — the scroll authority + message-container owner), so
// their position is CONSTANT relative to the message container regardless
// of keyboard state (the pane rides above the compose box + soft keyboard)
// and they never overlap. See DESIGN_NOTES 2026-07-17.
//
// This is a CSS-layout + keyboard-open-branch witness → it MUST run on a
// real WebKit engine (`@webkit` → webkit-iphone-15, the only place
// variant="mobile" mounts). jsdom/vitest is blind to layout geometry and
// the `:has(textarea:focus)` branch, so this Playwright e2e is the RED→
// GREEN gate (the tier→badge-color pure fn is separately unit-tested).
//
// Keyboard-open simulation: headless WebKit raises no soft keyboard, so
// `visualViewport` does not shrink and `--viewport-height` does not move.
// We drive the app's OWN keyboard-open signal the SAME way #264 / #278 do
// — focus the compose textarea, which flips `.shell-mobile:has(textarea:
// focus)`. We do NOT invent a parallel keyboard sim.
//
// Anti-false-green: next-active is asserted PRESENT (count reads "1" via a
// real unread window) BEFORE any geometry is measured — a hidden button
// (auto-hidden via `<Show when={hasActiveWindows()}>`) would trivially
// satisfy a no-overlap / size check.

import { type Page } from "@playwright/test";
import {
  composeTextarea,
  loginAs,
  scrollbackLines,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted, partChannel, restoreReadCursorToTail } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0]!;
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

const SCROLL_TO_BOTTOM = '[data-testid="scroll-to-bottom"]';
const NEXT_ACTIVE_BTN = '[data-testid="next-active-btn"]';
const NEXT_ACTIVE_COUNT = '[data-testid="next-active-btn"] .next-active-count';
const SCROLLBACK_PANE = ".scrollback-pane";

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Axis-aligned intersection area of two rects. 0 ⇒ no overlap (they may
// touch edges but do not cover the same pixels).
function overlapArea(a: Rect, b: Rect): number {
  const dx = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return Math.max(0, dx) * Math.max(0, dy);
}

function fmt(r: Rect): string {
  return `[x ${r.x.toFixed(0)}, y ${r.y.toFixed(0)}, w ${r.width.toFixed(0)}, h ${r.height.toFixed(0)} → right ${(r.x + r.width).toFixed(0)}, bottom ${(r.y + r.height).toFixed(0)}]`;
}

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

// Drive CHANNEL up into history (loadMore) until the pane is genuinely
// scrolled UP (not at bottom) so the floating scroll-to-bottom button
// shows. Mirrors #243's scroll harness.
async function scrollChannelUp(page: Page): Promise<void> {
  await expect
    .poll(async () => await scrollbackLines(page).count(), { timeout: 10_000 })
    .toBeGreaterThanOrEqual(50);
  let prev = -1;
  for (let i = 0; i < 8; i++) {
    const c = await scrollbackLines(page).count();
    if (c === prev) break;
    prev = c;
    await scrollToTop(page);
    await page.waitForTimeout(600);
  }
  await scrollToTop(page);
  await expect
    .poll(async () => (await distFromBottom(page)) ?? 0, { timeout: 5_000 })
    .toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
  await expect(page.locator(SCROLL_TO_BOTTOM)).toBeVisible({ timeout: 5_000 });
}

// The read cursor is server-owned + persists across page loads; every
// test below leaves CHANNEL unread (peer traffic below a frozen scroll or
// an unfocused window). Restore to tail so a later spec that assumes a
// clean cursor / exact next-active count is not poisoned (the cascade-
// poisoner discipline — mirror #243).
test.afterEach(async () => {
  const vjt = getSeededVjt();
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
});

test.describe("#280 — next-active + scroll-to-bottom coexist cleanly", () => {
  test("@webkit — both buttons coexist without overlap, same size, and next-active stays constant relative to the message container across keyboard open", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    const peerNick = `t280geo-${Date.now() % 100000}`;
    const bgChannel = "#t280geo";
    await loginAs(page, vjt);

    // scroll-to-bottom needs a scrollable window we STAY on; next-active
    // needs a DIFFERENT window with unread — a focused window marks itself
    // read on arrival (verified: peer traffic to the focused, scrolled-up
    // window does NOT light the affordance), so the unread must live
    // elsewhere. Join a second channel, let a peer talk there in the
    // BACKGROUND while we sit on CHANNEL scrolled up: scroll-to-bottom
    // (from CHANNEL) + next-active (from the background channel) then
    // coexist in CHANNEL's float stack.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    const peer = await IrcPeer.connect({ nick: peerNick });
    try {
      await peer.join(bgChannel);
      // Operator joins the background channel (compose /join → server JOIN
      // + cic subscribe) so its later traffic accrues unread. Mirrors the
      // push-trigger channel-mention seam (peer joins first, then op).
      await composeTextarea(page).fill(`/join ${bgChannel}`);
      await composeTextarea(page).press("Enter");
      await selectChannel(page, NETWORK_SLUG, bgChannel, { ownNick: NETWORK_NICK });

      // Back to CHANNEL and scroll UP → scroll-to-bottom shows and the pane
      // stays far from the tail (background arrivals will NOT auto-follow).
      await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
      await scrollChannelUp(page);

      // Background traffic → bgChannel unread → next-active mounts (count
      // "1"), without touching CHANNEL's scroll or focus, so both
      // affordances show at once.
      const line = "280 geometry traffic";
      peer.privmsg(bgChannel, line);
      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel: bgChannel,
        sender: peerNick,
        body: line,
      });

      // Anti-false-green: BOTH affordances present + measurable before any
      // geometry is read.
      await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", { timeout: 10_000 });
      const nextActive = page.locator(NEXT_ACTIVE_BTN);
      const scrollBottom = page.locator(SCROLL_TO_BOTTOM);
      const pane = page.locator(SCROLLBACK_PANE);
      await expect(nextActive).toBeVisible();
      await expect(scrollBottom).toBeVisible();

      // ── Coexistence (keyboard CLOSED): no overlap + same size. ──────
      const naClosed = await nextActive.boundingBox();
      const sbClosed = await scrollBottom.boundingBox();
      expect(naClosed, "next-active must have a bounding box").not.toBeNull();
      expect(sbClosed, "scroll-to-bottom must have a bounding box").not.toBeNull();
      if (!naClosed || !sbClosed) return;

      expect(
        overlapArea(naClosed, sbClosed),
        `keyboard-closed overlap must be 0 — next-active ${fmt(naClosed)} vs scroll-to-bottom ${fmt(sbClosed)}`,
      ).toBe(0);

      // Item 4 — same size (the pair must look consistent). scroll-to-
      // bottom used to be a 2rem square vs next-active's 3.5rem circle.
      expect(
        Math.abs(naClosed.width - sbClosed.width),
        `widths must match — next-active ${naClosed.width.toFixed(1)} vs scroll-to-bottom ${sbClosed.width.toFixed(1)}`,
      ).toBeLessThan(0.6);
      expect(
        Math.abs(naClosed.height - sbClosed.height),
        `heights must match — next-active ${naClosed.height.toFixed(1)} vs scroll-to-bottom ${sbClosed.height.toFixed(1)}`,
      ).toBeLessThan(0.6);

      // next-active is stacked ABOVE scroll-to-bottom (item 1 — moved up
      // to clear it) and they are right-aligned (evenly distributed pair).
      expect(
        naClosed.y + naClosed.height,
        `next-active bottom ${(naClosed.y + naClosed.height).toFixed(0)} must sit above scroll-to-bottom top ${sbClosed.y.toFixed(0)}`,
      ).toBeLessThanOrEqual(sbClosed.y + 0.6);

      // ── Constant relative to the message container across keyboard. ──
      // Offset of next-active's TOP within the pane, keyboard CLOSED.
      const paneClosed = await pane.boundingBox();
      expect(paneClosed, "scrollback-pane must have a bounding box").not.toBeNull();
      if (!paneClosed) return;
      const offsetClosed = naClosed.y - paneClosed.y;

      // Drive the app's keyboard-open signal: focus the compose textarea →
      // `.shell-mobile:has(textarea:focus)` fires (the same signal #264 /
      // #278 rely on). Pre-fix this applied `--nab-lift: 8rem` to the
      // viewport-fixed circle, jumping it UP relative to the pane.
      await composeTextarea(page).focus();

      // Poll until geometry settles, then assert the offset is unchanged
      // and the pair still does not overlap.
      await expect
        .poll(
          async () => {
            const na = await nextActive.boundingBox();
            const pn = await pane.boundingBox();
            if (!na || !pn) return -999;
            return Math.round(na.y - pn.y - offsetClosed);
          },
          {
            message:
              "keyboard-open: next-active offset within the message container must stay constant (pre-fix the 8rem focus-lift jumps it up)",
            timeout: 5_000,
          },
        )
        .toBe(0);

      const naOpen = await nextActive.boundingBox();
      const sbOpen = await scrollBottom.boundingBox();
      expect(naOpen, "next-active must have a bounding box (kbd open)").not.toBeNull();
      expect(sbOpen, "scroll-to-bottom must have a bounding box (kbd open)").not.toBeNull();
      if (naOpen && sbOpen) {
        expect(
          overlapArea(naOpen, sbOpen),
          `keyboard-open overlap must be 0 — next-active ${fmt(naOpen)} vs scroll-to-bottom ${fmt(sbOpen)}`,
        ).toBe(0);
      }
    } finally {
      await peer.disconnect("280 geometry done").catch(() => {});
      await partChannel(vjt.token, NETWORK_SLUG, bgChannel).catch(() => {});
    }
  });

  test("@webkit — badge is BLUE (normal class) when the next target is a plain channel message", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    const peerNick = `t280blue-${Date.now() % 100000}`;
    await loginAs(page, vjt);

    // Park focus on $server (a scrollback window OUTSIDE the unread cycle)
    // so an ordinary line to CHANNEL accrues unread there in the
    // background → next-active targets CHANNEL, tier 1 (plain channel).
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });

    const peer = await IrcPeer.connect({ nick: peerNick });
    try {
      await peer.join(CHANNEL);
      const line = "280 ordinary channel traffic";
      peer.privmsg(CHANNEL, line);
      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel: CHANNEL,
        sender: peerNick,
        body: line,
      });

      const count = page.locator(NEXT_ACTIVE_COUNT);
      await expect(count).toHaveText("1", { timeout: 10_000 });
      // Tier 1 → BLUE. Contract: the "normal" modifier class drives the
      // channel-blue badge background (vs "priority" red).
      await expect(count).toHaveClass(/next-active-count-normal/, { timeout: 5_000 });
      await expect(count).not.toHaveClass(/next-active-count-priority/);
    } finally {
      await peer.disconnect("280 blue done").catch(() => {});
    }
  });

  test("@webkit — badge is RED (priority class) when the next target carries a mention", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    const peerNick = `t280red-${Date.now() % 100000}`;
    await loginAs(page, vjt);

    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });

    const peer = await IrcPeer.connect({ nick: peerNick });
    try {
      await peer.join(CHANNEL);
      // A word-boundary mention of the operator's nick lands in CHANNEL
      // while focus is on $server → mentionCounts[CHANNEL] > 0 → tier 0
      // → next-active targets a mention → RED. (Same seam #182 / the
      // push-trigger channel-mention spec use.)
      const line = `${NETWORK_NICK}: 280 ping`;
      peer.privmsg(CHANNEL, line);
      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel: CHANNEL,
        sender: peerNick,
        body: line,
      });

      const count = page.locator(NEXT_ACTIVE_COUNT);
      await expect(count).toHaveText("1", { timeout: 10_000 });
      // Tier 0 → RED.
      await expect(count).toHaveClass(/next-active-count-priority/, { timeout: 5_000 });
      await expect(count).not.toHaveClass(/next-active-count-normal/);
    } finally {
      await peer.disconnect("280 red done").catch(() => {});
    }
  });
});
