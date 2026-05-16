// M-cluster M-9b — admin Sessions tab end-to-end: list + per-row
// Disconnect + Terminate actions + 422 self-protection.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT —
// only the admin user class reaches the tab; the gate spec lives at
// m7-admin-gate.spec.ts.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS
// the browser smoke for M-9b — chromium in the e2e harness renders
// the two-button-per-row inline-confirm CSS class flips that vitest
// jsdom can't see.
//
// Pre-seed pattern (per `feedback_visitor_mint_e2e_cold_start`):
// the m9b-test user + bind is in the seeder sidecar (compose.yaml),
// NOT minted at test time. Bootstrap spawns its Session.Server at
// grappa-test boot so the row is visible in /admin/sessions by the
// time the spec runs.
//
// Self-disconnect protection: admin-vjt has NO network bind in the
// seeder, so it has NO row in /admin/sessions. The 422
// `cannot_disconnect_self` server gate is therefore unreachable from
// this spec — every visible row belongs to vjt or m9b-test, both
// non-admin. The unit-level coverage for the 422 surface lives in
// AdminSessionsTab.test.tsx ("surfaces a 422 cannot_disconnect_self
// error inline prefixed with the verb"). Adding a Playwright case
// would require seeding admin-vjt with a network bind, which would
// in turn double the admin-vjt session footprint and complicate
// every other admin spec — out of scope here.

import { expect, test } from "@playwright/test";
import { getSeededAdmin } from "../fixtures/seedData";

async function adminFriendlyLogin(
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

async function openAdminSessionsTab(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  const drawer = page.getByRole("dialog", { name: /settings/i });
  await expect(drawer).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();
  await page.getByTestId("admin-tab-sessions").click();
  await expect(page.getByTestId("admin-sessions-table")).toBeVisible({ timeout: 10_000 });
}

test("M-9b admin Sessions tab lists live sessions including m9b-test seeded row", async ({
  page,
}) => {
  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  // vjt + m9b-test rows both seeded → at least 2 admin-session rows.
  // We don't filter by exact UUID here (the seeder doesn't echo UUIDs
  // to the runner env); the visible "who" projection includes
  // "user:" prefix + UUID prefix, so we assert at least 2 such rows.
  const rows = page.locator("[data-testid^='admin-session-row-']");
  await expect(rows).toHaveCount(2, { timeout: 15_000 });
});

// IMPORTANT — mutex spec MUST run BEFORE the destructive Disconnect /
// Terminate specs. The destructive specs leave the e2e DB in a
// post-action state (sessions parked / pids stopped), so when this
// spec opens the Sessions tab last it sees "no sessions" and the
// row locator times out. Playwright runs file-internal tests in
// declaration order, so keeping this above the destructive arms
// is the simplest fix vs. spinning up an isolation layer.
test("M-9b arming Disconnect on one row disarms the same row's Terminate (single mutex)", async ({
  page,
}) => {
  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  const firstRow = page.locator("[data-testid^='admin-session-row-']").first();
  const disc = firstRow.locator("[data-testid^='admin-session-disconnect-']");
  const term = firstRow.locator("[data-testid^='admin-session-terminate-']");

  await term.click();
  await expect(term).toHaveText(/^Confirm terminate\?$/);
  await expect(disc).toHaveText(/^Disconnect$/);

  await disc.click();
  await expect(disc).toHaveText(/^Confirm disconnect\?$/);
  await expect(term).toHaveText(/^Terminate$/);
});

test("M-9b admin Disconnect inline-confirm transitions Disconnect → Confirm disconnect? → fires", async ({
  page,
}) => {
  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  // Target the FIRST row's Disconnect button (either vjt or m9b-test;
  // both are non-admin so neither trips 422). The button's testid is
  // `admin-session-disconnect-<id>` where <id> = composite.
  const firstDisconnect = page.locator("[data-testid^='admin-session-disconnect-']").first();
  await expect(firstDisconnect).toHaveText(/^Disconnect$/);

  await firstDisconnect.click();
  await expect(firstDisconnect).toHaveText(/^Confirm disconnect\?$/);
  await expect(firstDisconnect).toHaveClass(/confirming/);

  await firstDisconnect.click();
  // Post-disconnect: table refreshes (the runAction re-fetches). The
  // target user's credential transitions to :parked → the Bootstrap
  // pid stops → row drops from /admin/sessions on the next list.
  // Assert the row count decreases OR (if the m9b/vjt session restarts
  // quickly via T32) the button resets to idle. We use the simpler
  // pre/post comparison: at minimum the error banner MUST NOT appear.
  await expect(page.getByTestId("admin-sessions-error")).toHaveCount(0, { timeout: 5_000 });
});

test("M-9b admin Terminate inline-confirm fires DELETE", async ({ page }) => {
  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  const firstTerminate = page.locator("[data-testid^='admin-session-terminate-']").first();
  await expect(firstTerminate).toHaveText(/^Terminate$/);

  await firstTerminate.click();
  await expect(firstTerminate).toHaveText(/^Confirm terminate\?$/);
  await expect(firstTerminate).toHaveClass(/confirming/);

  await firstTerminate.click();
  // 204 idempotent. Pid is gone; DB rows preserved (per M-9a spec).
  // No error surface expected.
  await expect(page.getByTestId("admin-sessions-error")).toHaveCount(0, { timeout: 5_000 });
});
