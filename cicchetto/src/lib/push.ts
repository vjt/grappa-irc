// cic Web Push helpers — push notifications cluster B2 (2026-05-14).
//
// Bridges the W3C Push API (`navigator.serviceWorker` +
// `pushManager`) to grappa's REST surface: fetches the VAPID public
// key, base64url-decodes it for `pushManager.subscribe`, and POSTs
// the resulting subscription JSON to /push/subscriptions.
//
// B2 ships the lower half: VAPID-key fetching + cache, the
// subscribe/unsubscribe primitives. The B3 settings UI imports this
// module's `enablePush` / `disablePush` / `listPushDevices` to drive
// the master toggle dance.
//
// ## VAPID public-key cache
//
// Key fetched from `GET /push/vapid-public-key` on first use, cached
// in localStorage so subsequent subscribe calls don't round-trip.
// Refresh path: cic catches `InvalidApplicationServerKey` from the
// browser's `pushManager.subscribe` and re-fetches once. No HTTP
// cache headers — operator-rotation is rare and the payload is ~88
// bytes; localStorage is the authoritative cache.

import { ApiError } from "./api";

const VAPID_PUBLIC_KEY_STORAGE_KEY = "cic.vapidPublicKey";

/**
 * Fetches the server's VAPID public key, returning the cached value
 * when present. The key is non-secret per the W3C Push spec; storing
 * it in localStorage is fine.
 *
 * @param forceRefresh — bypass the cache (used after an
 *   `InvalidApplicationServerKey` exception).
 */
export async function getVapidPublicKey(forceRefresh = false): Promise<string> {
  if (!forceRefresh) {
    const cached = localStorage.getItem(VAPID_PUBLIC_KEY_STORAGE_KEY);
    if (cached !== null && cached !== "") return cached;
  }
  const res = await fetch("/push/vapid-public-key", {
    headers: { "content-type": "application/json" },
  });
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText || "vapid_fetch_failed");
  }
  const body = (await res.json()) as { public_key?: unknown };
  if (typeof body.public_key !== "string" || body.public_key === "") {
    throw new ApiError(500, "vapid_malformed");
  }
  localStorage.setItem(VAPID_PUBLIC_KEY_STORAGE_KEY, body.public_key);
  return body.public_key;
}

/**
 * Converts the server's base64url-encoded VAPID public key (string)
 * into the Uint8Array shape that `pushManager.subscribe` requires
 * for `applicationServerKey`. Padding restoration handles
 * unpadded base64url emitted by `Base.url_encode64(_, padding: false)`
 * on the server side.
 */
export function vapidKeyToUint8Array(base64Url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i);
  }
  return out;
}

/** Clears the cached VAPID key — used by tests + after a server rotation. */
export function clearVapidPublicKeyCache(): void {
  localStorage.removeItem(VAPID_PUBLIC_KEY_STORAGE_KEY);
}

/**
 * Wire shape for POST /push/subscriptions request body. Mirrors the
 * W3C `PushSubscription.toJSON()` output exactly so callers can pipe
 * the subscription object through with no rename.
 */
export type PushSubscribeRequest = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

/**
 * POSTs a fresh subscription to the server's registry. The
 * authenticated bearer token is required — visitors get 403, but
 * the master toggle is hidden in cic for visitor sessions, so a
 * 403 here represents a programming error in the caller.
 */
export async function postPushSubscription(
  token: string,
  body: PushSubscribeRequest,
): Promise<{ id: string; created_at: string }> {
  const res = await fetch("/push/subscriptions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let info: Record<string, unknown> = {};
    let code = res.statusText || "push_subscribe_failed";
    try {
      info = (await res.json()) as Record<string, unknown>;
      if (typeof info.error === "string") code = info.error;
    } catch {
      /* fallthrough — code stays as statusText */
    }
    throw new ApiError(res.status, code, info);
  }
  return (await res.json()) as { id: string; created_at: string };
}

/**
 * DELETE /push/subscriptions/:id — used by the B3 settings UI per-
 * device "Remove" button and by `disablePush` when the master toggle
 * is flipped off.
 */
export async function deletePushSubscription(token: string, id: string): Promise<void> {
  const res = await fetch(`/push/subscriptions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText || "push_delete_failed");
  }
}

export type PushDeviceSummary = {
  id: string;
  user_agent: string | null;
  created_at: string;
  last_used_at: string | null;
};

/** GET /push/subscriptions — powers the per-device list in B3 settings. */
export async function listPushDevices(token: string): Promise<PushDeviceSummary[]> {
  const res = await fetch("/push/subscriptions", {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText || "push_list_failed");
  }
  const body = (await res.json()) as { subscriptions?: PushDeviceSummary[] };
  return body.subscriptions ?? [];
}

// ---------------------------------------------------------------------------
// Master-toggle orchestrators (push-notifications cluster B3, 2026-05-14)
// ---------------------------------------------------------------------------

// Local cache of the server-side subscription id, keyed by the SW's
// endpoint URL. Without this, `disablePush` cannot reliably DELETE
// the right server row — the GET /push/subscriptions list view does
// NOT echo `endpoint` back (B1 view contract: endpoint is credential-
// grade material). UA-string matching collides across profiles
// sharing the same browser version, so two PWAs in two profiles
// would wipe each other's subscription. Endpoint→id mapping in
// localStorage is the bridge: we know our endpoint locally, we
// stashed the id at subscribe-time, DELETE targets exactly that row.
const SUBSCRIPTION_ID_STORAGE_KEY = "cic.pushSubscriptionId";
const SUBSCRIPTION_ENDPOINT_STORAGE_KEY = "cic.pushSubscriptionEndpoint";

function rememberSubscription(id: string, endpoint: string): void {
  localStorage.setItem(SUBSCRIPTION_ID_STORAGE_KEY, id);
  localStorage.setItem(SUBSCRIPTION_ENDPOINT_STORAGE_KEY, endpoint);
}

function recallSubscriptionId(endpoint: string): string | null {
  const storedEndpoint = localStorage.getItem(SUBSCRIPTION_ENDPOINT_STORAGE_KEY);
  if (storedEndpoint !== endpoint) return null;
  return localStorage.getItem(SUBSCRIPTION_ID_STORAGE_KEY);
}

function forgetSubscription(): void {
  localStorage.removeItem(SUBSCRIPTION_ID_STORAGE_KEY);
  localStorage.removeItem(SUBSCRIPTION_ENDPOINT_STORAGE_KEY);
}

/**
 * Result of `enablePush` — discriminated by `status`. The B3 settings
 * UI dispatches on the `status` field to render the right surface:
 *
 *   * "enabled" — happy path; toggle reflects ON, devices list refreshes.
 *   * "permission_denied" — Notification.permission is "denied";
 *     the master toggle stays OFF and the UI renders the
 *     browser-specific reset-instructions banner.
 *   * "permission_dismissed" — user dismissed the permission prompt
 *     without granting (Notification.requestPermission resolved with
 *     "default"). Distinct from `denied` so cic can offer a friendlier
 *     "tap again to retry" surface vs the harder reset banner.
 *   * "unsupported" — the runtime does not expose the Push API at all
 *     (e.g. iOS Safari pre-16.4, or PWA-only contexts where the SW
 *     registration is missing). UI renders the install-to-home-screen
 *     instruction copy.
 */
export type EnablePushResult =
  | { status: "enabled"; subscriptionId: string }
  | { status: "permission_denied" }
  | { status: "permission_dismissed" }
  | { status: "unsupported"; reason: "no_service_worker" | "no_push_manager" | "no_notification" };

/**
 * Master toggle ON dance:
 *
 *   1. Probe the runtime — bail with `unsupported` if `Notification`,
 *      `navigator.serviceWorker`, or `pushManager` is missing.
 *   2. Check `Notification.permission`. If `denied`, bail with
 *      `permission_denied` (no prompt to re-show — the browser blocks
 *      programmatic re-asks until the user clears site data).
 *   3. If `default`, request permission. On `denied`/`default` after
 *      the prompt, bail with `permission_denied`/`permission_dismissed`.
 *   4. Get the SW registration (waits for ready). Fetch the VAPID
 *      public key (cached). Subscribe via `pushManager.subscribe`.
 *      On `InvalidApplicationServerKey`, refresh the cached key once
 *      and retry — protects against operator-rotated VAPID keys
 *      sticking around in localStorage.
 *   5. POST the subscription to `/push/subscriptions`. Return the
 *      created subscription's id so the UI can refresh its devices
 *      list directly without an extra GET round-trip.
 */
export async function enablePush(token: string): Promise<EnablePushResult> {
  if (typeof Notification === "undefined") {
    return { status: "unsupported", reason: "no_notification" };
  }
  if (typeof navigator === "undefined" || navigator.serviceWorker === undefined) {
    return { status: "unsupported", reason: "no_service_worker" };
  }

  if (Notification.permission === "denied") {
    return { status: "permission_denied" };
  }
  if (Notification.permission === "default") {
    const granted = await Notification.requestPermission();
    if (granted === "denied") return { status: "permission_denied" };
    if (granted !== "granted") return { status: "permission_dismissed" };
  }

  const registration = await navigator.serviceWorker.ready;
  if (registration.pushManager === undefined) {
    return { status: "unsupported", reason: "no_push_manager" };
  }

  const subscription = await subscribeWithVapidRetry(registration);
  const json = subscription.toJSON() as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
  };
  if (
    typeof json.endpoint !== "string" ||
    typeof json.keys?.p256dh !== "string" ||
    typeof json.keys?.auth !== "string"
  ) {
    throw new ApiError(500, "push_subscription_malformed");
  }
  const created = await postPushSubscription(token, {
    endpoint: json.endpoint,
    keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
  });
  rememberSubscription(created.id, json.endpoint);
  return { status: "enabled", subscriptionId: created.id };
}

/**
 * Master toggle OFF dance:
 *
 *   1. Get the SW's current PushSubscription (if any).
 *   2. Call `subscription.unsubscribe()` to release the browser-side
 *      registration.
 *   3. Recall the server-side row id from localStorage (stashed at
 *      enable-time, keyed by endpoint) and DELETE it. If the local
 *      cache is missing or stale, we skip the server-side DELETE
 *      rather than guess — B2's Sender will GC the dead row on
 *      next push attempt via the 410 Gone path. This is correct in
 *      the face of cleared site data / cross-profile re-installs:
 *      we never delete a row we can't prove ours.
 *
 * Returns `true` when a subscription existed and was removed; `false`
 * when no client-side subscription was present (idempotent OFF —
 * toggling off a never-enabled UI is a benign no-op).
 */
export async function disablePush(token: string): Promise<boolean> {
  if (typeof navigator === "undefined" || navigator.serviceWorker === undefined) return false;
  const registration = await navigator.serviceWorker.ready;
  if (registration.pushManager === undefined) return false;

  const subscription = await registration.pushManager.getSubscription();
  if (subscription === null) {
    forgetSubscription();
    return false;
  }

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();

  const knownId = recallSubscriptionId(endpoint);
  if (knownId !== null) {
    await deletePushSubscription(token, knownId).catch(() => {
      /* swallowed — a missing row is fine; B2 Sender will GC dead rows on next push */
    });
  }
  forgetSubscription();
  return endpoint !== "";
}

async function subscribeWithVapidRetry(
  registration: ServiceWorkerRegistration,
): Promise<PushSubscription> {
  const tryOnce = async (forceRefresh: boolean): Promise<PushSubscription> => {
    const key = await getVapidPublicKey(forceRefresh);
    const bytes = vapidKeyToUint8Array(key);
    return registration.pushManager.subscribe({
      userVisibleOnly: true,
      // Cast: BufferSource accepts a Uint8Array, but TS DOM lib's
      // PushSubscriptionOptionsInit narrows applicationServerKey to
      // ArrayBufferView<ArrayBuffer> (vs the wider ArrayBufferLike
      // returned by Uint8Array's typed-array union). The runtime
      // contract is byte-for-byte: we send the raw key bytes.
      applicationServerKey: bytes as BufferSource,
    });
  };
  try {
    return await tryOnce(false);
  } catch (err) {
    if (err instanceof DOMException && err.name === "InvalidAccessError") {
      // Browsers throw InvalidAccessError when the cached VAPID key no
      // longer matches the SW's existing subscription (operator key
      // rotation). Refresh once + retry.
      clearVapidPublicKeyCache();
      return tryOnce(true);
    }
    throw err;
  }
}
