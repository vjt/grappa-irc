// #85 — admin Featured Channels CRUD end-to-end.
//
// Mirrors admin-server-crud.spec.ts: the featured-channels disclosure
// is the sibling sub-section under each network's expansion. Public
// delivery (GET /networks/:id/featured -> HomePane) is covered by the
// controller test + HomePane vitest; the admin write path is the
// highest-value end-to-end surface, so we exercise it here against the
// real backend.
//
// Uses a freshly-created ephemeral network per test so we don't pollute
// the seeded networks' featured lists.

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

async function openNetworksTab(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();
  await page.getByTestId("admin-tab-networks").click();
  await expect(page.getByTestId("admin-networks-table")).toBeVisible({ timeout: 10_000 });
}

async function createNetwork(token: string, slug: string): Promise<number> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/networks`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ slug }),
  });
  if (!res.ok) throw new Error(`createNetwork: ${slug} → ${res.status}`);
  const body = (await res.json()) as { id: number };
  return body.id;
}

async function deleteNetworkBestEffort(token: string, networkId: number): Promise<void> {
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/networks/${networkId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort
  }
}

test("admin adds a featured channel to a network via the disclosure", async ({ page }) => {
  const admin = getSeededAdmin();
  const slug = `e2efeat-add-${Date.now()}`;
  let networkId: number | null = null;

  try {
    networkId = await createNetwork(admin.token, slug);

    await adminLogin(page, admin);
    await openNetworksTab(page);

    await page.getByTestId(`admin-network-expand-${slug}`).click();
    await expect(page.getByTestId(`admin-network-add-featured-form-${slug}`)).toBeVisible();

    await page.getByTestId(`admin-network-add-featured-name-${slug}`).fill("#sniffo");
    await page.getByTestId(`admin-network-add-featured-description-${slug}`).fill("il canale");
    await page.getByTestId(`admin-network-add-featured-submit-${slug}`).click();

    await expect(page.getByTestId(`admin-network-featured-table-${slug}`)).toBeVisible({
      timeout: 5_000,
    });
    await expect(
      page.locator(`[data-testid^='admin-network-featured-row-${slug}-']`),
    ).toHaveCount(1, { timeout: 5_000 });
  } finally {
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, networkId);
  }
});

test("admin deletes a featured channel via inline-confirm", async ({ page }) => {
  const admin = getSeededAdmin();
  const slug = `e2efeat-del-${Date.now()}`;
  let networkId: number | null = null;

  try {
    networkId = await createNetwork(admin.token, slug);

    const fRes = await fetch(
      `${GRAPPA_BASE_URL}/admin/networks/${networkId}/featured_channels`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
        body: JSON.stringify({ name: "#delme", description: "bye" }),
      },
    );
    expect(fRes.ok).toBe(true);
    const fBody = (await fRes.json()) as { id: number };
    const featuredId = fBody.id;

    await adminLogin(page, admin);
    await openNetworksTab(page);
    await page.getByTestId(`admin-network-expand-${slug}`).click();

    const delBtn = page.getByTestId(`admin-network-featured-delete-${slug}-${featuredId}`);
    await expect(delBtn).toHaveText(/^Delete$/);
    await delBtn.click();
    await expect(delBtn).toHaveText(/^Confirm delete\?$/);
    await delBtn.click();

    await expect(
      page.locator(`[data-testid='admin-network-featured-row-${slug}-${featuredId}']`),
    ).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId(`admin-network-featured-empty-${slug}`)).toBeVisible();
  } finally {
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, networkId);
  }
});
