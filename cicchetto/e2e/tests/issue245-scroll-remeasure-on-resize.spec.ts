// #245 — iOS PWA: the scrollback scroll JAMS in EVERY channel tab after a
// hot-reload / bundle-refresh until each tab is reopened (WebKit reflow).
//
// ROOT CAUSE (confirmed from code + CSS, NOT from a device):
//   `.scrollback` base rule is `touch-action: none` (themes/default.css) —
//   it REJECTS all pan/scroll. ONLY `.scrollback.scrollback-overflowing`
//   flips to `touch-action: pan-y`. That class is JS-measured:
//   `ScrollbackPane.measureOverflow()` sets `isOverflowing =
//   scrollHeight > clientHeight`, and `clientHeight` is viewport-derived
//   (the mobile shell height tracks `--vh` / `visualViewport.height`).
//   measureOverflow ran ONLY on mount + on message-length-change — NEVER
//   on a viewport resize. On a FULL-PAGE reload in an installed iOS PWA
//   (bundleHash.performRefresh → window.location.reload) the
//   visualViewport height is transiently wrong at boot and SETTLES a few
//   hundred ms later via a `resize` event (which rewrites `--vh`); the
//   cold mount measured `clientHeight` before that settle and latched
//   `isOverflowing=false`, so `.scrollback` kept `touch-action: none` and
//   was unscrollable in every tab until a remount (opening the tab a
//   SECOND time) re-ran the onMount measure after the viewport settled.
//   The fix wires `measureOverflow()` onto the EXISTING onMount
//   `resize` / `visualViewport.resize` seam so the settle re-measures
//   overflow and unjams the pane without a remount.
//
// WIRING-ONLY — this is NOT a device repro
// (feedback_playwright_webkit_not_ios_scroll). Playwright webkit has no OS
// keyboard and cannot reproduce real iOS WebKit post-reload reflow / touch
// scroll physics. This spec proves the CONTRACT: a `visualViewport` resize
// that changes whether the content overflows re-computes
// `scrollback-overflowing` (→ touch-action) — exactly the wiring the fix
// adds. A GREEN here does NOT close #245; that needs a real iOS Safari PWA
// (vjt on-device). Mirrors the simulate-via-stubbed-`vv.height` approach of
// issue66-keyboard-overlap.spec.ts.
//
// `@webkit` opts this into the `webkit-iphone-15` project so `html.is-ios`
// engages and the real iOS height path (`body { height: calc(var(--vh) *
// 100) }`) is exercised.

import { type Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { resetSubject } from "../fixtures/grappaApi";
import {
  AUTOJOIN_CHANNELS,
  getSeededAdmin,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
  VJT_USER,
} from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// A handful of rows: MORE than a keyboard-shrunk viewport can show (so it
// overflows there) but FEWER than the real device viewport can show (so it
// does NOT overflow at cold mount). The default 200-row seed overflows even
// the real viewport, which would make the not-overflowing baseline
// unreachable — so re-seed #bofh to a small corpus for this spec. The
// wrapped `test` fixture's afterEach truncates #bofh back to the 200-row
// baseline, so no manual cleanup is needed (same verb issue161 uses).
// COUPLING: this count MUST stay small enough that the rows do NOT overflow
// the `webkit-iphone-15` project viewport (393×659) — the not-overflowing
// baseline below depends on it. A future `--font-size` / `--line-height`
// bump or a device-profile change could invalidate it; the baseline
// assertion then fails LOUD (never a false green), so bump this down if so.
const SMALL_SEED_COUNT = 10;
// Far taller than any plausible content → content can never overflow.
const HUGE_VV_PX = 9000;
// Far shorter than the content → content must overflow (the on-device
// "viewport settled SMALLER than I measured at cold mount" case).
const TINY_VV_PX = 150;

// Stub `visualViewport.height` (OS-keyboard-driven + read-only from
// Playwright), then dispatch the `resize` the production tracker +
// ScrollbackPane listen for. Stub height FIRST, THEN dispatch, so
// production `installViewportHeightTracker` writes the stubbed value into
// `--viewport-height` / `--vh` — a bare `setProperty` gets clobbered the
// instant any resize fires (docs/TESTING.md gotcha). Poll the var to
// confirm the simulation took before asserting geometry.
async function setVisualViewportHeight(page: Page, px: number): Promise<void> {
  await page.evaluate((h) => {
    const vv = window.visualViewport;
    if (!vv) throw new Error("#245 spec: window.visualViewport unavailable");
    Object.defineProperty(vv, "height", { configurable: true, get: () => h });
    vv.dispatchEvent(new Event("resize"));
  }, px);
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--viewport-height").trim(),
        ),
      { timeout: 5_000 },
    )
    .toBe(`${px}px`);
}

test("@webkit #245 — .scrollback re-measures overflow (touch-action) on visualViewport resize", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const vjt = getSeededVjt();

  // Re-seed #bofh to a SMALL corpus so it does NOT overflow the real device
  // viewport (the not-overflowing baseline) but WILL overflow a
  // keyboard-shrunk viewport.
  await resetSubject(
    admin.token,
    VJT_USER,
    { [NETWORK_SLUG]: AUTOJOIN_CHANNELS },
    { [NETWORK_SLUG]: [{ name: CHANNEL, seedCount: SMALL_SEED_COUNT, seedSender: "seed-bot" }] },
  );

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const scrollback = page.getByTestId("scrollback");
  await expect(scrollback).toBeVisible({ timeout: 10_000 });

  const touchAction = (): Promise<string> =>
    scrollback.evaluate((el) => getComputedStyle(el).touchAction);

  // BASELINE (fix-independent — the mount + REST-load length-effect measure
  // at the real viewport): the small corpus fits, so `.scrollback` does NOT
  // overflow → base `touch-action: none`. Correct: nothing to scroll.
  await expect(scrollback).not.toHaveClass(/scrollback-overflowing/, { timeout: 10_000 });
  await expect.poll(touchAction, { timeout: 5_000 }).toBe("none");

  // DISCRIMINATING (the #245 bug + fix): shrink the visible viewport (the
  // on-device post-reload settle to a height SMALLER than the cold-mount
  // measure) so the SAME content now overflows. The pane MUST re-measure on
  // the resize and flip to `touch-action: pan-y`. WITHOUT the fix, resize
  // re-anchors scroll but never re-measures overflow, so the class stays
  // absent and the pane is JAMMED (`touch-action: none`) exactly as
  // reported. expect.poll absorbs measureOverflow's double-rAF.
  await setVisualViewportHeight(page, TINY_VV_PX);
  await expect(scrollback).toHaveClass(/scrollback-overflowing/, { timeout: 5_000 });
  await expect.poll(touchAction, { timeout: 5_000 }).toBe("pan-y");

  // BIDIRECTIONAL confirmation: grow the viewport back past the content →
  // overflow must clear (touch-action back to none). Proves the re-measure
  // tracks the viewport in BOTH directions, not a one-shot latch.
  await setVisualViewportHeight(page, HUGE_VV_PX);
  await expect(scrollback).not.toHaveClass(/scrollback-overflowing/, { timeout: 5_000 });
  await expect.poll(touchAction, { timeout: 5_000 }).toBe("none");
});
