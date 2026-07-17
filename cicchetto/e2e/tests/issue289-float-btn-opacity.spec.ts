// #289 (enhancement, fast-follow to #280) — the two MOBILE floating
// buttons, next-active (`NextActiveButton` variant="mobile") and
// scroll-to-bottom (`ScrollbackPane` `.scroll-to-bottom-btn`), used to be
// fully OPAQUE and painted on top of the message list. Any message text
// that wrapped behind a button became unreadable. #280 fixed them
// overlapping EACH OTHER (one container-anchored stack); this is the next
// polish pass on the same pair: now that they coexist cleanly, they must
// not hide message CONTENT.
//
// Fix: both mobile floating variants get a translucent whole-element
// opacity — the text behind stays legible while the control (large glyph
// + accent fill + shadow) stays clearly tappable. Whole-element opacity
// (not a per-color alpha) keeps the fix theme-agnostic: every built-in
// theme inherits it without a per-theme translucent color. See
// DESIGN_NOTES 2026-07-18.
//
// This is a rendered-computed-style witness on the mobile variants
// (`.next-active-btn-mobile`, `.shell-mobile .scroll-to-bottom-btn`),
// which mount ONLY on a real mobile WebKit engine (`@webkit` →
// webkit-iphone-15, the only place variant="mobile" mounts + the
// `.shell-mobile` gate applies). jsdom/vitest is blind to the mobile
// gate + computed opacity, so this Playwright e2e is the RED→GREEN gate.
//
// Anti-false-green: BOTH buttons are asserted PRESENT + VISIBLE (a real
// unread window lights next-active count "1"; a scrolled-up pane shows
// scroll-to-bottom) BEFORE any opacity is read — a hidden/absent button
// (an `opacity`-less element, or one gated out via `<Show>`) would
// trivially satisfy an opacity check.

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

// Translucency band: the fix makes the control see-through (opacity < 1 —
// the bug was a fully opaque 1.0) while keeping it clearly tappable
// (comfortably above a disabled-looking floor). The exact value is a
// tuning knob; the CONTRACT is "translucent yet visible", not a magic
// number, so we assert the band rather than an exact opacity.
const OPAQUE = 1;
const TAPPABLE_FLOOR = 0.4;

async function opacityOf(page: Page, selector: string): Promise<number> {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return -1;
    return parseFloat(getComputedStyle(el).opacity);
  }, selector);
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
// shows. Mirrors #280 / #243's scroll harness.
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

// The read cursor is server-owned + persists across page loads; this test
// leaves CHANNEL + the background channel unread. Restore to tail so a
// later spec that assumes a clean cursor / exact next-active count is not
// poisoned (cascade-poisoner discipline — mirror #280 / #243).
test.afterEach(async () => {
  const vjt = getSeededVjt();
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
});

test.describe("#289 — mobile floating buttons are translucent (text shows through)", () => {
  test("@webkit — next-active + scroll-to-bottom are translucent yet clearly tappable", async ({
    page,
  }) => {
    const vjt = getSeededVjt();
    const peerNick = `t289-${Date.now() % 100000}`;
    const bgChannel = "#t289op";
    await loginAs(page, vjt);

    // Surface BOTH buttons at once (mirrors #280 test-1): scroll-to-bottom
    // needs a scrolled-up window we STAY on; next-active needs a DIFFERENT
    // window with unread (a focused window marks itself read on arrival),
    // so the unread lives in a background channel while we sit on CHANNEL
    // scrolled up.
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    const peer = await IrcPeer.connect({ nick: peerNick });
    try {
      await peer.join(bgChannel);
      await composeTextarea(page).fill(`/join ${bgChannel}`);
      await composeTextarea(page).press("Enter");
      await selectChannel(page, NETWORK_SLUG, bgChannel, { ownNick: NETWORK_NICK });

      // Back to CHANNEL and scroll UP → scroll-to-bottom shows and the pane
      // stays far from the tail (background arrivals will NOT auto-follow).
      await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
      await scrollChannelUp(page);

      // Background traffic → bgChannel unread → next-active mounts (count
      // "1"), without touching CHANNEL's scroll or focus.
      const line = "289 opacity traffic";
      peer.privmsg(bgChannel, line);
      await assertMessagePersisted({
        token: vjt.token,
        networkSlug: NETWORK_SLUG,
        channel: bgChannel,
        sender: peerNick,
        body: line,
      });

      // Anti-false-green: BOTH affordances present + visible before any
      // opacity is read.
      await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", { timeout: 10_000 });
      await expect(page.locator(NEXT_ACTIVE_BTN)).toBeVisible();
      await expect(page.locator(SCROLL_TO_BOTTOM)).toBeVisible();

      // ── The fix: both mobile floating buttons are translucent. ──────
      const naOpacity = await opacityOf(page, NEXT_ACTIVE_BTN);
      const sbOpacity = await opacityOf(page, SCROLL_TO_BOTTOM);

      expect(
        naOpacity,
        `next-active must be translucent (< ${OPAQUE}) so text behind stays legible — got ${naOpacity}`,
      ).toBeLessThan(OPAQUE);
      expect(
        naOpacity,
        `next-active must stay clearly tappable (>= ${TAPPABLE_FLOOR}) — got ${naOpacity}`,
      ).toBeGreaterThanOrEqual(TAPPABLE_FLOOR);

      expect(
        sbOpacity,
        `scroll-to-bottom must be translucent (< ${OPAQUE}) so text behind stays legible — got ${sbOpacity}`,
      ).toBeLessThan(OPAQUE);
      expect(
        sbOpacity,
        `scroll-to-bottom must stay clearly tappable (>= ${TAPPABLE_FLOOR}) — got ${sbOpacity}`,
      ).toBeGreaterThanOrEqual(TAPPABLE_FLOOR);
    } finally {
      await peer.disconnect("289 opacity done").catch(() => {});
      await partChannel(vjt.token, NETWORK_SLUG, bgChannel).catch(() => {});
    }
  });
});
