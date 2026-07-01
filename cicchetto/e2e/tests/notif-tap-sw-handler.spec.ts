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

import { expect, test } from "../fixtures/test";
import { loginAs, sidebarWindow } from "../fixtures/cicchettoPage";
import { buildPushDeepLink } from "../fixtures/pushTap";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

test("#146 recurrence — real SW notificationclick delivers the navigate even when focus() rejects", async ({
  page,
  context,
}) => {
  const vjt = getSeededVjt();
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

  // Grab the live SW object.
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

  // Dispatch a real `notificationclick` into the SW. The synthetic event
  // carries the notification shape the handler reads (`data.url`,
  // `close()`); `waitUntil` collects the focusOrOpen promise so we can
  // see whether it rejected (the swallow).
  const waitUntilResult = await sw.evaluate((targetUrl) => {
    const ev = new Event("notificationclick") as Event & {
      notification: { data: { url: string }; close: () => void };
      waitUntil: (p: Promise<unknown>) => void;
    };
    ev.notification = { data: { url: targetUrl }, close() {} };
    let collected: Promise<unknown> = Promise.resolve();
    ev.waitUntil = (p: Promise<unknown>) => {
      collected = p;
    };
    self.dispatchEvent(ev);
    return collected.then(
      () => "resolved",
      (e) => `rejected: ${e}`,
    );
  }, url);
  // Diagnostic only — a "rejected: ..." here is the focus() swallow.
  console.log(`focusOrOpen waitUntil → ${waitUntilResult}`);

  // User-visible contract: the tapped channel is now focused. This only
  // holds if the navigate reached the page despite focus() rejecting.
  await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveClass(/selected/, {
    timeout: 10_000,
  });
});
