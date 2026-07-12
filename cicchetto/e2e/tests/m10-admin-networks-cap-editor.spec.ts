// M-cluster M-10 — admin Networks tab end-to-end: list + inline
// cap editor + per-row Save + Force Reap + (when applicable) Reset
// Circuit.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT —
// only the admin user class reaches the tab; gate spec at
// m7-admin-gate-settings-drawer.spec.ts.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS
// the browser smoke for M-10 — chromium renders the inline number
// editor's disabled/enabled transitions + the InlineConfirmButton
// CSS class flips that vitest jsdom can't see.
//
// Pre-seed pattern (per `feedback_visitor_mint_e2e_cold_start`):
// the bahamut-test + azzurra network rows are seeded by the
// e2e seeder sidecar (compose.yaml), NOT minted at test time. The
// vjt + admin-vjt + m9b-test user binds + network rows all exist
// by the time the spec runs.

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

async function openAdminNetworksTab(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  const drawer = page.getByRole("dialog", { name: /settings/i });
  await expect(drawer).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();
  await page.getByTestId("admin-tab-networks").click();
  await expect(page.getByTestId("admin-networks-table")).toBeVisible({ timeout: 10_000 });
}

test("M-10 admin Networks tab lists seeded network rows", async ({ page }) => {
  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminNetworksTab(page);

  // bahamut-test (user network) + azzurra (visitor network) both
  // seeded → AT LEAST 2 admin-network rows. #211 phase 6 seeded two
  // MORE visitor_enabled networks (azzurra2 + azzurra3) for the matrix
  // spec, so the count is now >2 — assert the floor + the two canonical
  // rows by testid rather than an exact count (per
  // `feedback_seed_expansion_audit`: a hardcoded seed count is fragile
  // to seed growth; the two named rows are the real intent).
  const rows = page.locator("[data-testid^='admin-network-row-']");
  await expect
    .poll(async () => await rows.count(), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId("admin-network-row-bahamut-test")).toBeVisible();
  await expect(page.getByTestId("admin-network-row-azzurra")).toBeVisible();
});

test("M-10 cap editor: edit + Save round-trips through server", async ({ page }) => {
  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminNetworksTab(page);

  const slug = "bahamut-test";
  // U-1 (`84388a7`) split `max_concurrent_sessions` into visitor + user
  // caps. The rendered testid moved from `admin-network-max-sessions-`
  // to `admin-network-max-visitor-sessions-` (+ a `user` sibling) but
  // this spec wasn't updated, so `inputValue` waited for a non-existent
  // testid until the 30s timeout. Visitor cap mirrors the pre-split
  // single cap (per the U-1 migration: visitor cap inherits the
  // historic value, user cap defaults to 3) — keep this spec on the
  // visitor cap for round-trip parity with the original intent.
  const sessionsInput = page.getByTestId(`admin-network-max-visitor-sessions-${slug}`);
  const save = page.getByTestId(`admin-network-save-${slug}`);

  // Pre-edit: Save disabled (no dirty).
  await expect(save).toBeDisabled();

  // Edit to a new sentinel value. Empty string ("") means the seeder
  // didn't set a cap (NULL = unlimited per U-3 admission contract);
  // bind_network doesn't accept cap params, so bahamut-test starts
  // cap-NULL while azzurra is explicitly cap-100. Round-trip works for
  // both shapes — the revert at the end restores whichever input value
  // was first read, blank or numeric.
  const current = await sessionsInput.inputValue();
  const next = current === "" ? "42" : String(Number.parseInt(current, 10) + 1);
  await sessionsInput.fill(next);
  await expect(save).toBeEnabled();

  await save.click();

  // Post-save: server echoes the new value → input still shows it,
  // Save returns to disabled (no longer dirty vs. server-echoed).
  await expect(sessionsInput).toHaveValue(next);
  await expect(save).toBeDisabled();
  await expect(page.getByTestId("admin-networks-error")).toHaveCount(0);

  // Revert so subsequent runs see the original seeder cap. Server
  // is authoritative — the revert is itself a PATCH round-trip.
  await sessionsInput.fill(current);
  await save.click();
  await expect(sessionsInput).toHaveValue(current);
});

test("M-10 Force Reap inline-confirm fires + renders swept count", async ({ page }) => {
  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminNetworksTab(page);

  const reap = page.getByTestId("admin-networks-force-reap");
  await expect(reap).toHaveText(/^Force Reap$/);
  await reap.click();
  await expect(reap).toHaveText(/^Confirm reap\?$/);
  await expect(reap).toHaveClass(/confirming/);
  await reap.click();

  // 202 envelope: `swept_count` may be 0 (no expired visitors at the
  // moment) — the success line still renders with the count. We
  // assert the line surfaces, not a specific count.
  await expect(page.getByTestId("admin-networks-reap-result")).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByTestId("admin-networks-error")).toHaveCount(0);
});
