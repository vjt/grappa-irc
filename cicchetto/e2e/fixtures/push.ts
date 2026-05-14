// Push-notifications e2e helpers — push notifications cluster B5
// (2026-05-14).
//
// Three concerns:
//
//   1. **Stub `pushManager.subscribe`** so the install-path spec can
//      complete the cic enablePush() dance without a real push vendor
//      registration. The real W3C `pushManager.subscribe` would
//      contact FCM / Mozilla autopush and fail in the integration
//      stack (no external network, no valid VAPID-public-key
//      registration with a vendor). The stub returns a
//      PushSubscription-shaped object whose `endpoint` points at the
//      push-catcher sidecar — cic POSTs that endpoint to
//      /push/subscriptions, server stores the row, and B2's
//      Push.Sender then routes to push-catcher.
//
//   2. **Grant / clear notification permission** at the BrowserContext
//      level so cic's `Notification.requestPermission()` short-
//      circuits to "granted" / "denied" without an OS dialog.
//
//   3. **Push-catcher REST client** for spec-side polling of "did a
//      Sender POST land for subscription <id>?". Mirrors
//      grappaApi.assertMessagePersisted's poll-with-timeout shape.
//
// Why a single helper module + page-level initScript stub instead of
// per-spec inline setup: each push-trigger spec opens a fresh
// BrowserContext, completes the same `loginAs + enablePush + assert
// catcher` sequence, and tears down by resetting catcher state. The
// helper lifts that ritual into one call site so the specs read like
// "operator enables push, peer mentions, catcher saw a body".
//
// Boundaries with cicchettoPage.ts: this module owns push-specific
// glue (initScript, permissions, catcher REST). Window-state
// assertions, scrollback queries, channel selection still come from
// cicchettoPage.ts — push specs use both.

import { type BrowserContext, type Page, expect } from "@playwright/test";

const PUSH_CATCHER_URL = process.env.E2E_PUSH_CATCHER_URL ?? "http://push-catcher:3000";

// W3C PushSubscription shape that cic's enablePush -> postPushSubscription
// expects. Mirrors `cicchetto/src/lib/push.ts` PushSubscribeRequest.
export type StubSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

// Real ECDSA P-256 client public key + auth secret used by the
// Sender Bypass test fixture (test/grappa/push/sender_test.exs).
// Reusing them here so the changeset's length validations
// (`p256dh_key max: 256`, `auth_key max: 64`) trivially pass and
// the upstream `:web_push_elixir` lib's encrypt step doesn't
// reject a malformed key when Sender actually fans out.
const STUB_P256DH =
  "BCfaYE5dGabdzef68MI0SN24b4Gsf1t_N3ftUlWaFGzkuudjHLor0CRjosM3c7SLZ7PfFufpsFUh8vsO1t8wCHs";
const STUB_AUTH = "dGVzdC1hdXRoLXNlY3JldDE2Yg";

/**
 * Mints a per-spec push-catcher endpoint. Each spec uses a unique
 * id so concurrent specs (when fullyParallel flips on later) and
 * within-spec multi-device cases don't pollute each other's
 * catcher inbox.
 */
export function pushCatcherEndpoint(id: string): string {
  return `${PUSH_CATCHER_URL}/p/${encodeURIComponent(id)}`;
}

/**
 * Adds an initScript that monkey-patches
 * `navigator.serviceWorker.ready.pushManager.subscribe` to return a
 * fake PushSubscription pointing at the push-catcher endpoint. Also
 * stubs `getSubscription()` so cic's probe-on-mount sees the active
 * subscription on subsequent loads.
 *
 * Additionally forces `Notification.permission === "granted"` because
 * chromium's headless mode reports `denied` for the getter even
 * after `context.grantPermissions(["notifications"])` (the grant
 * affects only `Notification.requestPermission()`'s resolved value;
 * the synchronous getter remains "denied"). Cic's `enablePush()`
 * short-circuits on the getter check before reaching
 * requestPermission, so without this stub the install path always
 * trips `permission_denied`.
 *
 * MUST be called BEFORE `page.goto` — initScript runs in every new
 * document context BEFORE any page script, so the stub is in place
 * when cic's `enablePush` resolves `navigator.serviceWorker.ready`.
 */
export async function stubPushManager(
  context: BrowserContext,
  opts: { endpoint: string },
): Promise<void> {
  await context.addInitScript(
    ([endpoint, p256dh, auth]) => {
      Object.defineProperty(Notification, "permission", {
        configurable: true,
        get: () => "granted",
      });
      Notification.requestPermission = async () => "granted";

      const fakeSubscription = {
        endpoint,
        expirationTime: null,
        options: { userVisibleOnly: true, applicationServerKey: null },
        getKey: (name: string) => {
          // Return a stub ArrayBuffer so any caller that introspects
          // the keys via getKey doesn't NPE. Production cic uses
          // toJSON only, so this branch is defensive.
          const src = name === "p256dh" ? p256dh : auth;
          const bytes = new Uint8Array(src.length);
          for (let i = 0; i < src.length; i++) bytes[i] = src.charCodeAt(i);
          return bytes.buffer;
        },
        toJSON: () => ({ endpoint, keys: { p256dh, auth } }),
        unsubscribe: async () => true,
      };
      // State: starts unsubscribed (matches a fresh browser profile).
      // `subscribe()` flips the flag — subsequent `getSubscription()`
      // calls reflect the post-subscribe state. SettingsDrawer's
      // `probeLocalSubscription` (onMount) calls getSubscription
      // BEFORE the user clicks the master toggle; if we returned the
      // fake sub eagerly, the toggle would render pre-checked + the
      // toggle.check() in the spec would be a no-op (no POST fires).
      let subscribed = false;
      // Patch the registration's pushManager AFTER serviceWorker.ready
      // resolves — registration is a real object owned by the browser,
      // we only swap its pushManager property.
      const originalReady = navigator.serviceWorker.ready;
      Object.defineProperty(navigator.serviceWorker, "ready", {
        configurable: true,
        get: () =>
          originalReady.then((reg) => {
            // Idempotent — multiple `await ready` calls in the same
            // page session must yield the same patched pushManager.
            // @ts-expect-error — patching for test-seam purposes.
            if (reg.pushManager.__cic_push_stub === true) return reg;
            const stubManager = {
              subscribe: async () => {
                subscribed = true;
                return fakeSubscription;
              },
              getSubscription: async () => (subscribed ? fakeSubscription : null),
              permissionState: async () => "granted",
              __cic_push_stub: true,
            };
            Object.defineProperty(reg, "pushManager", {
              configurable: true,
              get: () => stubManager,
            });
            return reg;
          }),
      });
    },
    [opts.endpoint, STUB_P256DH, STUB_AUTH] as const,
  );
}

/**
 * Adds an initScript that overrides `navigator.serviceWorker.ready`
 * so `pushManager.subscribe` rejects with a NotAllowedError, AND
 * `Notification.permission` is forced to "denied". Used by the
 * permission-denied spec to simulate the "user clicked Block at the
 * browser permission prompt" path without needing a real OS dialog.
 *
 * MUST be called BEFORE `page.goto` — same reason as stubPushManager.
 */
export async function stubPushManagerDenied(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(Notification, "permission", {
      configurable: true,
      get: () => "denied",
    });
    Notification.requestPermission = async () => "denied";
  });
}

/**
 * Hands a per-spec subscription id to the push-catcher's `/reset`
 * endpoint so prior runs' deliveries don't bleed into this spec.
 * Cleaner than per-id `DELETE /received/<id>` because resets cover
 * the multi-device shape too.
 */
export async function resetPushCatcher(): Promise<void> {
  const res = await fetch(`${PUSH_CATCHER_URL}/reset`, { method: "POST" });
  if (!res.ok) {
    throw new Error(`resetPushCatcher: ${res.status} ${await res.text()}`);
  }
}

/**
 * Default `notification_prefs` shape — MUST stay in lockstep with
 * `Grappa.UserSettings.default_notification_prefs/0` AND
 * `cicchetto/src/lib/userSettings.ts:DEFAULT_NOTIFICATION_PREFS`.
 *
 * Re-importing from `cicchetto/src/lib/userSettings.ts` would require
 * a path alias in `cicchetto/e2e/tsconfig.json` and a transitive
 * import of solid-router types — heavier than this small literal.
 * The drift class is real but bounded: a new pref key would silently
 * keep writing the old shape AND break cic's TypeScript at the same
 * time; the latter is the loud failure mode.
 */
const DEFAULT_NOTIFICATION_PREFS = {
  channel_messages_all: false,
  channel_messages_only: [] as string[],
  channel_mentions: true,
  private_messages_all: true,
  private_messages_only: [] as string[],
};

/**
 * Resets `notification_prefs` to the cic defaults via PUT
 * /me/settings/notification-prefs. Mirrors
 * `Grappa.UserSettings.default_notification_prefs/0`. Push prefs
 * persist across specs (server-side row, shared seeded vjt user);
 * the prefs-whitelist spec turns `channel_mentions` off, which
 * silently breaks subsequent channel-mention specs unless reset.
 */
export async function resetNotificationPrefs(token: string): Promise<void> {
  const base = "http://grappa-test:4000";
  await fetch(`${base}/me/settings/notification-prefs`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(DEFAULT_NOTIFICATION_PREFS),
  });
}

/**
 * Deletes every push_subscription row owned by `token`'s user. Cic's
 * GET /push/subscriptions exposes the row ids; DELETE /push/
 * subscriptions/:id removes them. Specs share the seeded `vjt`
 * user (per fixtures/seedData.ts), so without this teardown the
 * install spec's subscription leaks into permission-denied + every
 * trigger spec, polluting devices-list assertions and confusing
 * Push.Sender's per-user fan-out target list.
 */
export async function resetPushSubscriptions(token: string): Promise<void> {
  // grappa REST surface for the runner — same base as grappaApi.
  const base = "http://grappa-test:4000";
  const headers = { authorization: `Bearer ${token}` };
  const list = await fetch(`${base}/push/subscriptions`, { headers });
  if (!list.ok) {
    // Treat missing endpoint / 401 as "nothing to clean" — first-run
    // shape before any subscription has been created.
    return;
  }
  const body = (await list.json()) as { subscriptions?: { id: string }[] };
  for (const sub of body.subscriptions ?? []) {
    await fetch(`${base}/push/subscriptions/${encodeURIComponent(sub.id)}`, {
      method: "DELETE",
      headers,
    });
  }
}

export type CaughtDelivery = {
  headers: Record<string, string>;
  body_b64: string;
  received_at: number;
};

type CatcherResponse = { id: string; deliveries: CaughtDelivery[] };

/**
 * Polls `/received/<id>` until at least one delivery has landed for
 * the subscription, or the timeout elapses. Mirrors
 * grappaApi.assertMessagePersisted's poll-with-timeout shape.
 *
 * Sender's fan-out is fire-and-forget via `Task.async_stream`, so
 * the spec MUST poll rather than assume synchronous delivery. 5s
 * default ceiling matches `assertMessagePersisted` — the Sender HTTP
 * roundtrip + push-catcher record is sub-100ms in practice.
 */
export async function awaitPushDelivery(
  id: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<CaughtDelivery[]> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const intervalMs = opts.intervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${PUSH_CATCHER_URL}/received/${encodeURIComponent(id)}`);
    if (res.ok) {
      const body = (await res.json()) as CatcherResponse;
      if (body.deliveries.length > 0) return body.deliveries;
    }
    await sleep(intervalMs);
  }
  throw new Error(`awaitPushDelivery: timeout after ${timeoutMs}ms — id=${id}`);
}

/**
 * Asserts NO deliveries have landed for `id` by the end of `windowMs`.
 * Used by dedup + prefs-whitelist specs where the absence of a push
 * is the contract (focused-window suppress; unmatched channel skip).
 *
 * windowMs is intentionally short (default 1.5s) — Sender's hot path
 * is fire-and-forget but the eval+POST round-trip is sub-100ms when
 * it does fire, so a 1.5s window catches everything that *would*
 * have fired without dragging the suite. Pass a higher window only
 * if a real regression demonstrates a slower path.
 */
export async function assertNoPushDelivery(id: string, windowMs = 1_500): Promise<void> {
  const deadline = Date.now() + windowMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${PUSH_CATCHER_URL}/received/${encodeURIComponent(id)}`);
    if (res.ok) {
      const body = (await res.json()) as CatcherResponse;
      if (body.deliveries.length > 0) {
        throw new Error(
          `assertNoPushDelivery: expected zero, saw ${body.deliveries.length} for id=${id}`,
        );
      }
    }
    await sleep(100);
  }
}

/**
 * Decodes the body of a CaughtDelivery into the JSON push payload
 * `Push.Payload.build/3` wrote. Helper around base64 + `JSON.parse`
 * so spec assertions stay readable.
 *
 * NOTE: in production the lib AES-GCM-encrypts the body with the
 * subscription's p256dh+auth keys; the SW decrypts. Push-catcher
 * receives the encrypted bytes — but we use the same fixture key
 * pair as the sender_test.exs tests, and the upstream
 * `:web_push_elixir` lib does NOT encrypt when `body == ""` (see
 * `crypto: false` shape — applied at lib level). We pass real JSON
 * payloads so encryption DOES happen, then we assert on
 * structurally-meaningful headers (`content-encoding: aesgcm` —
 * the legacy RFC 8188 encoding emitted by `:web_push_elixir`
 * v0.8.0; new spec is RFC 8291 `aes128gcm` and the assertion will
 * need a bump when the lib upgrades — and `ttl`) instead of the
 * body bytes themselves. Body-shape assertions are validated
 * server-side by Push.Payload tests
 * (test/grappa/push/payload_test.exs); the e2e contract is "did
 * fan-out fire with vendor-shaped headers", not "did the body
 * decrypt to a specific JSON".
 */
export function deliveryHeaders(delivery: CaughtDelivery): Record<string, string> {
  return delivery.headers;
}

/**
 * Composite enable: opens SettingsDrawer + flips the master toggle.
 * Caller MUST have already installed the push stub via
 * `stubPushManager(context, { endpoint: pushCatcherEndpoint(id) })`
 * + granted notification permission BEFORE calling `loginAs` —
 * Playwright initScripts only run for FUTURE navigations, so a stub
 * added after page.goto wouldn't intercept the SW that already
 * registered. The helper closes the drawer afterwards so subsequent
 * sidebar / compose interactions aren't intercepted by the backdrop.
 *
 * Returns the pushCatcherEndpoint id used so the spec can poll for
 * deliveries against it.
 */
export async function enablePushFromSettings(
  page: Page,
  _context: BrowserContext,
  opts: { id: string; token: string },
): Promise<string> {
  // Reset prefs to defaults so a prior spec's `channel_mentions=false`
  // (or any non-default whitelist) doesn't silently neutralise the
  // current spec's trigger eval. Defaults: channel_mentions=true,
  // private_messages_all=true (matches cic's DEFAULT_NOTIFICATION_PREFS).
  await resetNotificationPrefs(opts.token);
  // Caller is responsible for navigation (loginAs etc.). We just
  // open the SettingsDrawer + flip the master toggle.
  await page.locator('[aria-label="open settings"]').click();
  const toggle = page.locator('[data-testid="push-master-toggle"]');
  await expect(toggle).toBeVisible();
  // click() not check() — see push-install.spec.ts moduledoc for
  // why .check() is unsafe under cic's signal-controlled toggle.
  await toggle.click();
  // The drawer's onMasterToggle awaits enablePush which awaits the
  // POST /push/subscriptions round-trip. Once the device list updates
  // (B3 contract: enablePush -> refreshDevices) we know the server
  // accepted the subscription.
  await expect(page.locator('[data-testid="devices-list"] li')).toHaveCount(1, {
    timeout: 5_000,
  });
  // Close the drawer so subsequent click targets (sidebar window
  // selection, compose textarea) aren't intercepted by the backdrop
  // that sits over the SPA when the drawer is open. Backdrop click
  // dismisses; force: true to bypass the visibility check that the
  // backdrop's hit-target ambiguity sometimes trips.
  await page.locator('[data-testid="settings-drawer-backdrop"]').click({ force: true });
  await expect(page.locator(".settings-drawer.open")).toHaveCount(0);
  return opts.id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
