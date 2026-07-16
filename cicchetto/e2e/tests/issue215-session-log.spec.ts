// #215 — admin Session Log tab end-to-end: the persisted IRC
// session-lifecycle log tail renders in the browser.
//
// Proves the whole read chain: the seeded `vjt` session connects to the
// testnet on boot → `Grappa.Session.Server` emits `:connected` /
// `:registered` → `Grappa.SessionLog` sink persists to `session_log_events`
// → `GET /admin/session_log` tail → `AdminSessionLogTab` renders. The
// disconnect-reason/duration + live-channel-push logic is covered by the
// server integration test + the AdminChannel/vitest unit tests; this spec
// is the browser smoke (jsdom is blind to the real REST+render surface).
//
// Per `feedback_e2e_user_class_parity_matrix`: admin-gated → EXEMPT from
// the visitor/nickserv/registered parity matrix (only the admin class
// reaches the tab; the gate itself is m7-admin-gate). Mirror of
// `m11-admin-events-live.spec.ts`.

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

test("#215 Session Log tab renders the persisted session-lifecycle tail", async ({ page }) => {
  await adminFriendlyLogin(page, getSeededAdmin());
  await openAdminPane(page);

  await page.getByTestId("admin-tab-session_log").click();
  await expect(page.getByTestId("admin-session-log-tab")).toBeVisible();

  // The seeded vjt session connected on boot → connect + register
  // lifecycle events are persisted; the tail read renders them. This
  // validates emit → sink persist → REST tail → cic render end-to-end.
  const rows = page.locator("[data-testid^='session-log-row-']");
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  expect(await rows.count()).toBeGreaterThan(0);

  // The composite session-id (`<kind>:<uuid>:<network_id>`) renders — a
  // structured row, not a placeholder.
  await expect(page.locator(".session-log-session-id").first()).toContainText(/^(user|visitor):/);
});
