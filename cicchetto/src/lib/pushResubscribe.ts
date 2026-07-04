// #181 — auto-renew a dropped-but-still-wanted push subscription.
//
// The bug: on iOS the browser silently drops the `pushManager`
// subscription across a service-worker swap (bundle refresh) or a
// storage eviction while the PWA is backgrounded, and nothing
// re-subscribes — so push stops with no error and the server row rots as
// a ghost the push service keeps 2xx-ing (no 410 → the server prune can't
// touch it). See DESIGN_NOTES 2026-07-04.
//
// This module wires `ensurePushSubscription` (in `lib/push.ts`, the
// RENEW-ONLY path — it never prompts) onto the lifecycle seams where the
// drop becomes observable:
//
//   * `navigator.serviceWorker` `controllerchange` — a new SW claimed the
//     page (the bundle-refresh trigger the issue names).
//   * `document` `visibilitychange` → visible — the app resumed; the
//     subscription may have been evicted while it was backgrounded.
//   * boot — the page may have loaded already-dropped.
//
// `ensurePushSubscription` is a no-op unless the user previously opted in
// (a stashed endpoint), permission is granted, AND the live subscription
// is gone — so firing it liberally on these seams is cheap and safe.

import { ensurePushSubscription } from "./push";

// Single-flight guard: overlapping seams (boot + controllerchange firing
// together) must not launch two concurrent re-subscribes.
let running = false;

async function runEnsure(getToken: () => string | null): Promise<void> {
  if (running) return;
  const token = getToken();
  if (token === null || token === "") return;
  running = true;
  try {
    await ensurePushSubscription(token);
  } catch (err) {
    // Surfaced in devtools; a failed renewal retries on the next seam.
    console.warn("pushResubscribe: ensure failed", err);
  } finally {
    running = false;
  }
}

/**
 * Installs the SW-update / app-resume listeners that renew a dropped push
 * subscription, and kicks one renewal at boot. Returns a disposer (for
 * tests / unmount); production never disposes — a PWA update is a full
 * page reload, so listeners never accumulate.
 *
 * `getToken` is the bearer accessor (`lib/auth`'s `token`); a null/empty
 * token (not logged in) makes every seam a no-op.
 */
export function installPushResubscribe(getToken: () => string | null): () => void {
  if (typeof navigator === "undefined" || navigator.serviceWorker === undefined) {
    return () => {};
  }

  const onControllerChange = (): void => void runEnsure(getToken);
  const onVisibility = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "visible") {
      void runEnsure(getToken);
    }
  };

  navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", onVisibility);
  }

  // Boot: renew immediately if the page loaded with a dropped-but-wanted sub.
  void runEnsure(getToken);

  return () => {
    navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", onVisibility);
    }
  };
}
