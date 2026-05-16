// U-cluster U-5 — admin Networks tab live cap counters (real-time
// via grappa:admin:events `cap_counts_changed` broadcast).
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated EXEMPT —
// only the admin user class reaches the tab; gate at m7-admin-gate.
//
// Per `feedback_cicchetto_browser_smoke`: this Playwright spec IS
// the browser smoke for U-5. The WS subscription lifecycle + signal
// reactivity across cross-tab admin actions is invisible to vitest
// jsdom.
//
// Single spec: terminate one of the seeded user sessions from the
// Sessions tab → navigate back to Networks → assert the user-count
// numerator decremented (either via the live broadcast overlay or
// the cold-state refetch on remount; both paths must agree).
//
// Structural column-rendering coverage lives in
// `src/__tests__/AdminNetworksTab.test.tsx` (vitest); duplicating
// it here would add noise without independent signal (S5 of U-5
// review).

import { expect, test } from "@playwright/test";
import { getSeededAdmin } from "../fixtures/seedData";

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

test("U-5 Networks live user-count drops after a session is terminated", async ({ page }) => {
  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminPane(page);

  // 1. Open Networks tab; capture the bahamut-test row's USER live
  //    count (vjt + m9b-test are both user-kind sessions seeded
  //    against bahamut-test → count ≥ 2 at boot).
  await page.getByTestId("admin-tab-networks").click();
  await expect(page.getByTestId("admin-networks-table")).toBeVisible({ timeout: 10_000 });

  const bahamutUsersCell = page.getByTestId("admin-network-live-users-bahamut-test");
  await expect(bahamutUsersCell).toBeVisible();
  await expect(bahamutUsersCell).toHaveText(/^\d+\/(\d+|∞)$/);
  const initial = await bahamutUsersCell.textContent();
  if (initial === null) throw new Error("bahamut-test live users cell empty");
  const initialCount = Number.parseInt(initial.split("/")[0], 10);
  expect(initialCount).toBeGreaterThanOrEqual(1);

  // 2. Navigate to Sessions tab; terminate the first session row.
  await page.getByTestId("admin-tab-sessions").click();
  await expect(page.getByTestId("admin-sessions-table")).toBeVisible({ timeout: 10_000 });

  const firstTerminate = page.locator("[data-testid^='admin-session-terminate-']").first();
  await firstTerminate.click();
  await expect(firstTerminate).toHaveText(/^Confirm terminate\?$/);
  await firstTerminate.click();
  // Allow the action a moment to settle (REST round-trip + Session.Server
  // terminate/2 emits :cap_counts_changed telemetry which the AdminEvents
  // sink translates + broadcasts).
  await page.waitForTimeout(500);

  // 3. Navigate back to Networks tab; the onMount refetch returns the
  //    decremented live_counts from the server's Registry scan.
  //    Whether the live overlay or the cold refetch wins, the cell
  //    must reflect the post-terminate truth.
  await page.getByTestId("admin-tab-networks").click();
  await expect(page.getByTestId("admin-networks-table")).toBeVisible({ timeout: 10_000 });

  await expect
    .poll(
      async () => {
        const txt = await bahamutUsersCell.textContent();
        if (txt === null) return null;
        return Number.parseInt(txt.split("/")[0], 10);
      },
      {
        message: `expected bahamut-test users count to drop below ${initialCount}`,
        timeout: 10_000,
      },
    )
    .toBeLessThan(initialCount);
});
