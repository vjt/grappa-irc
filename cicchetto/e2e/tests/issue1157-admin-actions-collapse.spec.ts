// #1157 — the dictated column 4, on a real phone.
//
// vjt, 2026-08-09: the row's disconnect / terminate buttons "on mobile
// collapse into a single button with a dropdown". `AdminSessionsTab`
// branches on `isAdminNarrow()`, which is `matchMedia("(max-width:
// 899px)")` — and jsdom has none, so the unit file
// (`adminSessionsActionsMenu.test.tsx`) has to SUPPLY the regime. It
// proves the branch; it cannot prove which side of it a phone lands on.
// That is this file's whole job, and it is why the phone case is
// `@webkit` (the iPhone 15 device, 393px) rather than a resized desktop.
//
// Both sides run, deliberately. A collapse that also fired on a 1280px
// desktop would satisfy a phone-only file, and "desktop keeps them side
// by side" is half the dictation.
//
// NOTHING here confirms a verb. The two verbs on a user row stop a real
// seeded session, and this suite shares its stack — the m9b actions spec
// carries an `afterEach` repair hook precisely because it does fire them.
// The claim under test is that picking from the menu ARMS a confirmation
// instead of running it, so arming and then cancelling is not a
// half-measure: it is the assertion.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated, EXEMPT.

import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { expectShellReady, openAdminSessionsTab } from "../fixtures/cicchettoPage";
import { getSeededAdmin, getSeededVjt } from "../fixtures/seedData";

async function adminLogin(page: Page): Promise<void> {
  const seed = getSeededAdmin();
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [seed.token, seed.subjectJson] as const,
  );
  await page.goto("/");
  await expectShellReady(page);
}

function idFromSubjectJson(subjectJson: string): string {
  const subject = JSON.parse(subjectJson) as { id?: string };
  if (typeof subject.id !== "string") {
    throw new Error(`seeded subject carries no id: ${subjectJson}`);
  }
  return subject.id;
}

// A USER row, which is the only shape with two verbs to collapse — a
// visitor row carries exactly one (`rowActions`). Addressed by the
// `user:<id>:` prefix rather than a full composite key because the
// network id depends on seeding order.
async function userRowKey(page: Page): Promise<string> {
  const id = idFromSubjectJson(getSeededVjt().subjectJson);
  const row = page.locator(`[data-testid^='admin-session-row-user:${id}:']`).first();
  await expect(row).toBeVisible({ timeout: 15_000 });
  const testId = await row.getAttribute("data-testid");
  if (testId === null) throw new Error("the seeded user row lost its testid");
  return testId.replace("admin-session-row-", "");
}

test("#1157 @webkit a phone gives the row's verbs one control, and it is the menu", async ({
  page,
}) => {
  await adminLogin(page);
  await openAdminSessionsTab(page);
  const key = await userRowKey(page);

  const cell = page.locator(`[data-testid='admin-session-row-${key}'] td.admin-sessions-actions`);
  await cell.scrollIntoViewIfNeeded();

  // Exactly one, painted. A cell that merely ADDED the menu beside the
  // verbs would still show the menu.
  await expect(cell.locator("button")).toHaveCount(1);
  await expect(page.getByTestId(`admin-session-actions-menu-${key}`)).toBeVisible();
  await expect(page.getByTestId(`admin-session-disconnect-${key}`)).toHaveCount(0);
  await expect(page.getByTestId(`admin-session-terminate-${key}`)).toHaveCount(0);
});

test("#1157 @webkit the dropdown arms a verb rather than running it", async ({ page }) => {
  await adminLogin(page);
  await openAdminSessionsTab(page);
  const key = await userRowKey(page);

  await page.getByTestId(`admin-session-actions-menu-${key}`).click();

  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByText("Disconnect")).toBeVisible();
  await expect(menu.getByText("Terminate")).toBeVisible();

  await menu.getByText("Terminate").click();

  // Armed, not fired: the label is the confirmation, and the menu is
  // gone. If the pick had run the verb the row would have reloaded and
  // this locator would be an idle "Terminate" instead.
  await expect(page.getByTestId(`admin-session-terminate-${key}`)).toHaveText("Confirm terminate");
  await expect(menu).toHaveCount(0);
  // Nothing was stopped: the error banner is where a failed or refused
  // verb lands, and a successful one would have refreshed the list.
  await expect(page.getByTestId("admin-sessions-error")).toHaveCount(0);

  // And back out, leaving the session exactly as this spec found it.
  await page.getByTestId(`admin-session-actions-cancel-${key}`).click();
  await expect(page.getByTestId(`admin-session-terminate-${key}`)).toHaveCount(0);
  await expect(page.getByTestId(`admin-session-actions-menu-${key}`)).toBeVisible();
});

test("#1157 a desktop keeps both verbs side by side and grows no menu", async ({ page }) => {
  await adminLogin(page);
  await openAdminSessionsTab(page);
  const key = await userRowKey(page);

  await expect(page.getByTestId(`admin-session-disconnect-${key}`)).toBeVisible();
  await expect(page.getByTestId(`admin-session-terminate-${key}`)).toBeVisible();
  await expect(page.getByTestId(`admin-session-actions-menu-${key}`)).toHaveCount(0);
});
