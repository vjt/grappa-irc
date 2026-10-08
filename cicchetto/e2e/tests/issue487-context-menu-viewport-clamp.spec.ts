// #487 — the member-list right-click context menu must open FULLY inside the
// viewport. Before the fix, UserContextMenu positioned itself at the raw
// {clientX, clientY} with no clamp/flip, so a right-click near the bottom (or
// the right edge — the members pane is the right rail) pushed the tail of the
// 8-item menu below the fold: kick/ban/whois/query rendered off-screen and
// were unclickable (Sonic's report on #grappa).
//
// jsdom can't measure real layout (getBoundingClientRect → 0s), so the flip
// math is unit-tested in src/lib/menuPosition.test.ts and the VISIBLE
// placement is proven here against a real browser viewport (the honest split:
// feedback_playwright_webkit_not_ios_scroll — core=vitest, WIRING=chromium).
//
// WIRING via a synthetic `contextmenu` MouseEvent: `contextmenu` is in Solid's
// DelegatedEvents set, and MembersPane's onContextMenu reads e.clientX/clientY
// off the event, so arbitrary corner coordinates drive the menu to the exact
// overflow condition regardless of where the nick row physically sits. Runs
// untagged (chromium) — the MouseEvent constructor is reliable there; the
// short-viewport cases stand in for the mobile "keyboard up → --viewport-height
// shrinks" scenario without the mobile drawer's opener complexity.

import type { Page } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Dispatch a synthetic contextmenu at (x,y) on the first member-list nick,
// then wait for the menu to render. Coordinates are arbitrary client px — the
// handler reads them off the event, not off the element box (mirrors the
// synthSwipe pattern for touch gestures).
async function openMenuAt(page: Page, x: number, y: number): Promise<void> {
  await page.evaluate(
    ({ x, y }) => {
      const btn = document.querySelector(".members-pane .member-name");
      if (!(btn instanceof HTMLElement)) throw new Error("no .member-name button in members-pane");
      btn.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y }),
      );
    },
    { x, y },
  );
  await expect(page.locator(".context-menu")).toBeVisible({ timeout: 5_000 });
}

// Read the menu box + last-item box + viewport, once positioning has settled.
async function menuGeometry(page: Page) {
  return await page.evaluate(() => {
    const menu = document.querySelector(".context-menu");
    const items = document.querySelectorAll(".context-menu-item");
    const last = items[items.length - 1];
    if (!(menu instanceof HTMLElement) || !(last instanceof HTMLElement)) {
      throw new Error("context menu not fully rendered");
    }
    const m = menu.getBoundingClientRect();
    const l = last.getBoundingClientRect();
    return {
      top: m.top,
      left: m.left,
      right: m.right,
      bottom: m.bottom,
      width: m.width,
      height: m.height,
      lastItemBottom: l.bottom,
      itemCount: items.length,
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      scrollable: menu.scrollHeight > menu.clientHeight + 1,
    };
  });
}

async function seedChannel(page: Page): Promise<void> {
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  // Own nick is always in NAMES after autojoin → at least one member row.
  await expect(page.locator(".members-pane .member-name").first()).toBeVisible({ timeout: 5_000 });
}

test.describe("#487 context menu viewport clamp", () => {
  test("bottom-right right-click keeps the whole menu inside the desktop viewport", async ({
    page,
  }) => {
    await seedChannel(page);
    const vp = page.viewportSize();
    if (!vp) throw new Error("no viewport size");

    // 4px in from the bottom-right corner — where the members rail lives.
    await openMenuAt(page, vp.width - 4, vp.height - 4);
    const g = await menuGeometry(page);

    // Precondition (anti-hollow-green): at the raw click the menu WOULD have
    // overflowed BOTH edges, so the flip math was genuinely exercised.
    // #1192 added the CTCP group between WHOIS and Query, so the nick menu is
    // nine rows; issue 2346 replaced the one Ban row with Ban nick / Ban host
    // / Kickban (disabled without @, never hidden), so it is eleven. Kept as
    // an exact count, not a `>=`: this number is the precondition that the
    // menu really is tall enough to overflow, and a loosened assertion would
    // stop noticing if the menu ever shrank.
    expect(g.itemCount).toBe(11);
    expect(g.height).toBeGreaterThan(0);
    expect(vp.height - 4 + g.height).toBeGreaterThan(g.innerHeight);
    expect(vp.width - 4 + g.width).toBeGreaterThan(g.innerWidth);

    // The fix: menu fully inside the viewport on BOTH axes.
    expect(g.top).toBeGreaterThanOrEqual(0);
    expect(g.left).toBeGreaterThanOrEqual(0);
    expect(g.bottom).toBeLessThanOrEqual(g.innerHeight);
    expect(g.right).toBeLessThanOrEqual(g.innerWidth);
    // The last item (Query) sits inside the fold → clickable. Still Query after
    // #1192: the CTCP group went in ABOVE it, deliberately, so this proof stays
    // a proof — a drill-down row would swap the list instead of closing, and
    // the click below would assert nothing.
    expect(g.lastItemBottom).toBeLessThanOrEqual(g.innerHeight);

    // Actionability proof: the last item is hit-testable (not covered / off
    // screen) — clicking it fires its action and closes the menu.
    await page.locator(".context-menu-item").last().click();
    await expect(page.locator(".context-menu")).toHaveCount(0, { timeout: 5_000 });
  });

  test.describe("short viewport (keyboard-up analogue)", () => {
    test.use({ viewport: { width: 800, height: 300 } });

    test("near-bottom right-click flips the menu up into view", async ({ page }) => {
      await seedChannel(page);
      const vp = page.viewportSize();
      if (!vp) throw new Error("no viewport size");

      await openMenuAt(page, 400, vp.height - 4);
      const g = await menuGeometry(page);

      // Precondition: raw placement would overflow the bottom.
      expect(vp.height - 4 + g.height).toBeGreaterThan(g.innerHeight);

      expect(g.top).toBeGreaterThanOrEqual(0);
      expect(g.bottom).toBeLessThanOrEqual(g.innerHeight);
      expect(g.lastItemBottom).toBeLessThanOrEqual(g.innerHeight);
    });
  });

  test.describe("menu taller than the viewport (extreme keyboard-up)", () => {
    test.use({ viewport: { width: 800, height: 150 } });

    test("pins to the top and scrolls when the menu can't fit", async ({ page }) => {
      await seedChannel(page);
      const vp = page.viewportSize();
      if (!vp) throw new Error("no viewport size");

      await openMenuAt(page, 400, vp.height - 4);
      const g = await menuGeometry(page);

      // The menu is genuinely taller than this viewport → the max-height +
      // overflow-y:auto fallback engages (menu is scrollable, pinned to top).
      expect(g.scrollable).toBe(true);
      expect(g.top).toBeLessThanOrEqual(1);
      expect(g.bottom).toBeLessThanOrEqual(g.innerHeight);
    });
  });
});
