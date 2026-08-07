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
// THE DISCRIMINATOR HAS RUN. Its numbers, from webkit-iphone-15 (run
// 31179452487), are what the rest of this header is now written against:
//
//   h=659  scrollTop 0  menuTop 140.25  firstRow 148.25  clientHeight 435 (fits)
//   h=520  scrollTop 0  menuTop 9       firstRow 17      clientHeight 427 / 435
//   h=430  scrollTop 0  menuTop 9       firstRow 17      clientHeight 337 / 435
//   h=360  scrollTop 0  menuTop 9       firstRow 17      clientHeight 267 / 435
//   XXL@360 scrollTop 0 menuTop 9       firstRow 20      clientHeight 252 / 457
//
// `home` was the first row, wholly inside the port, and the hit-test target at
// every one of them. The premise of #988 — that the first row is out of reach —
// did NOT reproduce.
//
// The two readings #988 offers, and what this spec does with them:
//
//   Reading 2 (a stray scroll offset hides `home`) is FALSIFIED BY MEASUREMENT,
//   not by argument: `scrollTop` read 0 on all five passes above, including the
//   three where the menu genuinely overflowed. A fresh `overflow-y: auto`
//   container opens at 0 and nothing in RailActions scrolls it. Still read on
//   every pass, because that is what keeps the falsification live.
//
//   What the first run DID surface was a constant gap between the menu's top
//   and its first row: 8px at every viewport height, 11px at XXL. Not scroll —
//   `scrollTop` was 0 — but the menu's OWN chrome: `padding: 0.5rem` over a
//   `border: 1px`, and `rem` follows `--font-size` (`html, body { font-size:
//   var(--font-size) }`), so 7+1 at the default 14px root and 10+1 at XXL's
//   20px. Both numbers, to the pixel, from one cause. The assertion that
//   tripped on it was comparing a content-box coordinate to a border-box one;
//   it is corrected below, and the chrome is now MEASURED per pass so the
//   attribution is the run's and not this comment's.
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
//   That argument was structure without magnitude when it was written, which
//   is precisely how it could have been wrong. The sweep supplies the missing
//   magnitude: at the three heights where the menu overflows, the first row is
//   already at the top of the port and reachable. The no-op reading is now
//   held up by measurement rather than by reasoning about rectangles.
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
  // The menu's OWN chrome above its content. `getBoundingClientRect().top` is
  // the BORDER box; the first row starts at the CONTENT box. Measured rather
  // than read off the stylesheet, so the attribution is the run's, not the
  // author's.
  borderTopWidth: number;
  paddingTop: number;
  rootFontSize: number;
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
    const menuStyle = getComputedStyle(menu);
    const hit = document.elementFromPoint(
      rowRect.x + rowRect.width / 2,
      rowRect.y + rowRect.height / 2,
    );
    return {
      scrollTop: menu.scrollTop,
      scrollHeight: menu.scrollHeight,
      clientHeight: menu.clientHeight,
      menuTop: menuRect.top,
      borderTopWidth: Number.parseFloat(menuStyle.borderTopWidth),
      paddingTop: Number.parseFloat(menuStyle.paddingTop),
      rootFontSize: Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
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
  // The first row sits at the top of the CONTENT box, and the whole distance
  // from the menu's border-box top down to it is accounted for by the menu's
  // own chrome — nothing else. Written as an equality on the RESIDUAL, which
  // is what makes it a guard rather than a tolerance: any offset that is not
  // border + padding (a stray scroll, a hidden sibling, a margin on row one)
  // shows up here as a non-zero number and fails, whichever direction it goes.
  //
  // The predicate this replaces compared `firstRowTop` against `menuTop`, i.e.
  // a content-box coordinate against a BORDER-box one, and demanded they be
  // within 1px. That is not a weaker or stronger version of the criterion —
  // it is the wrong quantity: it can only hold on a menu with no border and no
  // padding, and `.rail-actions-menu` has always had both (`padding: 0.5rem`,
  // `border: 1px`). It failed at every height for that reason alone and no
  // other, and the numbers say so exactly — see the header.
  const chromeAbove = g.borderTopWidth + g.paddingTop;
  expect(
    Math.abs(g.firstRowTop - (g.menuTop + chromeAbove)),
    `${label} — the first row is ${g.firstRowTop - g.menuTop}px below the menu's top, but the menu's own chrome above it is only ${chromeAbove}px (border ${g.borderTopWidth} + padding ${g.paddingTop}); the remainder is unexplained`,
  ).toBeLessThanOrEqual(0.5);
  // `clientHeight` spans the PADDING box, so the scroll port's bottom edge is
  // measured from below the top border — the same border-vs-content slip as
  // above, here masked by the 1px tolerance rather than caught by it.
  expect(
    g.firstRowBottom,
    `${label} — the first row is not WHOLLY visible inside the scroll port`,
  ).toBeLessThanOrEqual(g.menuTop + g.borderTopWidth + g.clientHeight + 1);

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

// The discriminator has to be READABLE from the run's log, not merely
// computed. Two exits, deliberately:
//
//   * a NODE-side `console.log` (this is after the `page.evaluate` returns —
//     a log inside the browser context would never leave it). Verified
//     against the `list` reporter: stdout from a PASSING test is printed, so
//     the numbers arrive even on the green run, which is the run whose
//     numbers settle whether #988's premise was real at all.
//   * a `testInfo.attach`, because attachments survive into the HTML report
//     and are not interleaved with 200 other lines of suite output.
//
// Both are called ONCE with every reading, from a `finally` — not per
// iteration before its own assertion. Logging inside the loop meant the first
// height to fail swallowed every later height's numbers, which is exactly
// when they are wanted.
async function reportReadings(
  testInfo: import("@playwright/test").TestInfo,
  label: string,
  readings: { height: number; g: MenuGeometry }[],
): Promise<void> {
  if (readings.length === 0) return;
  for (const { height, g } of readings) console.log(`#988 ${label} h=${height} ${JSON.stringify(g)}`);
  await testInfo.attach(`issue988-geometry-${label}`, {
    body: JSON.stringify(readings, null, 2),
    contentType: "application/json",
  });
}

test.setTimeout(120_000);

test("@webkit #988 — the actions menu opens with `home` visible at every viewport height", async ({
  page,
}, testInfo) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // A channel window so the menu carries its widest row set (rooms + denoise
  // are selection-gated) — the tall menu #988 is about.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // MEASURE EVERY HEIGHT FIRST, assert afterwards. The two phases are split on
  // purpose: this spec is a discriminator before it is a guard, and asserting
  // inside the loop meant the first height to fail took the remaining heights'
  // numbers down with it — losing the reading in the only run where it decides
  // anything.
  const readings: { height: number; g: MenuGeometry }[] = [];
  try {
    for (const height of HEIGHTS) {
      await page.setViewportSize({ width: WIDTH, height });
      await openRailMenu(page);
      readings.push({ height, g: await measureMenu(page) });
      await page.keyboard.press("Escape");
      await expect(page.locator(".rail-actions-menu")).toHaveCount(0, { timeout: 5_000 });
    }
  } finally {
    // Whatever was collected before a mid-loop throw still reaches the log.
    await reportReadings(testInfo, "viewport-sweep", readings);
  }

  for (const { height, g } of readings) {
    assertFirstRowVisible(g, `#988 @${height}px`);
    expect(g.firstRowLabel, `#988 @${height}px — \`home\` must be the first row`).toContain("home");
  }

  // Without this the whole sweep could pass on a menu that always fits, which
  // asserts nothing about the case #988 is about. If it ever trips, the menu
  // stopped being able to overflow at 360px and the heights need revisiting —
  // not the assertion.
  expect(
    readings.some(({ g }) => g.scrollHeight > g.clientHeight + 1),
    "#988 — no viewport in the set made the menu overflow; the capped case was never exercised",
  ).toBe(true);
});

test("@webkit #988 — `home` stays visible at XXL text with the viewport at its shortest", async ({
  page,
}, testInfo) => {
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
    // Reported BEFORE the assertion, for the same reason the sweep defers its
    // own: the XXL reading is wanted most on the run where it fails.
    await reportReadings(testInfo, "xxl-360", [{ height: 360, g }]);
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
