// M-cluster M-11 — admin Events tab end-to-end: real-time fan-out of
// admin-relevant events on `grappa:admin:events`. The AdminPane mount
// joins the channel + installs the ingest hook; the Events tab
// renders the (newest-first, cap=200) ring buffer.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT —
// only the admin user class reaches the tab; gate at m7-admin-gate.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS
// the browser smoke for M-11. WS subscription lifecycle + cross-tab
// state flow (action on Networks tab → row appears on Events tab)
// is invisible to vitest jsdom.
//
// Strategy: trigger admin actions on OTHER tabs (Networks → Force
// Reap + cap edit) and assert the corresponding admin-event rows
// land in the Events tab within the expected fan-out window.

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

async function openAdminPane(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  const drawer = page.getByRole("dialog", { name: /settings/i });
  await expect(drawer).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();
}

test("M-11 Events tab renders + receives reaper_swept after Force Reap", async ({ page }) => {
  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminPane(page);

  // Mount triggered the channel join + snapshot push. Switch to
  // Networks tab to trigger Force Reap (which emits admin event
  // `reaper_swept` per CRIT-2 fix — unconditional emit from
  // Operator.reap_visitors/1).
  await page.getByTestId("admin-tab-networks").click();
  await expect(page.getByTestId("admin-networks-table")).toBeVisible({ timeout: 10_000 });

  const reap = page.getByTestId("admin-networks-force-reap");
  await reap.click();
  await expect(reap).toHaveText(/^Confirm reap\?$/);
  await reap.click();
  await expect(page.getByTestId("admin-networks-reap-result")).toBeVisible({ timeout: 5_000 });

  // Hop to Events tab; assert the reaper_swept event row landed.
  // This validates the entire M-11 wire end-to-end: AdminPane mount
  // → channel join → snapshot push → server-side admin event emit
  // → broadcast → cic ingest → AdminEventsTab render.
  await page.getByTestId("admin-tab-events").click();
  await expect(page.getByTestId("admin-events-tab")).toBeVisible();
  await expect(page.getByTestId("admin-event-reaper_swept").first()).toBeVisible({
    timeout: 5_000,
  });
});
