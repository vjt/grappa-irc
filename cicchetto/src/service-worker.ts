/// <reference lib="webworker" />

// Cicchetto service worker — push notifications cluster B0
// (2026-05-14) onwards.
//
// vite-plugin-pwa runs in `injectManifest` mode: this file is
// compiled and bundled, and Workbox replaces `self.__WB_MANIFEST`
// at build time with the precache list (every emitted hashed
// asset). The same shell-only precache shape that the pre-B0
// `generateSW` config produced via `globPatterns` — just expressed
// imperatively here so we own the install/activate/fetch lifecycle
// and can layer push handlers on top in B2.
//
// Architectural notes:
//   - REST fetches (mode=cors / same-origin) and WS upgrades
//     (mode=websocket) are NOT navigation requests; the
//     NavigationRoute below only matches `request.mode === "navigate"`,
//     so they pass through to the network untouched. The denylist
//     excludes server-handled paths (auth, REST scopes, /socket)
//     from navigation-fallback rewriting — keep in lockstep with
//     `lib/grappa_web/router.ex` REST scope prefixes.
//   - skipWaiting + clients.claim is correct for a shell-only
//     cache where stale assets are never useful (matches the
//     pre-B0 `registerType: "autoUpdate"` behavior).
//   - B2 (2026-05-14): push + notificationclick listeners, dedup
//     via clients.matchAll when a window is focused on the source
//     URL.

import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { narrowPushPayload, type PushPayload, urlMatches } from "./lib/pushPayload";

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>;
};

precacheAndRoute(self.__WB_MANIFEST);

// SPA navigation fallback: any in-app route (e.g. `/`, `/login`)
// resolves to the precached `index.html`. The denylist mirrors
// router.ex REST scope prefixes — those paths must reach the
// origin server even on an explicit navigation (e.g. an OAuth-
// style redirect). Workbox `NavigationRoute` only matches
// `request.mode === "navigate"`, so non-navigation REST + WS
// requests are unaffected by this route.
const navigationHandler = createHandlerBoundToURL("index.html");
const navigationRoute = new NavigationRoute(navigationHandler, {
  denylist: [/^\/auth/, /^\/me/, /^\/networks/, /^\/socket/, /^\/push/],
});
registerRoute(navigationRoute);

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// ── Web Push (B2, 2026-05-14) ──────────────────────────────────────
//
// Payload narrowing + URL-match logic live in `lib/pushPayload.ts`
// so vitest can exercise them without instantiating the full SW
// global scope. The SW is the single caller; see that file for the
// PushPayload wire-shape contract.

self.addEventListener("push", (event: PushEvent) => {
  if (!event.data) return;
  let raw: unknown;
  try {
    raw = event.data.json();
  } catch {
    // Vendor delivered something we cannot parse — surface in SW
    // devtools but don't show a notification (an empty notification
    // is worse than none).
    console.warn("push.handler: payload not JSON");
    return;
  }
  const payload = narrowPushPayload(raw);
  if (!payload) {
    console.warn("push.handler: payload shape rejected", raw);
    return;
  }

  event.waitUntil(handlePush(payload));
});

async function handlePush(payload: PushPayload): Promise<void> {
  // Dedup: if any window client is currently focused AND its URL
  // matches the deep-link target (same pathname + query), suppress
  // the OS notification and post a message into the page so cic can
  // render an in-app badge instead. matchAll across all windows
  // (includeUncontrolled: true) so a tab opened before the SW
  // activated still counts.
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  const matchingFocused = clients.find((client) => {
    if (!client.focused) return false;
    return urlMatches(client.url, payload.url);
  });

  if (matchingFocused) {
    matchingFocused.postMessage({ type: "push.suppressed", payload });
    return;
  }

  await self.registration.showNotification(payload.title, {
    body: payload.body,
    tag: payload.tag,
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: payload.url },
  });
}

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const data = event.notification.data as { url?: string } | null;
  const url = data?.url ?? "/";

  event.waitUntil(focusOrOpen(url));
});

async function focusOrOpen(url: string): Promise<void> {
  // Prefer focusing an existing client over opening a new window —
  // mobile browsers in particular handle openWindow inconsistently
  // when an instance is already running.
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  const existing = clients.find((client) => urlMatches(client.url, url));
  if (existing) {
    await existing.focus();
    // Navigate the focused client if its current URL doesn't match
    // (e.g. user was on a different channel when the push arrived).
    if (!urlMatches(existing.url, url) && "navigate" in existing) {
      await existing.navigate(url);
    }
    return;
  }

  await self.clients.openWindow(url);
}
