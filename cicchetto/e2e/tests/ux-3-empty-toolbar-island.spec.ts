// UX-3 (2026-05-17) — `.shell-empty-toolbar` Dynamic Island clearance.
//
// iOS-2 added `padding: max(0.5rem, env(safe-area-inset-top))` to
// `.topic-bar` so the channel-view header clears the iPhone Dynamic
// Island. `.shell-empty-toolbar` (rendered when no channel is
// selected — both desktop and mobile shell branches) was missing the
// same inset, so the cold-load shell painted under the Island.
//
// Verification strategy. Playwright's iPhone 15 device emulation
// matches viewport + UA but does NOT inject real `env(safe-area-*)`
// values — `getComputedStyle().paddingTop` resolves to the
// `max(0.5rem, env(...))` FLOOR of 8px regardless. So asserting
// against a numeric px value can't distinguish the buggy rule
// (`padding: 0.5rem 1rem`) from the fixed rule. Instead, walk the
// document stylesheets, locate the `.shell-empty-toolbar` rule, and
// assert its declared padding-top SOURCE contains both `env(` and
// `safe-area-inset-top`. That pins the FIX shape without relying on
// emulated viewport metrics that webkit-iphone-15 doesn't fake.
//
// Also assert the rule's computed paddingTop resolves to ≥ 8px (the
// floor) — a weak smoke that the rule actually compiled (no typo).
//
// Per-class parity matrix per `feedback_e2e_user_class_parity_matrix`:
// UX-3 is a CSS shape bucket — not an IRC-function spec. The
// `.shell-empty-toolbar` rule is class-agnostic; one visitor login
// suffices. Full visitor/nickserv/registered loop runs in UX-Z.

import { expect, test } from "@playwright/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("@webkit UX-3 — .shell-empty-toolbar mirrors .topic-bar safe-area-inset-top", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Cold-load N-3 auto-selects the first joined channel; to surface
  // `.shell-empty-toolbar`, PART that channel — BUG5a contract sends
  // selectedChannel back to null and the empty stub renders.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);

  const emptyToolbar = page.locator(".shell-empty-toolbar");
  await expect(emptyToolbar).toBeVisible({ timeout: 10_000 });

  // Source assertion — walks document.styleSheets, locates the rule,
  // returns the raw padding-top declaration. The buggy rule returns
  // `0.5rem`; the fixed rule returns a string containing both `env(`
  // and `safe-area-inset-top`.
  const declaredPaddingTop = await page.evaluate(() => {
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules;
      } catch {
        // Cross-origin sheet — skip.
        continue;
      }
      for (const rule of Array.from(rules)) {
        if (!(rule instanceof CSSStyleRule)) continue;
        if (rule.selectorText !== ".shell-empty-toolbar") continue;
        // The shorthand `padding` is what's authored; CSSOM keeps it
        // intact (does NOT expand to longhand) when the value
        // contains a CSS function. Return the shorthand.
        const padding = rule.style.getPropertyValue("padding").trim();
        const paddingTopLonghand = rule.style.getPropertyValue("padding-top").trim();
        return padding.length > 0 ? padding : paddingTopLonghand;
      }
    }
    return null;
  });

  expect(declaredPaddingTop).not.toBeNull();
  expect(declaredPaddingTop).toContain("env(");
  expect(declaredPaddingTop).toContain("safe-area-inset-top");

  // Computed smoke — the rule compiled and the floor applies.
  const computedPaddingTopPx = await emptyToolbar.evaluate(
    (el) => parseFloat(window.getComputedStyle(el).paddingTop),
  );
  expect(computedPaddingTopPx).toBeGreaterThanOrEqual(8);
});
