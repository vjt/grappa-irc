// M-cluster M-7 — admin-gated drawer entry + admin pane skeleton.
//
// Three-class parity matrix per `feedback_e2e_user_class_parity_matrix`:
// admin-gated is the EXEMPT shape — only ONE class (admin user) sees
// the surface. The spec still loops the three classes to assert the
// OPPOSITE polarity (non-admin user + visitor see NO drawer entry +
// can't open the admin pane).
//
// Visitor sub-case: visitors can't easily be seeded into the e2e
// harness today (no per-test visitor mint API; the captcha + Turnstile
// gate complicates it). The visitor branch is covered by the vitest
// unit at SettingsDrawer.test.tsx (visitor subject in localStorage →
// admin entry hidden); the Playwright spec covers the two seeded
// user classes (vjt non-admin, admin-vjt admin). The vitest pin is
// the load-bearing assertion for visitors; Playwright is the
// production-fidelity confirmation for the gate logic.
//
// Per `feedback_cicchetto_browser_smoke`: this spec exercises the
// real CSS render path that vitest jsdom can't — admin-console-entry
// button needs to be visible (display, opacity, transform) inside
// the open SettingsDrawer overlay.

import { expect, test } from "../fixtures/test";
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
  await expect(page.getByLabel(/open settings/i)).toBeVisible({ timeout: 10_000 });
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
  test(`M-7 SettingsDrawer admin entry — ${c.label}`, async ({ page }) => {
    await adminFriendlyLogin(page, c.seed());

    // Open the settings drawer via the cog button.
    await page.getByLabel(/open settings/i).click();
    const drawer = page.getByRole("dialog", { name: /settings/i });
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveClass(/open/);

    if (c.expectAdminEntry) {
      const entry = page.getByTestId("admin-console-entry");
      await expect(entry).toBeVisible();
      // Per `feedback_css_block_button_wraps_inline_prefix`:
      // textContent assertion catches the ::before / inline-prefix
      // clip case that pure visibility checks miss.
      await expect(entry).toHaveText(/admin console/i);

      // Click → drawer dismisses → admin pane mounts. Pane replaces
      // the channel/empty fallback in `.shell-main`.
      await entry.click();
      await expect(drawer).not.toHaveClass(/open/);
      const pane = page.getByTestId("admin-pane");
      await expect(pane).toBeVisible();
      await expect(pane.getByRole("heading", { name: /admin console/i })).toBeVisible();

      // Close button returns to the channel/empty state — pane
      // unmounts entirely (not just hidden via CSS).
      await page.getByTestId("admin-pane-close").click();
      await expect(page.getByTestId("admin-pane")).toHaveCount(0);
    } else {
      // Non-admin: entry MUST be absent from the DOM (Show gate
      // unmounts the button when is_admin !== true). Pair the
      // negative-polarity assertion with a positive twin (the
      // registered-user "detach" button, issue #43 — replaced the old
      // single "log out" for `kind === "user"` subjects) so a testid
      // typo can't silently green BOTH assertion paths.
      await expect(page.getByTestId("detach-btn")).toBeVisible();
      await expect(page.getByTestId("admin-console-entry")).toHaveCount(0);

      // Even forcibly opening the SPA against an admin-only URL
      // wouldn't matter since M-7 has no admin route — but the
      // testid absence is the load-bearing assertion.
    }
  });
}
