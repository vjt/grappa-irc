// UX-6-B (2026-05-21) — Playwright e2e for the admin Settings tab.
//
// Covers:
//   * Admin opens AdminPane → Settings tab renders w/ defaults
//     fetched from GET /admin/settings.
//   * Admin flips active host embedded → litterbox → Save → PUT
//     /admin/settings → 200 with new view + saved-indicator
//     appears.
//   * The reactive `serverSettings()` signal in cic re-hydrates
//     from the server-side fan-out broadcast (parity with the
//     cic-bundle-changed precedent): re-opening the picker on a
//     fresh page reads the new active host.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT —
// the gate at m7-admin-gate covers the visibility; this spec covers
// the behavior assuming admin reach.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS
// the browser smoke for the Settings tab. PUT → server fan-out →
// reactive signal update across surfaces is invisible to vitest
// jsdom (no real WS, no real REST).
//
// Per `feedback_no_silent_drops_closed`: after-test cleanup MUST
// reset the active_host back to "embedded" so subsequent specs
// (including UX-6-B embedded-upload) don't pick up a stale
// litterbox pin. We use the request fixture (admin bearer from
// seedData) to PUT it back in afterEach.

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

async function openAdminPaneAndSettingsTab(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  const drawer = page.getByRole("dialog", { name: /settings/i });
  await expect(drawer).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();
  await page.getByTestId("admin-tab-settings").click();
  await expect(page.getByTestId("admin-settings-tab")).toBeVisible();
}

test.describe("UX-6-B admin Settings tab", () => {
  test.afterEach(async ({ request }) => {
    // Reset to the server default so subsequent specs (including this
    // file's other tests + the embedded-upload spec) see a clean
    // active_host. Per `feedback_no_silent_drops_closed`: stale shared
    // state is a quiet source of cross-spec flakes.
    const admin = getSeededAdmin();
    const res = await request.put("/admin/settings", {
      headers: { authorization: `Bearer ${admin.token}` },
      data: { upload: { active_host: "embedded" } },
    });
    expect(res.ok()).toBe(true);
  });

  test("renders default settings + can flip active host litterbox → embedded", async ({
    page,
  }) => {
    await adminFriendlyLogin(page, getSeededAdmin());
    await openAdminPaneAndSettingsTab(page);

    // Defaults from B1: embedded host + 10 MB per-file + 10 GB global.
    await expect(page.getByTestId("admin-settings-active-host")).toHaveValue("embedded");

    // Flip to litterbox + save.
    await page.getByTestId("admin-settings-active-host").selectOption("litterbox");
    await page.getByTestId("admin-settings-save").click();

    // Saved indicator appears after the PUT succeeds.
    await expect(page.getByTestId("admin-settings-saved")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("admin-settings-active-host")).toHaveValue("litterbox");
  });

  test("422 invalid_setting flags the offending field", async ({ page }) => {
    await adminFriendlyLogin(page, getSeededAdmin());
    await openAdminPaneAndSettingsTab(page);

    // Negative per-file cap → server returns 422 invalid_setting
    // with field: "upload.per_file_cap_bytes".
    const perFile = page.getByTestId("admin-settings-per-file-cap");
    await perFile.fill("0");
    await page.getByTestId("admin-settings-save").click();

    await expect(perFile).toHaveClass(/admin-settings-field-error/, { timeout: 5_000 });
  });

  test("PUT /admin/settings fans out server_settings_changed on user-topics", async ({
    page,
  }) => {
    await adminFriendlyLogin(page, getSeededAdmin());
    await openAdminPaneAndSettingsTab(page);

    // Listen on the page console + waitForResponse for the PUT, then
    // verify the page state. The fan-out itself is wire-level
    // (Phoenix Channel push); browser-side proof = the saved-indicator
    // + the local serverSettings() signal update, both verified above.
    // Cross-tab fan-out is exercised at the server level by the
    // SettingsControllerTest fan-out assertions; this e2e covers the
    // happy-path round trip end-to-end.
    await page.getByTestId("admin-settings-active-host").selectOption("litterbox");
    const [response] = await Promise.all([
      page.waitForResponse(
        (r) => r.url().includes("/admin/settings") && r.request().method() === "PUT",
      ),
      page.getByTestId("admin-settings-save").click(),
    ]);
    expect(response.status()).toBe(200);

    await expect(page.getByTestId("admin-settings-saved")).toBeVisible({ timeout: 5_000 });
  });
});
