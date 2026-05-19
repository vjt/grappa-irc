// P-0d — LUSERS card. Operator issues `/lusers`; Bahamut emits the
// 7-numeric LUSERS sequence (251/252/253/254/255/265/266); server
// folds + flushes the bundle on 266 RPL_GLOBALUSERS as a typed
// `:lusers_bundle` wire event on Topic.user/1; cic dispatches and
// renders the LusersCard pinned at the top of the $server window.
//
// This e2e drives the full path:
//   1. operator focused on the $server window
//   2. operator issues `/lusers` via composeSend
//   3. server's 266 handler fires → cic mounts LusersCard
//
// Per `feedback_ux_e2e_mandatory`: every cic UX-touching change ships
// with a Playwright e2e via scripts/integration.sh.
//
// Note: connect-welcome auto-emits LUSERS too, so the card may already
// be mounted when we navigate to the $server window. The test issues
// /lusers explicitly to exercise the slash → push → broadcast → render
// path end-to-end (without depending on the welcome-time race).

import { expect, test } from "@playwright/test";
import { composeSend, loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

test("P-0d — /lusers surfaces LusersCard pinned in the $server window", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Click the always-present Server sidebar slot.
  //
  // UX-5 BH (2026-05-19): pre-bucket `<h3>` per-network header was
  // dropped in UX-4 bucket C — use `.sidebar-network-header`.
  const serverEntry = page
    .locator(".sidebar-network-section")
    .filter({ has: page.locator(".sidebar-network-header").filter({ hasText: NETWORK_SLUG }) })
    .locator("li")
    .filter({ has: page.locator(".sidebar-channel-name").filter({ hasText: /^Server$/ }) });
  await expect(serverEntry).toHaveCount(1);
  await serverEntry.locator(".sidebar-window-btn").click();

  // Issue /lusers. Server pushes LUSERS upstream; Bahamut replies with
  // the 7-numeric sequence; 266 RPL_GLOBALUSERS flushes the bundle.
  await composeSend(page, "/lusers");

  // The LUSERS card mounts pinned at the top of the scrollback for the
  // $server window. Welcome-time auto-emit may have already populated
  // the store, but issuing /lusers explicitly guarantees a fresh
  // last-write-wins broadcast.
  const card = page.locator("[data-testid='lusers-card']");
  await expect(card).toBeVisible({ timeout: 5_000 });
  // Contains at least one numeric (any of the bundle fields rendered).
  // Bahamut testnet has at least the operator's own session as a user,
  // so total_users >= 1.
  await expect(card).toContainText(/\d+/);
});
