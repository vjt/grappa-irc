// Minimal shell-cache service worker.
//
// PWA install eligibility requires *some* SW registration; this caches
// the static shell so a second visit serves index.html offline. NO
// runtime data is cached — REST + WebSocket calls always go to network.
// Phase 5+ may extend with offline-aware queueing.

const CACHE = "cicchetto-shell-v1";
const SHELL = ["/", "/index.html", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Network-first for API + WS upgrades; cache-first for the shell.
  if (url.pathname.startsWith("/api") || url.pathname.startsWith("/auth") || url.pathname.startsWith("/socket")) {
    return;
  }
  event.respondWith(caches.match(req).then((cached) => cached || fetch(req)));
});
