// UX-6-J — push notification deep-link routing on the cic side.
//
// Pre-J: tapping an OS push notification ran the SW's
// `notificationclick` handler, which called `existing.navigate(url)`
// on the focused client. cic is an SPA — every route resolves to
// `index.html`, selection state lives in the `selectedChannel` signal
// (not the router), so `navigate(url)` reloaded the SPA at `/` and
// the deep-link query params (`?network=…&channel=…`) were ignored.
// vjt iPhone-dogfood Bug 10: tap a push for #sniffo while focused on
// home → returned to home, not #sniffo.
//
// J: split the responsibility. The SW posts `{type: "navigate", url}`
// to the focused client AFTER `focus()`; this module installs the
// listener, parses the URL via `parsePushTargetUrl`, and calls
// `setSelectedChannel`. The existing selection-store machinery
// (`subscribe.ts` join effects, scrollback backfill, badge clear)
// fires automatically off the signal change. No router involvement,
// no SPA reload — the same code path as a sidebar click.
//
// `applyPushTargetFromUrl` covers the cold-path case: SW called
// `openWindow(url)` on a not-yet-running client. The URL ships the
// deep-link params; this helper reads `location.search` at boot and
// applies the same routing. Deferred until networks() seed so the
// selection doesn't fire on a still-loading store.

import { createEffect, createRoot, on } from "solid-js";
import { networks } from "./networks";
import { type PushTarget, parsePushTargetUrl } from "./pushPayload";
import { setSelectedChannel } from "./selection";

/**
 * Resolves a push-target URL and routes selection. Returns true if a
 * selection was applied, false on parse failure or no-op.
 *
 * Pure wrt the selection store — caller responsibility to invoke from
 * a context where setSelectedChannel side-effects are appropriate
 * (boot, post-network-seed, or SW message handler).
 *
 * Parse failures `console.warn` (per `feedback_no_silent_drops_*`):
 * a future malformed-payload bug should surface in devtools rather
 * than degrade silently to "click did nothing".
 */
export function applyPushTarget(rawUrl: string): boolean {
  const target = parsePushTargetUrl(rawUrl);
  if (target === null) {
    console.warn("pushTarget: URL parse failed", rawUrl);
    return false;
  }
  setSelectedChannel({
    networkSlug: target.networkSlug,
    channelName: target.channelName,
    kind: target.kind,
  });
  return true;
}

/**
 * Wires the SW → client `message` channel. The SW posts
 * `{type: "navigate", url}` from its `notificationclick` handler;
 * this listener filters non-navigate messages and routes through
 * `applyPushTarget`.
 *
 * No-op when `navigator.serviceWorker` is absent (test envs without
 * SW polyfills, browsers with SW disabled). Matches the same
 * defensive shape as `lib/socket.ts`'s navigator-feature checks.
 *
 * Mounted at boot from `main.tsx`. Single global listener — the SW
 * matchAll fans out posts to every controlled client, but in practice
 * there's only one open cic tab per user-agent at any time (the PWA
 * shape).
 */
export function installPushTargetListener(): void {
  if (typeof navigator === "undefined") return;
  if (!("serviceWorker" in navigator)) return;
  navigator.serviceWorker.addEventListener("message", (ev: MessageEvent) => {
    const data = ev.data;
    if (typeof data !== "object" || data === null) return;
    const { type, url } = data as { type?: unknown; url?: unknown };
    if (type !== "navigate") return;
    if (typeof url !== "string") return;
    applyPushTarget(url);
  });
}

/**
 * Cold-path reader: when the SW opens a fresh window via
 * `openWindow(url)`, the URL ships the deep-link params but there's
 * no message-to-listener handshake (the page hasn't installed the
 * listener yet at openWindow time). Read `location.href` at boot,
 * defer the selection until `networks()` seeds — without the wait,
 * setSelectedChannel fires against an empty store and the UX-4
 * bucket E / D effects can't validate against the live data.
 *
 * Wrapped in `createRoot` because `main.tsx` calls this BEFORE
 * `render()`, and Solid's `createEffect` outside a reactive owner
 * warns + never disposes. The root is intentionally never disposed
 * — the cold-path effect is module-singleton and one-shot.
 *
 * Test seam (`__cicPushTargetApplied`): the e2e cold-path spec sets
 * an assertion on this flag so it doesn't pass for the wrong reason
 * (e.g. a session-restore code path that selected the same channel
 * independently). Pure dev/test signal — production code ignores it.
 *
 * Residual: the deep-link params are cleared from the URL bar via
 * `history.replaceState({}, "", "/")` after the selection lands.
 * Prevents a refresh from re-triggering the cold-path read against
 * a stale deep-link, and keeps the URL clean for share-link
 * ergonomics. The selection store's UX-5 BU tuple-equality
 * short-circuit means a re-fire would no-op anyway, but cleaning
 * the URL removes the question entirely.
 */
export function applyPushTargetFromUrl(): void {
  if (typeof window === "undefined" || !window.location) return;
  const target = parsePushTargetUrl(window.location.href);
  if (target === null) return;
  deferUntilNetworksSeed(target);
}

declare global {
  interface Window {
    __cicPushTargetApplied?: boolean;
  }
}

function deferUntilNetworksSeed(target: PushTarget): void {
  let applied = false;
  createRoot(() => {
    createEffect(
      on(networks, (nets) => {
        if (applied) return;
        if (!nets || nets.length === 0) return;
        applied = true;
        setSelectedChannel({
          networkSlug: target.networkSlug,
          channelName: target.channelName,
          kind: target.kind,
        });
        if (typeof window !== "undefined") {
          window.__cicPushTargetApplied = true;
          if (window.history && window.location) {
            window.history.replaceState({}, "", "/");
          }
        }
      }),
    );
  });
}
