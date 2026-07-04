// #181 — push subscription survives a silent drop, and the ghost row does
// NOT accumulate.
//
// Root cause (live iOS debug, 2026-07-04): the browser silently drops
// `pushManager.getSubscription()` across a service-worker swap (bundle
// refresh) / storage eviction WITHOUT unsubscribing, so the push service
// keeps 2xx-ing the dead endpoint (no 410 → the server prune never fires)
// and nothing re-subscribes. Repeated manual re-enables then minted a new
// row each time → ghost devices piled up "subscribed but undeliverable".
//
// Fix, end-to-end, exercised here:
//   1. CLIENT — `installPushResubscribe` (main.tsx) renews the dropped
//      subscription on the SW-update seam (`controllerchange`) via
//      `ensurePushSubscription` (RENEW-ONLY: permission granted + a stashed
//      endpoint proving prior opt-in + a now-null live subscription).
//   2. The renew POSTs the fresh subscription with
//      `supersedes: <old endpoint>`.
//   3. SERVER — `Push.create/2` deletes that subject-scoped old row
//      atomically with the insert, so the device list stays at ONE entry
//      (the ghost is pruned) instead of growing to two.
//
// This drives the REAL controllerchange → installPushResubscribe →
// ensurePushSubscription → POST → server-supersede path. The stub only
// stands in for the push VENDOR (no real Web Push service in the harness),
// exactly like the other push specs; the drop + endpoint-rotation is the
// behaviour iOS exhibits.

import type { BrowserContext } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { resetPushCatcher, resetPushSubscriptions } from "../fixtures/push";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const ENDPOINT_A = "https://push.example/e2e/resub-A";
const ENDPOINT_B = "https://push.example/e2e/resub-B";
const GRAPPA_BASE = "http://grappa-test:4000";

// Real ECDSA P-256 public key + auth secret (same pair the Sender Bypass
// tests use) so the server changeset length caps + any encrypt step pass.
const STUB_P256DH =
  "BCfaYE5dGabdzef68MI0SN24b4Gsf1t_N3ftUlWaFGzkuudjHLor0CRjosM3c7SLZ7PfFufpsFUh8vsO1t8wCHs";
const STUB_AUTH = "dGVzdC1hdXRoLXNlY3JldDE2Yg";

// Self-contained vendor stub: `subscribe()` returns the CURRENT endpoint
// and marks the browser subscribed; `getSubscription()` reflects that; and
// `window.__e2ePushDrop(next)` reproduces the iOS silent-drop-with-rotation
// (live subscription vanishes, next subscribe mints a fresh endpoint).
async function stubRotatingPushManager(
  context: BrowserContext,
  opts: { initialEndpoint: string },
): Promise<void> {
  await context.addInitScript(
    ([initialEndpoint, p256dh, auth]) => {
      Object.defineProperty(Notification, "permission", {
        configurable: true,
        get: () => "granted",
      });
      Notification.requestPermission = async () => "granted";

      let subscribed = false;
      let currentEndpoint = initialEndpoint;
      const fakeSub = (endpoint: string) => ({
        endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: null },
        toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
        unsubscribe: async () => true,
      });

      const stubManager = {
        subscribe: async () => {
          subscribed = true;
          return fakeSub(currentEndpoint);
        },
        getSubscription: async () => (subscribed ? fakeSub(currentEndpoint) : null),
        permissionState: async () => "granted",
        __cic_push_stub: true,
      };

      const originalReady = navigator.serviceWorker.ready;
      Object.defineProperty(navigator.serviceWorker, "ready", {
        configurable: true,
        get: () =>
          originalReady.then((reg) => {
            Object.defineProperty(reg, "pushManager", {
              configurable: true,
              get: () => stubManager,
            });
            return reg;
          }),
      });

      // Reproduce the silent drop: live subscription gone + endpoint rotated.
      (window as unknown as { __e2ePushDrop: (next: string) => void }).__e2ePushDrop = (
        next: string,
      ) => {
        subscribed = false;
        currentEndpoint = next;
      };
    },
    [opts.initialEndpoint, STUB_P256DH, STUB_AUTH] as const,
  );
}

async function listDeviceCount(token: string): Promise<number> {
  const res = await fetch(`${GRAPPA_BASE}/push/subscriptions`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) return 0;
  const body = (await res.json()) as { subscriptions?: unknown[] };
  return body.subscriptions?.length ?? 0;
}

test("silent drop → controllerchange re-subscribes with supersedes; device list stays at 1 (#181)", async ({
  page,
  context,
}) => {
  const vjt = getSeededVjt();
  await resetPushCatcher();
  await resetPushSubscriptions(vjt.token);
  await stubRotatingPushManager(context, { initialEndpoint: ENDPOINT_A });
  await context.grantPermissions(["notifications"]);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  // Enable push: toggle → subscribe (endpoint A) → POST → device list = 1.
  await page.locator('[aria-label="open settings"]').click();
  const toggle = page.locator('[data-testid="push-master-toggle"]');
  await expect(toggle).toBeVisible();
  await toggle.click();
  await expect(page.locator('[data-testid="devices-list"] li')).toHaveCount(1, { timeout: 5_000 });
  expect(await listDeviceCount(vjt.token)).toBe(1);

  // Arm the waiter BEFORE the drop — its predicate only matches the
  // supersedes-bearing renew POST (the enable POST above has none), so a
  // renewal fired by any seam (controllerchange OR a spontaneous
  // visibilitychange) is captured with no race window.
  const resubPost = page.waitForRequest(
    (req) =>
      req.url().endsWith("/push/subscriptions") &&
      req.method() === "POST" &&
      (req.postData() ?? "").includes("supersedes"),
    { timeout: 8_000 },
  );

  // Silent drop + endpoint rotation (iOS SW-swap / eviction).
  await page.evaluate((next) => {
    (window as unknown as { __e2ePushDrop: (n: string) => void }).__e2ePushDrop(next);
  }, ENDPOINT_B);

  // Fire the SW-update seam that installPushResubscribe listens on.
  await page.evaluate(() => {
    navigator.serviceWorker.dispatchEvent(new Event("controllerchange"));
  });

  const req = await resubPost;
  const body = JSON.parse(req.postData() ?? "{}") as { endpoint?: string; supersedes?: string };
  expect(body.endpoint).toBe(ENDPOINT_B);
  expect(body.supersedes).toBe(ENDPOINT_A);

  // Server superseded the ghost: exactly ONE device remains (B), not two.
  await expect
    .poll(async () => listDeviceCount(vjt.token), { timeout: 5_000 })
    .toBe(1);
});
