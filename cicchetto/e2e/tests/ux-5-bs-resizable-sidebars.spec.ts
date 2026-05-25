// UX-5 bucket BS — desktop resizable sidebars.
//
// Pre-bucket: `.shell` grid template literal `16rem 1fr 14rem`. Operator
// on a wide screen wants more room for the nick list; operator on a
// narrow desktop wants more scrollback area. No way to adjust.
//
// Post-bucket end state:
//   * Two `.resize-handle` elements mounted inside the left + right
//     <aside>s on the desktop branch. ARIA shape: role="separator",
//     aria-orientation="vertical", aria-label="Resize sidebar" |
//     "Resize members pane", valuenow/min/max wired.
//   * Drag mutates CSS custom property `--sidebar-width` /
//     `--members-width` live, which drives `grid-template-columns` via
//     `var()`. Drag-end persists to localStorage
//     ("cicchetto.sidebarWidth" / "cicchetto.membersWidth").
//   * Min width: 160px. Max width: 50% of viewport.
//   * Mobile branch: handles are NOT mounted (separate JSX branch) AND
//     CSS `@media (max-width: 768px)` display:none's any stray instance.
//
// Per `feedback_cicchetto_browser_smoke` + `feedback_ux_e2e_mandatory`:
// drag/pointer events are real DOM events, jsdom can't render layout —
// real chromium drag is the only way to assert this contract.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: subject-
// shape-agnostic (UI shape contract). Registered vjt suffices.

import { test, expect } from "../fixtures/test";
import { devices } from "@playwright/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.setTimeout(60_000);

async function asideWidth(page: import("@playwright/test").Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (!box) throw new Error(`${selector} has no bounding box`);
  return Math.round(box.width);
}

test("ux-5-bs desktop — drag left handle widens sidebar + persists across reload", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

  // Baseline: default 256px (16rem at 16px base). Handle visible inside
  // .shell-sidebar.
  const handle = page.locator(".shell-sidebar .resize-handle-left");
  await expect(handle).toHaveCount(1);
  await expect(handle).toHaveAttribute("role", "separator");
  await expect(handle).toHaveAttribute("aria-orientation", "vertical");

  const widthBefore = await asideWidth(page, ".shell-sidebar");
  expect(widthBefore).toBeGreaterThan(240);
  expect(widthBefore).toBeLessThan(280);

  // Drag the handle 80px to the right.
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("handle has no bounding box");
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 80, startY, { steps: 10 });
  await page.mouse.up();

  const widthAfter = await asideWidth(page, ".shell-sidebar");
  // Allow 5px slop for handle hit-area centering + sub-pixel rounding.
  expect(Math.abs(widthAfter - (widthBefore + 80))).toBeLessThanOrEqual(5);

  // localStorage persists; reload reads it back synchronously in
  // main.tsx applySidebarWidthsFromStorage BEFORE render — no flash to
  // default and no flash to stored either.
  const stored = await page.evaluate(() => localStorage.getItem("cicchetto.sidebarWidth"));
  expect(Number.parseInt(stored ?? "0", 10)).toBeGreaterThanOrEqual(widthAfter - 5);
  expect(Number.parseInt(stored ?? "0", 10)).toBeLessThanOrEqual(widthAfter + 5);

  await page.reload();
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();
  const widthReloaded = await asideWidth(page, ".shell-sidebar");
  expect(Math.abs(widthReloaded - widthAfter)).toBeLessThanOrEqual(5);
});

test("ux-5-bs desktop — drag right handle widens members pane + persists", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

  // Members pane mounted (joined channel; `.shell` lacks
  // `.shell-no-members` modifier).
  const handle = page.locator(".shell-members .resize-handle-right");
  await expect(handle).toHaveCount(1);

  const widthBefore = await asideWidth(page, ".shell-members");
  expect(widthBefore).toBeGreaterThan(200);
  expect(widthBefore).toBeLessThan(240);

  // Drag handle LEFT by 60px → members pane grows (it's at the right
  // edge of the viewport; left handle = left edge of members).
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("handle has no bounding box");
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX - 60, startY, { steps: 10 });
  await page.mouse.up();

  const widthAfter = await asideWidth(page, ".shell-members");
  expect(Math.abs(widthAfter - (widthBefore + 60))).toBeLessThanOrEqual(5);

  const stored = await page.evaluate(() => localStorage.getItem("cicchetto.membersWidth"));
  expect(Number.parseInt(stored ?? "0", 10)).toBeGreaterThanOrEqual(widthAfter - 5);
});

test("ux-5-bs desktop — drag past min clamps to 160px", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible();

  const handle = page.locator(".shell-sidebar .resize-handle-left");
  const handleBox = await handle.boundingBox();
  if (!handleBox) throw new Error("handle has no bounding box");
  const startX = handleBox.x + handleBox.width / 2;
  const startY = handleBox.y + handleBox.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Drag aggressively left — past the min threshold.
  await page.mouse.move(50, startY, { steps: 10 });
  await page.mouse.up();

  const widthAfter = await asideWidth(page, ".shell-sidebar");
  expect(widthAfter).toBe(160);
  const stored = await page.evaluate(() => localStorage.getItem("cicchetto.sidebarWidth"));
  expect(stored).toBe("160");
});

test("ux-5-bs mobile — drag handles NOT present (mobile branch never mounts them)", async ({
  browser,
}) => {
  // iPhone 15 device profile carries hasTouch: true + viewport 393×852,
  // matching what cicchettoPage selectChannel/loginAs expect on mobile
  // (target.tap() needs hasTouch).
  const ctx = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await ctx.newPage();
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Mobile shell uses BottomBar + .shell-mobile single-column grid; no
  // .shell-sidebar (sidebar replaced by bottom-bar) and members is a
  // fixed-position drawer with no resize concept.
  await expect(page.locator(".resize-handle")).toHaveCount(0);
  await ctx.close();
});
