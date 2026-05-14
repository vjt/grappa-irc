// push-install — push notifications cluster B5 spec 1b
// (2026-05-14).
//
// Coverage: full enable-push happy path. Operator opens settings,
// flips the master toggle, the cic `enablePush()` orchestrator
// (cicchetto/src/lib/push.ts):
//   1. Reads Notification.permission (granted via
//      `context.grantPermissions(["notifications"])`).
//   2. Awaits `navigator.serviceWorker.ready` then calls
//      `pushManager.subscribe` (stubbed via fixtures/push.ts to
//      return a push-catcher endpoint, since the integration
//      harness has no real Web Push vendor reachable).
//   3. POSTs the subscription to `/push/subscriptions`
//      (PushSubscriptionController.create).
//   4. Refreshes `GET /push/subscriptions` to populate the device
//      list.
//
// Outcome assertions:
//   * Devices list shows 1 entry (server persisted, list endpoint
//     returns the new row).
//   * The toggle is checked.
//   * No banner (banner is the unhappy-path surface).

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import {
  pushCatcherEndpoint,
  resetPushCatcher,
  resetPushSubscriptions,
  stubPushManager,
} from "../fixtures/push";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SUB_ID = "install-happy";

test("master toggle enables push: subscribe → POST /push/subscriptions → device list shows 1", async ({
  page,
  context,
}) => {
  const vjt = getSeededVjt();
  await resetPushCatcher();
  // The seeded `vjt` user is shared across every push spec; without
  // a per-spec wipe of push_subscriptions, leftover rows from prior
  // specs poison the devices-list count + Push.Sender's per-user
  // fan-out target list.
  await resetPushSubscriptions(vjt.token);
  await stubPushManager(context, { endpoint: pushCatcherEndpoint(SUB_ID) });
  await context.grantPermissions(["notifications"]);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  // Watch for the subscribe POST so we can assert request shape +
  // response status. POST may fire before the devices-list refresh,
  // so we set up the waiter before the click.
  const subscribePostPromise = page.waitForResponse(
    (resp) =>
      resp.url().endsWith("/push/subscriptions") && resp.request().method() === "POST",
    { timeout: 5_000 },
  );

  await page.locator('[aria-label="open settings"]').click();
  const toggle = page.locator('[data-testid="push-master-toggle"]');
  await expect(toggle).toBeVisible();
  await toggle.click();

  const subscribeResp = await subscribePostPromise;
  expect(subscribeResp.status()).toBe(201);
  const created = (await subscribeResp.json()) as { id: string; created_at: string };
  expect(typeof created.id).toBe("string");
  expect(created.id).not.toBe("");

  // Device list reflects the new subscription. Banner stays absent
  // (no permission_denied / unsupported branch fired).
  await expect(page.locator('[data-testid="devices-list"] li')).toHaveCount(1, {
    timeout: 5_000,
  });
  await expect(page.locator('[data-testid="push-banner"]')).toHaveCount(0);
  await expect(toggle).toBeChecked();
});
