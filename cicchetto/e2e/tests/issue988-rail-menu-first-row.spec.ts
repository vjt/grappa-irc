// @webkit — #988. The rail actions menu must open with its FIRST row visible,
// without scrolling, at every viewport height and text size.
//
// #988 is a PREDICTION, not an observation: its own body says "A screenshot
// was attempted and did not go through, so the geometry below is read off the
// code, not off a picture", and it hands the implementer a discriminator to
// settle on a device first. `home` getting three new siblings in #986 is what
// prompted it. So this spec is the discriminator BEFORE it is a guard — it
// measures, prints what it measured, and only then asserts.
//
// The two readings #988 offers, and what this spec does with them:
//
//   Reading 2 (a stray scroll offset hides `home`) is falsified here directly:
//   `scrollTop` is read on every pass. A fresh `overflow-y: auto` container
//   opens at 0 and nothing in RailActions scrolls it, so the expectation is 0
//   — printed, not assumed.
//
//   Reading 1 (re-anchor a tall menu to the top) does NOT get a code change in
//   this branch, because the geometry says it cannot produce one. When the
//   content exceeds the cap, `max-height` is `spaceAbove - inset` and the box
//   already runs from `inset + RAIL_MENU_TOP_GAP` down to the launcher — which
//   is exactly the box a top-anchored menu with the same cap would occupy.
//   Bottom-anchored-and-capped and top-anchored are the SAME rectangle in the
//   only case that matters; they differ solely when the menu FITS, and #988
//   explicitly keeps `bottom: 100%` there. A re-anchor would be a no-op
//   wearing the shape of a fix. What is worth having instead is this: the
//   acceptance criterion, pinned, at the heights where the cap bites.
//
// The cap (#588) and the safe-area subtraction (#913) are asserted as
// preconditions rather than left implicit — they are the two things that make
// the criterion hold, and #988 warns that a re-anchor must not lose either.
//
// Keyboard-up is APPROXIMATED by a short viewport. In the emulator
// `visualViewport.height` follows the viewport, which is the input
// `lib/viewportHeight.ts` publishes as `--viewport-height` and the input
// `spaceAbove` measures against — so the arithmetic under test sees the same
// numbers a keyboard would produce. What it does NOT reproduce is iOS keeping
// `env(safe-area-inset-top)` at its device value while the visual viewport
// shrinks: Playwright synthesizes no insets at all, in either project, so
// every `--safe-area-inset-top` here is 0px. The notch half needs a real
// device.
//
// Mobile-only surface, so webkit-iphone-15 alone — the @webkit tag; the
// chromium project grepInverts it.

import {
  closeSettings,
  loginAs,
  openRailMenu,
  openSettingsSection,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const WIDTH = 393;

// iPhone 15 portrait, then three progressively shorter shells. 360 is where
// the cap bites hardest — below the point the menu's content can fit — and it
// is the pass that carries the "did the overflow case even happen?" guard.
const HEIGHTS = [659, 520, 430, 360];

type MenuGeometry = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  menuTop: number;
  firstRowTop: number;
  firstRowBottom: number;
  firstRowLabel: string;
  rows: number;
  spaceAboveVar: string;
  insetVar: string;
  firstRowIsHitTarget: boolean;
};

async function measureMenu(page: import("@playwright/test").Page): Promise<MenuGeometry> {
  return page.evaluate(() => {
    const menu = document.querySelector(".rail-actions-menu");
    if (menu === null) throw new Error("#988 — the rail actions menu is not mounted");
    const rows = menu.querySelectorAll(".rail-action");
    const first = rows[0];
    if (first === undefined) throw new Error("#988 — the menu has no rows");
    const menuRect = menu.getBoundingClientRect();
    const rowRect = first.getBoundingClientRect();
    const hit = document.elementFromPoint(
      rowRect.x + rowRect.width / 2,
      rowRect.y + rowRect.height / 2,
    );
    return {
      scrollTop: menu.scrollTop,
      scrollHeight: menu.scrollHeight,
      clientHeight: menu.clientHeight,
      menuTop: menuRect.top,
      firstRowTop: rowRect.top,
      firstRowBottom: rowRect.bottom,
      firstRowLabel: first.textContent?.trim() ?? "",
      rows: rows.length,
      spaceAboveVar: getComputedStyle(menu).getPropertyValue("--rail-menu-space-above").trim(),
      insetVar: getComputedStyle(menu).getPropertyValue("--safe-area-inset-top").trim(),
      firstRowIsHitTarget: hit === first || first.contains(hit),
    };
  });
}

function assertFirstRowVisible(g: MenuGeometry, label: string): void {
  // Reading 2, settled by measurement rather than by argument.
  expect(g.scrollTop, `${label} — a freshly opened menu must not be scrolled`).toBe(0);

  // The acceptance criterion, in the two ways it can be violated: the row can
  // be scrolled out of the menu's own scroll port, or the whole menu can sit
  // above the top of the screen (the #588 failure — a cap too large means no
  // scrollbar AND rows off-screen).
  expect(
    g.firstRowTop,
    `${label} — the first row starts ${g.firstRowTop}px from the viewport top, i.e. off-screen`,
  ).toBeGreaterThanOrEqual(-0.5);
  expect(
    g.firstRowTop - g.menuTop,
    `${label} — the first row is not at the top of the scroll port`,
  ).toBeLessThanOrEqual(1);
  expect(
    g.firstRowBottom,
    `${label} — the first row is not WHOLLY visible inside the scroll port`,
  ).toBeLessThanOrEqual(g.menuTop + g.clientHeight + 1);

  // Visible is not the same as reachable: `home` must also be the element
  // under the finger, not something painted over it.
  expect(g.firstRowIsHitTarget, `${label} — the first row is covered by another element`).toBe(
    true,
  );

  // #588 — the cap must be the MEASURED space above, not the pre-measure
  // viewport-height fallback. Losing this is what let rows grow off the top
  // with no scrollbar, which is precisely the shape #988 fears a re-anchor
  // would recreate downward.
  expect(g.spaceAboveVar, `${label} — the JS-measured cap was never published`).not.toBe("");
}

test.setTimeout(120_000);

test("@webkit #988 — the actions menu opens with `home` visible at every viewport height", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // A channel window so the menu carries its widest row set (rooms + denoise
  // are selection-gated) — the tall menu #988 is about.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  let sawOverflow = false;
  for (const height of HEIGHTS) {
    await page.setViewportSize({ width: WIDTH, height });
    await openRailMenu(page);
    const g = await measureMenu(page);
    console.log(`#988 h=${height} ${JSON.stringify(g)}`);
    assertFirstRowVisible(g, `#988 @${height}px`);
    expect(g.firstRowLabel, "#988 — `home` must be the first row").toContain("home");
    if (g.scrollHeight > g.clientHeight + 1) sawOverflow = true;
    await page.keyboard.press("Escape");
    await expect(page.locator(".rail-actions-menu")).toHaveCount(0, { timeout: 5_000 });
  }

  // Without this the whole loop could pass on a menu that always fits, which
  // asserts nothing about the case #988 is about. If it ever trips, the menu
  // stopped being able to overflow at 360px and the heights need revisiting —
  // not the assertion.
  expect(
    sawOverflow,
    "#988 — no viewport in the set made the menu overflow; the capped case was never exercised",
  ).toBe(true);
});

test("@webkit #988 — `home` stays visible at XXL text with the viewport at its shortest", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  try {
    // The production path, not a CSS var poke: the operator picks the size in
    // the display sub-page and `lib/fontSize.ts` writes `--font-size`.
    await openSettingsSection(page, "display");
    await page.locator('[data-testid="font-size-XXL"]').tap();
    await expect(page.locator('[data-testid="font-size-XXL"]')).toBeChecked();
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--font-size").trim(),
      ),
    ).toBe("20px");
    // The mutex swapped the members drawer for the settings drawer; close it
    // or its slide-out intercepts the taps `openRailMenu` is about to make.
    await closeSettings(page);

    await page.setViewportSize({ width: WIDTH, height: 360 });
    await openRailMenu(page);
    const g = await measureMenu(page);
    console.log(`#988 XXL h=360 ${JSON.stringify(g)}`);
    assertFirstRowVisible(g, "#988 XXL @360px");
  } finally {
    // Reset, or every later spec in this browser inherits XXL — the
    // cascade-poisoner shape.
    await page.keyboard.press("Escape").catch(() => {});
    await openSettingsSection(page, "display")
      .then(() => page.locator('[data-testid="font-size-M"]').tap())
      .catch(() => {});
  }
});
