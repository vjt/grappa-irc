// #285 (P0) — iOS PWA: the scrollback scroll is COMPLETELY LOCKED in every
// channel tab after a full-page reload / cold boot, until a tab switch or the
// on-screen keyboard opens. Longstanding, NOT a regression.
//
// ROOT CAUSE (refined at REOPEN, from code + CSS, NOT a device):
//   The touch-pan gate FAILED CLOSED. `.scrollback` base was
//   `touch-action: none` and only `.scrollback.scrollback-overflowing` flipped
//   to `pan-y`, JS-measured by `measureOverflow` off a viewport-derived
//   `clientHeight`. The first #285 fix added a ResizeObserver — necessary but
//   NOT sufficient: on a cold iOS-PWA kill+relaunch the boot read latches an
//   INFLATED `--viewport-height`, the container BAKES to that inflated height,
//   and NO subsequent box change ever occurs to correct it — so the RO never
//   fires, `measureOverflow` never re-runs, and the pane stays
//   `touch-action: none` FOREVER (worse in tabs with no unread marker, whose
//   content sits just under the inflated threshold).
//
//   THE DURABLE FIX (this reopen): (1) INVERT the gate to FAIL OPEN — base
//   `.scrollback { touch-action: pan-y }`, and `.scrollback.scrollback-locked
//   { touch-action: none }` locks ONLY when `shouldLockScrollGate` proves the
//   content fits a trustworthy clientHeight, so a bad/pre-settle read can never
//   latch the pane dead; (2) a boot settle RE-READ of `visualViewport.height`
//   (viewportHeight.ts) that corrects the inflated `--viewport-height`
//   event-independently; (3) a post-mount settle re-measure timer. The RO stays
//   for legit box-change tracking.
//
// WIRING / CSS-CONTRACT ONLY — this is NOT a device repro
// (feedback_playwright_webkit_not_ios_scroll). Playwright cannot reproduce real
// iOS WebKit post-reload reflow / touch-pan physics. This spec proves: (a) the
// FAIL-OPEN base — `.scrollback`'s base `touch-action` is `pan-y`; and (b) a
// container height change with NO `resize` event re-computes the
// `scrollback-locked` gate (RO). A GREEN here does NOT close #285 — the actual
// iOS touch-pan unlock after a cold relaunch is verified ON DEVICE by vjt.
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
// the dispatch. The container box change is then caught ONLY by the #285
// ResizeObserver — no `resize` event exists for #245's onResize to see.
//
// CLOBBER GUARD (reopen-flake fix, 2026-07-17): we ALSO stub the REAL
// `visualViewport.height` (as #245 does via `Object.defineProperty`), but WITHOUT
// dispatching a resize. Rationale: the reopen fix added an EVENT-INDEPENDENT
// boot-settle re-read (viewportHeight.ts `SETTLE_REREAD_DELAYS_MS = [100,400,900]`)
// that re-reads `window.visualViewport.height` on a timer and rewrites
// `--viewport-height` / `--vh`. A bare CSS-var set leaves the real `vv.height` at
// the device height (659px on webkit-iphone-15), so any pending settle timer (or
// a stray real resize) reconciles our fake value BACK to 659px — the container
// regrows and the fail-open gate RE-LOCKS to `touch-action: none`. That clobber
// is timing-dependent (whether a re-read fires after we set the var) → green
// locally, red on slower CI (the reported failure: the CI trace shows the gate
// unlock at `--viewport-height:150px`, then RE-LOCK once the var was clobbered
// back to 659px). Stubbing `vv.height` makes every production re-read write the
// SAME value, so the simulated device state is self-consistent and the gate
// stays where the ResizeObserver put it. We still dispatch NO resize: the
// box-change re-measure under test remains the ResizeObserver alone, exactly as
// before — this only removes the source-of-truth contradiction the bare CSS-var
// set created, it does not change what is being asserted.
async function setViewportVarsNoResize(page: Page, px: number): Promise<void> {
  await page.evaluate((h) => {
    const vv = window.visualViewport;
    if (vv) {
      Object.defineProperty(vv, "height", { configurable: true, get: () => h });
    }
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

test("@webkit #285 reopen — .scrollback base is fail-open pan-y and the lock gate re-measures on a container height change with NO resize event", async ({
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

  // FAIL-OPEN BASE (#285 reopen — the CSS contract only a real browser can
  // verify; jsdom is blind to CSS). With every state class stripped, the base
  // `.scrollback` rule computes `touch-action: pan-y`. This is the crux: a
  // missing / pre-settle / failed measurement leaves the pane PANNABLE, never
  // the dead `touch-action: none` the old fail-CLOSED base baked. Strip + read
  // + restore synchronously inside one evaluate so Solid's reactive classList
  // can't re-assert mid-read (no race).
  const baseTouchAction = await scrollback.evaluate((el) => {
    const prev = el.className;
    el.className = "scrollback";
    const ta = getComputedStyle(el).touchAction;
    el.className = prev;
    return ta;
  });
  expect(baseTouchAction).toBe("pan-y");

  // BASELINE (fix-independent — the mount + REST-load length-effect measure at
  // the real viewport): the small corpus fits → `.scrollback` does NOT
  // overflow → the fail-open gate LOCKS to `touch-action: none`. Correct:
  // nothing to scroll.
  await expect(scrollback).toHaveClass(/scrollback-locked/, { timeout: 10_000 });
  await expect.poll(touchAction, { timeout: 5_000 }).toBe("none");

  // DISCRIMINATING (the #285 wiring): shrink the container height via CSS vars
  // with NO `resize` event — the on-device post-reload settle that #245's
  // onResize never sees. The pane MUST re-measure on the container's box change
  // and UNLOCK to `touch-action: pan-y`. WITHOUT the ResizeObserver, nothing
  // re-runs `measureOverflow` (no `resize` event fired), so the lock stays and
  // the pane is JAMMED (`touch-action: none`). expect.poll absorbs the RO
  // callback's double-rAF.
  await setViewportVarsNoResize(page, TINY_VV_PX);
  await expect(scrollback).not.toHaveClass(/scrollback-locked/, { timeout: 5_000 });
  await expect.poll(touchAction, { timeout: 5_000 }).toBe("pan-y");

  // BIDIRECTIONAL confirmation: grow the container back past the content — again
  // with NO resize event — so the gate must re-LOCK (touch-action back to none).
  // Proves the ResizeObserver tracks geometry in BOTH directions, not a
  // one-shot unlatch.
  await setViewportVarsNoResize(page, HUGE_VV_PX);
  await expect(scrollback).toHaveClass(/scrollback-locked/, { timeout: 5_000 });
  await expect.poll(touchAction, { timeout: 5_000 }).toBe("none");
});
