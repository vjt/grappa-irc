// #228, #251 — vhost (source-bind) editor end-to-end.
//
// Asserts the VISIBLE outcome across both surfaces the feature adds:
//   1. admin opens the Vhosts tab, creates a vhost from a host
//      candidate, and marks it generally-available (UI writes persist).
//      The admin grant form has NO pin control (#251 — a grant is
//      availability-only; the admin hard-pin was removed).
//   2. a normal user opens Settings, sees that vhost in the
//      source-address <select> under the In-pool / Out-of-pool
//      optgroups, selects it, and the selection persists (verified via
//      the /me/settings/vhost REST read — the same door the widget uses).
//
// Per feedback_cicchetto_browser_smoke + feedback_ux_e2e_mandatory this
// exercises the real CSS/DOM render path jsdom can't. Admin writes go
// through the UI (the point of the feature); a couple of REST calls set
// up / verify state without re-driving unrelated UI.

import { expect, test } from "../fixtures/test";
import { getSeededAdmin, getSeededVjt } from "../fixtures/seedData";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";

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

test("admin curates a vhost; a user self-selects it and the binding persists", async ({ page }) => {
  const admin = getSeededAdmin();
  const user = getSeededVjt();
  const candidate = await firstHostCandidate(admin.token);
  let vhostId: number | null = null;

  try {
    // --- Admin creates a generally-available vhost via the UI ---
    await loginAs(page, admin);
    await openVhostsTab(page);

    await page.getByTestId("vhost-address-select").selectOption(candidate);
    await page.getByTestId("vhost-create-generally-available").check();
    await page.getByTestId("vhost-create-submit").click();

    // Row appears with the created address.
    const row = page.locator('[data-testid^="admin-vhost-row-"]', { hasText: candidate });
    await expect(row).toBeVisible({ timeout: 10_000 });

    // #251 — the grant form has NO pin control (a grant is availability-only).
    await expect(page.locator('[data-testid^="admin-vhost-grant-pinned-"]')).toHaveCount(0);

    // Grab the id from the REST index for cleanup + later assertions.
    const idxRes = await fetch(`${GRAPPA_BASE_URL}/admin/vhosts`, {
      headers: { authorization: `Bearer ${admin.token}` },
    });
    const idxBody = (await idxRes.json()) as { vhosts: { id: number; address: string }[] };
    vhostId = idxBody.vhosts.find((v) => v.address === candidate)?.id ?? null;
    expect(vhostId).not.toBeNull();

    // --- User opens Settings, sees + selects the vhost ---
    const userPage = await page.context().newPage();
    try {
      await loginAs(userPage, user);
      await userPage.getByLabel(/open settings/i).click();
      await expect(userPage.getByRole("dialog", { name: /settings/i })).toBeVisible();

      const select = userPage.getByTestId("vhost-select");
      await expect(select).toBeVisible({ timeout: 10_000 });
      // The generally-available vhost is an option in the widget.
      await expect(select.locator(`option[value="${candidate}"]`)).toHaveCount(1);

      await select.selectOption(candidate);

      // The selection persisted server-side (the widget's own door).
      await expect
        .poll(async () => (await vhostSelectionFor(user.token)).selection, { timeout: 10_000 })
        .toContain(candidate);
    } finally {
      await userPage.close();
    }
  } finally {
    if (vhostId !== null) await deleteVhostBestEffort(admin.token, vhostId);
  }
});
