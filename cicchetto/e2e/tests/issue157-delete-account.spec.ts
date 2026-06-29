// Issue #157 (P1) — self-service "delete my account": an explicit,
// IRREVERSIBLE total wipe of the caller's OWN account + all state,
// DISTINCT from #126's quit (which PRESERVES a persistent identity).
//
// Scope of THIS spec (the visible, isolatable browser outcomes):
//
//   1. USER WIPE (the RED-provable flow) — a registered NON-admin user
//      opens the settings drawer, clicks "delete account", types their
//      name into the confirm modal, and confirms. The web session ends
//      (back to /login) AND the account is gone server-side: a fresh
//      `POST /auth/login` for that identity fails, and the old bearer
//      no longer authenticates `/me`. A THROWAWAY user is created via
//      `POST /admin/users` so we never delete a seeded account (deleting
//      vjt/admin cascades the whole suite). RED before #157 (no
//      delete-account button / no `DELETE /me` route).
//
//   2. ANON-VISITOR GATING — a minted (ephemeral) visitor's drawer does
//      NOT offer delete-account; its only teardown verb stays quit. This
//      is a GUARD (green pre-#157 too — the button never existed), not the
//      RED proof; the RED proof is the user flow above.
//
// A REGISTERED visitor's visible wipe needs the full NickServ REGISTER
// dance (no pre-seeded identified nick in the e2e testnet — the same wall
// #126 hit). The wipe MECHANISM is identical for user/visitor, and the
// registered-vs-anon GATING is covered by the server-unit
// (`Grappa.AccountDeletionTest`) + cic vitest (SettingsDrawer gating +
// DeleteAccountModal). Honest scope, mirroring issue126-detach-lifecycle.

import { test, expect } from "../fixtures/test";
import { GRAPPA_BASE_URL, adminDeleteVisitor, login, mintVisitor } from "../fixtures/grappaApi";
import { getSeededAdmin } from "../fixtures/seedData";

const PASSWORD = "test-password-not-secret";

async function createThrowawayUser(
  adminToken: string,
  name: string,
  password: string,
): Promise<string> {
  const res = await fetch(`${GRAPPA_BASE_URL}/admin/users`, {
    method: "POST",
    headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name, password }),
  });
  if (!res.ok) {
    throw new Error(`createThrowawayUser: ${name} → ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { id: string };
  return body.id;
}

async function deleteUserBestEffort(adminToken: string, id: string): Promise<void> {
  try {
    await fetch(`${GRAPPA_BASE_URL}/admin/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${adminToken}` },
    });
  } catch {
    // best-effort cleanup — the test under assertion may already have
    // deleted the row (the success path), in which case this 404s.
  }
}

async function loginRejected(identifier: string, password: string): Promise<boolean> {
  const res = await fetch(`${GRAPPA_BASE_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  return !res.ok;
}

test.describe("issue #157 — delete account", () => {
  test("registered non-admin user wipes their account via the drawer; the login stops working", async ({
    page,
  }) => {
    const admin = getSeededAdmin();
    const name = `e2e157-${Date.now()}`;
    const identifier = `${name}@grappa.test`;
    let createdId: string | null = null;

    try {
      createdId = await createThrowawayUser(admin.token, name, PASSWORD);

      // Mint the throwaway user's OWN bearer + subject (never the seeded
      // admin's) and hydrate localStorage exactly like adminLogin does.
      const { token, subject } = await login(identifier, PASSWORD);
      await page.addInitScript(
        ([t, subjectJson]) => {
          localStorage.setItem("grappa-token", t);
          localStorage.setItem("grappa-subject", subjectJson);
          localStorage.setItem("cic.installChoice", "browser");
        },
        [token, JSON.stringify(subject)] as const,
      );
      await page.goto("/");
      await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });

      // Open the drawer → the delete-account entry is offered (non-admin).
      await page.getByLabel(/open settings/i).click();
      await expect(page.getByRole("dialog", { name: /settings/i })).toHaveClass(/open/);
      await page.getByTestId("delete-account-btn").click();

      // The confirm modal gates the destructive button behind typing the
      // exact account name — the irreversibility gate.
      await expect(page.getByTestId("delete-account-modal")).toBeVisible();
      await expect(page.getByTestId("delete-account-confirm")).toBeDisabled();
      await page.getByTestId("delete-account-confirm-input").fill(name);
      await expect(page.getByTestId("delete-account-confirm")).toBeEnabled();
      await page.getByTestId("delete-account-confirm").click();

      // The web session ends → back to /login.
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });

      // The account is GONE server-side: a fresh login fails …
      expect(await loginRejected(identifier, PASSWORD)).toBe(true);
      // … and the old bearer no longer authenticates.
      const meRes = await fetch(`${GRAPPA_BASE_URL}/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(meRes.status).toBe(401);

      // Success path deleted the row — skip cleanup.
      createdId = null;
    } finally {
      if (createdId !== null) await deleteUserBestEffort(admin.token, createdId);
    }
  });

  test("a minted (anon) visitor is NOT offered delete account — only quit", async ({ browser }) => {
    const visitor = await mintVisitor(`e2e157v-${Date.now()}`);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    try {
      const subjectJson = JSON.stringify({
        kind: "visitor",
        id: visitor.id,
        nick: visitor.nick,
        network_slug: visitor.network_slug,
        registered: false,
      });
      await page.addInitScript(
        ([token, subject]) => {
          localStorage.setItem("grappa-token", token);
          localStorage.setItem("grappa-subject", subject);
          localStorage.setItem("cic.installChoice", "browser");
        },
        [visitor.token, subjectJson] as const,
      );
      await page.goto("/");
      await page.getByLabel(/open settings/i).click();
      await expect(page.getByRole("dialog", { name: /settings/i })).toHaveClass(/open/);

      // The ephemeral visitor gets quit, never delete-account.
      await expect(page.getByTestId("quit-irc-btn")).toBeVisible();
      await expect(page.getByTestId("delete-account-btn")).toHaveCount(0);
    } finally {
      await ctx.close();
      const admin = getSeededAdmin();
      await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
    }
  });
});
