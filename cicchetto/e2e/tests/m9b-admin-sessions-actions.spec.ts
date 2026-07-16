// M-cluster M-9b — admin Sessions tab end-to-end: list + per-row
// Disconnect + Terminate actions + 422 self-protection.
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT —
// only the admin user class reaches the tab; the gate spec lives at
// m7-admin-gate-settings-drawer.spec.ts.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS
// the browser smoke for M-9b — chromium in the e2e harness renders
// the two-button-per-row inline-confirm CSS class flips that vitest
// jsdom can't see.
//
// Pre-seed pattern (per `feedback_visitor_mint_e2e_cold_start`):
// the m9b-test user + bind is in the seeder sidecar (compose.yaml),
// NOT minted at test time. Bootstrap spawns its Session.Server at
// grappa-test boot so the row is visible in /admin/sessions by the
// time the spec runs.
//
// Self-disconnect protection: admin-vjt has NO network bind in the
// seeder, so it has NO row in /admin/sessions. The 422
// `cannot_disconnect_self` server gate is therefore unreachable from
// this spec — every visible row belongs to vjt or m9b-test, both
// non-admin. The unit-level coverage for the 422 surface lives in
// AdminSessionsTab.test.tsx ("surfaces a 422 cannot_disconnect_self
// error inline prefixed with the verb"). Adding a Playwright case
// would require seeding admin-vjt with a network bind, which would
// in turn double the admin-vjt session footprint and complicate
// every other admin spec — out of scope here.

import { expect, test } from "@playwright/test";
import { patchNetworkConnectionState } from "../fixtures/grappaApi";
import { getSeededAdmin, getSeededM9bVictim, NETWORK_SLUG } from "../fixtures/seedData";

// E2E-ROBUSTNESS bucket D — cascade root fix. The Disconnect spec
// parks m9b-victim's credential and the Terminate spec stops its pid;
// without a cleanup hook the session stays dead for the remainder of
// the chromium suite, causing 30s timeout cascades in every downstream
// spec that depends on a live m9b-victim (push specs, marker specs,
// P-cluster, UX-5/UX-6 fan-out — 36+ specs total in the baseline).
//
// PATCH connection_state:"connected" is idempotent: no-op if already
// connected, respawn via Networks.connect/1 if parked or terminated.
// Runs after EVERY spec in this file — overkill for tests 1+2 but the
// guarantee matters more than the wasted PATCH.
test.afterEach(async () => {
  const victim = getSeededM9bVictim();
  await patchNetworkConnectionState(victim.token, NETWORK_SLUG, {
    connection_state: "connected",
  });
});

async function adminFriendlyLogin(
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

async function openAdminSessionsTab(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  const drawer = page.getByRole("dialog", { name: /settings/i });
  await expect(drawer).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();
  await page.getByTestId("admin-tab-sessions").click();
  await expect(page.getByTestId("admin-sessions-table")).toBeVisible({ timeout: 10_000 });
}

test("M-9b admin Sessions tab lists live sessions including m9b-test seeded row", async ({
  page,
}) => {
  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  // vjt + m9b-test + m9b-victim rows seeded → at least 3 admin-session
  // rows. m9b-victim was added in GREEN-CI batch-1 as the sacrificial
  // target for destructive specs (see Disconnect / Terminate specs
  // below). admin-vjt has no bind so doesn't appear.
  const rows = page.locator("[data-testid^='admin-session-row-']");
  await expect(rows).toHaveCount(3, { timeout: 15_000 });
});

test("#242 admin Sessions tab shows the network slug (not the raw network_id FK)", async ({
  page,
}) => {
  // Reconnect the sacrificial victim so its row is guaranteed live
  // (idempotent if already :connected) — every seeded session is bound
  // to bahamut-test, so the network cell of ANY row must render that
  // slug. We target the victim's row deterministically via its
  // composite session id.
  const victim = getSeededM9bVictim();
  await patchNetworkConnectionState(victim.token, NETWORK_SLUG, {
    connection_state: "connected",
  });

  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  const victimRow = page.getByTestId(`admin-session-row-${victim.sessionId}`);
  await expect(victimRow).toBeVisible({ timeout: 15_000 });

  // The network column is the 3rd cell (state, who, network, …). We
  // assert by column position rather than the `admin-session-network-*`
  // testid so the RED run (fix stripped, testid absent) still fails on
  // a VALUE mismatch — pre-fix the cell renders the raw integer FK
  // ("1"); post-fix it renders the resolved slug ("bahamut-test").
  const networkCell = victimRow.locator("td").nth(2);
  await expect(networkCell).toHaveText(NETWORK_SLUG, { timeout: 10_000 });
});

// IMPORTANT — mutex spec MUST run BEFORE the destructive Disconnect /
// Terminate specs. The destructive specs leave the e2e DB in a
// post-action state (sessions parked / pids stopped), so when this
// spec opens the Sessions tab last it sees "no sessions" and the
// row locator times out. Playwright runs file-internal tests in
// declaration order, so keeping this above the destructive arms
// is the simplest fix vs. spinning up an isolation layer.
test("M-9b arming Disconnect on one row disarms the same row's Terminate (single mutex)", async ({
  page,
}) => {
  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  const firstRow = page.locator("[data-testid^='admin-session-row-']").first();
  const disc = firstRow.locator("[data-testid^='admin-session-disconnect-']");
  const term = firstRow.locator("[data-testid^='admin-session-terminate-']");

  await term.click();
  await expect(term).toHaveText(/^Confirm terminate\?$/);
  await expect(disc).toHaveText(/^Disconnect$/);

  await disc.click();
  await expect(disc).toHaveText(/^Confirm disconnect\?$/);
  await expect(term).toHaveText(/^Terminate$/);
});

test("M-9b admin Disconnect inline-confirm transitions Disconnect → Confirm disconnect? → fires", async ({
  page,
}) => {
  // GREEN-CI batch-1 — target m9b-victim's row deterministically (NOT
  // `.first()` which is Registry-insertion-order non-deterministic and
  // was killing vjt's session, cascading sidebar-empty failures across
  // every downstream vjt-using spec). Reconnect m9b-victim first
  // (idempotent if already :connected) so the row is guaranteed live;
  // Disconnect parks the credential and the row drops on the next
  // refetch.
  const victim = getSeededM9bVictim();
  await patchNetworkConnectionState(victim.token, NETWORK_SLUG, {
    connection_state: "connected",
  });

  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  const victimDisconnect = page.getByTestId(`admin-session-disconnect-${victim.sessionId}`);
  await expect(victimDisconnect).toHaveText(/^Disconnect$/, { timeout: 15_000 });

  await victimDisconnect.click();
  await expect(victimDisconnect).toHaveText(/^Confirm disconnect\?$/);
  await expect(victimDisconnect).toHaveClass(/confirming/);

  await victimDisconnect.click();
  // Post-disconnect: table refreshes (the runAction re-fetches). The
  // target user's credential transitions to :parked → the Bootstrap
  // pid stops → row drops from /admin/sessions on the next list.
  // At minimum the error banner MUST NOT appear.
  await expect(page.getByTestId("admin-sessions-error")).toHaveCount(0, { timeout: 5_000 });
});

test("M-9b admin Terminate inline-confirm fires DELETE", async ({ page }) => {
  // GREEN-CI batch-1 — same victim, same reconnect dance. Disconnect
  // (above) parked m9b-victim's credential; reconnect-via-PATCH spawns
  // a fresh Session.Server and the row reappears in /admin/sessions.
  // Terminate then stops the pid (DB row preserved per M-9a contract).
  const victim = getSeededM9bVictim();
  await patchNetworkConnectionState(victim.token, NETWORK_SLUG, {
    connection_state: "connected",
  });

  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminSessionsTab(page);

  const victimTerminate = page.getByTestId(`admin-session-terminate-${victim.sessionId}`);
  await expect(victimTerminate).toHaveText(/^Terminate$/, { timeout: 15_000 });

  await victimTerminate.click();
  await expect(victimTerminate).toHaveText(/^Confirm terminate\?$/);
  await expect(victimTerminate).toHaveClass(/confirming/);

  await victimTerminate.click();
  // 204 idempotent. Pid is gone; DB rows preserved (per M-9a spec).
  // No error surface expected.
  await expect(page.getByTestId("admin-sessions-error")).toHaveCount(0, { timeout: 5_000 });
});
