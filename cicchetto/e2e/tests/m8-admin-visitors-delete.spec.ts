// M-cluster M-8 — admin Visitors tab end-to-end: list + inline-
// confirm delete.
//
// Per `feedback_e2e_user_class_parity_matrix`: AdminVisitorsTab is
// admin-gated EXEMPT — only the admin user class reaches the tab.
// M-7's spec (`m7-admin-gate-settings-drawer.spec.ts`) covers reachability for all
// three classes (admin / non-admin / visitor); M-8's spec covers
// only the admin case since the gate is the same.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS
// the browser smoke for M-8 — chromium in the e2e harness renders
// the inline-confirm CSS class flip + the live_state badge layout
// that vitest jsdom can't see.
//
// Pre-UD7 history (no longer current): `mintVisitor()` 504'd because
// the single `login_probe_timeout_ms` 3s budget covered TCP +
// NICK/USER + welcome and exhausted on first-IRC-connection cold-start.
// Post-UD7 (commit a68bc19) the budget splits into connect=3s +
// welcome=30s + outer=35s, so the welcome wait has enough headroom for
// cold-start. This spec re-enables M-8 to verify the post-UD7 budget
// actually holds in the e2e harness.

import { expect, test } from "../fixtures/test";
import { getSeededAdmin } from "../fixtures/seedData";
import { mintVisitor, adminDeleteVisitor } from "../fixtures/grappaApi";

test("M-8 admin Visitors tab lists + deletes a minted visitor (inline confirm two-step)", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitorNick = `m8-victim-${Date.now()}`;

  // Mint a throwaway visitor via REST. Post-UD7 the login welcome
  // budget is 30s; cold-start latency to bahamut-test should complete
  // within that window.
  const visitor = await mintVisitor(visitorNick);

  try {
    // Login as admin in the browser, open the drawer, mount AdminPane,
    // click Visitors tab. Same shape as m-z-admin-cluster-journey.
    await page.addInitScript(
      ([token, subjectJson]) => {
        localStorage.setItem("grappa-token", token);
        localStorage.setItem("grappa-subject", subjectJson);
        localStorage.setItem("cic.installChoice", "browser");
      },
      [admin.token, admin.subjectJson] as const,
    );
    await page.goto("/");
    await page.getByLabel(/open settings/i).click();
    await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
    await page.getByTestId("admin-console-entry").click();
    await expect(page.getByTestId("admin-pane")).toBeVisible();
    await page.getByTestId("admin-tab-visitors").click();
    await expect(page.getByTestId("admin-visitors-table")).toBeVisible({ timeout: 10_000 });

    // The minted visitor row is present.
    const row = page.getByTestId(`admin-visitor-row-${visitor.id}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText(visitorNick);

    // Inline-confirm two-step: click Delete → label flips to
    // "Confirm delete?" → click again → row disappears (splice).
    const deleteBtn = page.getByTestId(`admin-visitor-delete-${visitor.id}`);
    await expect(deleteBtn).toHaveText(/delete/i);
    await deleteBtn.click();
    await expect(deleteBtn).toHaveText(/confirm delete/i);
    await deleteBtn.click();

    // Row gone; no error banner.
    await expect(row).toHaveCount(0);
    await expect(page.getByTestId("admin-visitors-error")).toHaveCount(0);
  } finally {
    // Idempotent — 404 if test already deleted it; safety net for
    // mid-arrange failures (so we don't leak a visitor row across runs).
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
