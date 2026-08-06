// #913 — the rail actions menu must cap itself against the SAFE top edge, not
// the physical one.
//
// Sibling of the #588 guard in issue500-rail-launcher-overflow.spec.ts. #588
// proved the menu stops growing off the top of the screen; it asserts the
// topmost row lands at y >= 0. #913 is the residue: under `viewport-fit=cover`
// y = 0 is the PHYSICAL top of the display, behind the status bar, so a row at
// y = 8 satisfied #588 while sitting under the clock — and the cap being one
// inset too generous, the rows still fit, `overflow-y: auto` never engaged, and
// the occluded row could not be scrolled to.
//
// THE MEASUREMENT PROBLEM. Playwright does not synthesize
// `env(safe-area-inset-*)` on any engine we run: it resolves to 0, so the real
// on-device geometry is NOT observable here and no assertion about a 59px
// notch can be honest. What IS observable is the WIRING — whether the inset
// reaches the cap at all, and at what rate. So this spec measures the SAME menu
// twice, once with the inset at its Playwright value and once with a stubbed
// non-zero one, and asserts the topmost row moved down by exactly that much.
//
// That differential is what makes it non-hollow. Against the pre-fix build the
// cap ignores the variable entirely, so the delta is 0 and this fails. An
// absolute `y >= inset` assertion would NOT fail there — it is already true at
// inset 0, which is precisely how #588 passed while #913 was live.
//
// The stub goes through `--safe-area-inset-top` on `:root`, the indirection the
// fix introduced (JS cannot reliably read `env()` back out of a custom
// property, so the arithmetic lives in CSS). Being a variable is what makes it
// stubbable at all; the felt behaviour on a notched device is still vjt's to
// confirm, and this spec does not claim it.

import { expect, test } from "../fixtures/test";
import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0]; // #bofh — vjt's seeded autojoin channel

// Short enough that the action rows cannot all fit above the bottom-pinned
// launcher, so the menu is pinned to its cap rather than to its content height.
// A tall viewport would let the menu fit, the cap would stop being the binding
// constraint, and the delta below would be 0 on a FIXED build too — the #588
// trap, restated. Mirrors the sibling spec's viewport for the same reason.
const VIEWPORT = { width: 1280, height: 200 };

// A plausible notch: iPhone 17 Pro reports ~59px. The exact number does not
// matter to the assertion (it is a delta), only that it is non-zero and large
// enough to dwarf sub-pixel layout noise.
const STUB_INSET = 59;

// No peers needed: menu overflow is a function of row count vs the space above
// the launcher, independent of the member list (the #588 spec's own note).
test.setTimeout(90_000);

test("#913 — the safe-area inset shrinks the rail menu cap, pushing its top row clear", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  await page.setViewportSize(VIEWPORT);
  await openRailMenu(page);

  const menu = page.locator(".rail-actions-menu");
  await expect(menu).toBeVisible();
  const topRow = menu.locator("[data-testid='mobile-panel-home']");
  await expect(topRow).toBeVisible();

  // Precondition — the menu ACTUALLY overflows, so its box is the cap and not
  // its content. Without this the whole measurement is of the wrong thing.
  const overflowsBefore = await menu.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(overflowsBefore, "rail menu must overflow for the cap to be the binding constraint").toBe(
    true,
  );

  const boxBefore = await topRow.boundingBox();
  expect(boxBefore, "top menu row must have a layout box").not.toBeNull();

  // Stub a non-zero inset. `:root:root` (0,2,0) rather than `:root` (0,1,0) so
  // the override wins on specificity and does not depend on where the bundler
  // injected the stylesheet relative to this tag. The menu is `max-height`-
  // capped in CSS, so this reflows on its own — the JS-measured
  // `--rail-menu-space-above` is unaffected (the launcher has not moved), which
  // is exactly what isolates the inset as the only changed operand.
  await page.addStyleTag({ content: `:root:root { --safe-area-inset-top: ${STUB_INSET}px; }` });

  // The cap shrank, so the menu can only overflow harder — assert it, or a
  // regression that collapses the menu entirely would sail past the delta.
  const overflowsAfter = await menu.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  expect(overflowsAfter, "a smaller cap must still leave the menu scrollable").toBe(true);

  const boxAfter = await topRow.boundingBox();
  expect(boxAfter, "top menu row must still have a layout box").not.toBeNull();

  if (boxBefore && boxAfter) {
    // THE DEFECT: pre-fix the cap ignores the inset, the box does not move, and
    // this delta is 0. Post-fix the top edge descends by exactly one inset.
    // Sub-pixel tolerance only — a partial subtraction is a bug, not a rounding.
    expect(
      boxAfter.y - boxBefore.y,
      "the top row must descend by exactly the safe-area inset",
    ).toBeGreaterThan(STUB_INSET - 1.5);
    expect(
      boxAfter.y - boxBefore.y,
      "the top row must not descend by MORE than the inset (double-counted)",
    ).toBeLessThan(STUB_INSET + 1.5);
  }
});
