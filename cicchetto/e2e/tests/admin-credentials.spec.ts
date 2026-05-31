// Admin-panel bucket 6 — admin Credentials CRUD end-to-end.
//
// Three scenarios per orchestrate plan:
//   1. admin binds new credential → row appears.
//   2. admin edits credential (cosmetic field) → :left_alone toast.
//   3. admin unbinds credential → row gone.
//
// Each test creates a unique throwaway user + network pair, binds,
// asserts, and cleans up best-effort. We don't touch the seeded
// vjt/bahamut-test credential (it's load-bearing for other specs).

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

async function openCredentialsTab(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();
  await page.getByTestId("admin-tab-credentials").click();
  await expect(page.getByTestId("admin-credentials-table")).toBeVisible({ timeout: 10_000 });
}

async function createUser(token: string, name: string): Promise<string> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/users`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name, password: "test-password-not-secret" }),
  });
  if (!res.ok) throw new Error(`createUser: ${name} → ${res.status}`);
  const body = (await res.json()) as { id: string };
  return body.id;
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

async function bindCredential(
  token: string,
  userId: string,
  networkId: number,
  nick: string,
): Promise<void> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ user_id: userId, network_id: networkId, nick, auth_method: "none" }),
  });
  if (!res.ok) throw new Error(`bindCredential: ${nick} → ${res.status}`);
}

async function unbindBestEffort(token: string, userId: string, networkId: number): Promise<void> {
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/credentials/${userId}/${networkId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort
  }
}

async function deleteUserBestEffort(token: string, userId: string): Promise<void> {
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/users/${userId}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort
  }
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

test("admin binds a new credential via the bind form — row appears", async ({ page }) => {
  const admin = getSeededAdmin();
  const userName = `e2ecred-bind-u-${Date.now()}`;
  const netSlug = `e2ecred-bind-n-${Date.now()}`;
  let userId: string | null = null;
  let networkId: number | null = null;

  try {
    userId = await createUser(admin.token, userName);
    networkId = await createNetwork(admin.token, netSlug);

    await adminLogin(page, admin);
    await openCredentialsTab(page);

    await page.getByTestId("admin-credentials-bind-user").selectOption(userId);
    await page.getByTestId("admin-credentials-bind-network").selectOption(String(networkId));
    await page.getByTestId("admin-credentials-bind-nick").fill("boundnick");
    await page.getByTestId("admin-credentials-bind-submit").click();

    await expect(
      page.getByTestId(`admin-credential-row-${userId}:${networkId}`),
    ).toBeVisible({ timeout: 10_000 });
  } finally {
    if (userId !== null && networkId !== null) {
      await unbindBestEffort(admin.token, userId, networkId);
    }
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, networkId);
    if (userId !== null) await deleteUserBestEffort(admin.token, userId);
  }
});

test("admin edits a credential (realname change) — left_alone toast", async ({ page }) => {
  const admin = getSeededAdmin();
  const userName = `e2ecred-edit-u-${Date.now()}`;
  const netSlug = `e2ecred-edit-n-${Date.now()}`;
  let userId: string | null = null;
  let networkId: number | null = null;

  try {
    userId = await createUser(admin.token, userName);
    networkId = await createNetwork(admin.token, netSlug);
    await bindCredential(admin.token, userId, networkId, "edittest");

    await adminLogin(page, admin);
    await openCredentialsTab(page);

    const credKey = `${userId}:${networkId}`;
    await page.getByTestId(`admin-credential-edit-${credKey}`).click();
    await expect(page.getByTestId(`admin-credential-edit-form-${credKey}`)).toBeVisible();

    await page
      .getByTestId(`admin-credential-edit-realname-${credKey}`)
      .fill("Updated Real Name");
    await page.getByTestId(`admin-credential-edit-submit-${credKey}`).click();

    // Toast surfaces left_alone (cosmetic change, no session impact).
    await expect(
      page.getByTestId("admin-credentials-session-action-toast"),
    ).toBeVisible({ timeout: 5_000 });
    await expect(page.getByTestId("admin-credentials-session-action-toast")).toContainText(
      /left alone/i,
    );
  } finally {
    if (userId !== null && networkId !== null) {
      await unbindBestEffort(admin.token, userId, networkId);
    }
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, networkId);
    if (userId !== null) await deleteUserBestEffort(admin.token, userId);
  }
});

test("admin unbinds a credential via inline-confirm — row spliced", async ({ page }) => {
  const admin = getSeededAdmin();
  const userName = `e2ecred-unbind-u-${Date.now()}`;
  const netSlug = `e2ecred-unbind-n-${Date.now()}`;
  let userId: string | null = null;
  let networkId: number | null = null;

  try {
    userId = await createUser(admin.token, userName);
    networkId = await createNetwork(admin.token, netSlug);
    await bindCredential(admin.token, userId, networkId, "unbindtest");

    await adminLogin(page, admin);
    await openCredentialsTab(page);

    const credKey = `${userId}:${networkId}`;
    const unbindBtn = page.getByTestId(`admin-credential-unbind-${credKey}`);
    await expect(unbindBtn).toHaveText(/^Unbind$/);
    await unbindBtn.click();
    await expect(unbindBtn).toHaveText(/^Confirm unbind\?$/);
    await unbindBtn.click();

    await expect(page.getByTestId(`admin-credential-row-${credKey}`)).toHaveCount(0, {
      timeout: 5_000,
    });
  } finally {
    if (userId !== null && networkId !== null) {
      await unbindBestEffort(admin.token, userId, networkId);
    }
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, networkId);
    if (userId !== null) await deleteUserBestEffort(admin.token, userId);
  }
});
