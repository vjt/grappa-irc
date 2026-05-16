// M-cluster M-8 — admin Visitors tab end-to-end: list + inline-
// confirm delete.
//
// Per `feedback_e2e_user_class_parity_matrix`: AdminVisitorsTab is
// admin-gated EXEMPT — only the admin user class reaches the tab.
// M-7's spec (`m7-admin-gate.spec.ts`) covers reachability for all
// three classes (admin / non-admin / visitor); M-8's spec covers
// only the admin case since the gate is the same.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS
// the browser smoke for M-8 — chromium in the e2e harness renders
// the inline-confirm CSS class flip + the live_state badge layout
// that vitest jsdom can't see.

import { expect, type Page, test } from "@playwright/test";
import { adminDeleteVisitor, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

// admin-vjt has no network bind — the M-7 `.sidebar-network h3`
// shell-ready signal never fires. Wait on the settings cog button
// instead (always rendered in the no-network fallback header).
// Lifted from `m7-admin-gate.spec.ts`; second reuse so the
// extraction earns its keep.
async function adminFriendlyLogin(
  page: Page,
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

test("M-8 admin Visitors tab lists + deletes a minted visitor (inline confirm two-step)", async ({
  page,
}) => {
  // Mint a fresh visitor against grappa-test. Unique nick per run
  // via timestamp suffix avoids the per-network nick uniqueness
  // constraint on test re-runs.
  const visitorNick = `m8-victim-${Date.now()}`;
  const minted = await mintVisitor(visitorNick);
  const admin = getSeededAdmin();

  // afterEach-equivalent: ensure the minted visitor is reaped even
  // on early-assertion failure. Admin-token DELETE is idempotent
  // (404 == success) so a successful in-UI delete during the test
  // makes this a no-op. Avoids accumulating orphan visitor rows
  // across failed runs (Visitors.Reaper only sweeps on expiry).
  let cleanupRequired = true;
  const cleanup = async () => {
    if (!cleanupRequired) return;
    cleanupRequired = false;
    await adminDeleteVisitor(admin.token, minted.id);
  };
  page.on("close", () => void cleanup());

  try {
    await adminFriendlyLogin(page, admin);

    // Open SettingsDrawer → click admin console entry → AdminPane mounts.
    await page.getByLabel(/open settings/i).click();
    await expect(page.getByRole("dialog", { name: /settings/i })).toHaveClass(/open/);
    await page.getByTestId("admin-console-entry").click();
    await expect(page.getByTestId("admin-pane")).toBeVisible();

    // Visitors tab is the default-active tab in M-8.
    const visitorsTab = page.getByTestId("admin-tab-visitors");
    await expect(visitorsTab).toBeVisible();
    await expect(visitorsTab).toHaveAttribute("aria-selected", "true");

    // The list fetch fires onMount. Refresh button visible too.
    await expect(page.getByTestId("admin-visitors-refresh")).toBeVisible();

    // The minted visitor's row appears. The row testid is keyed to the
    // minted UUID so this query won't false-positive against the seeded
    // vjt fixtures or any sibling visitor rows.
    const row = page.getByTestId(`admin-visitor-row-${minted.id}`);
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row).toContainText(visitorNick);

    // Click Delete → button text flips to "Confirm delete?" without
    // firing the DELETE call. Per `feedback_css_block_button_wraps_inline_prefix`:
    // textContent is the load-bearing UX signal — assert directly.
    const deleteBtn = page.getByTestId(`admin-visitor-delete-${minted.id}`);
    await expect(deleteBtn).toHaveText(/^Delete$/);
    await deleteBtn.click();
    await expect(deleteBtn).toHaveText(/Confirm delete\?/);

    // Second click → row disappears within 2s. Splice (not refetch)
    // means sibling rows remain.
    await deleteBtn.click();
    await expect(row).toHaveCount(0, { timeout: 2_000 });

    // CRITICAL non-finding sanity: the M-7 placeholder text is gone
    // (M-8 replaced the placeholder paragraph with the tab nav).
    await expect(page.getByText(/tabs land in M-8/i)).toHaveCount(0);
  } finally {
    await cleanup();
  }
});
