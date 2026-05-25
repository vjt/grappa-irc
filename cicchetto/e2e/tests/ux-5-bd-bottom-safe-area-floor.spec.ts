// UX-5 bucket BD (2026-05-20) — bottom action-button safe-area-inset
// clearance across mobile modals/drawers.
//
// BUG (vjt iPhone dogfood): Settings drawer's bottom "Done" button is
// partly hidden behind iOS app chrome (Safari URL bar, gesture
// indicator strip) on devices where `env(safe-area-inset-bottom)` is
// 0 (non-notched iPhone, iPad). Pre-BD floors:
//
//   * `.shell-members` ~:285 — `padding-bottom: env(safe-area-inset-bottom)` NO floor (BM `.mobile-panel-actions` launcher footer's only bottom inset)
//   * `.settings-drawer` ~:1382 — `padding: ... max(1rem, env(safe-area-inset-bottom))`
//   * `.archive-modal` ~:2490 — `padding: ... max(0.75rem, env(safe-area-inset-bottom))`
//   * `.image-upload-modal` ~:1187 — flat `padding: 1.5rem` (NO inset at all — worst)
//
// On notched devices `env(safe-area-inset-bottom)` ~= 34px and wins via
// `max()`. On non-notched models env() = 0px and the floor wins —
// 0-1rem (0-16px) leaves bottom-anchored buttons cramped against
// the chrome edge.
//
// FIX (uniform): floor bump to 1.5rem (24px @ 16px root) across all 4
// surfaces. Matches mobile-thumb-reach ergonomics with breathing room
// above iOS 17 home-indicator strip on every device shape. Single-
// class fix per "Fix root causes, not examples" — same trap on all 4,
// same value. Reviewer MED expanded scope to include .shell-members
// after first pass (BM footer hosts launchers; same bug class as
// .settings-drawer-done).
//
// WEBKIT LIMITATION
//
// Playwright webkit emulation reports `env(safe-area-inset-bottom)` as
// 0 (no notch), so we can't observe the `max()` selecting the env path
// — but we CAN read the computed `padding-bottom` and assert it's at
// least the 1.5rem floor. Root font-size is the browser default (16px);
// cicchetto's `--font-size: 14px` is a CSS *variable* consumed via
// `var()`, NOT a `:root { font-size: }` override, so `rem` units anchor
// to the browser default and `1.5rem = 24px`. The computed-style test
// reads `getComputedStyle(documentElement).fontSize` dynamically so a
// future `:root { font-size: }` change doesn't silently invalidate the
// assertion. The CSS-source walker (UX-3 OCT pattern) also asserts the
// `max(1.5rem, env(...))` declaration shape so future refactors that
// drop the env() arm still fail loud.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Walk CSS source for the named selector and return the declared
// value of `prop` (either the `padding` shorthand or `padding-bottom`
// longhand). Mirrors BV/UX-3 OCT walker.
async function readDeclaredCssValue(
  page: import("@playwright/test").Page,
  selector: string,
  prop: "padding" | "padding-bottom",
): Promise<string | null> {
  return await page.evaluate(
    ({ selector, prop }) => {
      function visit(rules: CSSRuleList): string | null {
        for (const rule of Array.from(rules)) {
          if (rule instanceof CSSMediaRule) {
            const inner = visit(rule.cssRules);
            if (inner) return inner;
            continue;
          }
          if (!(rule instanceof CSSStyleRule)) continue;
          const sels = rule.selectorText.split(",").map((s) => s.trim());
          if (!sels.includes(selector)) continue;
          const p = rule.style.getPropertyValue(prop).trim();
          if (p.length > 0) return p;
        }
        return null;
      }
      for (const sheet of Array.from(document.styleSheets)) {
        try {
          const found = visit(sheet.cssRules);
          if (found) return found;
        } catch {
          continue;
        }
      }
      return null;
    },
    { selector, prop },
  );
}

test("@webkit ux-5-bd — .settings-drawer padding uses 1.5rem env() bottom floor", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const pad = await readDeclaredCssValue(page, ".settings-drawer", "padding");
  expect(pad).not.toBeNull();
  // CSS-source shape: `max(1.5rem, env(safe-area-inset-bottom))` for
  // the bottom arm of the shorthand. The bottom arm is the 3rd value
  // in `padding: top horizontal bottom horizontal` (4-arm form).
  expect(pad).toContain("max(1.5rem, env(safe-area-inset-bottom))");
});

test("@webkit ux-5-bd — .settings-drawer computed padding-bottom >= 1.5rem floor (non-notched)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Computed style proves the env() floor takes effect, not just the
  // source declaration. Webkit emulation reports env() = 0 so max()
  // picks the floor — that's exactly the non-notched-iOS case the
  // bug fix targets. Reads root font-size dynamically so a future
  // `:root { font-size: }` change doesn't silently invalidate the
  // assertion (today the browser default 16px applies).
  await page.locator('[data-testid="shell-chrome-cog"]').tap();
  const drawer = page.locator(".settings-drawer.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });

  const { paddingBottom, rootEm } = await drawer.evaluate((el) => ({
    paddingBottom: parseFloat(getComputedStyle(el).paddingBottom),
    rootEm: parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  expect(paddingBottom).toBeGreaterThanOrEqual(1.5 * rootEm);
});

test("@webkit ux-5-bd — .archive-modal padding uses 1.5rem env() bottom floor", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const pad = await readDeclaredCssValue(page, ".archive-modal", "padding");
  expect(pad).not.toBeNull();
  expect(pad).toContain("max(1.5rem, env(safe-area-inset-bottom))");
});

test("@webkit ux-5-bd — .archive-modal computed padding-bottom >= 1.5rem floor (non-notched)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // ArchiveModal launcher lives in BM members-drawer footer on mobile-
  // channel. Mirror BO's path: select a channel, open drawer, tap
  // archive launcher.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await page.getByLabel(/open members sidebar/i).tap();
  await expect(page.locator(".shell-members.open")).toBeVisible({ timeout: 5_000 });
  await page
    .locator(".shell-members.open [data-testid='mobile-panel-archive']")
    .tap();
  const modal = page.locator(".archive-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });

  const { paddingBottom, rootEm } = await modal.evaluate((el) => ({
    paddingBottom: parseFloat(getComputedStyle(el).paddingBottom),
    rootEm: parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  expect(paddingBottom).toBeGreaterThanOrEqual(1.5 * rootEm);
});

test("@webkit ux-5-bd — .image-upload-modal padding uses 1.5rem env() bottom floor", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const pad = await readDeclaredCssValue(page, ".image-upload-modal", "padding");
  expect(pad).not.toBeNull();
  // Pre-BD the modal had flat `padding: 1.5rem` (no env() arm at all
  // for bottom). Post-BD the bottom arm gets the safe-area treatment.
  expect(pad).toContain("max(1.5rem, env(safe-area-inset-bottom))");
});

test("@webkit ux-5-bd — .shell-members padding-bottom uses 1.5rem env() floor (BM launcher footer trap)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // .shell-members uses split longhand (`padding-top` + `padding-bottom`)
  // not the shorthand — needs the longhand read. Reviewer MED-1 catch:
  // the BM `.mobile-panel-actions` launcher footer hosts archive +
  // settings buttons and relies entirely on the aside's inset for
  // bottom clearance; pre-BD `padding-bottom: env(...)` was 0px on
  // non-notched iPhones leaving the launcher row cramped under Safari
  // chrome.
  const pad = await readDeclaredCssValue(page, ".shell-members", "padding-bottom");
  expect(pad).not.toBeNull();
  expect(pad).toContain("max(1.5rem, env(safe-area-inset-bottom))");
});

test("@webkit ux-5-bd — .shell-members computed padding-bottom >= 1.5rem floor (non-notched)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Open the mobile members drawer so the aside is layout-active.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await page.getByLabel(/open members sidebar/i).tap();
  const drawer = page.locator(".shell-members.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });

  const { paddingBottom, rootEm } = await drawer.evaluate((el) => ({
    paddingBottom: parseFloat(getComputedStyle(el).paddingBottom),
    rootEm: parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  expect(paddingBottom).toBeGreaterThanOrEqual(1.5 * rootEm);
});
