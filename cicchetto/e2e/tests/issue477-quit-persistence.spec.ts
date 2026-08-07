// Issue #477 — quit() + the detach affordance route on PERSISTENCE,
// not subject class. Before #477 both hand-rolled the same predicate twice
// (`kind === "user" || (visitor && registered === true)`); the collapse
// routes both through the shared `isPersistentIdentity` (lib/auth.ts). This
// is the real-browser parity proof that the predicate's VISIBLE outcome is
// consistent across the three subject classes (per feedback_ux_e2e_mandatory
// + the SINGLE-spec parity-matrix idiom):
//
//   * a PERSISTENT identity (a registered user OR a NickServ-identified
//     visitor) is offered BOTH detach + quit;
//   * an EPHEMERAL (anon) visitor is offered ONLY quit, and its quit lands
//     back on /login (the logout path).
//
// ─── COVERAGE BOUNDARY — READ BEFORE ADDING A TEST HERE ──────────────────
// This spec asserts the drawer AFFORDANCE (which lifecycle buttons the
// predicate RENDERS per class) plus the ephemeral quit ACTION. The
// persistent quit ACTION to completion — a user/registered visitor
// confirming quit → quitAll parks ALL networks → logout revokes the bearer —
// is covered ONLY by lib/lifecycle.test.ts (unit), DELIBERATELY, and MUST
// stay that way:
//
//   * DO NOT add a destructive persistent-quit e2e here. Confirming a
//     persistent quit parks the SHARED vjt network + revokes the SHARED
//     bearer, cascading a 401 through every downstream vjt spec —
//     issue43-split-logout documents this exact trap and withholds the
//     second tap for the same reason.
//   * DO NOT assume the persistent quit ACTION is e2e-covered elsewhere. It
//     is not. The unit test is the entire safety net for that action; a
//     registered-visitor composite would additionally need the full NickServ
//     REGISTER dance, out of scope for a stable browser gate (issue126).
//
// Why this is still airtight: the affordance IS the SAME
// isPersistentIdentity predicate the quit ACTION routes on, so a
// misclassification (e.g. a registered visitor mis-typed as ephemeral)
// turns THIS spec red, visibly. The ephemeral quit-to-/login below runs on
// a THROWAWAY minted visitor (deleted in teardown), so it mutates no shared
// state — the one quit ACTION safe to drive end-to-end in the browser.
// ─────────────────────────────────────────────────────────────────────────
//
// The registered-visitor case seeds `registered: true` into the persisted
// subject — the SAME field the server sets for a real registered visitor and
// the SOLE input the detach gate reads (issue126 seeds `registered: false`
// symmetrically for its ephemeral case).

import { openRailMenu, loginAs } from "../fixtures/cicchettoPage";
import { mintVisitor, reapVisitors } from "../fixtures/grappaApi";
import { getSeededAdmin, getSeededVjt } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";
import { type Browser, type Page } from "@playwright/test";

// #986 — the lifecycle verbs left the settings drawer for the rail actions
// menu. The persistence QUESTION this spec is about (`isPersistentIdentity`,
// via `canDetach()`) did not change; only the surface it gates did.
async function openLifecycleMenu(page: Page): Promise<void> {
  await openRailMenu(page);
}

// Mint a throwaway visitor, seed it into a fresh isolated context carrying
// the given `registered` flag (the field canDetach() + quit() read), and
// bootstrap cicchetto. Returns the page + a teardown that closes the context
// and deletes the visitor row (idempotent — an ephemeral quit already purged
// it server-side, so the delete 404s, swallowed).
async function bootVisitor(
  browser: Browser,
  registered: boolean,
): Promise<{ page: Page; teardown: () => Promise<void> }> {
  const label = registered ? "reg" : "anon";
  const visitor = await mintVisitor(`e2e477-${label}-${Date.now()}`);
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const subjectJson = JSON.stringify({
    kind: "visitor",
    id: visitor.id,
    nick: visitor.nick,
    network_slug: visitor.network_slug,
    registered,
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
  return {
    page,
    teardown: async () => {
      await ctx.close();
      await reapVisitors(getSeededAdmin().token, visitor.id);
    },
  };
}

test.describe("issue #477 — quit()/detach route on persistence, not class", () => {
  test("registered USER (persistent) → the rail offers BOTH detach and quit", async ({ page }) => {
    await loginAs(page, getSeededVjt());
    await openLifecycleMenu(page);

    // Persistent identity → isPersistentIdentity true → canDetach() renders
    // the detach affordance alongside the universal quit. Read-only: no
    // click mutates the shared vjt session.
    await expect(page.getByTestId("detach-btn")).toBeVisible();
    await expect(page.getByTestId("quit-irc-btn")).toBeVisible();
  });

  test("registered VISITOR (persistent) → the rail offers BOTH detach and quit", async ({
    browser,
  }) => {
    const { page, teardown } = await bootVisitor(browser, true);
    try {
      await openLifecycleMenu(page);

      // `registered === true` → persistent, exactly like a user: detach is
      // offered. This is the arm the #477 collapse must keep grouped with
      // the user arm — no existing e2e covered a registered visitor here.
      await expect(page.getByTestId("detach-btn")).toBeVisible();
      await expect(page.getByTestId("quit-irc-btn")).toBeVisible();

      // #986 — persistent, so the quit copy must PROMISE SURVIVAL. Against a
      // real NickServ-flagged visitor, not a stubbed subject: this is the
      // middle row of the three-way copy split, and the one a vitest fake
      // cannot prove the shipped client reaches.
      await page.getByTestId("quit-irc-btn").click();
      await expect(page.getByTestId("confirm-modal-body")).toHaveText(/survive/i);
      await page.getByTestId("confirm-modal-cancel").click();
      await expect(page.getByTestId("confirm-modal")).toHaveCount(0);
    } finally {
      await teardown();
    }
  });

  test("ephemeral VISITOR → the rail offers ONLY quit, and quit lands on /login", async ({
    browser,
  }) => {
    const { page, teardown } = await bootVisitor(browser, false);
    try {
      await openLifecycleMenu(page);

      // Ephemeral (not persistent) → no detach; quit is the only lifecycle
      // verb (positive twin so a testid typo can't silently green the
      // negative assertion).
      await expect(page.getByTestId("quit-irc-btn")).toBeVisible();
      await expect(page.getByTestId("detach-btn")).toHaveCount(0);

      // The quit ACTION end-state: #986 replaced the two-tap arm with the
      // shared confirm modal, so the first tap RAISES it (no navigation) and
      // the affirmative fires quit() → logout (the ephemeral path) →
      // RequireAuth bounces to /login. On a throwaway visitor, so it poisons
      // no shared state.
      await page.getByTestId("quit-irc-btn").click();
      await expect(page.getByTestId("confirm-modal-body")).toHaveText(/deletes it/i);
      await expect(page).not.toHaveURL(/\/login/);
      await page.getByTestId("confirm-modal-confirm").click();
      await expect(page).toHaveURL(/\/login/, { timeout: 10_000 });
    } finally {
      await teardown();
    }
  });
});
