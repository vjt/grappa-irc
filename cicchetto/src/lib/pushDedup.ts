// Pure helper for the cic service-worker's push suppression gate.
// UX-6-L (2026-05-20) — broadened from focused-AND-URL-match to
// visible-anywhere.
//
// Extracted from `service-worker.ts` so vitest can exercise the
// predicate without instantiating the full ServiceWorkerGlobalScope
// (workbox-precaching imports `self.__WB_MANIFEST` that doesn't
// exist outside the SW build). Same boundary precedent as
// `lib/pushPayload.ts`.

/**
 * Returns true when the SW should SUPPRESS the OS notification.
 *
 * Rule: any visible window client suppresses. Pre-L was "focused
 * AND URL matches deep-link target" — L drops the URL match because
 * the in-app beep (`lib/beep.ts`, wired in `subscribe.ts`) covers
 * the alert side whenever cic is foreground, regardless of which
 * channel/window is on top. Background (PWA closed / Safari tab
 * in another app) returns false → SW falls through to
 * `showNotification`.
 *
 * Per UX-6-L spec — accept caveat: server still sends every push
 * (~50% wasted when foreground); APNs quota tax acceptable at
 * current scale. Hybrid follow-up (server-side WSPresence +
 * visibility-heartbeat fast-path skip) parked until quota bites.
 */
export function shouldSuppressPush(
  clients: ReadonlyArray<{ visibilityState: DocumentVisibilityState }>,
): boolean {
  return clients.some((client) => client.visibilityState === "visible");
}
