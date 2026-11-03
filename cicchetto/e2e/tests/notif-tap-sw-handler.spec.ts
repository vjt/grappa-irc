// #146 recurrence — drive the REAL service-worker `notificationclick`
// handler, not the synthetic `applyPushTarget` / MessageEvent shortcuts
// the shipped gate uses.
//
// The shipped gate (notif-tap-focus.spec.ts) proved the cic ROUTING
// (open-then-select) is correct. It never exercised the SW→page
// DELIVERY: `focusOrOpen` runs `await client.focus()` and only THEN
// `client.postMessage({type:"navigate"})`. `WindowClient.focus()`
// returns a Promise that REJECTS when the call lacks transient
// activation (headless synthetic dispatch — and, in the field, iOS /
// WebKit reject it even from a genuine notification tap). A rejected
// `focus()` throws out of `focusOrOpen` BEFORE `postMessage` runs, so
// the navigate never reaches the page → the tap opens nothing. That is
// the recurrence: the routing is fine, the delivery is swallowed.
//
// This spec dispatches a real `notificationclick` into the live SW and
// asserts the page still receives the navigate (window becomes
// selected). RED against the `await focus(); postMessage()` ordering,
// GREEN once delivery no longer depends on focus() resolving.

import { loginAs, sidebarWindow } from "../fixtures/cicchettoPage";
import { buildPushDeepLink, tapNotification } from "../fixtures/pushTap";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

test("#146 recurrence — real SW notificationclick delivers the navigate even when focus() rejects", async ({
  page,
  context,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  // The page is now a window client and the SW is registered. Wait for
  // it to claim the page so `clients.matchAll` inside focusOrOpen sees
  // this client.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 15_000,
  });

  const channel = AUTOJOIN_CHANNELS[0];
  // Baseline: the channel is not the focused window before the tap.
  await expect(sidebarWindow(page, NETWORK_SLUG, channel)).not.toHaveClass(/selected/);

  const url = buildPushDeepLink(NETWORK_SLUG, channel);

  // Dispatch a real `notificationclick` into the SW; the outcome of its
  // `waitUntil` says whether focusOrOpen rejected (the swallow).
  const waitUntilResult = await tapNotification(context, url);
  // Diagnostic only — a "rejected: ..." here is the focus() swallow.
  console.log(`focusOrOpen waitUntil → ${waitUntilResult}`);

  // User-visible contract: the tapped channel is now focused. This only
  // holds if the navigate reached the page despite focus() rejecting.
  await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveClass(/selected/, {
    timeout: 10_000,
  });
});
