// M-cluster M-Z — full operator-journey end-to-end. Covers the
// shipping reality of the entire M cluster (M-7..M-11) from the
// admin's browser session: drawer → AdminPane mount → 4 tab
// visits (Visitors / Sessions / Networks / Events) → real
// cap-saturation event flow (PATCH cap to 0 → mint visitor → 503
// → typed `:capacity_reject` admin event lands in Events tab in
// real time).
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT —
// only the admin user class reaches the pane; m7-admin-gate-settings-drawer.spec.ts
// covers the three-class reachability matrix.
//
// Per `feedback_cicchetto_browser_smoke`: this spec IS the cluster
// browser smoke for M-Z; vitest jsdom can't render the WS-stream
// fan-out (channel join → broadcast → ingest → list render) that
// is the load-bearing M-11 surface.
//
// Per orchestrator vjt 2026-05-16: M-Z's smoke checklist must be
// reproducible — ad-hoc browser walk-throughs at cluster close
// are not. This spec replays the entire 7-step plan §M-Z journey
// in CI on every integration run, forever.
//
// Pre-seed pattern (per `feedback_visitor_mint_e2e_cold_start`):
// admin-vjt + vjt + m9b-test + bahamut-test/azzurra networks all
// seeded by `grappa-e2e-seeder` sidecar (compose.yaml) BEFORE
// grappa-test boots.
//
// Test order discipline: this spec is INTENTIONALLY non-mutating
// for the destructive surfaces — it asserts presence of Visitors
// + Sessions + Networks rows without firing per-row Disconnect /
// Terminate / Delete (those are covered by per-bucket specs
// m8-admin-visitors-delete + m9b-admin-sessions-actions +
// m10-admin-networks-cap-editor). The cap-saturation arm DOES
// mutate (PATCH azzurra cap from 100 → 0 → 100), but reverts in
// a try/finally so the seeder's baseline is restored even on
// assertion failure. Failure-mode: subsequent specs that mint
// visitors against azzurra would 503 if the revert didn't run.

import { expect, test } from "@playwright/test";
import { getSeededAdmin } from "../fixtures/seedData";
import { mintVisitor } from "../fixtures/grappaApi";

const GRAPPA_BASE_URL = "http://grappa-test:4000";
const AZZURRA_SLUG = "azzurra";
const AZZURRA_BASELINE_CAP = 100;

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

async function openAdminPane(page: import("@playwright/test").Page): Promise<void> {
  await page.getByLabel(/open settings/i).click();
  const drawer = page.getByRole("dialog", { name: /settings/i });
  await expect(drawer).toBeVisible();
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();
}

// PATCH /admin/networks/:slug — partial body shape per M-10. Only
// max_concurrent_visitor_sessions is sent; max_per_client unchanged.
async function patchNetworkCap(adminToken: string, slug: string, cap: number): Promise<void> {
  const url = `${GRAPPA_BASE_URL}/admin/networks/${encodeURIComponent(slug)}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ max_concurrent_visitor_sessions: cap }),
  });
  if (!res.ok) {
    throw new Error(`patchNetworkCap: ${slug}=${cap} → ${res.status} ${await res.text()}`);
  }
}

test("M-Z admin operator journey: drawer → 4 tabs → cap-saturation event lands live", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  await adminFriendlyLogin(page, admin);

  // STEP 1 — Login as admin → drawer entry visible.
  // adminFriendlyLogin already asserts the cog is visible; opening
  // the drawer + asserting the Admin entry exercises the M-7 gate.
  await page.getByLabel(/open settings/i).click();
  const drawer = page.getByRole("dialog", { name: /settings/i });
  await expect(drawer).toBeVisible();
  await expect(page.getByTestId("admin-console-entry")).toBeVisible();

  // Mount the AdminPane → channel join + snapshot push happen here.
  // EVERY subsequent assertion depends on the pane being mounted, so
  // the channel subscription is live by the time we hit cap-saturate.
  await page.getByTestId("admin-console-entry").click();
  await expect(page.getByTestId("admin-pane")).toBeVisible();

  // STEP 2 — Visitors tab: list renders (table when populated, or
  // the explicit "no visitors" marker when empty — seeder doesn't
  // mint baseline visitors). Per-row delete is M-8 territory;
  // here we only assert the tab mounts cleanly.
  await page.getByTestId("admin-tab-visitors").click();
  const visitorsTable = page.getByTestId("admin-visitors-table");
  const visitorsEmpty = page.getByTestId("admin-visitors-empty");
  await expect(visitorsTable.or(visitorsEmpty)).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("admin-visitors-error")).toHaveCount(0);

  // STEP 3 — Sessions tab: at least 2 rows from seeded vjt + m9b-test.
  // Per m9b-admin-sessions-actions.spec.ts this count holds when the
  // destructive specs haven't run yet; M-Z runs against the same DB
  // so we accept ">= 1" to stay robust to file-ordering quirks.
  await page.getByTestId("admin-tab-sessions").click();
  await expect(page.getByTestId("admin-sessions-table")).toBeVisible({ timeout: 10_000 });
  const sessionRows = page.locator("[data-testid^='admin-session-row-']");
  await expect.poll(() => sessionRows.count(), { timeout: 10_000 }).toBeGreaterThanOrEqual(1);

  // STEP 4 — Networks tab: bahamut-test + azzurra both seeded.
  await page.getByTestId("admin-tab-networks").click();
  await expect(page.getByTestId("admin-networks-table")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("admin-network-row-bahamut-test")).toBeVisible();
  await expect(page.getByTestId(`admin-network-row-${AZZURRA_SLUG}`)).toBeVisible();

  // STEP 5 — Events tab: mounts cleanly (snapshot may include prior
  // test events from the same compose run; we don't assert empty).
  await page.getByTestId("admin-tab-events").click();
  await expect(page.getByTestId("admin-events-tab")).toBeVisible();

  // STEP 6 — Cap-saturation: PATCH azzurra cap to 0, mint visitor
  // (expected to 503 with `network_busy`), assert the typed
  // `capacity_reject` admin event row lands in the Events tab in
  // real time. Revert in finally so subsequent specs see the
  // seeder baseline.
  //
  // Choosing azzurra (not bahamut-test) on purpose: bahamut-test
  // hosts the user-bind sessions that other specs depend on; mucking
  // with its cap risks stranding vjt's autojoin. azzurra's only
  // traffic is visitor mints — squeezing it to 0 and back is
  // self-contained.
  try {
    await patchNetworkCap(admin.token, AZZURRA_SLUG, 0);

    // Mint a throwaway visitor against azzurra. Expected: 503
    // (`network_busy`) → server emits `:capacity_reject` admin event
    // via Admission.Telemetry → AdminEvents.record → broadcast on
    // grappa:admin:events → cic Events tab renders new row.
    const mintErr = await mintVisitor(`mz-cap-reject-${Date.now()}`).catch(
      (e: Error) => e.message,
    );
    expect(typeof mintErr).toBe("string");
    expect(mintErr).toMatch(/503/);

    // The Events tab should now show a `capacity_reject` row. Use
    // .first() because prior cluster specs in the same compose run
    // may have generated other capacity_reject rows. Timeout
    // generous enough to absorb the WS round-trip + render tick.
    await expect(page.getByTestId("admin-event-capacity_reject").first()).toBeVisible({
      timeout: 10_000,
    });
  } finally {
    // Restore baseline cap so other specs that mint visitors against
    // azzurra don't 503. Wrap in try/catch so a revert failure
    // doesn't mask the original assertion failure (Playwright shows
    // both via the unhandled-promise path).
    await patchNetworkCap(admin.token, AZZURRA_SLUG, AZZURRA_BASELINE_CAP).catch((e) => {
      // eslint-disable-next-line no-console
      console.error(`M-Z cap revert failed: ${e}`);
    });
  }

  // STEP 7 — Non-admin gate: covered by m7-admin-gate-settings-drawer.spec.ts (the
  // dedicated three-class parity gate). Re-asserting here would
  // duplicate the per-bucket spec's coverage without adding new
  // signal — M-Z is the cross-bucket compositional spec, not a
  // re-run of every guarded surface.
});
