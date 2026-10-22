// #1115 — right-clicking a message row on DESKTOP opens the message menu
// (Copy / Reply / Select…) at the cursor, and the browser's own menu does not
// appear. #1067 shipped that menu with exactly one opener, a touch long-press,
// so a mouse user reached none of it.
//
// Harness + limits:
//   * chromium, DESKTOP viewport and NO `hasTouch` — the point of the spec is
//     the modality #1067 left out, and a touch-capable context would let a
//     green here be earned by the wrong door.
//   * The click is a REAL right button press (`click({ button: "right" })`),
//     so the `contextmenu` event is the browser's own, not a synthesized one.
//     That is what makes the suppression arm meaningful: `defaultPrevented`
//     is read off the event the engine actually dispatched.
//   * Whether the OS-drawn native menu is truly absent is not observable from
//     Playwright. `defaultPrevented` is the contract the engine honours, and
//     it is the strongest oracle available in-page; the drawn menu is a
//     dogfood call.
//   * Touch long-press is NOT re-tested here — it is unchanged code with its
//     own live guard in issue1067-swipe-reply-message-menu.spec.ts, and a
//     second copy would drift.
import type { Locator, Page } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.use({ viewport: { width: 1280, height: 800 }, hasTouch: false });
test.setTimeout(90_000);

const CHANNEL = AUTOJOIN_CHANNELS[0];

// A body unique per run: the e2e sqlite scrollback persists across KEEP_STACK=1
// re-runs, and a static string would match two rows on the second run and trip
// Playwright strict mode.
function uniqueBody(tag: string): string {
  return `issue1115 ${tag} ${Date.now()}`;
}

const menu = (page: Page) => page.locator(".context-menu");
// Whole label, not a substring: issue 2430 put "Encrypted query" on the nick
// menu, so `hasText: "Query"` resolved two rows (same idiom as issue 2346's).
const menuItem = (page: Page, label: string) =>
  page.locator(".context-menu .context-menu-item", { hasText: new RegExp(`^${label}$`) });
const rowWith = (page: Page, body: string) =>
  page.locator('[data-testid="scrollback-line"]', { hasText: body });

async function postMessage(page: Page, body: string): Promise<void> {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await composeSend(page, body);
  await expect(rowWith(page, body)).toBeVisible({ timeout: 5_000 });
}

// Right-click at `frac` across the row's OWN measured width. Measured rather
// than a pixel constant because the pane's width depends on the sidebar and
// members rail; a hardcoded x could land on the nick span (which owns its own
// right-click) and turn a real regression into a green.
async function rightClickRow(page: Page, row: Locator, frac: number): Promise<void> {
  const box = await row.boundingBox();
  if (box === null) throw new Error("message row has no box");
  await page.mouse.click(box.x + box.width * frac, box.y + box.height / 2, { button: "right" });
}

// Arm a WINDOW-level bubble listener: it is the last hop of the bubble path,
// so it observes `defaultPrevented` AFTER both the scrollback container
// listener (#1115) and Solid's document-level delegated handlers (the nick
// menu) have had their say. A capture-phase listener would run first and
// always read `false`, proving nothing.
async function watchContextMenu(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ctxPrevented: boolean | null };
    w.__ctxPrevented = null;
    window.addEventListener("contextmenu", (e) => {
      w.__ctxPrevented = e.defaultPrevented;
    });
  });
}

async function nativeMenuSuppressed(page: Page): Promise<boolean | null> {
  return await page.evaluate(
    () => (window as unknown as { __ctxPrevented: boolean | null }).__ctxPrevented,
  );
}

test("issue1115 — right-clicking a message row opens the message menu and suppresses the browser's", async ({
  page,
}) => {
  const body = uniqueBody("open");
  await postMessage(page, body);

  // Assert the pre-state: an already-open menu would make the outcome below
  // true for the wrong reason.
  await expect(menu(page)).toHaveCount(0);
  await watchContextMenu(page);

  await rightClickRow(page, rowWith(page, body), 0.5);

  await expect(menu(page)).toBeVisible();
  await expect(menuItem(page, "Copy")).toBeVisible();
  await expect(menuItem(page, "Reply")).toBeVisible();
  await expect(menuItem(page, "Select…")).toBeVisible();
  // The nick menu is NOT what opened: its verbs are absent.
  await expect(menuItem(page, "WHOIS")).toHaveCount(0);

  expect(await nativeMenuSuppressed(page)).toBe(true);
});

// "At the cursor" without pinning a pixel constant: the same row, two
// different press points, two different menu origins. A menu parked at a
// fixed corner passes neither half.
test("issue1115 — the menu opens where the cursor is, not at a fixed spot", async ({ page }) => {
  const body = uniqueBody("position");
  await postMessage(page, body);
  const row = rowWith(page, body);

  await rightClickRow(page, row, 0.5);
  await expect(menu(page)).toBeVisible();
  const near = await menu(page).boundingBox();

  await page.locator(".context-menu-backdrop").click();
  await expect(menu(page)).toHaveCount(0);

  await rightClickRow(page, row, 0.75);
  await expect(menu(page)).toBeVisible();
  const far = await menu(page).boundingBox();

  if (near === null || far === null) throw new Error("menu has no box");
  // A quarter of the pane's width apart, and the menu is ~180px wide at a
  // 1280px viewport, so neither press is near the #487 clamp.
  expect(far.x - near.x).toBeGreaterThan(100);
});

// The nick span lives INSIDE the row, so a row-level door would swallow the
// nick's own right-click. Both menus are reachable from the same pixel
// neighbourhood; the nick has to keep winning.
test("issue1115 — right-clicking a nick still opens the nick menu, not the message menu", async ({
  page,
}) => {
  const body = uniqueBody("nick");
  await postMessage(page, body);
  await watchContextMenu(page);

  await rowWith(page, body).locator(".scrollback-sender").click({ button: "right" });

  await expect(menu(page)).toBeVisible();
  // The nick menu's verbs, none of which the message menu has…
  await expect(menuItem(page, "WHOIS")).toBeVisible();
  await expect(menuItem(page, "Query")).toBeVisible();
  // …and none of the message menu's.
  await expect(menuItem(page, "Select…")).toHaveCount(0);

  // The nick's own handler preventDefaults too — #1115 must not have made the
  // event dead before it got there.
  expect(await nativeMenuSuppressed(page)).toBe(true);
});
