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
 * #182 (2026-07-05): the server now suppresses the push at source when
 * any device reports the PWA visible (WSPresence + Push.Triggers gate),
 * because this SW-side `visibilityState` is unreliable on iOS PWAs. This
 * predicate is RETAINED as a defensive backstop (the small just-connected
 * window before a fresh tab reports visibility; non-iOS where matchAll is
 * trustworthy) — it must never be weakened.
 */
export function shouldSuppressPush(
  clients: ReadonlyArray<{ visibilityState: DocumentVisibilityState }>,
): boolean {
  return clients.some((client) => client.visibilityState === "visible");
}
