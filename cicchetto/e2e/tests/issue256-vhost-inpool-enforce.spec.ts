// #256 — AdminVhostsTab: in_pool ON auto-sets + disables generally_available.
//
// Business rule: a vhost that is in_pool is, by definition, available to
// every subject — the server ORs the two flags at the availability read
// boundary (Grappa.Vhosts.allowed_vhosts/1: generally_available OR in_pool
// OR granted). The admin UI mirrors that invariant: ticking in_pool shows
// generally_available checked + disabled (you can't set an in-pool vhost as
// not-generally-available); un-ticking re-enables it.
//
// This is a DESKTOP admin surface → chromium project (the admin pane is
// not a mobile/@webkit surface). vjt is a permanent admin in the seed.
//
// Availability = OR (in_pool ⟹ available) is EXISTING, unchanged server
// behaviour — already unit-tested at test/grappa/vhosts_test.exs
// ("includes in_pool vhosts so a no-grant subject can self-select the
// pool"). #256 is a cic-only change, so the RED→GREEN leg here is the UI
// enforce-forward (tick → checked + disabled), not the read-side OR.

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

async function openVhostsTab(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();
  await page.getByTestId("admin-tab-vhosts").click();
  await expect(page.getByTestId("admin-vhosts-table")).toBeVisible({ timeout: 10_000 });
}

async function createVhost(token: string, address: string): Promise<number> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/vhosts`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ address, in_pool: false, generally_available: false }),
  });
  if (!res.ok) throw new Error(`createVhost: ${address} → ${res.status}`);
  const body = (await res.json()) as { id: number };
  return body.id;
}

async function deleteVhostBestEffort(token: string, id: number): Promise<void> {
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/vhosts/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
  } catch {
    // best-effort teardown
  }
}

test("#256 — ticking in_pool checks + disables generally_available; un-ticking re-enables it", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  // Unique IPv6 literal so parallel/repeat runs never collide on the
  // (address) unique constraint.
  const address = `2001:db8:256::${(Date.now() % 0xffff).toString(16)}`;
  let vhostId: number | null = null;

  try {
    vhostId = await createVhost(admin.token, address);

    await adminLogin(page, admin);
    await openVhostsTab(page);

    const row = page.getByTestId(`admin-vhost-row-${vhostId}`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    const inPool = page.getByTestId(`vhost-in-pool-toggle-${vhostId}`);
    const general = page.getByTestId(`vhost-generally-available-toggle-${vhostId}`);

    // Seeded not-in_pool + not-generally-available: the general control is
    // independently editable and unchecked.
    await expect(inPool).not.toBeChecked();
    await expect(general).not.toBeChecked();
    await expect(general).toBeEnabled();

    // Tick in_pool → PATCH + refresh → general shows checked + disabled
    // (in_pool ⟹ generally available). Pre-fix (no derive) it stays
    // unchecked + enabled → these assertions fail (RED).
    await inPool.check();
    await expect(inPool).toBeChecked({ timeout: 5_000 });
    await expect(general).toBeChecked({ timeout: 5_000 });
    await expect(general).toBeDisabled();

    // Un-tick in_pool → general re-enables and reveals the stored flag
    // (false → unchecked), independently editable again.
    await inPool.uncheck();
    await expect(inPool).not.toBeChecked({ timeout: 5_000 });
    await expect(general).toBeEnabled({ timeout: 5_000 });
    await expect(general).not.toBeChecked();
  } finally {
    if (vhostId !== null) await deleteVhostBestEffort(admin.token, vhostId);
  }
});
