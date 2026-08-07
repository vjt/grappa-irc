// cic Web Push helpers — push notifications cluster B2 (2026-05-14).
//
// Bridges the W3C Push API (`navigator.serviceWorker` +
// `pushManager`) to grappa's REST surface: fetches the VAPID public
// key, base64url-decodes it for `pushManager.subscribe`, and POSTs
// the resulting subscription JSON to /push/subscriptions.
//
// B2 ships the lower half: VAPID-key fetching, the
// subscribe/unsubscribe primitives. The B3 settings UI imports this
// module's `enablePush` / `disablePush` / `listPushDevices` to drive
// the master toggle dance.
//
// ## The VAPID public key is fetched, never recalled (#1323)
//
// `localStorage["cic.vapidPublicKey"]` used to be a read-through cache:
// populated on first fetch, returned unconditionally afterwards. That is
// what made an operator key rotation a silent, permanent kill — measured on
// staging as `400 {"reason":"VapidPkHashMismatch"}` from Apple (and `403`
// from FCM for the same failure in Google's vocabulary). The push service
// binds a subscription to the key that CREATED it, so a client subscribing
// with the recalled old key produces a perfectly valid subscription the
// server can never sign for. No exception is raised anywhere: the browser
// sees nothing inconsistent, the UI says push is on, the server logs a
// rejection nobody reads.
//
// So the same storage key now means something else: **the key the LIVE
// subscription was created with**, written ONLY after a subscribe succeeds
// and cleared with the subscription. It is a comparison anchor, never a
// source. Every subscribe fetches the served key and reconciles against it;
// on a difference the browser subscription is dropped and re-created. The
// re-meaning needs no migration — the old cache was populated at subscribe
// time, so a client broken by a rotation already holds exactly the key it
// subscribed with, which is what makes it heal on its first ensure seam.

import { ApiError, readError } from "./api";
import { formatDurationSince } from "./duration";
import { isIos, isStandalonePwa } from "./platform";
import { parseUserAgent } from "./userAgent";

const SUBSCRIBED_VAPID_KEY_STORAGE_KEY = "cic.vapidPublicKey";

/**
 * #459 — THE single, synchronous "can push actually be delivered here?" gate,
 * reused by both the login opt-in banner (`lib/pushOptin.ts`) and the settings
 * master toggle. One home, imported by both, so the two surfaces can never
 * disagree on availability.
 *
 * MUST stay synchronous: the banner's `[of course!]` handler calls
 * `enablePush` — which calls `Notification.requestPermission()` before its
 * first `await` — straight from the click, and Safari (desktop AND iOS) requires
 * a user gesture for that prompt. An async availability probe would resolve on a
 * later microtask, after the gesture is spent, and the prompt would silently
 * fail. So this probes only synchronously-readable capabilities.
 *
 * True when the three Web Push primitives are present AND, on iOS, the app is
 * an installed (home-screen / standalone) PWA — iOS Web Push fires ONLY for
 * standalone PWAs, never for a Safari browser tab. Everywhere else (desktop
 * Chromium, Android tab) a plain tab suffices.
 */
export function pushAvailable(): boolean {
  if (typeof Notification === "undefined") return false;
  if (typeof navigator === "undefined" || navigator.serviceWorker === undefined) return false;
  if (typeof PushManager === "undefined") return false;
  if (isIos()) return isStandalonePwa();
  return true;
}

/**
 * The VAPID public key the server signs with, straight from
 * `GET /push/vapid-public-key`. Always a round-trip: nothing is recalled
 * from storage (see the moduledoc — recalling it is #1323). The key is
 * non-secret per the W3C Push spec, and the payload is ~90 bytes.
 */
export async function fetchVapidPublicKey(): Promise<string> {
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

/**
 * Wire shape for POST /push/subscriptions request body. Mirrors the
 * W3C `PushSubscription.toJSON()` output exactly so callers can pipe
 * the subscription object through with no rename.
 */
export type PushSubscribeRequest = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  // #181 — on re-subscribe, the previous endpoint this subscription
  // replaces. The server deletes that subject-scoped row atomically with
  // the insert (churn dedup), so a silently-dropped endpoint does not
  // linger as a ghost the push service keeps 2xx-ing. Omitted on the
  // first subscribe.
  supersedes?: string;
};

// #112 — an opaque, server-minted push-subscription id. Branded (nominal
// typing) so a bare `string` — a nick, a bearer token, an endpoint — can't
// be passed where a subscription id is expected. The sole producer is the
// server (`POST` / `GET /push/subscriptions`); the sole consumer is
// `DELETE /push/subscriptions/:id`. The brand is applied at the two source
// boundaries only (the raw JSON reply + the localStorage recall).
export type SubscriptionId = string & { readonly __brand: "SubscriptionId" };

/**
 * POSTs a fresh subscription to the server's registry. The
 * authenticated bearer token is required; both registered users and
 * visitors are accepted (visitor-parity V3, 2026-05-15).
 */
export async function postPushSubscription(
  token: string,
  body: PushSubscribeRequest,
): Promise<{ id: SubscriptionId; created_at: string }> {
  const res = await fetch("/push/subscriptions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  // #112 — route through the ONE error decoder: dedups the redundant `error`
  // key from `info` AND fires the shared 401 dead-token handler this inline
  // shaper skipped (see `readError` moduledoc).
  if (!res.ok) throw await readError(res);
  return (await res.json()) as { id: SubscriptionId; created_at: string };
}

/**
 * DELETE /push/subscriptions/:id — used by the B3 settings UI per-
 * device "Remove" button and by `disablePush` when the master toggle
 * is flipped off.
 */
export async function deletePushSubscription(token: string, id: SubscriptionId): Promise<void> {
  const res = await fetch(`/push/subscriptions/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText || "push_delete_failed");
  }
}

export type PushDeviceSummary = {
  id: SubscriptionId;
  user_agent: string | null;
  /** #964 — user-set device name. `null` until renamed; see `deviceRows`. */
  label: string | null;
  created_at: string;
  last_used_at: string | null;
};

/** A device paired with the name the row should actually print. */
export type DeviceRow = {
  device: PushDeviceSummary;
  /** The user's label when set, else the derived `Browser on OS [#n]`. */
  displayName: string;
  /** True when `displayName` is the user's own label rather than the default. */
  named: boolean;
};

const parsedDeviceName = (device: PushDeviceSummary): string => {
  const parsed = parseUserAgent(device.user_agent);
  return `${parsed.browser} on ${parsed.os}`;
};

// Oldest first, id as the tiebreak so the ordering is TOTAL — two rows
// created in the same microsecond (or with an unparseable instant) must
// still get a stable order, or the ordinals would shuffle between renders.
const byCreation = (a: PushDeviceSummary, b: PushDeviceSummary): number => {
  const ta = Date.parse(a.created_at);
  const tb = Date.parse(b.created_at);
  const ka = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
  const kb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};

/**
 * #964 — pairs each device with the name its row prints, preserving the
 * server's ordering (newest first).
 *
 * The user's `label` wins outright. Without one the row falls back to the
 * parsed `Browser on OS`, which is exactly the string that collides — so
 * when two or more UNLABELLED devices parse to the same name, each gets an
 * ordinal (`Firefox on Linux #1`, `#2`) assigned oldest-first. A device
 * alone in its group takes no suffix: a solitary `#1` is noise.
 *
 * Labelled rows are excluded from the grouping, not just from the suffix.
 * Naming one of two twins already disambiguates the pair, and leaving the
 * other as a lone `#2` would be the stale-ordinal bug reintroduced by hand.
 *
 * ## Why the ordinal is DERIVED here and not a column
 *
 * Two independent reasons, and either alone settles it:
 *
 *   1. An ordinal is a function of how many rows currently share a parsed
 *      name. Stored, it goes stale the instant one of them is deleted —
 *      a `#2` with no `#1` that nothing realigns. Derived, the list
 *      self-heals on the next render. The LABEL is the stored thing here;
 *      the ordinal is only the fallback.
 *   2. The grouping key is the OUTPUT of `parseUserAgent`, which exists
 *      only in this codebase. Deriving server-side would mean a second UA
 *      parser in Elixir whose classification could disagree with this one,
 *      and then the ordinal would number a grouping the user cannot see.
 */
export function deviceRows(devices: PushDeviceSummary[]): DeviceRow[] {
  const unlabelled = devices.filter((d) => (d.label ?? null) === null);

  return devices.map((device) => {
    const label = device.label ?? null;
    if (label !== null) return { device, displayName: label, named: true };

    const name = parsedDeviceName(device);
    const twins = unlabelled.filter((d) => parsedDeviceName(d) === name).sort(byCreation);
    const displayName =
      twins.length < 2 ? name : `${name} #${twins.findIndex((d) => d.id === device.id) + 1}`;
    return { device, displayName, named: false };
  });
}

/**
 * PATCH /push/subscriptions/:id — the #964 inline rename. An empty string
 * clears the label server-side, so the row falls back to its derived name.
 */
export async function renamePushDevice(
  token: string,
  id: SubscriptionId,
  label: string,
): Promise<void> {
  const res = await fetch(`/push/subscriptions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) throw await readError(res);
}

/**
 * #964 — the device row's activity line.
 *
 * `parseUserAgent` collapses the UA to `Browser on OS`, so two instances of
 * the same browser on the same OS render byte-identical rows. The payload
 * already carries two disambiguating instants the row used to throw away;
 * this turns them into the one string that actually separates the twins
 * (two devices are almost never last used in the same minute).
 *
 * `last_used_at` is `nil` until B2's Sender has pushed to the row at least
 * once, so a freshly-enabled device falls back to `created_at` — "added 3m
 * ago" is the honest reading of a device nothing has been sent to yet, and
 * it is equally disambiguating.
 *
 * Returns null when NEITHER instant parses: per the #474 facts-only rule,
 * omit the line rather than render a confident-wrong value.
 */
export function formatDeviceActivity(device: PushDeviceSummary, nowMs: number): string | null {
  const lastUsed = formatDurationSince(device.last_used_at, nowMs);
  if (lastUsed !== null) return `last used ${lastUsed} ago`;
  const added = formatDurationSince(device.created_at, nowMs);
  return added === null ? null : `added ${added} ago`;
}

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

function rememberSubscription(id: SubscriptionId, endpoint: string, vapidKey: string): void {
  localStorage.setItem(SUBSCRIPTION_ID_STORAGE_KEY, id);
  localStorage.setItem(SUBSCRIPTION_ENDPOINT_STORAGE_KEY, endpoint);
  // #1323 — recorded only here, i.e. only once a subscribe has succeeded.
  // Recording the served key any earlier would make the NEXT reconciliation
  // read "same key" off a subscription that was never re-created.
  localStorage.setItem(SUBSCRIBED_VAPID_KEY_STORAGE_KEY, vapidKey);
}

/**
 * The server-side row id we stashed for `endpoint`, or null when the live
 * endpoint is not the one we registered (cleared site data, cross-profile
 * re-install, a silently-rotated subscription).
 *
 * The endpoint match is the whole point: it is what makes the answer PROOF
 * that the row is ours rather than a guess. `disablePush` leans on it to
 * never DELETE a row it can't prove ours; #964's "this device" marker leans
 * on it for the same reason — a stale id would badge the WRONG row.
 */
export function subscriptionIdForEndpoint(endpoint: string): SubscriptionId | null {
  const storedEndpoint = localStorage.getItem(SUBSCRIPTION_ENDPOINT_STORAGE_KEY);
  if (storedEndpoint !== endpoint) return null;
  // localStorage hands back a bare string; brand it at this recall seam.
  return localStorage.getItem(SUBSCRIPTION_ID_STORAGE_KEY) as SubscriptionId | null;
}

function forgetSubscription(): void {
  localStorage.removeItem(SUBSCRIPTION_ID_STORAGE_KEY);
  localStorage.removeItem(SUBSCRIPTION_ENDPOINT_STORAGE_KEY);
  localStorage.removeItem(SUBSCRIBED_VAPID_KEY_STORAGE_KEY);
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
  | { status: "enabled"; subscriptionId: SubscriptionId }
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
 *   4. Get the SW registration (waits for ready). Fetch the served VAPID
 *      public key and reconcile it against the key our live subscription
 *      was created with (#1323); on a rotation, drop that subscription
 *      before subscribing with the fresh key.
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

  const { subscription, key } = await subscribeWithCurrentVapidKey(registration);
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
  rememberSubscription(created.id, json.endpoint, key);
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
    // #181 — the browser subscription vanished (iOS SW-swap / storage
    // eviction) WITHOUT unsubscribing, so the push service never returned
    // 410 and the server row is a ghost it keeps 2xx-ing. DELETE it by its
    // stashed id instead of merely forgetting the mapping (the pre-#181 bug
    // that orphaned the row). A missing row is a benign no-op.
    const orphanId = localStorage.getItem(SUBSCRIPTION_ID_STORAGE_KEY) as SubscriptionId | null;
    if (orphanId !== null) {
      await deletePushSubscription(token, orphanId).catch(() => {
        /* swallowed — an already-gone row is fine */
      });
    }
    forgetSubscription();
    return false;
  }

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();

  const knownId = subscriptionIdForEndpoint(endpoint);
  if (knownId !== null) {
    await deletePushSubscription(token, knownId).catch(() => {
      /* swallowed — a missing row is fine; B2 Sender will GC dead rows on next push */
    });
  }
  forgetSubscription();
  return endpoint !== "";
}

/**
 * Outcome of `ensurePushSubscription`:
 *
 *   * "renewed"   — the browser subscription had dropped; re-subscribed
 *     and POSTed the fresh subscription (superseding the old row).
 *   * "rekeyed"   — #1323: the server serves a VAPID key that supersedes the
 *     one the live subscription was created with, so that subscription can
 *     never be signed for; it was dropped and re-created with the fresh key.
 *   * "present"   — a live subscription exists AND was created with the key
 *     the server still serves (or a same-endpoint replay), nothing to do.
 *   * "skipped"   — the runtime can't push (no Notification / SW /
 *     pushManager) or permission isn't `granted`. Never prompts here.
 *   * "no-intent" — the user never opted in / disabled push (no stashed
 *     endpoint), so there is nothing to renew.
 */
export type EnsurePushOutcome = "renewed" | "rekeyed" | "present" | "skipped" | "no-intent";

/**
 * #181 — renew a dropped-but-still-wanted push subscription on the
 * SW-update / app-resume lifecycle seams (wired by `lib/pushResubscribe.ts`).
 *
 * RENEW-ONLY: it never prompts for permission and never opts a user in.
 * It acts only when BOTH hold: `Notification.permission === "granted"` and
 * the user previously opted in (a stashed endpoint proves intent — cleared
 * on disable). Given those, it re-subscribes in two states: the browser's
 * live `pushManager.getSubscription()` has gone `null` (#181's silent drop),
 * or the server's VAPID key has moved past the one the live subscription was
 * created with (#1323's silent mismatch, which no browser reports). Either
 * way it POSTs the fresh subscription with `supersedes: <old endpoint>` so
 * the server prunes the row it replaces. A `422` replay (endpoint did not
 * rotate) counts as present.
 */
export async function ensurePushSubscription(token: string): Promise<EnsurePushOutcome> {
  if (typeof Notification === "undefined") return "skipped";
  if (typeof navigator === "undefined" || navigator.serviceWorker === undefined) return "skipped";
  if (Notification.permission !== "granted") return "skipped";

  const stashedEndpoint = localStorage.getItem(SUBSCRIPTION_ENDPOINT_STORAGE_KEY);
  if (stashedEndpoint === null || stashedEndpoint === "") return "no-intent";

  const registration = await navigator.serviceWorker.ready;
  if (registration.pushManager === undefined) return "skipped";

  // #1323 — the reconciliation seam. A subscription created with a
  // superseded VAPID key is indistinguishable from a healthy one from here:
  // it exists, it looks valid, and the push service rejects every send to it
  // forever. The served key is the only thing that tells them apart, so ask
  // for it before believing a live subscription.
  const { key, rotated } = await reconcileVapidKey();

  const existing = await registration.pushManager.getSubscription();
  if (existing !== null) {
    if (!rotated) return "present";
    await existing.unsubscribe();
  }

  const subscription = await subscribeWithKey(registration, key);
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

  try {
    const created = await postPushSubscription(token, {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
      supersedes: stashedEndpoint,
    });
    rememberSubscription(created.id, json.endpoint, key);
    return rotated ? "rekeyed" : "renewed";
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) {
      // Endpoint did not rotate — the server row already exists (replay).
      // Re-point the endpoint stash at the live sub; the id is unchanged.
      // The key record moves too: the subscription in hand WAS created with
      // it, and leaving the superseded one behind would re-tear-down the
      // same subscription on every following seam.
      localStorage.setItem(SUBSCRIPTION_ENDPOINT_STORAGE_KEY, json.endpoint);
      localStorage.setItem(SUBSCRIBED_VAPID_KEY_STORAGE_KEY, key);
      return "present";
    }
    throw err;
  }
}

/**
 * #1323 — the served key plus whether it supersedes the one our live
 * subscription was created with. `rotated` is false when we have no record
 * (nothing was ever subscribed here, or site data was cleared): an absent
 * record proves nothing, so it must not trigger a teardown.
 */
async function reconcileVapidKey(): Promise<{ key: string; rotated: boolean }> {
  const subscribedWith = localStorage.getItem(SUBSCRIBED_VAPID_KEY_STORAGE_KEY);
  const key = await fetchVapidPublicKey();
  return {
    key,
    rotated: subscribedWith !== null && subscribedWith !== "" && subscribedWith !== key,
  };
}

/**
 * Subscribes with exactly `key`, dropping a conflicting subscription rather
 * than giving up. `InvalidAccessError` is the browser refusing to hand back
 * a subscription bound to a DIFFERENT application server key — re-fetching
 * the key cannot resolve that (it is already the current one); only
 * unsubscribing the incumbent can.
 */
async function subscribeWithKey(
  registration: ServiceWorkerRegistration,
  key: string,
): Promise<PushSubscription> {
  const options: PushSubscriptionOptionsInit = {
    userVisibleOnly: true,
    // Cast: BufferSource accepts a Uint8Array, but TS DOM lib's
    // PushSubscriptionOptionsInit narrows applicationServerKey to
    // ArrayBufferView<ArrayBuffer> (vs the wider ArrayBufferLike
    // returned by Uint8Array's typed-array union). The runtime
    // contract is byte-for-byte: we send the raw key bytes.
    applicationServerKey: vapidKeyToUint8Array(key) as BufferSource,
  };
  try {
    return await registration.pushManager.subscribe(options);
  } catch (err) {
    if (err instanceof DOMException && err.name === "InvalidAccessError") {
      await dropLiveSubscription(registration);
      return registration.pushManager.subscribe(options);
    }
    throw err;
  }
}

/** Releases the browser-side subscription, if the SW still holds one. */
async function dropLiveSubscription(registration: ServiceWorkerRegistration): Promise<void> {
  const live = await registration.pushManager.getSubscription();
  if (live !== null) await live.unsubscribe();
}

/**
 * The one subscribe door: reconcile against the served key, drop a
 * subscription bound to a superseded one, then subscribe. Returns the key it
 * subscribed with so the caller can record it once the server row exists.
 */
async function subscribeWithCurrentVapidKey(
  registration: ServiceWorkerRegistration,
): Promise<{ subscription: PushSubscription; key: string }> {
  const { key, rotated } = await reconcileVapidKey();
  if (rotated) await dropLiveSubscription(registration);
  return { subscription: await subscribeWithKey(registration, key), key };
}
