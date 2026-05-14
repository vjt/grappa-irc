// Pure helpers for the cic service-worker's push handler.
// Push notifications cluster B2 (2026-05-14).
//
// Extracted from `service-worker.ts` so vitest can exercise the
// payload narrower + URL-match logic without instantiating the
// full ServiceWorkerGlobalScope (workbox-precaching imports a
// `self.__WB_MANIFEST` that doesn't exist outside the SW build).
//
// Mirrors the `lib/wireNarrow.ts` precedent: leaf module, pure
// functions, dedicated vitest. The SW imports from here at runtime;
// no SW APIs are touched.

/**
 * Wire shape for a Web Push payload (server → cic SW).
 *
 * The values are user-facing strings — the documented exception to
 * the wire-shape rule per
 * docs/plans/2026-05-14-push-notifications.md § Standing rules.
 * The OS surface (lockscreen, notification centre) renders these
 * BEFORE cic JS gets a chance to format, so cic-side localization
 * is impossible for push.
 *
 * Mirrors `Grappa.Push.Sender.payload()` (see
 * lib/grappa/push/sender.ex moduledoc).
 */
export type PushPayload = {
  title: string;
  body: string;
  tag: string;
  url: string;
};

/**
 * Defensive runtime narrower — server emits the typed shape, but a
 * stale SW running against a future server with an additional
 * payload field shouldn't reject the whole notification. We require
 * only the four fields we render and return null on any mismatch.
 *
 * Per `feedback_no_silent_drops_*`: callers MUST log the reject
 * (the SW does so via console.warn).
 */
export function narrowPushPayload(raw: unknown): PushPayload | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.title !== "string") return null;
  if (typeof obj.body !== "string") return null;
  if (typeof obj.tag !== "string") return null;
  if (typeof obj.url !== "string") return null;
  return { title: obj.title, body: obj.body, tag: obj.tag, url: obj.url };
}

/**
 * Compares just the path + search of an SW client URL against the
 * payload deep link, ignoring host (same-origin guaranteed by SW
 * scope). The payload URL is server-built as a relative path like
 * `/?network=libera&channel=%23sbiffo`.
 *
 * Returns false on any URL parse error — defensive for the case
 * where the client URL is somehow malformed.
 */
export function urlMatches(clientUrl: string, payloadUrl: string): boolean {
  try {
    const client = new URL(clientUrl);
    const payload = new URL(payloadUrl, client.origin);
    return client.pathname === payload.pathname && client.search === payload.search;
  } catch {
    return false;
  }
}
