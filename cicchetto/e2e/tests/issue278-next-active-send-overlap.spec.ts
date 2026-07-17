// #278 (bug, P1) — REGRESSION from #264. #264 made the mobile "jump to
// next active window" affordance (`NextActiveButton` variant="mobile") a
// keyboard-safe CIRCLE anchored `position: fixed` off `--viewport-height`,
// and — fork B — bumped `--nab-lift` from 0.75rem to 4rem when a text
// field is focused (the keyboard-open signal) so the circle clears the
// bottom bar. But 4rem clears ONLY the bottom bar (min-height 3rem), NOT
// the compose box that stacks ON TOP of the bottom bar. So with the
// keyboard OPEN the circle (z-index: 40) lands in the compose-row band on
// the RIGHT edge — exactly where the send button lives — and, since the
// send button is an in-flow flex child with no stacking context, the
// circle paints over it. Tapping near send hits the wrong target.
//
// vjt reported it live on device (screenshot):
//   * keyboard OPEN  → next-active circle overlaps the send button. ❌
//   * keyboard CLOSED → no overlap (circle floats over the bottom bar). ✅
//
// Forward-fix (NOT a revert — reverting #264 re-buries the circle under
// the keyboard): the focus lift must clear the compose box too, so the
// circle sits ABOVE the send button while staying reachable/visible.
//
// This is a CSS-layout + keyboard-open-branch witness → it MUST run on a
// real WebKit engine (`@webkit` → webkit-iphone-15, the only place
// variant="mobile" mounts). jsdom/vitest is blind to layout geometry and
// the `:has(textarea:focus)` branch, so the Playwright e2e is the RED→GREEN
// gate.
//
// Keyboard-open simulation: headless WebKit raises no soft keyboard, so
// `visualViewport` does not shrink and `--viewport-height` does not move.
// We drive the app's OWN keyboard-open signal the SAME way #264 / #235 do
// — focus the compose textarea, which flips `.shell-mobile:has(textarea:
// focus)` and applies the focus-lift branch. We do NOT invent a parallel
// keyboard sim.
//
// Anti-false-green: the button is asserted PRESENT (count reads "1" via a
// real unread window) BEFORE any geometry is measured — a hidden button
// (auto-hidden via <Show when={hasActiveWindows()}>) would trivially
// satisfy a no-overlap check.
//
// Anti-#bofh-pollution: a peer JOINs the seeded autojoin channel and sends
// one line while vjt's focus is parked on the neutral $server window (which
// mounts a compose box), so the channel accrues unread while we have a
// compose box to focus; the peer disconnects in `finally`.

import { composeTextarea, loginAs, selectChannel, sidebarMessageBadge } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const NEXT_ACTIVE_BTN = '[data-testid="next-active-btn"]';
const NEXT_ACTIVE_COUNT = '[data-testid="next-active-btn"] .next-active-count';

const CHANNEL = AUTOJOIN_CHANNELS[0];
const CHANNEL_LINE = "278 ordinary channel traffic";

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

test("#278 @webkit — with the keyboard open the next-active circle does not overlap the send button and stays reachable", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const peerNick = `t278peer-${Date.now() % 100000}`;
  await loginAs(page, vjt);

  // Clear the channel's baseline unread (focus baselines the cursor to
  // tail), then park focus on $server — a window OUTSIDE the unread cycle
  // that still mounts a compose box (kindHasScrollback("server") === true)
  // — so the channel line below accrues unread AND we have a compose box
  // to focus for the keyboard-open leg.
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

    // Anti-false-green: the affordance must be PRESENT (unread window
    // exists, count reads "1") before any geometry is measured.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, CHANNEL)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", { timeout: 10_000 });

    // Drive the app's keyboard-open signal: focus the compose textarea →
    // `.shell-mobile:has(textarea:focus)` applies the focus-lift branch
    // (the SAME signal #264 / #235 rely on; WebKit raises no real soft
    // keyboard so `--viewport-height` alone would not move).
    await composeTextarea(page).focus();

    const nextActive = page.locator(NEXT_ACTIVE_BTN);
    const sendBtn = page.getByRole("button", { name: /send message/i });

    // Both must be present with a measurable box while the keyboard is
    // "open"; the next-active circle stays reachable (visible + enabled).
    await expect(sendBtn).toBeVisible();
    await expect(nextActive).toBeVisible();
    await expect(nextActive).toBeEnabled();

    // Poll geometry: the focus-lift recomputes the circle's `top`; wait
    // until both boxes are stable and assert no pixel overlap.
    await expect
      .poll(
        async () => {
          const na = await nextActive.boundingBox();
          const sb = await sendBtn.boundingBox();
          if (!na || !sb) return -1;
          return overlapArea(na, sb);
        },
        {
          message:
            "keyboard-open: next-active circle must NOT overlap the send button (#264's 4rem focus-lift drops it onto send)",
          timeout: 5_000,
        },
      )
      .toBe(0);

    // Explicit witness (also prints both boxes on failure for geometry).
    const na = await nextActive.boundingBox();
    const sb = await sendBtn.boundingBox();
    expect(na, "next-active must have a bounding box").not.toBeNull();
    expect(sb, "send button must have a bounding box").not.toBeNull();
    if (na && sb) {
      expect(
        overlapArea(na, sb),
        `keyboard-open overlap must be 0 — next-active ${fmt(na)} vs send ${fmt(sb)}`,
      ).toBe(0);

      // Reachable: the circle stays fully inside the visual viewport (not
      // pushed off-screen by an over-eager lift).
      const vp = page.viewportSize();
      expect(vp, "viewport size must be known").not.toBeNull();
      if (vp) {
        expect(na.y, `next-active top ${na.y.toFixed(0)} must be ≥ 0 (on-screen)`).toBeGreaterThanOrEqual(0);
        expect(
          na.y + na.height,
          `next-active bottom ${(na.y + na.height).toFixed(0)} must be ≤ viewport height ${vp.height}`,
        ).toBeLessThanOrEqual(vp.height + 0.5);
        expect(
          na.x + na.width,
          `next-active right ${(na.x + na.width).toFixed(0)} must be ≤ viewport width ${vp.width}`,
        ).toBeLessThanOrEqual(vp.width + 0.5);
      }
    }
  } finally {
    await peer.disconnect("278 done").catch(() => {});
  }
});
