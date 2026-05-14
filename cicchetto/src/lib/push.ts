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
