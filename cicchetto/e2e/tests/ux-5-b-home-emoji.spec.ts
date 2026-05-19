// UX-5 bucket B — home sidebar row 🏠 emoji icon.
//
// Pre-bucket symptom (vjt 2026-05-19 dogfood):
//   The home row in the desktop sidebar (UX-4 bucket B addition)
//   rendered only the text "Home" — no emoji icon. Visual outlier
//   against the bucket-C network row (`⚙️ <slug>`) and bucket-N
//   admin row (`🔧 admin`).
//
// Post-bucket end state:
//   Home row carries a `.sidebar-home-emoji` span (aria-hidden) with
//   the 🏠 character, in the same slot position as the admin/network
//   rows. CSS class naming mirrors `sidebar-<kind>-emoji` for cic
//   reader symmetry.
//
// Parity matrix per `feedback_e2e_user_class_parity_matrix`: this
// asserts a UI shape contract that is subject-shape-agnostic — the
// home row renders identically for visitor / nickserv / registered.
// One registered class pass is sufficient. Chromium-only — mobile
// uses BottomBar and the home row is not present there.

import { test, expect } from "@playwright/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt } from "../fixtures/seedData";

test.setTimeout(60_000);

test("ux-5-b — home sidebar row renders the 🏠 emoji icon", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Shell mounted; cold-load lands on home (UX-4 bucket B selection
  // default). The sidebar's home section is identity-scoped and always
  // mounted regardless of network state.
  await expect(page.getByTestId("shell-chrome")).toBeVisible({ timeout: 10_000 });

  const homeEmoji = page.locator(".sidebar-home-section .sidebar-home-emoji");
  await expect(homeEmoji).toHaveCount(1);
  await expect(homeEmoji).toHaveText("🏠");

  // Belt-and-suspenders: the emoji span lives INSIDE the home button
  // (sibling of the "Home" label span), not as a stray standalone
  // element. Catches a regression that moves the emoji outside the
  // button or that drops the .sidebar-home-btn parent.
  const homeBtn = page.locator(".sidebar-home-section .sidebar-home-btn");
  await expect(homeBtn.locator(".sidebar-home-emoji")).toHaveCount(1);
  await expect(homeBtn).toContainText("Home");
});
