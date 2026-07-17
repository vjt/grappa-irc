// #285 (P0) — iOS PWA: the scrollback scroll is COMPLETELY LOCKED in every
// channel tab after a full-page reload / cold boot, until a tab switch or the
// on-screen keyboard opens. Longstanding, NOT a regression.
//
// ROOT CAUSE (confirmed from code + CSS, NOT from a device):
//   `.scrollback` base rule is `touch-action: none` (themes/default.css) — it
//   REJECTS all pan. ONLY `.scrollback.scrollback-overflowing` flips to
//   `touch-action: pan-y`. That class is JS-measured:
//   `ScrollbackPane.measureOverflow()` sets `isOverflowing =
//   scrollHeight > clientHeight`, and `clientHeight` is viewport-derived (the
//   mobile shell height tracks `--vh` / `--viewport-height` /
//   `visualViewport.height`). #245 already made `measureOverflow` re-run on
//   window/visualViewport `resize` EVENTS. But on an installed iOS PWA cold
//   reload the corrective viewport SHRINK is a CSS layout / safe-area-inset
//   settle that fires NO `resize` event this pane catches (or a vv.resize in
//   the boot→onMount window before the listener attaches). So #245's
//   remeasure never runs, the mount's false `isOverflowing=false` latch is
//   never corrected, and the pane stays `touch-action: none` — scroll DEAD.
//
//   THE FIX: a ResizeObserver on the scroll container. It fires on the
//   container's height change ITSELF, independent of any `resize` event, so
//   the false latch self-corrects the instant the settled height propagates.
//
// WIRING-ONLY — this is NOT a device repro
// (feedback_playwright_webkit_not_ios_scroll). Playwright cannot reproduce
// real iOS WebKit post-reload reflow / touch-pan physics. This spec proves
// the DISCRIMINATING contract #245 could not: a container height change with
// NO `resize` event re-computes `scrollback-overflowing` (→ touch-action).
// Pre-fix that path re-runs nothing (no `resize` → #245's onResize is silent)
// so the class stays absent and the pane is JAMMED; only the ResizeObserver
// unjams it. A GREEN here does NOT close #285 — the actual iOS touch-pan
// unlock after reload is verified ON DEVICE by vjt, not by CI.
//
// `@webkit` opts this into the `webkit-iphone-15` project so `html.is-ios`
// engages and the real iOS height path drives `.scrollback`'s clientHeight —
// mirrors issue245-scroll-remeasure-on-resize.spec.ts (its direct sibling).

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
// A small corpus: fits the real device viewport (the not-overflowing
// baseline) but overflows a shrunk one. Mirrors #245's coupling — kept small
// enough NOT to overflow the `webkit-iphone-15` viewport (393×659); a
// `--font-size` / `--line-height` / device-profile bump fails the baseline
// LOUD (never a false green), so bump this down if so.
const SMALL_SEED_COUNT = 10;
// Far taller than any plausible content → content can never overflow.
const HUGE_VV_PX = 9000;
// Far shorter than the content → content must overflow.
const TINY_VV_PX = 150;

// Shrink/grow the visible viewport by rewriting the height CSS vars DIRECTLY,
// WITHOUT dispatching a `resize` event. This is the #285 case #245 misses: an
// installed iOS PWA's post-reload settle can change `.scrollback`'s
// clientHeight via a CSS layout / safe-area reflow that fires NO
// window/visualViewport `resize` event. Mirrors `writeViewport`
// (lib/viewportHeight.ts) — both `--vh` and `--viewport-height` — but OMITS
// the dispatch. No dispatch = nothing re-runs `installViewportHeightTracker`,
// so the direct set is not clobbered (the #245 clobber gotcha only bites when
// a `resize` actually fires). The container box change is caught ONLY by the
// #285 ResizeObserver — no `resize` event exists for #245's onResize to see.
async function setViewportVarsNoResize(page: Page, px: number): Promise<void> {
  await page.evaluate((h) => {
    const s = document.documentElement.style;
    s.setProperty("--viewport-height", `${h}px`);
    s.setProperty("--vh", `${(h * 0.01).toFixed(2)}px`);
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

test("@webkit #285 — .scrollback re-measures overflow via ResizeObserver on a container height change with NO resize event", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const vjt = getSeededVjt();

  // Re-seed #bofh to a SMALL corpus so it does NOT overflow the real device
  // viewport (the not-overflowing baseline) but WILL overflow a shrunk one.
  // The wrapped `test` fixture's afterEach truncates #bofh back to the 200-row
  // baseline (same verb #245 / #161 use), so no manual cleanup is needed.
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

  // BASELINE (fix-independent — the mount + REST-load length-effect measure at
  // the real viewport): the small corpus fits → `.scrollback` does NOT
  // overflow → base `touch-action: none`. Correct: nothing to scroll.
  await expect(scrollback).not.toHaveClass(/scrollback-overflowing/, { timeout: 10_000 });
  await expect.poll(touchAction, { timeout: 5_000 }).toBe("none");

  // DISCRIMINATING (the #285 bug + fix): shrink the container height via CSS
  // vars with NO `resize` event — the on-device post-reload settle that #245's
  // onResize never sees. The pane MUST re-measure on the container's box change
  // and flip to `touch-action: pan-y`. WITHOUT the ResizeObserver, nothing
  // re-runs `measureOverflow` (no `resize` event fired), so the class stays
  // absent and the pane is JAMMED (`touch-action: none`) exactly as reported.
  // expect.poll absorbs the RO callback's double-rAF.
  await setViewportVarsNoResize(page, TINY_VV_PX);
  await expect(scrollback).toHaveClass(/scrollback-overflowing/, { timeout: 5_000 });
  await expect.poll(touchAction, { timeout: 5_000 }).toBe("pan-y");

  // BIDIRECTIONAL confirmation: grow the container back past the content — again
  // with NO resize event — so overflow must clear (touch-action back to none).
  // Proves the ResizeObserver tracks geometry in BOTH directions, not a
  // one-shot unlatch.
  await setViewportVarsNoResize(page, HUGE_VV_PX);
  await expect(scrollback).not.toHaveClass(/scrollback-overflowing/, { timeout: 5_000 });
  await expect.poll(touchAction, { timeout: 5_000 }).toBe("none");
});
