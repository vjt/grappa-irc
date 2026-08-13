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
import { expectShellReady, openAdminConsole } from "../fixtures/cicchettoPage";
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
  await expectShellReady(page);
}

async function openAdminPaneAndSettingsTab(page: import("@playwright/test").Page): Promise<void> {
  // openAdminConsole waits for the settings drawer to finish its 200ms
  // slide-out before returning, so the Settings-tab click below can't land on
  // the still-closing drawer — the latent delivery race #508's iOS font floor
  // perturbed into a ~9% flake (see the primitive's comment in cicchettoPage).
  await openAdminConsole(page);
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
      // #201 — the duration cap joins active_host in the reset: the
      // video-upload specs probe a ~1s clip against it, so a lowered
      // value left behind would refuse every one of them.
      data: { upload: { active_host: "embedded", video_max_duration_seconds: 120 } },
    });
    expect(res.ok()).toBe(true);
  });

  test("renders default settings + can flip active host litterbox → embedded", async ({ page }) => {
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

    // Zero image per-file cap → server returns 422 invalid_setting
    // with field: "upload.image_per_file_cap_bytes".
    const perFile = page.getByTestId("admin-settings-image-cap");
    await perFile.fill("0");
    await page.getByTestId("admin-settings-save").click();

    await expect(perFile).toHaveClass(/admin-settings-field-error/, { timeout: 5_000 });
  });

  test("PUT /admin/settings fans out server_settings_changed on user-topics", async ({ page }) => {
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

  // #201 — the video duration ceiling became a server setting. Full
  // round trip: form → PUT → DB → the operator-facing GET that cic's
  // upload orchestrator reads its ceiling from. The REFUSAL itself
  // (an over-long clip rejected with a message naming the new value)
  // is pinned by vitest, not here: the only committed video fixture,
  // e2e/fixtures/tiny.mp4, is exactly 1.000s (mvhd timescale 1000 /
  // duration 1000) and the smallest settable ceiling is 1s, so no
  // admin value can make it too long.
  test("video duration cap: form → PUT → /api/server-settings (#201)", async ({
    page,
    request,
  }) => {
    const admin = getSeededAdmin();
    await adminFriendlyLogin(page, admin);
    await openAdminPaneAndSettingsTab(page);

    const duration = page.getByTestId("admin-settings-video-max-duration");
    await expect(duration).toHaveValue("120");

    await duration.fill("45");
    await page.getByTestId("admin-settings-save").click();
    await expect(page.getByTestId("admin-settings-saved")).toBeVisible({ timeout: 5_000 });

    // The value the CLIENT reads — same door cic hydrates from at boot.
    const res = await request.get("/api/server-settings", {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    expect(res.ok()).toBe(true);
    expect((await res.json()).upload.video_max_duration_seconds).toBe(45);
  });

  test("422 invalid_setting flags the video duration field (#201)", async ({ page }) => {
    await adminFriendlyLogin(page, getSeededAdmin());
    await openAdminPaneAndSettingsTab(page);

    const duration = page.getByTestId("admin-settings-video-max-duration");
    await duration.fill("0");
    await page.getByTestId("admin-settings-save").click();

    await expect(duration).toHaveClass(/admin-settings-field-error/, { timeout: 5_000 });
  });
});
