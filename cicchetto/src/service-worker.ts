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
//   - B2 will add `push` and `notificationclick` listeners.

import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

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
  denylist: [/^\/auth/, /^\/me/, /^\/networks/, /^\/socket/],
});
registerRoute(navigationRoute);

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});
