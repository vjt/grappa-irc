// iOS-4 — Font-size selector in SettingsDrawer.
//
// The SettingsDrawer gained a fieldset with 5 radios (S/M/L/XL/XXL =
// 12/14/16/18/20 px). Selecting a size writes `--font-size` on
// `<html>` and persists the key to localStorage. Boot in main.tsx
// re-applies the stored key BEFORE render so the first frame is at
// the right size.
//
// Subject-agnostic UX: visitor is sufficient. Webkit iPhone 15
// emulation hits the same code path as desktop — the drawer DOM is
// identical across viewports; only TopicBar trigger differs.
//
// Three assertions:
//   1. Default radio is "M" (= current behavior, 14px).
//   2. Picking "XL" mutates `getComputedStyle(html).--font-size`
//      to "18px".
//   3. Reload → "XL" still selected + `--font-size` = "18px"
//      (localStorage persistence + boot-apply roundtrip).

import { expect, test } from "@playwright/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";

test("@webkit iOS-4 — font-size selector persists across reload", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Open the settings drawer via TopicBar ⚙ button.
  await page.getByRole("button", { name: "open settings" }).tap();

  const drawer = page.locator(".settings-drawer.open");
  await expect(drawer).toBeVisible({ timeout: 5_000 });

  // Default radio is "M".
  const mRadio = page.locator('[data-testid="font-size-M"]');
  await expect(mRadio).toBeChecked();

  // Pick "XL".
  const xlRadio = page.locator('[data-testid="font-size-XL"]');
  await xlRadio.tap();
  await expect(xlRadio).toBeChecked();

  // CSS var mutation on <html>.
  const xlSize = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-size").trim(),
  );
  expect(xlSize).toBe("18px");

  // localStorage persistence verified via reload.
  await page.reload();
  await page.getByRole("button", { name: "open settings" }).tap();
  await expect(page.locator(".settings-drawer.open")).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('[data-testid="font-size-XL"]')).toBeChecked();

  const reloadedSize = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--font-size").trim(),
  );
  expect(reloadedSize).toBe("18px");

  // Cleanup — reset to default so subsequent specs don't inherit XL.
  await page.locator('[data-testid="font-size-M"]').tap();
});
