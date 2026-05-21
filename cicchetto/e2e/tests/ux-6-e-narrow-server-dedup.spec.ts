// UX-6-E — narrow-mode (mobile) Server-tab dedup.
//
// Pre-fix narrow shape:
//   [freenode]  [Server]  [#bofh]  ...
//   ^chip span  ^standalone tab     channel tabs
//
// Post-fix shape (matches wide mode, where the network header IS the
// server entry):
//   [⚙️ freenode]  [×]  [#bofh]  ...
//   ^clickable header   ^channel tabs
//
// The chip + emoji + slug compose the Server-window entry; clicking it
// dispatches selectedChannel.kind = "server". The separate "Server"
// label is gone — one entry per network instead of two.
//
// @webkit tag opts into the webkit-iphone-15 project (393×852, mobile
// branch). Per `feedback_e2e_visitor_members_list` etc., UX-bucket
// specs (not IRC-function parity) don't loop across user classes —
// visitor login is sufficient. Per `feedback_ux_e2e_mandatory`, every
// cic UX-behavior change ships a Playwright e2e.

import { expect, test } from "@playwright/test";
import { loginAs } from "../fixtures/cicchettoPage";
import { getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

test("@webkit UX-6-E — narrow mode renders one network entry; no standalone 'Server' tab", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // The per-network section now contains a `.bottom-bar-network-header`
  // (clickable) instead of the old chip+Server-tab pair.
  const section = page.locator(".bottom-bar-network", {
    has: page.locator(`.bottom-bar-network-header[data-network-slug="${NETWORK_SLUG}"]`),
  });
  await expect(section).toBeVisible({ timeout: 10_000 });

  const header = section.locator(`.bottom-bar-network-header[data-network-slug="${NETWORK_SLUG}"]`);
  await expect(header).toBeVisible();
  await expect(header).toContainText(NETWORK_SLUG);

  // The old standalone "Server" label is gone: no .bottom-bar-tab whose
  // own text starts with "Server" (the header has the emoji + slug, not
  // the word "Server"). Filter excludes the header so a regression that
  // re-introduces a standalone Server tab inside the same section trips.
  const standaloneServer = section
    .locator(".bottom-bar-tab:not(.bottom-bar-network-header)")
    .filter({ hasText: /^Server$/ });
  await expect(standaloneServer).toHaveCount(0);
});

test("@webkit UX-6-E — clicking the network-header focuses the server window", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const header = page.locator(
    `.bottom-bar-network-header[data-network-slug="${NETWORK_SLUG}"]`,
  );
  await expect(header).toBeVisible({ timeout: 10_000 });

  // Pre-tap: header isn't selected (login lands on home).
  await expect(header).not.toHaveClass(/selected/);

  await header.tap();

  // Post-tap: header carries `.selected` (kind=server is now active).
  await expect(header).toHaveClass(/selected/, { timeout: 5_000 });
});

test("@webkit UX-6-E — network-header has a disconnect × sibling, mirroring sidebar", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const section = page.locator(".bottom-bar-network", {
    has: page.locator(`.bottom-bar-network-header[data-network-slug="${NETWORK_SLUG}"]`),
  });
  // The disconnect × is the immediate sibling after the header — same
  // sibling discipline as channel/query close buttons (post-UX-3-DEC).
  const disconnectBtn = section.locator(
    `.bottom-bar-network-header[data-network-slug="${NETWORK_SLUG}"] + .bottom-bar-close`,
  );
  await expect(disconnectBtn).toBeVisible();
  await expect(disconnectBtn).toHaveAttribute("aria-label", `Disconnect ${NETWORK_SLUG}`);
});
