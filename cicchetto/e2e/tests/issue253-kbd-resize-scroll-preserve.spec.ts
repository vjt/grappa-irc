// #253 — focusing the compose input opens the iOS soft keyboard, which shrinks
// `window.visualViewport.height` and fires a `visualViewport` `resize`. The
// onMount handler wired that resize to `scrollToActivation("tail-only", …)`,
// which snaps to the BOTTOM *unconditionally* — never consulting `atBottom()`.
// So a reader parked above the tail (unread marker, scrolled-up history) was
// YANKED to the bottom the instant the keyboard opened, losing their position.
//
// The fix reuses the length-effect's irssi-shape follow rule (ScrollbackPane
// ~:2033): re-pin to the tail on resize ONLY when the reader was already
// tail-following (`atBottom()` true); otherwise leave `scrollTop` untouched so
// a keyboard/viewport shrink preserves the reader's position. `window.resize`
// (desktop window resize / zoom / devtools) rides the same handler and is
// gated identically.
//
// SEAM / WIRING SCOPE ONLY (feedback_playwright_webkit_not_ios_scroll):
// Playwright webkit has NO OS keyboard and does NOT reproduce the real iOS
// soft-keyboard `visualViewport`-resize timing/physics. We mirror what a real
// device produces — stub `vv.height` smaller and dispatch the `resize` the
// production tracker + ScrollbackPane listen for (same technique as
// issue66-keyboard-overlap). A GREEN proves the atBottom-gate WIRING fires and
// `scrollTop` is preserved under a STUBBED vv resize; it does NOT prove the
// real iOS keyboard-open is fixed. That needs a real iOS Safari PWA dogfood.
// jsdom is blind to scroll geometry, so a vitest test would be a hollow
// mirror — the @webkit e2e is the seam test (precedent: #66 / #196 / #245).
//
// `@webkit` opts these specs into the `webkit-iphone-15` project
// (playwright.config.ts grep) so `html.is-ios` engages and the real iOS height
// path (`body { height: calc(var(--vh) * 100) }`) is exercised.

import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { restoreReadCursorToTail } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Mirror of ScrollbackPane.SCROLL_BOTTOM_THRESHOLD_PX (not exported) — the
// reader is "at the tail" when distance-to-bottom is within it.
const SCROLL_BOTTOM_THRESHOLD_PX = 50;
// Stand-in for "the keyboard leaves ~300px of the screen visible" — far below
// the iPhone 15 device viewport (393×659) so the shrink is real. Same value
// issue66-keyboard-overlap uses for the keyboard-occlusion contract.
const FAKE_VISIBLE_PX = 300;

// Shrink the visualViewport the way the iOS soft keyboard does, then fire the
// `resize` the production code listens for. GOTCHA (docs/TESTING.md): define
// `vv.height` FIRST so `installViewportHeightTracker`'s own resize handler
// reads the shrunk value and writes `--vh` / `--viewport-height` — a bare
// setProperty would be clobbered the instant any resize fires. Dispatch the
// event AFTER the stub is in place.
async function simulateKeyboardOpen(page: import("@playwright/test").Page): Promise<void> {
  await page.evaluate((px) => {
    const vv = window.visualViewport;
    if (!vv) throw new Error("issue253 spec: window.visualViewport unavailable");
    Object.defineProperty(vv, "height", { configurable: true, get: () => px });
    vv.dispatchEvent(new Event("resize"));
  }, FAKE_VISIBLE_PX);
  // Confirm the simulated keyboard actually shrank the var BEFORE asserting
  // scroll geometry — so a failure below means "the scroll position moved"
  // (the #253 bug), never "the simulation didn't take".
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--viewport-height").trim(),
        ),
      { timeout: 5_000 },
    )
    .toBe(`${FAKE_VISIBLE_PX}px`);
}

test.describe("#253 — keyboard/viewport resize must not yank a scrolled-up reader to the tail", () => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

  // The discriminating spec SCROLLS UP on the shared #bofh. The scroll-settle
  // cursor write is gated on `recentInput` (a real pointerdown/wheel/touchmove/
  // keydown), which our synthetic `scroll` events do NOT arm, so this most
  // likely does NOT advance the cursor — but restore it to the tail after EACH
  // run anyway as defensive cascade hygiene: a fully-read #bofh is what the
  // sibling specs (and this spec's own positive control, which relies on a
  // cold-mount-at-tail) assume, and any drift would seed an unread marker →
  // cold-mount marker-jump → scroll flake. afterEach, NOT afterAll (under
  // --repeat-each afterAll fires far too late). feedback_cascade_poisoner_pattern.
  test.afterEach(async () => {
    const vjt = getSeededVjt();
    await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);
  });

  test("@webkit #253 — a scrolled-up reader keeps their scrollTop when the keyboard opens", async ({
    page,
  }) => {
    test.slow();
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    const sc = page.getByTestId("scrollback");

    // #bofh seeds 200 lines → the pane overflows. Park the reader UP in history
    // (well above the tail) so `atBottom()` is false — the case the bug yanks.
    //
    // `atBottom` flips false ONLY on a real scroll-UP: production `onScroll`
    // requires `scrollTop < lastScrollTop`. So we reproduce a real operator's
    // path — seat at the BOTTOM first (establishes lastScrollTop = max), THEN
    // move UP. Two caveats Playwright webkit forces (both seam-level, like the
    // vv-resize stub): (1) webkit emits NO `scroll` event for a programmatic
    // `scrollTop` write (chromium does), so we dispatch it so the production
    // handler reads the real, updated scrollTop; (2) each step is its own
    // dispatch so `lastScrollTop` is max before the upward move registers.
    const before = await sc.evaluate((el, threshold) => {
      const max = el.scrollHeight - el.clientHeight;
      el.scrollTop = max; // seat at the tail → onScroll sets atBottom=true, lastScrollTop=max
      el.dispatchEvent(new Event("scroll"));
      el.scrollTop = Math.floor(max * 0.3); // scroll UP → onScroll sees st < lastScrollTop → atBottom=false
      el.dispatchEvent(new Event("scroll"));
      return {
        top: el.scrollTop,
        max,
        distanceToBottom: el.scrollHeight - el.scrollTop - el.clientHeight,
        overflows: max > threshold,
      };
    }, SCROLL_BOTTOM_THRESHOLD_PX);
    await page.waitForTimeout(200); // let onScroll settle atBottom → false
    // Void the probe unless we are genuinely scrolled up in an overflowing pane.
    expect(before.overflows).toBe(true);
    expect(before.distanceToBottom).toBeGreaterThan(SCROLL_BOTTOM_THRESHOLD_PX);
    // The follow-gate keys off `atBottom()`; the fix is only meaningful when it
    // is FALSE here. The floating scroll-to-bottom button renders `when
    // {!atBottom()}`, so its presence is the observable proof the scroll-up
    // flipped the signal — assert it before simulating the keyboard, else the
    // probe would silently test the at-bottom path (a mirror).
    await expect(page.getByTestId("scroll-to-bottom")).toBeVisible({ timeout: 5_000 });

    await simulateKeyboardOpen(page);

    // THE ASSERTION: the reader's absolute scrollTop is PRESERVED — not snapped
    // to the tail. RED pre-fix: onResize → scrollToActivation("tail-only") →
    // scrollTop jumps to ~scrollHeight-clientHeight (the bottom). GREEN
    // post-fix: atBottom() is false → the handler no-ops → scrollTop unchanged.
    // Wait out scrollToActivation's double-rAF so a would-be snap has landed
    // before we assert it did NOT happen (mirrors issue196 live-arrival).
    await page.waitForTimeout(500);
    const during = await sc.evaluate((el) => el.scrollTop);
    expect(Math.abs(during - before.top)).toBeLessThanOrEqual(5);
  });

  test("@webkit #253 — an at-bottom reader stays pinned to the tail when the keyboard opens", async ({
    page,
  }) => {
    test.slow();
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    const sc = page.getByTestId("scrollback");

    // Positive control (non-discriminating; documents intent): a reader
    // following the tail (`atBottom()` true) must STAY at the tail across the
    // resize — a shrinking viewport keeps the bottom visible. Both pre- and
    // post-fix re-pin here, so this passes either way; it guards against a fix
    // that over-corrects and stops following live.
    const before = await sc.evaluate((el) => {
      el.scrollTop = el.scrollHeight; // hard bottom
      // Dispatch the scroll production onScroll needs (webkit fires none on a
      // programmatic write) so it sets atBottom=true from distance<=threshold —
      // don't lean on the cold-mount-at-tail state for the follow signal here.
      el.dispatchEvent(new Event("scroll"));
      return { overflows: el.scrollHeight - el.clientHeight > 0 };
    });
    await page.waitForTimeout(200);
    expect(before.overflows).toBe(true);

    await simulateKeyboardOpen(page);

    // After the resize the pane must be back at the tail (distance-to-bottom
    // within threshold). expect.poll absorbs scrollToActivation's double-rAF.
    await expect
      .poll(async () => sc.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), {
        timeout: 5_000,
      })
      .toBeLessThanOrEqual(SCROLL_BOTTOM_THRESHOLD_PX);
  });
});
