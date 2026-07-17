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
//   - UX-6-L (2026-05-20): broaden suppression gate to any visible
//     window (drop focused-AND-URL-match). Foreground alerting is
//     covered by an in-app beep wired in `lib/subscribe.ts`; this
//     keeps the OS notification silent whenever cic is foreground,
//     regardless of which channel is selected.

import { createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";
import { shouldSuppressPush } from "./lib/pushDedup";
import { narrowPushPayload, type PushPayload, pushNotificationOptions } from "./lib/pushPayload";
import { deliverNavigate } from "./lib/swNavigate";

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
//
// REV-G H22 (2026-05-22): added `/api`, `/admin`, `/uploads`.
// `/uploads/<slug>` is the public file-fetch surface for embedded
// image uploads (UX-6-B1); when a user posts `📸 host/uploads/<slug>`
// in IRC and a peer taps the link in a new tab, the PWA SW
// intercepts the top-level navigation and pre-REV-G served the SPA
// shell instead of the image bytes. `/admin` covers BOTH the
// loopback hooks (`/admin/reload`) and the operator console
// (`/admin/me`, `/admin/visitors`, etc.) — direct navigation
// pre-REV-G served the SPA shell instead of forwarding to the
// controller. `/api` covers the small authenticated surface
// (uploads.create, server-settings.show). `/healthz` is intentionally
// omitted (single GET; if a curl probe is opened in a tab the SPA
// shell isn't a security issue).
//
// The denylist MUST be a superset of router.ex's top-level scope
// prefixes. `test/grappa_web/router_sw_denylist_test.exs` enforces
// this — adding a new top-level scope without updating this regex
// list trips the test before deploy.
const navigationHandler = createHandlerBoundToURL("index.html");
const navigationRoute = new NavigationRoute(navigationHandler, {
  denylist: [
    /^\/auth/,
    /^\/me/,
    /^\/networks/,
    /^\/socket/,
    /^\/push/,
    /^\/api/,
    /^\/session/,
    /^\/admin/,
    /^\/uploads/,
    // #75 themes REST surface. PLURAL only — `/^\/themes/` does NOT match the
    // singular `/theme/:id` SPA share route (after `/theme` comes `/`, not
    // `s`), so a shared theme link still resolves to the SPA shell.
    /^\/themes/,
  ],
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
  // Dedup gate — UX-6-L (2026-05-20): if ANY window client is
  // currently visible (focused tab in the foreground, regardless of
  // which channel is selected), suppress the OS notification. The
  // in-app beep wired in `lib/subscribe.ts` covers the foreground
  // alert side, and a parallel OS notification on top would be
  // noise.
  //
  // matchAll across all windows (includeUncontrolled: true) so a tab
  // opened before the SW activated still counts.
  //
  // #182 (2026-07-05): the hybrid landed — the server now suppresses the
  // push at source when any device reports the PWA is visible (page-context
  // `document.visibilitychange` → WSPresence → Push.Triggers gate), because
  // this SW `clients.matchAll` visibility is UNRELIABLE on iOS PWAs (often
  // an empty/non-"visible" client list while foregrounded). This client
  // re-check is RETAINED as a defensive backstop for the small
  // just-connected window before a fresh tab reports visibility (server
  // defaults it :hidden = deliver-leaning), and for non-iOS where matchAll
  // is trustworthy.
  // PWA icon badge (door #1 receive side, 2026-06-21): stamp the
  // server-computed count onto the home-screen icon. Done BEFORE the
  // suppress-return below — a badge update is non-intrusive, so it must
  // apply even when the foreground gate skips the toast. A payload
  // without `badge` (older server) leaves the icon untouched.
  applyIconBadge(payload.badge);

  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  if (shouldSuppressPush(clients)) {
    return;
  }

  await self.registration.showNotification(payload.title, pushNotificationOptions(payload));
}

// Home-screen icon badge via the Badging API on the WorkerNavigator.
// NOTE: distinct from the `badge:` field of `showNotification` above —
// that is the monochrome status-bar glyph; this is the numeric count on
// the app icon. Feature-detected (absent on browsers without the
// Badging API and on iOS < 16.4); `.catch` swallows the SecurityError
// thrown when the page isn't an installed PWA.
function applyIconBadge(badge: number | undefined): void {
  if (badge === undefined) return;
  const nav = self.navigator as WorkerNavigator & {
    setAppBadge?: (count?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  if (badge > 0) {
    void nav.setAppBadge?.(badge)?.catch(() => {});
  } else {
    void nav.clearAppBadge?.()?.catch(() => {});
  }
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
  //
  // UX-6-J (2026-05-22): warm-path uses postMessage to tell the
  // focused client which deep-link to navigate to. Pre-J this called
  // `existing.navigate(url)` directly, but cic is an SPA — every
  // route resolves to index.html and selection state lives in the
  // `selectedChannel` signal, not the router. `navigate(url)`
  // reloaded the SPA at `/` and the deep-link params were dropped.
  // postMessage hands the URL to `lib/pushTarget.ts` which calls
  // `setSelectedChannel` via the same signal-driven path a sidebar
  // click would use. Cold-path (`openWindow`) still ships the URL
  // through location.href — `applyPushTargetFromUrl` reads it at
  // boot.
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  const existing = clients[0];
  if (existing) {
    // #146 recurrence (2026-07-01): deliver the navigate BEFORE focusing.
    // `WindowClient.focus()` rejects with `InvalidAccessError: Not
    // allowed to focus a window` when the notificationclick lacks
    // transient activation — iOS/WebKit reject it even from a genuine
    // tap. The old `await existing.focus(); postMessage(...)` ordering
    // let that rejection throw out of this async fn BEFORE the
    // postMessage ran, so the deep-link never reached the page and the
    // tap opened nothing. `deliverNavigate` posts first, then focuses
    // best-effort (rejection caught). See `lib/swNavigate.ts`.
    await deliverNavigate(existing, url);
    return;
  }

  await self.clients.openWindow(url);
}
