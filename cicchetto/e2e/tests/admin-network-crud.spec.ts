// Admin-panel bucket 6 — admin Networks CRUD end-to-end.
//
// Three scenarios per orchestrate plan:
//   1. admin creates new network → appears in tab.
//   2. admin attempts delete network with bound credentials → 409 UI msg.
//   3. admin unbinds all + deletes → succeeds.
//
// The seeded networks (bahamut-test, azzurra) are LOAD-BEARING for
// other specs — never delete those. Tests create unique slugs (timestamp
// suffix) and best-effort delete in finally.

import { expect, test } from "../fixtures/test";
import { getSeededAdmin } from "../fixtures/seedData";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";

function userIdFromSubject(subjectJson: string): string {
  const subj = JSON.parse(subjectJson) as { kind: string; id: string };
  return subj.id;
}

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

async function deleteNetworkBestEffort(token: string, slug: string): Promise<void> {
  try {
    const res = await fetch(`${GRAPPA_BASE_URL}/admin/networks`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) return;
    const body = (await res.json()) as { networks: Array<{ id: number; slug: string }> };
    const net = body.networks.find((n) => n.slug === slug);
    if (net === undefined) return;
    await fetch(`${GRAPPA_BASE_URL}/admin/networks/${net.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort
  }
}

async function bindCredentialBestEffort(
  token: string,
  userId: string,
  networkId: number,
  nick: string,
): Promise<void> {
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        user_id: userId,
        network_id: networkId,
        nick,
        auth_method: "none",
      }),
    });
  } catch {
    // best-effort
  }
}

async function unbindCredentialBestEffort(
  token: string,
  userId: string,
  networkId: number,
): Promise<void> {
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/credentials/${userId}/${networkId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort
  }
}

test("admin creates a new network and sees the row appear", async ({ page }) => {
  const admin = getSeededAdmin();
  const slug = `e2enet-${Date.now()}`;

  try {
    await adminLogin(page, admin);
    await openNetworksTab(page);

    await page.getByTestId("admin-networks-create-slug").fill(slug);
    await page.getByTestId("admin-networks-create-submit").click();

    await expect(page.getByTestId(`admin-network-row-${slug}`)).toBeVisible({ timeout: 10_000 });
  } finally {
    await deleteNetworkBestEffort(admin.token, slug);
  }
});

test("admin delete refuses when bound credentials exist (409)", async ({ page }) => {
  const admin = getSeededAdmin();
  const adminUserId = userIdFromSubject(admin.subjectJson);
  const slug = `e2enet-bound-${Date.now()}`;
  let networkId: number | null = null;

  try {
    // Create the network via REST (faster + reusable than driving the UI).
    const createRes = await fetch(`${GRAPPA_BASE_URL}/admin/networks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ slug }),
    });
    expect(createRes.ok).toBe(true);
    const created = (await createRes.json()) as { id: number };
    networkId = created.id;

    // Bind a credential to it (admin-vjt user).
    await bindCredentialBestEffort(admin.token, adminUserId, networkId, "tmpnick");

    await adminLogin(page, admin);
    await openNetworksTab(page);

    const deleteBtn = page.getByTestId(`admin-network-delete-${slug}`);
    await deleteBtn.click();
    await deleteBtn.click();

    await expect(page.getByTestId("admin-networks-error")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("admin-networks-error")).toContainText(/bound credential/);
    // Row still present (delete refused).
    await expect(page.getByTestId(`admin-network-row-${slug}`)).toBeVisible();
  } finally {
    if (networkId !== null) {
      await unbindCredentialBestEffort(admin.token, adminUserId, networkId);
      await deleteNetworkBestEffort(admin.token, slug);
    }
  }
});

test("admin unbinds then deletes a network — row goes away", async ({ page }) => {
  const admin = getSeededAdmin();
  const slug = `e2enet-clean-${Date.now()}`;
  let networkId: number | null = null;

  try {
    const createRes = await fetch(`${GRAPPA_BASE_URL}/admin/networks`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${admin.token}` },
      body: JSON.stringify({ slug }),
    });
    expect(createRes.ok).toBe(true);
    const created = (await createRes.json()) as { id: number };
    networkId = created.id;

    await adminLogin(page, admin);
    await openNetworksTab(page);

    const deleteBtn = page.getByTestId(`admin-network-delete-${slug}`);
    await deleteBtn.click();
    await deleteBtn.click();

    await expect(page.getByTestId(`admin-network-row-${slug}`)).toHaveCount(0, { timeout: 5_000 });
    await expect(page.getByTestId("admin-networks-error")).toHaveCount(0);
    networkId = null; // already deleted
  } finally {
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, slug);
  }
});
