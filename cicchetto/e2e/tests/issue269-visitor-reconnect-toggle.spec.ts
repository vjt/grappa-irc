// #269 — admin Visitors tab: per-(visitor, network) Disconnect ⇄ Reconnect
// toggle, mirroring the Sessions tab's Disconnect control. Brings the
// Visitors tab to parity: an operator can tear down a visitor's live
// session on ONE network and bring it back up — per-network, never a
// global "disconnect everywhere".
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT — only
// the admin user class reaches the Visitors tab; the reachability gate
// lives in m7-admin-gate-settings-drawer.spec.ts.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS the
// browser smoke for #269 — chromium in the e2e harness renders the
// inline-confirm text flip (Disconnect → Confirm disconnect? → Reconnect
// → …) + the live-badge transition that vitest jsdom can't see.
//
// Per `feedback_ux_e2e_mandatory`: the OUTCOME asserted is the live-pid
// truth flipping per-network — the toggle text + the live badge both
// derive from `/admin/visitors[].networks[].live_state` (the Registry
// SessionEntry join, i.e. Session.whereis truth). Disconnect drops the
// pid → `live_state: null` → the toggle reads Reconnect + the badge reads
// "BEAM has no pid"; Reconnect spawns it back → `live_state` non-null →
// toggle reads Disconnect + the badge reads "● N chan". Not DOM cosmetics
// alone: the session genuinely goes down then up on the SPECIFIC network.

import { expect, test } from "../fixtures/test";
import { getSeededAdmin } from "../fixtures/seedData";
import { mintVisitor, adminDeleteVisitor } from "../fixtures/grappaApi";

async function adminOpenVisitorsTab(
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
  await page.getByLabel(/open settings/i).click();
  await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();
  await page.getByTestId("admin-tab-visitors").click();
  await expect(page.getByTestId("admin-visitors-table")).toBeVisible({ timeout: 10_000 });
}

test("#269 admin Visitors tab Disconnect ⇄ Reconnect toggles a per-network visitor session", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const visitor = await mintVisitor(`i269-victim-${Date.now()}`);

  try {
    await adminOpenVisitorsTab(page, admin);

    const row = page.getByTestId(`admin-visitor-row-${visitor.id}`);
    await expect(row).toBeVisible({ timeout: 10_000 });

    const toggle = page.getByTestId(`admin-visitor-toggle-${visitor.id}-${visitor.network_slug}`);
    const networkCell = page.getByTestId(
      `admin-visitor-network-${visitor.id}-${visitor.network_slug}`,
    );

    // Live on mint: the toggle reads Disconnect, and the live badge shows
    // the alive channel count (live_state non-null).
    await expect(toggle).toHaveText(/^Disconnect$/, { timeout: 15_000 });
    await expect(networkCell).toContainText(/chan/);

    // Disconnect (inline-confirm two-step): tear the pid down on THIS
    // network. Visitor disconnect collapses to terminate; the refetch then
    // shows live_state: null → the toggle flips to Reconnect + the badge
    // reads the U-0 honesty signal.
    await toggle.click();
    await expect(toggle).toHaveText(/^Confirm disconnect\?$/);
    await expect(toggle).toHaveClass(/confirming/);
    await toggle.click();

    await expect(toggle).toHaveText(/^Reconnect$/, { timeout: 15_000 });
    await expect(networkCell).toContainText(/BEAM has no pid/);
    await expect(page.getByTestId("admin-visitors-error")).toHaveCount(0);

    // Reconnect (inline-confirm two-step): spawn the session back on THIS
    // network. The refetch shows live_state non-null → the toggle flips
    // back to Disconnect + the alive badge returns.
    await toggle.click();
    await expect(toggle).toHaveText(/^Confirm reconnect\?$/);
    await expect(toggle).toHaveClass(/confirming/);
    await toggle.click();

    await expect(toggle).toHaveText(/^Disconnect$/, { timeout: 15_000 });
    await expect(networkCell).toContainText(/chan/);
    await expect(page.getByTestId("admin-visitors-error")).toHaveCount(0);
  } finally {
    // Idempotent cleanup — Operator.delete_visitor stops every live
    // session + deletes the row, so a downed OR live victim is fully
    // reaped and never poisons a downstream spec.
    await adminDeleteVisitor(admin.token, visitor.id).catch(() => {});
  }
});
