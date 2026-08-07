// M-cluster M-7 — the admin-gated door + admin pane skeleton.
//
// #986 — that door is no longer the settings drawer. The drawer's "admin
// console" entry was an exact duplicate of the rail's 🔧 admin launcher (same
// isAdmin() gate, same setSelectedChannel payload, same destination) and was
// deleted; the gate itself is unchanged, so this spec keeps its name and its
// job and simply asserts it on the surviving surface. Filename kept
// deliberately: six sibling specs cross-reference it as THE M-7 gate spec.
//
// Three-class parity matrix per `feedback_e2e_user_class_parity_matrix`:
// admin-gated is the EXEMPT shape — only ONE class (admin user) sees
// the surface. The spec still loops the three classes to assert the
// OPPOSITE polarity (non-admin user + visitor see NO admin launcher +
// can't open the admin pane).
//
// Visitor sub-case: visitors can't easily be seeded into the e2e
// harness today (no per-test visitor mint API; the captcha + Turnstile
// gate complicates it). The visitor branch is covered by the vitest
// unit at RailActions.test.tsx (isAdmin() false → launcher unmounted;
// SettingsDrawer.test.tsx pins that no drawer copy survived); the
// Playwright spec covers the two seeded
// user classes (vjt non-admin, admin-vjt admin). The vitest pin is
// the load-bearing assertion for visitors; Playwright is the
// production-fidelity confirmation for the gate logic.
//
// Per `feedback_cicchetto_browser_smoke`: this spec exercises the
// real CSS render path that vitest jsdom can't — the admin launcher
// needs to be visible (display, opacity, transform) inside the
// expanded RailActions menu, which is absolutely positioned, capped by
// a JS-measured max-height and overlays the members list.

import { expect, test } from "../fixtures/test";
import { openRailMenu, expectShellReady } from "../fixtures/cicchettoPage";
import { getSeededAdmin, getSeededVjt } from "../fixtures/seedData";

// admin-vjt has no network bind — loginAs's `.sidebar-network-section h3`
// shell-ready selector would time out. Wait on the always-visible
// settings cog button instead (rendered in the no-network fallback
// header via `aria-label="open settings"`).
async function adminFriendlyLogin(
  page: import("@playwright/test").Page,
  seed: ReturnType<typeof getSeededVjt>,
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

const cases = [
  {
    label: "admin user (admin-vjt)",
    seed: getSeededAdmin,
    expectAdminEntry: true,
  },
  {
    label: "non-admin user (vjt)",
    seed: getSeededVjt,
    expectAdminEntry: false,
  },
];

for (const c of cases) {
  test(`M-7 admin launcher gate — ${c.label}`, async ({ page }) => {
    await adminFriendlyLogin(page, c.seed());

    // #500 — every rail affordance lives behind the launcher menu.
    await openRailMenu(page);

    if (c.expectAdminEntry) {
      const entry = page.getByTestId("mobile-panel-admin");
      await expect(entry).toBeVisible();
      // Per `feedback_css_block_button_wraps_inline_prefix`:
      // text assertion catches the ::before / inline-prefix clip case
      // that pure visibility checks miss. #473 gave every rail row a
      // visible NAME beside the glyph — that name is the contract.
      await expect(entry).toHaveText(/admin/i);

      // Tap → the nav mutex closes members/settings/archive and sets
      // selection; the pane replaces the channel/empty fallback.
      await entry.click();
      const pane = page.getByTestId("admin-pane");
      await expect(pane).toBeVisible();
      await expect(pane.getByRole("heading", { name: /admin console/i })).toBeVisible();

      // Close button returns to the channel/empty state — pane
      // unmounts entirely (not just hidden via CSS).
      await page.getByTestId("admin-pane-close").click();
      await expect(page.getByTestId("admin-pane")).toHaveCount(0);
    } else {
      // Non-admin: the launcher MUST be absent from the DOM (the Show
      // gate unmounts it when is_admin !== true). Pair the negative
      // polarity with a positive twin in the SAME menu — the
      // registered-user "detach" entry (#986 moved it here from the
      // drawer; a user is a persistent identity, so it renders) — so a
      // testid typo cannot silently green BOTH assertion paths.
      await expect(page.getByTestId("detach-btn")).toBeVisible();
      await expect(page.getByTestId("mobile-panel-admin")).toHaveCount(0);
      // And the retired drawer door must not have grown back.
      await expect(page.getByTestId("admin-console-entry")).toHaveCount(0);
    }
  });
}
