// Admin-panel bucket 6 — admin Servers CRUD end-to-end.
//
// Three scenarios per orchestrate plan:
//   1. admin adds server to existing network.
//   2. admin edits server (TLS toggle).
//   3. admin deletes server — response shows affected_session_count.
//
// Uses a freshly-created ephemeral network per test (so we don't
// pollute the seeded networks' server lists).

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

test("admin adds a server to a network via the disclosure", async ({ page }) => {
  const admin = getSeededAdmin();
  const slug = `e2esrv-add-${Date.now()}`;
  let networkId: number | null = null;

  try {
    networkId = await createNetwork(admin.token, slug);

    await adminLogin(page, admin);
    await openNetworksTab(page);

    await page.getByTestId(`admin-network-expand-${slug}`).click();
    await expect(page.getByTestId(`admin-network-add-server-form-${slug}`)).toBeVisible();

    await page
      .getByTestId(`admin-network-add-server-host-${slug}`)
      .fill("irc.example.test");
    await page.getByTestId(`admin-network-add-server-port-${slug}`).fill("6697");
    await page.getByTestId(`admin-network-add-server-submit-${slug}`).click();

    // New row lands in the servers table.
    await expect(
      page.getByTestId(`admin-network-servers-table-${slug}`),
    ).toBeVisible({ timeout: 5_000 });
    await expect(
      page.locator(`[data-testid^='admin-network-server-row-${slug}-']`),
    ).toHaveCount(1, { timeout: 5_000 });
  } finally {
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, networkId);
  }
});

test("admin toggles TLS on an existing server", async ({ page }) => {
  const admin = getSeededAdmin();
  const slug = `e2esrv-tls-${Date.now()}`;
  let networkId: number | null = null;

  try {
    networkId = await createNetwork(admin.token, slug);

    // Pre-seed a server via REST.
    const sRes = await fetch(`${GRAPPA_BASE_URL}/admin/networks/${networkId}/servers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ host: "tls.example.test", port: 6697, tls: true }),
    });
    expect(sRes.ok).toBe(true);
    const sBody = (await sRes.json()) as { id: number };
    const serverId = sBody.id;

    await adminLogin(page, admin);
    await openNetworksTab(page);
    await page.getByTestId(`admin-network-expand-${slug}`).click();

    const tlsBtn = page.getByTestId(`admin-network-server-toggle-tls-${slug}-${serverId}`);
    await expect(tlsBtn).toHaveText(/disable tls/i);
    await tlsBtn.click();

    // After refresh, button text flips to "Enable TLS".
    await expect(tlsBtn).toHaveText(/enable tls/i, { timeout: 5_000 });
  } finally {
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, networkId);
  }
});

test("admin deletes a server via inline-confirm", async ({ page }) => {
  const admin = getSeededAdmin();
  const slug = `e2esrv-del-${Date.now()}`;
  let networkId: number | null = null;

  try {
    networkId = await createNetwork(admin.token, slug);

    const sRes = await fetch(`${GRAPPA_BASE_URL}/admin/networks/${networkId}/servers`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ host: "del.example.test", port: 6697 }),
    });
    expect(sRes.ok).toBe(true);
    const sBody = (await sRes.json()) as { id: number };
    const serverId = sBody.id;

    await adminLogin(page, admin);
    await openNetworksTab(page);
    await page.getByTestId(`admin-network-expand-${slug}`).click();

    const delBtn = page.getByTestId(`admin-network-server-delete-${slug}-${serverId}`);
    await expect(delBtn).toHaveText(/^Delete$/);
    await delBtn.click();
    await expect(delBtn).toHaveText(/^Confirm delete\?$/);
    await delBtn.click();

    // Row gone.
    await expect(
      page.locator(`[data-testid='admin-network-server-row-${slug}-${serverId}']`),
    ).toHaveCount(0, { timeout: 5_000 });
    // Servers list reflects empty.
    await expect(page.getByTestId(`admin-network-servers-empty-${slug}`)).toBeVisible();
  } finally {
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, networkId);
  }
});
