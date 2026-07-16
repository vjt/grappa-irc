// #252 — vhost (source address) self-service V2 end-to-end. Supersedes
// the #228/#251 `vhost-editor.spec.ts`: the interim native `<select
// multiple>` is replaced by a dedicated, mobile-friendly SUB-PAGE
// (customize toggle + tap-select sections, NAME-primary labels).
//
// Asserts the VISIBLE outcome across both surfaces the feature touches:
//   1. admin opens the Vhosts tab and creates an in-pool,
//      generally-available vhost from a host candidate (UI writes persist).
//      The grant form has NO pin control (#251 — a grant is
//      availability-only; the admin hard-pin was removed).
//   2. a normal user opens Settings → taps the "source address (vhost)"
//      row → lands on the sub-page → sees the vhost rendered by its NAME
//      (the /128 rides along) → turns "customize" ON → taps the vhost →
//      the selection PUTs + persists → turns "customize" OFF → the
//      selection resets to [] (random-from-pool). Persistence is verified
//      via the /me/settings/vhost REST read — the same door the widget uses.
//
// NAME rendering: in CI the reverse-DNS name falls back to the raw IP
// (real DNS is unavailable in the test container), so this spec asserts
// the option shows the address in its NAME-primary structure. The
// distinguishable name≠IP proof lives in the server controller test +
// VhostSettingsPage vitest (both drive a deterministic offline resolver).
//
// Per feedback_cicchetto_browser_smoke + feedback_ux_e2e_mandatory this
// exercises the real CSS/DOM render path jsdom can't.

import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { getSeededAdmin, getSeededVjt } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

type Seed = ReturnType<typeof getSeededAdmin>;

async function loginAs(page: import("@playwright/test").Page, seed: Seed): Promise<void> {
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

async function openVhostsTab(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();
  await page.getByTestId("admin-tab-vhosts").click();
  await expect(page.getByTestId("admin-vhosts-create-form")).toBeVisible({ timeout: 10_000 });
}

// The host_candidates come from :inet.getifaddrs/0 on the grappa-test
// container — 127.0.0.1 is filtered (loopback), but the container's
// eth0 address is present. Read the candidate list from the REST index
// so the test picks a real one rather than hard-coding an env-specific IP.
async function firstHostCandidate(token: string): Promise<string> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/vhosts`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /admin/vhosts → ${res.status}`);
  const body = (await res.json()) as { host_candidates: string[] };
  if (body.host_candidates.length === 0) {
    throw new Error("no host_candidates — getifaddrs returned no egressable address");
  }
  return body.host_candidates[0];
}

async function vhostSelectionFor(token: string): Promise<{ selection: string[] }> {
  const res = await fetch(`${GRAPPA_BASE_URL}/me/settings/vhost`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`GET /me/settings/vhost → ${res.status}`);
  return (await res.json()) as { selection: string[] };
}

async function deleteVhostBestEffort(token: string, id: number): Promise<void> {
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/vhosts/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort cleanup
  }
}

test("#252 admin curates a vhost; a user customizes it via the sub-page and it persists", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const user = getSeededVjt();
  const candidate = await firstHostCandidate(admin.token);
  let vhostId: number | null = null;

  try {
    // --- Admin creates an in-pool, generally-available vhost via the UI ---
    await loginAs(page, admin);
    await openVhostsTab(page);

    await page.getByTestId("vhost-address-select").selectOption(candidate);
    // #256 — check generally_available BEFORE in_pool: ticking in_pool
    // auto-sets + disables the generally_available control (an in-pool vhost
    // is generally available by rule), so it can't be checked afterwards.
    // Setting it first keeps the stored (in_pool=1, generally_available=1).
    await page.getByTestId("vhost-create-generally-available").check();
    await page.getByTestId("vhost-create-in-pool").check();
    await page.getByTestId("vhost-create-submit").click();

    // Row appears with the created address.
    const row = page.locator('[data-testid^="admin-vhost-row-"]', { hasText: candidate });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // #251 — the grant form has NO pin control (a grant is availability-only).
    await expect(page.locator('[data-testid^="admin-vhost-grant-pinned-"]')).toHaveCount(0);

    // Grab the id from the REST index for cleanup.
    const idxRes = await fetch(`${GRAPPA_BASE_URL}/admin/vhosts`, {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const idxBody = (await idxRes.json()) as { vhosts: { id: number; address: string }[] };
    vhostId = idxBody.vhosts.find((v) => v.address === candidate)?.id ?? null;
    expect(vhostId).not.toBeNull();

    // --- User opens Settings, navigates into the vhost sub-page ---
    const userPage = await page.context().newPage();
    try {
      await loginAs(userPage, user);
      await userPage.getByLabel(/open settings/i).click();
      await expect(userPage.getByRole("dialog", { name: /settings/i })).toBeVisible();

      // The main page carries the nav ROW; tapping it lands on the sub-page.
      await userPage.getByTestId("vhost-settings-entry").click();
      await expect(userPage.getByTestId("vhost-subpage")).toBeVisible({ timeout: 10_000 });

      // Turn "customize" ON to reveal the tap-select sections.
      await userPage.getByTestId("vhost-customize-toggle").check();

      // The vhost renders in its NAME-primary structure (label populated;
      // the address shown — as the muted /128 when a PTR resolves, or as
      // the label itself on the CI fallback).
      const option = userPage.getByTestId(`vhost-option-${candidate}`);
      await expect(option).toBeVisible();
      await expect(option.locator(".mode-modal-toggle-label")).toBeVisible();
      await expect(option).toContainText(candidate);

      // Tap → selection PUTs + persists (the widget's own REST door).
      await option.click();
      await expect
        .poll(async () => (await vhostSelectionFor(user.token)).selection, { timeout: 10_000 })
        .toContain(candidate);

      // Turn "customize" OFF → selection resets to [] (random-from-pool).
      await userPage.getByTestId("vhost-customize-toggle").uncheck();
      await expect
        .poll(async () => (await vhostSelectionFor(user.token)).selection, { timeout: 10_000 })
        .toEqual([]);
    } finally {
      await userPage.close();
    }
  } finally {
    if (vhostId !== null) await deleteVhostBestEffort(admin.token, vhostId);
  }
});
