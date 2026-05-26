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

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, sidebarWindow } from "../fixtures/cicchettoPage";
import { getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

test("P-0d — /lusers surfaces LusersCard pinned in the $server window", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Focus the always-present Server sidebar slot via the shared
  // sidebarWindow fixture. Post-UX-4-C the desktop sidebar's
  // server-window entry IS the `li.sidebar-network-header` itself
  // (visible text is `⚙️ <slug>`, NOT the word "Server"); the
  // fixture's `windowName === "Server"` branch handles both desktop
  // and mobile contracts (cicchettoPage.ts:167-203). Pre-FLAKE-B
  // Part 1 the spec used a hardcoded `.sidebar-channel-name`
  // hasText "Server" filter that never matched post-UX-4-C — same
  // class of breakage that c804208 fixed for the 6 desktop specs
  // already routed through sidebarWindow().
  const serverEntry = sidebarWindow(page, NETWORK_SLUG, "Server");
  await expect(serverEntry).toHaveCount(1);
  await serverEntry.locator(".sidebar-window-btn").click();

  // Issue /lusers. Server pushes LUSERS upstream; Bahamut replies with
  // the 7-numeric sequence; 266 RPL_GLOBALUSERS flushes the bundle.
  await composeSend(page, "/lusers");

  const card = page.locator("[data-testid='lusers-card']");
  await expect(card).toBeVisible({ timeout: 5_000 });

  // Bahamut testnet has at least the operator's own session as a user
  // and the seed-joined channels — so total_users ≥ 1 and channels ≥ 1
  // must render. Assert the named-field shape (dt + numeric dd) so a
  // regression to e.g. "card visible but bundle dispatch dropped" is
  // caught (the prior /\d+/ assertion would have passed on any digit
  // anywhere in the card chrome).
  const dt = (label: string) => card.locator("dt", { hasText: new RegExp(`^${label}$`) });
  const ddFor = (label: string) =>
    dt(label).locator("xpath=following-sibling::dd[1]");

  await expect(dt("users")).toHaveCount(1);
  await expect(ddFor("users")).toContainText(/\d+/);
  await expect(dt("channels")).toHaveCount(1);
  await expect(ddFor("channels")).toContainText(/\d+/);
});
