// EXPERIMENT (#146 recurrence) — does the deep-link survive when the
// service worker CONTROLS the page and serves the precached shell?
//
// The shipped #146 gate (notif-tap-focus.spec.ts) drives the cold path
// via `page.goto(deepLink)` on a FRESH context, where the SW has not
// registered/claimed yet, so index.html is served from the NETWORK.
// On a real installed PWA the SW is already registered and CLAIMS the
// page, so `clients.openWindow(deepLink)` is served from PRECACHE via
// the Workbox NavigationRoute. That serving path — and the `/session`
// denylist added in 7816c53 — is never exercised by the shipped gate.
//
// This spec forces the real-device shape: load `/` first so the SW
// registers + claims, wait for `navigator.serviceWorker.controller`,
// THEN navigate to the deep-link so the SW-controlled precache serves
// it. If the deep-link routing survives the network-served path but
// NOT the SW-served path, this is RED while the shipped gate is GREEN.

import { expect, test } from "../fixtures/test";
import { loginAs, sidebarWindow } from "../fixtures/cicchettoPage";
import { buildPushDeepLink } from "../fixtures/pushTap";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const DM_PEER = "notif146-swctl";

test.describe("#146 recurrence — SW-controlled deep-link serving", () => {
  test("channel deep-link survives SW-controlled precache serving", async ({ page }) => {
    const vjt = getSeededVjt();
    // loginAs seeds auth + goto("/") + waits for shell ready. The SW
    // registers on window.load during this navigation.
    await loginAs(page, vjt);
    // Wait for the SW to actually CLAIM this page (controller set) —
    // otherwise the next navigation would still be network-served.
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: 15_000,
    });

    const channel = AUTOJOIN_CHANNELS[0];
    // Now navigate to the deep-link — SW-controlled → precache-served,
    // exactly the `openWindow(url)` real-device shape.
    await page.goto(buildPushDeepLink(NETWORK_SLUG, channel));

    await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveClass(/selected/, {
      timeout: 15_000,
    });
  });

  test("DM deep-link survives SW-controlled precache serving", async ({ page }) => {
    const vjt = getSeededVjt();
    await loginAs(page, vjt);
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
      timeout: 15_000,
    });

    await page.goto(buildPushDeepLink(NETWORK_SLUG, DM_PEER));

    await expect(sidebarWindow(page, NETWORK_SLUG, DM_PEER)).toHaveClass(/selected/, {
      timeout: 15_000,
    });
  });
});
