// #1158 — a user's network access, end to end, on the per-user page.
//
// Was `admin-credentials.spec.ts`, which drove the Credentials tab: a
// database-wide list of every (user, network) binding fronted by a form whose
// first question was "which user". vjt's ruling retired that surface, so the
// scenarios move to the page that replaced it rather than dying with it.
//
// Four scenarios:
//   1. ONE FLOW — create the account and give it a network without ever
//      leaving the Users tab. This is the acceptance the ruling asks for, and
//      the thing the old surface could not do: creating a user there left the
//      operator to go and find their own new user in a select.
//   2. add a network to an existing user.
//   3. edit a network's cosmetic field → the row reports `left_alone`.
//   4. remove a network behind the inline confirm → the row goes.
//
// Each test builds its own throwaway user and network and cleans both up
// best-effort. The seeded vjt/bahamut-test credential is load-bearing for
// other specs and is never touched.
//
// Names carry a random suffix as well as a timestamp so the file survives
// `--repeat-each`: two repeats can start inside the same millisecond, and a
// slug collision would fail the second one for the wrong reason.

import { expectShellReady, openAdminConsole } from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// A network slug is `^[a-z0-9_-]{1,32}$` (`Identifier.@network_slug_regex`),
// and going over it answers 422 at setup — a failure that reads as a broken
// test rather than as the length rule it is. So the clock is truncated and the
// budget is asserted here, where a future edit trips over it while it is being
// written instead of thirty seconds into a container run.
function unique(prefix: string): string {
  const id = `${prefix}-${Date.now() % 1_000_000}-${Math.random().toString(36).slice(2, 6)}`;
  if (id.length > 32) throw new Error(`unique: "${id}" is ${id.length} chars, slug limit is 32`);
  return id;
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
  await expectShellReady(page);
}

async function openUsersTab(page: import("@playwright/test").Page): Promise<void> {
  await openAdminConsole(page);
  await page.getByTestId("admin-tab-users").click();
  await expect(page.getByTestId("admin-users-table")).toBeVisible({ timeout: 10_000 });
}

/** Drill into one user's page from the list, the way an operator does. */
async function openUserPage(page: import("@playwright/test").Page, userId: string): Promise<void> {
  await openUsersTab(page);
  await page.getByTestId(`admin-user-networks-${userId}`).click();
  await expect(page.getByTestId("admin-user-page")).toBeVisible({ timeout: 10_000 });
}

/**
 * Give the user one network, the #1157 way: tick the section, fill the
 * nick the bind needs, Save. There is no `+` and no network picker —
 * every configured network already has a section, and the tick is the
 * whole statement about access.
 */
async function enableNetwork(
  page: import("@playwright/test").Page,
  networkId: number,
  nick: string,
): Promise<void> {
  await page.getByTestId(`admin-user-network-enabled-${networkId}`).check();
  await expect(page.getByTestId(`admin-user-network-form-${networkId}`)).toBeVisible();
  await page.getByTestId(`admin-user-network-nick-${networkId}`).fill(nick);
  await page.getByTestId(`admin-user-network-save-${networkId}`).click();
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

async function findUserId(token: string, name: string): Promise<string> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/users`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`listUsers → ${res.status}`);
  const body = (await res.json()) as { users: { id: string; name: string }[] };
  const found = body.users.find((u) => u.name === name);
  if (found === undefined) throw new Error(`findUserId: ${name} not in the list`);
  return found.id;
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

test("an operator creates a user and gives it a network in one flow", async ({ page }) => {
  const admin = getSeededAdmin();
  const userName = unique("e2eun-flow-u");
  const netSlug = unique("e2eun-flow-n");
  let userId: string | null = null;
  let networkId: number | null = null;

  try {
    networkId = await createNetwork(admin.token, netSlug);

    await adminLogin(page, admin);
    await openUsersTab(page);

    // The account is created HERE, in the console, not seeded over REST:
    // the flow under test starts at an operator with no user.
    await page.getByTestId("admin-users-create-name").fill(userName);
    await page.getByTestId("admin-users-create-password").fill("test-password-not-secret");
    await page.getByTestId("admin-users-create-submit").click();

    // Landing on the new user's page IS the flow: no tab switch, no hunting
    // for the account in a select.
    await expect(page.getByTestId("admin-user-page")).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId("admin-user-page-name")).toHaveText(userName);

    await enableNetwork(page, networkId, "flownick");

    // The operator-visible outcome: the section for that network is
    // ticked, and it names the network it is about.
    const section = page.getByTestId(`admin-user-network-${networkId}`);
    await expect(section).toContainText(netSlug);
    await expect(page.getByTestId(`admin-user-network-enabled-${networkId}`)).toBeChecked({
      timeout: 10_000,
    });

    // And it survives a reload, so the verdict rests on the server's answer
    // rather than on the reply the form just rendered.
    userId = await findUserId(admin.token, userName);
    await page.reload();
    await openUserPage(page, userId);
    await expect(page.getByTestId(`admin-user-network-enabled-${networkId}`)).toBeChecked({
      timeout: 10_000,
    });
  } finally {
    if (userId === null) {
      try {
        userId = await findUserId(admin.token, userName);
      } catch {
        // the create never landed; nothing to clean up
      }
    }
    if (userId !== null && networkId !== null) {
      await unbindBestEffort(admin.token, userId, networkId);
    }
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, networkId);
    if (userId !== null) await deleteUserBestEffort(admin.token, userId);
  }
});

test("admin gives an existing user a network — the section ticks", async ({ page }) => {
  const admin = getSeededAdmin();
  const userName = unique("e2eun-add-u");
  const netSlug = unique("e2eun-add-n");
  let userId: string | null = null;
  let networkId: number | null = null;

  try {
    userId = await createUser(admin.token, userName);
    networkId = await createNetwork(admin.token, netSlug);

    await adminLogin(page, admin);
    await openUserPage(page, userId);

    // Pre-state: the section EXISTS (it is a configured network) and is
    // NOT ticked, so the tick this test asserts on cannot be a leftover
    // from an earlier run. Asserting the section's ABSENCE would be the
    // pre-#1157 claim, and is now false by construction.
    const tick = page.getByTestId(`admin-user-network-enabled-${networkId}`);
    await expect(tick).toBeVisible({ timeout: 10_000 });
    await expect(tick).not.toBeChecked();

    await enableNetwork(page, networkId, "boundnick");

    await expect(tick).toBeChecked({ timeout: 10_000 });
  } finally {
    if (userId !== null && networkId !== null) {
      await unbindBestEffort(admin.token, userId, networkId);
    }
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, networkId);
    if (userId !== null) await deleteUserBestEffort(admin.token, userId);
  }
});

test("admin edits a network (realname change) — the section reports left_alone", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const userName = unique("e2eun-edit-u");
  const netSlug = unique("e2eun-edit-n");
  let userId: string | null = null;
  let networkId: number | null = null;

  try {
    userId = await createUser(admin.token, userName);
    networkId = await createNetwork(admin.token, netSlug);
    await bindCredential(admin.token, userId, networkId, "edittest");

    await adminLogin(page, admin);
    await openUserPage(page, userId);

    // No Edit button to press: a bound network's settings form is simply
    // open, because the section IS the editor.
    await expect(page.getByTestId(`admin-user-network-form-${networkId}`)).toBeVisible();
    await page.getByTestId(`admin-user-network-realname-${networkId}`).fill("Updated Name");
    await page.getByTestId(`admin-user-network-save-${networkId}`).click();

    // Section state, not a toast (vjt: a toast throws four values away), and the
    // raw wire token, per the operator-console policy the banners follow.
    await expect(page.getByTestId(`admin-user-network-session-action-${networkId}`)).toContainText(
      "left_alone",
      { timeout: 10_000 },
    );
  } finally {
    if (userId !== null && networkId !== null) {
      await unbindBestEffort(admin.token, userId, networkId);
    }
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, networkId);
    if (userId !== null) await deleteUserBestEffort(admin.token, userId);
  }
});

test("admin removes a network by unticking it — the tick clears", async ({ page }) => {
  const admin = getSeededAdmin();
  const userName = unique("e2eun-rm-u");
  const netSlug = unique("e2eun-rm-n");
  let userId: string | null = null;
  let networkId: number | null = null;

  try {
    userId = await createUser(admin.token, userName);
    networkId = await createNetwork(admin.token, netSlug);
    await bindCredential(admin.token, userId, networkId, "rmtest");

    await adminLogin(page, admin);
    await openUserPage(page, userId);

    // Two steps, as before, but over the shape this page now has:
    // unticking ARMS and the named button fires. Unticking alone must not
    // delete anything, which is the first assertion.
    const tick = page.getByTestId(`admin-user-network-enabled-${networkId}`);
    await tick.uncheck();
    await expect(page.getByTestId(`admin-user-network-form-${networkId}`)).toHaveCount(0);
    await expect(page.getByTestId(`admin-user-network-remove-${networkId}`)).toBeVisible();

    await page.getByTestId(`admin-user-network-remove-${networkId}`).click();

    // The credential is gone: the section stays (the network is still
    // configured) and its tick is clear.
    await expect(page.getByTestId(`admin-user-network-remove-${networkId}`)).toHaveCount(0, {
      timeout: 10_000,
    });
    await expect(tick).not.toBeChecked();
  } finally {
    if (userId !== null && networkId !== null) {
      await unbindBestEffort(admin.token, userId, networkId);
    }
    if (networkId !== null) await deleteNetworkBestEffort(admin.token, networkId);
    if (userId !== null) await deleteUserBestEffort(admin.token, userId);
  }
});
