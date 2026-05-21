// UX-3 OCT (2026-05-18) — full iOS keyboard-resilience stack lockdown.
//
// The UX-3 cluster shipped four ORDER-DEPENDENT fixes after vjt's
// real-iPhone smoke turned every CSS-only attempt into a regression
// (BIS → TER → QUAT → SEX → SEPT → PENT → OCT). The combination
// that finally worked, end-to-end:
//
//   * BIS — safe-area inset on `.shell.shell-mobile` (not bars). Bar
//     boxes sit below Dynamic Island so iOS doesn't eat their touches.
//   * SEPT — `interactive-widget=resizes-content` viewport meta. iOS
//     17.4+ shrinks the layout viewport on keyboard open instead of
//     overlay-scrolling the body.
//   * PENT — `installViewportHeightTracker` writes
//     `--viewport-height: <visualViewport.height>px` on <html>, kept
//     live via `visualViewport.resize`. `.shell.shell-mobile { height:
//     var(--viewport-height, 100dvh) }` follows.
//   * OCT — `installScrollPin` snaps `window.scrollTo(0, 0)` on every
//     non-zero scroll event. Kills iOS's programmatic focus-scroll-
//     into-view that bypasses `body { overflow: hidden }`.
//
// Webkit emulation in Playwright doesn't simulate the OS keyboard,
// so this spec asserts the SHIPPING SHAPE of each layer — every
// piece either present or honored — rather than the end-user
// keyboard interaction. Real keyboard smoke is vjt's iPhone only.
// The full-stack regression that triggered this spec was a series
// of "we fixed half the stack and re-broke the other half" cycles;
// the spec exists to catch the regression NEXT time someone touches
// any of these moving parts.
//
// Per `feedback_e2e_user_class_parity_matrix`: CSS shape + JS-side-
// effect bucket. Single visitor login is sufficient.

import { expect, test } from "@playwright/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";

test("@webkit UX-3 OCT — viewport meta carries interactive-widget=resizes-content", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const viewportContent = await page.evaluate(() => {
    const meta = document.querySelector('meta[name="viewport"]');
    return meta?.getAttribute("content") ?? "";
  });

  expect(viewportContent).toContain("interactive-widget=resizes-content");
  // The other UX-3 BIS-relevant tokens stay required — guards against
  // an accidental rewrite that drops viewport-fit=cover.
  expect(viewportContent).toContain("viewport-fit=cover");
});

test("@webkit UX-3 OCT — installViewportHeightTracker writes --viewport-height on <html>", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // The tracker fires at main.tsx boot, BEFORE render(). By the time
  // loginAs resolves shell-ready, the var has been set at least once.
  const cssVar = await page.evaluate(() =>
    document.documentElement.style.getPropertyValue("--viewport-height").trim(),
  );

  // Format is "<n>px"; n must be a positive number.
  expect(cssVar).toMatch(/^\d+(\.\d+)?px$/);
  const px = parseFloat(cssVar);
  expect(px).toBeGreaterThan(0);

  // Sanity: the value should match the current visualViewport height
  // (no race between boot and shell-ready; webkit emulation has a
  // stable visualViewport equal to window.innerHeight when no keyboard
  // is active).
  const vpHeight = await page.evaluate(() => window.visualViewport?.height ?? -1);
  expect(vpHeight).toBeGreaterThan(0);
  expect(Math.abs(px - vpHeight)).toBeLessThan(1);
});

test("@webkit UX-3 OCT — installScrollPin REMOVED (UX-6 bucket D v2): window scroll is NOT yanked back to 0", async ({
  page,
}) => {
  // UX-6 bucket D v2 (2026-05-21) removed `installScrollPin`. With
  // D1's `.shell-mobile:has(:focus) { padding-bottom: 0 }` AND D2's
  // `.scrollback { min-height: 0 }`, the shell shrinks to
  // visualViewport.height when the keyboard opens — iOS no longer
  // needs to auto-scroll the page to keep compose visible. The pin
  // had become hostile: it cancelled user drag gestures by yanking
  // scrollY back to 0 on every touch (vjt iPhone PWA dogfood). This
  // test asserts the new contract — programmatic scrolls are
  // preserved, not snapped.
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Force the document tall enough to scroll.
  await page.evaluate(() => {
    document.body.style.overflow = "auto";
    const pad = document.createElement("div");
    pad.style.height = "5000px";
    pad.id = "ux-3-oct-scroll-probe";
    document.body.appendChild(pad);
  });

  const finalScrollY = await page.evaluate(async () => {
    window.scrollTo(0, 500);
    await new Promise((r) => setTimeout(r, 50));
    return window.scrollY;
  });
  // Pre-removal: pin yanked to 0. Post-removal: scroll is preserved.
  // Even if browsers can't honor 500 exactly in a custom test layout,
  // the asserttion is "scroll wasn't forced to 0".
  expect(finalScrollY).toBeGreaterThan(0);

  await page.evaluate(() => {
    document.body.style.overflow = "";
    document.getElementById("ux-3-oct-scroll-probe")?.remove();
  });
});

test("@webkit UX-3 OCT — .shell-mobile reads var(--viewport-height) with 100dvh fallback", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Walk the CSS source to confirm the rule shape. Webkit emulation
  // can't probe a real keyboard event; the source assertion is the
  // mechanical contract that this layer is wired.
  const heightDecl = await page.evaluate(() => {
    function visit(rules: CSSRuleList): string | null {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSMediaRule) {
          const inner = visit(rule.cssRules);
          if (inner) return inner;
          continue;
        }
        if (!(rule instanceof CSSStyleRule)) continue;
        const sels = rule.selectorText.split(",").map((s) => s.trim());
        if (!sels.includes(".shell-mobile")) continue;
        const h = rule.style.getPropertyValue("height").trim();
        if (h.length > 0) return h;
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
  });

  expect(heightDecl).not.toBeNull();
  expect(heightDecl).toContain("var(--viewport-height");
  // Fallback chain — the second arg to var() is the 100dvh fallback,
  // applied while the JS-driven var is being computed at boot.
  expect(heightDecl).toContain("100dvh");
});
