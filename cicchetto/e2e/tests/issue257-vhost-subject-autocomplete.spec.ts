// #257 — AdminVhostsTab grant form: the raw subject_type-select +
// subject_id text input is replaced by ONE autocomplete over BOTH subject
// kinds (users + visitors). The operator types a nick, sees type-tagged
// "network - nickname" results, picks one, and the grant is stored against
// the subject's STABLE id (visitor id — NOT the nick; a visitor is
// multi-network so the nick is not a stable key, #257).
//
// This is a DESKTOP admin surface → chromium project. vjt is a permanent
// admin in the seed. Per `feedback_e2e_user_class_parity_matrix`:
// admin-gated is EXEMPT from the three-class parity matrix.
//
// The RED before #257 was structural: the `subject-autocomplete-input-*`
// testid did not exist (the old form had a `admin-vhost-grant-subject-id-*`
// text input). The behavioural assertion below — a VISITOR picked from the
// autocomplete lands a grant whose subject_id is the visitor UUID, not the
// typed nick — is the value proof.

import { expect, test } from "../fixtures/test";
import { adminDeleteVisitor, GRAPPA_BASE_URL, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

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

test("#257 — picking a visitor from the grant autocomplete stores its stable id, not the nick", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const address = `2001:db8:257::${(Date.now() % 0xffff).toString(16)}`;
  // The `zz` marker is non-hex on purpose: the grants table renders the
  // visitor UUID (hex + dashes), so `not.toContainText(nick)` below is a
  // collision-free proof that the STABLE id, not the nick, was stored.
  const nick = `ac257zz${(Date.now() % 0xffff).toString(16)}`;

  let vhostId: number | null = null;
  let visitorId: string | null = null;

  try {
    // A real visitor identity with a per-network credential (nick on
    // bahamut-test) — the autocomplete's visitor leg searches the
    // credential nick and returns the STABLE visitor id.
    const visitor = await mintVisitor(nick);
    visitorId = visitor.id;
    // The stable key must be a UUID surrogate, never the typed nick.
    expect(visitor.id).not.toBe(visitor.nick);

    vhostId = await createVhost(admin.token, address);

    await adminLogin(page, admin);
    await openVhostsTab(page);

    // The grant form for THIS vhost carries the new autocomplete (the old
    // raw subject_id text input is gone).
    const input = page.getByTestId(`subject-autocomplete-input-${vhostId}`);
    await expect(input).toBeVisible();

    // Type the visitor's nick → debounced search → type-tagged result row
    // displaying "network - nickname".
    await input.fill(visitor.nick);

    const option = page.getByTestId(
      `subject-autocomplete-option-${vhostId}-visitor-${visitor.id}`,
    );
    await expect(option).toBeVisible({ timeout: 10_000 });
    await expect(option).toContainText(`${visitor.network_slug} - ${visitor.nick}`);

    // Pick it → the chip shows the selection; the input is replaced.
    await option.click();
    await expect(page.getByTestId(`subject-autocomplete-selected-${vhostId}`)).toContainText(
      `${visitor.network_slug} - ${visitor.nick}`,
    );

    // Submit the grant.
    await page.getByTestId(`admin-vhost-grant-submit-${vhostId}`).click();

    // The persisted grant row shows the visitor's STABLE id (UUID), never
    // the typed nick — the whole point of #257.
    const grantsTable = page.getByTestId(`admin-vhost-grants-table-${vhostId}`);
    await expect(grantsTable).toBeVisible({ timeout: 10_000 });
    await expect(grantsTable).toContainText("visitor");
    await expect(grantsTable).toContainText(visitor.id);
    await expect(grantsTable).not.toContainText(visitor.nick);
  } finally {
    if (vhostId !== null) await deleteVhostBestEffort(admin.token, vhostId);
    if (visitorId !== null) await adminDeleteVisitor(admin.token, visitorId);
  }
});
