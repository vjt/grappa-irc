// #264 (bug) — the mobile "jump to next active window" affordance
// (`NextActiveButton` variant="mobile", from #235) was a small rounded-rect
// pill anchored `position: absolute; bottom: 0.5rem`. `.shell-mobile` is not
// a positioned / transform containing block, so the button escaped to the
// LAYOUT viewport (the initial containing block), which iOS does NOT shrink
// when the on-screen keyboard opens — so it sat UNDER the keyboard exactly
// when you want to hop windows while typing.
//
// vjt's three requirements:
//   1. Ride above the keyboard + bottom bar (anchor to the keyboard-aware
//      VISUAL viewport, not the layout box).
//   2. Bigger + more visible.
//   3. A proper CIRCLE (symmetric), icon-only, count in a corner badge;
//      ≥44px HIG tap target.
//
// This is a CSS-layout witness → it MUST run on a real WebKit engine
// (`@webkit` → webkit-iphone-15, 393×852 = the mobile shell branch, the
// only place `variant="mobile"` mounts). jsdom/vitest is blind to layout
// geometry, so the Playwright e2e is the RED→GREEN gate.
//
// TESTABLE legs (RED→GREEN here):
//   (i)   CIRCLE: computed width === height (the pre-fix pill is wider than
//         tall → the equal-w/h assertion FAILS on the broken state), and a
//         round border-radius. Glyph rendered; count is a corner badge
//         (`position: absolute`) not an inline pill segment.
//   (ii)  ≥44px tap target: width ≥ 44 AND height ≥ 44 (the pre-fix pill is
//         ~20px tall → FAILS).
//
// #280 SUPERSEDED leg (iii). On scrollback windows (channel/query/server —
// incl. the `$server` window parked below) next-active no longer rides up
// via `.shell-mobile:has(...:focus)`: it renders in ScrollbackPane's float
// stack, `position: static`, ANCHORED to the message container, so it stays
// CONSTANT relative to the pane across keyboard toggles (the pane already
// rides above the compose box + soft keyboard). #264's keyboard-safety
// requirement is preserved by that pane-anchoring, and the new
// constant-relative-to-container wiring is proven by
// `issue280-button-coexist.spec.ts`. This spec retains #264's SHAPE
// contract (legs i + ii — circle / ≥44px / corner badge), which #280
// preserves; the ride-up leg is REMOVED (superseded), not weakened.
//
// NOT reproducible here (device-only, deferred): the ACTUAL soft-keyboard
// geometry (visualViewport shrink → `--viewport-height` change → button
// clears the real keyboard). Headless WebKit raises no soft keyboard, so
// `visualViewport` does not shrink on focus — we do NOT fabricate one.
//
// Anti-false-green: the button is asserted PRESENT (its count reads "1" via
// a real unread window) BEFORE any geometry is measured — a hidden button
// (auto-hidden via <Show when={hasActiveWindows()}>) would trivially
// satisfy any shape/position cap.
//
// Anti-#bofh-pollution: a peer JOINs the seeded autojoin channel and sends
// one line while vjt's focus is parked on the neutral $server window, so the
// channel accrues unread; the peer disconnects in `finally`.

import { loginAs, selectChannel, sidebarMessageBadge } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const NEXT_ACTIVE_BTN = '[data-testid="next-active-btn"]';
const NEXT_ACTIVE_COUNT = '[data-testid="next-active-btn"] .next-active-count';

const CHANNEL = AUTOJOIN_CHANNELS[0];
const CHANNEL_LINE = "264 ordinary channel traffic";

// HIG minimum tap target.
const MIN_TAP_PX = 44;
// The circle is width === height; allow sub-pixel + 1px border slack.
const SQUARE_TOLERANCE_PX = 1.5;

interface BtnMetrics {
  width: number;
  height: number;
  top: number;
  borderRadius: string;
  glyphText: string | null;
  glyphWidth: number;
  countText: string | null;
  countPosition: string | null;
}

async function measureButton(page: import("@playwright/test").Page): Promise<BtnMetrics> {
  return page.locator(NEXT_ACTIVE_BTN).evaluate((btn) => {
    const rect = btn.getBoundingClientRect();
    const cs = getComputedStyle(btn);
    const glyph = btn.querySelector(".next-active-glyph");
    const count = btn.querySelector(".next-active-count");
    return {
      width: rect.width,
      height: rect.height,
      top: rect.top,
      borderRadius: cs.borderRadius,
      glyphText: glyph?.textContent?.trim() ?? null,
      glyphWidth: glyph instanceof HTMLElement ? glyph.getBoundingClientRect().width : 0,
      countText: count?.textContent?.trim() ?? null,
      countPosition: count instanceof HTMLElement ? getComputedStyle(count).position : null,
    };
  });
}

// A `border-radius` computed to "50%" (WebKit keeps the percentage) OR a px
// value ≥ half the width both render a square element as a circle.
function isRound(borderRadius: string, width: number): boolean {
  const first = borderRadius.split(" ")[0];
  if (first.endsWith("%")) return Number.parseFloat(first) >= 50;
  return Number.parseFloat(first) >= width / 2 - 1;
}

test("#264 @webkit — mobile next-active button is a keyboard-safe circle (≥44px, corner badge)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const peerNick = `t264peer-${Date.now() % 100000}`;
  await loginAs(page, vjt);

  // Clear the channel's baseline unread (focus baselines the cursor to
  // tail), then park focus on $server — a window OUTSIDE the unread cycle
  // that still mounts a compose box (kindHasScrollback("server") === true) —
  // so the channel line below accrues unread AND we have a compose box to
  // focus for the ride-above leg.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });

  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    await peer.join(CHANNEL);
    peer.privmsg(CHANNEL, CHANNEL_LINE);
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: CHANNEL,
      sender: peerNick,
      body: CHANNEL_LINE,
    });
    // Anti-false-green: the button must be PRESENT (unread window exists,
    // count reads "1") before any geometry is measured.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", { timeout: 10_000 });

    // --- Legs (i) + (ii): CIRCLE + ≥44px, measured on a real WebKit layout.
    const unfocused = await measureButton(page);

    expect(
      Math.abs(unfocused.width - unfocused.height),
      `circle must be symmetric: width ${unfocused.width}px vs height ${unfocused.height}px`,
    ).toBeLessThanOrEqual(SQUARE_TOLERANCE_PX);
    expect(unfocused.width, `width ${unfocused.width}px must be ≥ ${MIN_TAP_PX}px (HIG)`).toBeGreaterThanOrEqual(
      MIN_TAP_PX,
    );
    expect(unfocused.height, `height ${unfocused.height}px must be ≥ ${MIN_TAP_PX}px (HIG)`).toBeGreaterThanOrEqual(
      MIN_TAP_PX,
    );
    expect(
      isRound(unfocused.borderRadius, unfocused.width),
      `border-radius ${unfocused.borderRadius} must render the ${unfocused.width}px box as a circle`,
    ).toBe(true);

    // Icon-only body + count in a corner badge (position: absolute), so the
    // shape stays round.
    expect(unfocused.glyphText, "glyph » must be rendered").toBe("»");
    expect(unfocused.glyphWidth, "glyph must have layout width").toBeGreaterThan(0);
    expect(unfocused.countText, "count wiring must still read the active-window count").toBe("1");
    expect(
      unfocused.countPosition,
      `count must be an absolutely-positioned corner badge, got position: ${unfocused.countPosition}`,
    ).toBe("absolute");

    // Leg (iii) — RIDE-ABOVE wiring — REMOVED: #280 superseded the
    // viewport-fixed `:has(textarea:focus)` lift on scrollback windows
    // (incl. this `$server` parked window). next-active now sits in
    // ScrollbackPane's pane-anchored float stack (position: static), so it
    // does NOT move on focus — it stays constant relative to the message
    // container, which `issue280-button-coexist.spec.ts` asserts directly.
  } finally {
    await peer.disconnect("264 done").catch(() => {});
  }
});
