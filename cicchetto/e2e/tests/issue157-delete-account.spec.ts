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
import { openSettingsDrawer, expectShellReady, openRailMenu, closeSettings } from "../fixtures/cicchettoPage";
import { GRAPPA_BASE_URL, login, mintVisitor, reapVisitors } from "../fixtures/grappaApi";
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
      await expectShellReady(page);

      // Open the drawer → the delete-account entry is offered (non-admin).
      await openSettingsDrawer(page);
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

  // #987 — the dialog must sit ON the screen, not BE the screen. The backdrop
  // was `align-items: stretch`, which forces a flex child to the full
  // cross-axis extent, so the modal was viewport-tall whatever it held and its
  // own `max-height` read like a cap that never bit. Asserted as GEOMETRY, not
  // computed style: `getComputedStyle` under device emulation has already lied
  // once (#963), and "is it stretched" is a box question anyway.
  //
  // Note which assertion carries the weight. Scrim-above/below is the RED one:
  // pre-fix the box starts at y=0 and ends at the viewport bottom, so both
  // legs fail. The centring check is a GUARD, not the proof — a
  // full-height box is trivially "centred" and would satisfy it alone.
  test("#987 — the delete-account dialog is centred and sized to its content", async ({ page }) => {
    const admin = getSeededAdmin();
    const name = `e2e987-${Date.now()}`;
    const identifier = `${name}@grappa.test`;
    let createdId: string | null = null;

    try {
      createdId = await createThrowawayUser(admin.token, name, PASSWORD);
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
      await expectShellReady(page);

      await openSettingsDrawer(page);
      await page.getByTestId("delete-account-btn").click();
      const modal = page.getByTestId("delete-account-modal");
      await expect(modal).toBeVisible();

      // Measure the dialog against its own SCRIM, not against
      // `page.viewportSize()`. The backdrop is `position: fixed; inset: 0`, and
      // a fixed box resolves against the nearest transformed ancestor rather
      // than the viewport — the settings drawer is `transform: translateX(0)`
      // when open, so pinning the maths to the viewport would be one refactor
      // (moving the modal inside the drawer) away from measuring the wrong
      // rectangle and reporting it confidently. The scrim is also what "scrim
      // above and below" is literally about. A sanity leg below still ties the
      // scrim to the screen.
      const backdrop = page.getByTestId("delete-account-backdrop");
      const scrim = await backdrop.boundingBox();
      const box = await modal.boundingBox();
      const viewport = page.viewportSize();
      expect(scrim, "the backdrop must have a layout box").not.toBeNull();
      expect(box, "the modal must have a layout box").not.toBeNull();
      expect(viewport, "the test needs a known viewport").not.toBeNull();
      if (!scrim || !box || !viewport) return;

      // Sanity: the scrim really is the screen, so the assertions below are
      // about what the operator sees and not about some inner box.
      expect(Math.round(scrim.height)).toBe(viewport.height);

      // THE DEFECT: scrim above and below. Pre-fix there is none of either —
      // `align-items: stretch` pins the dialog to both edges.
      expect(box.y, "scrim must be visible above the dialog").toBeGreaterThan(scrim.y);
      expect(box.y + box.height, "scrim must be visible below the dialog").toBeLessThan(
        scrim.y + scrim.height,
      );

      // Sized to content: this dialog holds a heading, a warning, one input and
      // two buttons. Three quarters of the scrim is a generous ceiling that
      // still fails hard on the stretched box (which is exactly 1.0).
      expect(box.height, "a short dialog must not claim most of the screen").toBeLessThan(
        scrim.height * 0.75,
      );

      // Guard: vertically centred, the `.confirm-modal` contract. Allow a
      // couple of px for sub-pixel rounding.
      expect(Math.abs(box.y - scrim.y - (scrim.height - box.height) / 2)).toBeLessThanOrEqual(2);

      // The dialog is only inspected here — never confirmed — so the throwaway
      // account still exists and the `finally` below reaps it.
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
      await openSettingsDrawer(page);
      await expect(page.getByRole("dialog", { name: /settings/i })).toHaveClass(/open/);

      // The ephemeral visitor never gets delete-account. #986 moved the
      // positive twin (quit) out of this drawer and into the rail, so the
      // twin is asserted there — the drawer must show NEITHER, and the
      // delete-account absence keeps a real positive control via the
      // registered cases above.
      await expect(page.getByTestId("delete-account-btn")).toHaveCount(0);
      await expect(page.getByTestId("quit-irc-btn")).toHaveCount(0);
      await closeSettings(page);
      await openRailMenu(page);
      await expect(page.getByTestId("quit-irc-btn")).toBeVisible();
    } finally {
      await ctx.close();
      const admin = getSeededAdmin();
      await reapVisitors(admin.token, visitor.id);
    }
  });
});
