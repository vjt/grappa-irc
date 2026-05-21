// iOS-3 — Bottom-bar tab close × on mobile.
//
// BottomBar tabs gained a close × per channel + query window (server
// window remains non-closeable). Webkit iPhone 15 emulation hits the
// mobile branch (393×852 viewport ≤ 768px) so BottomBar renders
// instead of Sidebar. Tap × → PART REST call → channel removed from
// channelsBySlug → tab disappears from BottomBar.
//
// Subject-agnostic UX: visitor is sufficient — no /msg /query DM
// path needed here; the channel #bofh autojoin gives us the tab to
// close. iOS-3 is mechanical render+click; per-class parity matrix
// (per `feedback_e2e_user_class_parity_matrix`) doesn't apply (UX
// bucket, not an IRC-function spec).
//
// @webkit tag opts into the webkit-iphone-15 project per
// e2e/playwright.config.ts grep.

import { expect, test } from "@playwright/test";
import { loginAs, sidebarCloseButton, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0]; // #bofh

test("@webkit iOS-3 — bottom-bar channel tab close × removes the tab", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Tab is present after login + autojoin completes.
  const tab = sidebarWindow(page, NETWORK_SLUG, CHANNEL);
  await expect(tab).toBeVisible({ timeout: 10_000 });

  // Close × is rendered as a flat sibling of the tab in the
  // bottom-bar (post-UX-3-DEC the wrapping <span> is dropped).
  const closeBtn = sidebarCloseButton(page, NETWORK_SLUG, CHANNEL);
  await expect(closeBtn).toBeVisible();
  await expect(closeBtn).toHaveText("×");
  await expect(closeBtn).toHaveAttribute("aria-label", `Close ${CHANNEL}`);

  // Tap × — fires PART via closeChannelWindow → postPart REST.
  await closeBtn.tap();

  // The channel disappears from channelsBySlug once the server
  // emits PART; sidebarWindow's hasText filter no longer matches.
  // Generous timeout: PART round-trips through HTTP + IRC server.
  await expect(tab).not.toBeVisible({ timeout: 10_000 });
});

test("@webkit iOS-3 — bottom-bar Server tab has NO close × button", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // UX-6-E: the server-window entry is now the network header itself
  // (`.bottom-bar-network-header`, replacing the old chip+Server-tab
  // pair). It DOES have a sibling × — but that × disconnects the
  // network (mirrors the wide-mode UX-4-D affordance), not "close the
  // server window." iOS-3's invariant — "server window itself is not
  // closeable via a tab × the way channels/queries are" — still holds:
  // no `bottom-bar-close` element is `aria-label="Close <something>"`
  // for the Server tab. The disconnect × is `aria-label="Disconnect
  // <slug>"` and is asserted by ux-6-e-narrow-server-dedup.spec.ts.
  const section = page.locator(".bottom-bar-network", {
    has: page.locator(`.bottom-bar-network-header[data-network-slug="${NETWORK_SLUG}"]`),
  });
  const header = section.locator(
    `.bottom-bar-network-header[data-network-slug="${NETWORK_SLUG}"]`,
  );
  await expect(header).toBeVisible({ timeout: 10_000 });

  // No "Close Server" affordance exists — direct aria-label assertion
  // for clarity. The disconnect × on the header is aria-label="Disconnect
  // <slug>", a separate invariant (see ux-6-e-narrow-server-dedup).
  const closeServerBtn = section.locator('.bottom-bar-close[aria-label="Close Server"]');
  await expect(closeServerBtn).toHaveCount(0);
});
