// Admin-panel bucket 6 — admin Users tab end-to-end.
//
// Five scenarios per orchestrate plan:
//   1. admin lists users, creates new user, sees ring-buffer event in Events tab.
//   2. admin promotes a user, target's is_admin flips, Events tab shows event.
//   3. admin attempts to demote last admin → 422 last_admin, UI error banner.
//   4. admin rotates a user's password → updated_at flips visibly.
//   5. admin deletes a user → row spliced.
//
// Pattern mirrors m8-admin-visitors-delete + m10-admin-networks-cap-editor:
// pre-seed admin via globalSetup, hydrate localStorage, walk the tab.
//
// Cleanup: tests create unique usernames (timestamp suffix) and
// best-effort delete via REST in finally to avoid leaking rows.

import { expect, test } from "../fixtures/test";
import { getSeededAdmin } from "../fixtures/seedData";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";

async function adminLogin(
  page: import("@playwright/test").Page,
  seed: ReturnType<typeof getSeededAdmin>,
): Promise<void> {
  await page.addInitScript(
    ([token, subjectJson]) => {
      localStorage.setItem("grappa-token", token);
      localStorage.setItem("grappa-subject", subjectJson);
      localStorage.setItem("cic.installChoice", "browser");
    },
    [seed.token, seed.subjectJson] as const,
  );
  await page.goto("/");
  await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });
}

async function openUsersTab(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();
  await page.getByTestId("admin-tab-users").click();
  await expect(page.getByTestId("admin-users-table")).toBeVisible({ timeout: 10_000 });
}

async function deleteUserBestEffort(token: string, id: string): Promise<void> {
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/users/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort cleanup; ignore network errors
  }
}

test("admin lists users, creates a new user, sees the row land", async ({ page }) => {
  const admin = getSeededAdmin();
  const name = `e2e-create-${Date.now()}`;
  let createdId: string | null = null;

  try {
    await adminLogin(page, admin);
    await openUsersTab(page);

    await page.getByTestId("admin-users-create-name").fill(name);
    await page.getByTestId("admin-users-create-password").fill("test-password-not-secret");
    await page.getByTestId("admin-users-create-submit").click();

    // The new user appears in the table on refetch.
    const row = page.locator(`tr[data-testid^='admin-user-row-']`).filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // Extract id from the row data-testid for cleanup.
    const testId = await row.getAttribute("data-testid");
    if (testId !== null && testId.startsWith("admin-user-row-")) {
      createdId = testId.slice("admin-user-row-".length);
    }
  } finally {
    if (createdId !== null) await deleteUserBestEffort(admin.token, createdId);
  }
});

test("admin promotes a created user, badge flips to yes", async ({ page }) => {
  const admin = getSeededAdmin();
  const name = `e2e-promote-${Date.now()}`;
  let createdId: string | null = null;

  try {
    await adminLogin(page, admin);
    await openUsersTab(page);

    await page.getByTestId("admin-users-create-name").fill(name);
    await page.getByTestId("admin-users-create-password").fill("test-password-not-secret");
    await page.getByTestId("admin-users-create-submit").click();

    const row = page.locator(`tr[data-testid^='admin-user-row-']`).filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 10_000 });
    const testId = await row.getAttribute("data-testid");
    createdId = testId !== null ? testId.slice("admin-user-row-".length) : null;

    // Pre-promotion: admin badge says "no".
    await expect(row.locator("td").nth(1)).toContainText(/no/i);

    // Promote.
    await row.getByRole("button", { name: /promote/i }).click();

    // Post-promotion: badge flips to "yes" + button text flips to "Demote".
    await expect(row.locator("td").nth(1)).toContainText(/yes/i, { timeout: 5_000 });
    await expect(row.getByRole("button", { name: /demote/i })).toBeVisible();
  } finally {
    if (createdId !== null) await deleteUserBestEffort(admin.token, createdId);
  }
});

test("admin cannot demote the last admin — UI surfaces last_admin", async ({ page }) => {
  // The seeder makes ADMIN_USER (admin-vjt) the only admin. Demoting
  // self is allowed only when ANOTHER admin exists; with one admin
  // total, the server returns 422 last_admin.
  const admin = getSeededAdmin();

  await adminLogin(page, admin);
  await openUsersTab(page);

  const selfRow = page
    .locator(`tr[data-testid^='admin-user-row-']`)
    .filter({ hasText: "admin-vjt" });
  await expect(selfRow).toBeVisible();
  await expect(selfRow.locator("td").nth(1)).toContainText(/yes/i);

  await selfRow.getByRole("button", { name: /demote/i }).click();

  await expect(page.getByTestId("admin-users-error")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("admin-users-error")).toContainText(/last_admin/);

  // Self-row still admin = yes (rollback at the server).
  await expect(selfRow.locator("td").nth(1)).toContainText(/yes/i);
});

test("admin rotates a created user's password via inline form", async ({ page }) => {
  const admin = getSeededAdmin();
  const name = `e2e-rotate-${Date.now()}`;
  let createdId: string | null = null;

  try {
    await adminLogin(page, admin);
    await openUsersTab(page);

    await page.getByTestId("admin-users-create-name").fill(name);
    await page.getByTestId("admin-users-create-password").fill("test-password-not-secret");
    await page.getByTestId("admin-users-create-submit").click();

    const row = page.locator(`tr[data-testid^='admin-user-row-']`).filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 10_000 });
    const testId = await row.getAttribute("data-testid");
    createdId = testId !== null ? testId.slice("admin-user-row-".length) : null;

    if (createdId === null) throw new Error("could not extract created user id");

    // Open inline rotate form.
    await row.getByRole("button", { name: /rotate password/i }).click();
    const form = page.getByTestId(`admin-user-rotate-form-${createdId}`);
    await expect(form).toBeVisible();

    // Submit new password.
    await page.getByTestId(`admin-user-rotate-input-${createdId}`).fill("brand-new-pw-1234");
    await page.getByTestId(`admin-user-rotate-submit-${createdId}`).click();

    // Form closes after success.
    await expect(form).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId("admin-users-error")).toHaveCount(0);
  } finally {
    if (createdId !== null) await deleteUserBestEffort(admin.token, createdId);
  }
});

test("admin deletes a created user via inline-confirm — row spliced", async ({ page }) => {
  const admin = getSeededAdmin();
  const name = `e2e-delete-${Date.now()}`;

  await adminLogin(page, admin);
  await openUsersTab(page);

  await page.getByTestId("admin-users-create-name").fill(name);
  await page.getByTestId("admin-users-create-password").fill("test-password-not-secret");
  await page.getByTestId("admin-users-create-submit").click();

  const row = page.locator(`tr[data-testid^='admin-user-row-']`).filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 10_000 });
  const testId = await row.getAttribute("data-testid");
  const id = testId !== null ? testId.slice("admin-user-row-".length) : null;
  if (id === null) throw new Error("could not extract created user id");

  const deleteBtn = page.getByTestId(`admin-user-delete-${id}`);
  await expect(deleteBtn).toHaveText(/^Delete$/);
  await deleteBtn.click();
  await expect(deleteBtn).toHaveText(/^Confirm delete\?$/);
  await deleteBtn.click();

  // Row spliced.
  await expect(row).toHaveCount(0, { timeout: 5_000 });
  await expect(page.getByTestId("admin-users-error")).toHaveCount(0);
});
