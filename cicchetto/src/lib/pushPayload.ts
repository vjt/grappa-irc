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
 * UX-6-J — deep-link target parser.
 *
 * Extracts the (networkSlug, channelName, kind) tuple from the URL
 * shape that `Grappa.Push.Payload.build_url/2` writes:
 * `/?network=<slug>&channel=<percent-encoded>`. Accepts either an
 * absolute URL (the SW client.url shape) or a relative path (the
 * payload.url shape stored in the notification data).
 *
 * `kind` discriminator follows RFC 2812 channel-name sigils
 * `#`, `&`, `!`, `+` (`canonicalChannel` in lib/channelKey.ts) —
 * starts-with-sigil ⇒ `"channel"`, otherwise ⇒ `"query"` (DM target).
 * Server / list / mentions / home / admin pseudo-windows never carry
 * push payloads.
 *
 * Returns null on any shape mismatch (missing param, empty value,
 * unparseable URL). Callers route to a no-op fallback so a stale SW
 * or future payload format change degrades to "click does nothing"
 * rather than crashing the SPA.
 */
export type PushTarget = {
  networkSlug: string;
  channelName: string;
  kind: "channel" | "query";
};

export function parsePushTargetUrl(rawUrl: string): PushTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl, "https://placeholder.invalid");
  } catch {
    return null;
  }
  const networkSlug = url.searchParams.get("network");
  const channelName = url.searchParams.get("channel");
  if (networkSlug === null || networkSlug.length === 0) return null;
  if (channelName === null || channelName.length === 0) return null;
  const first = channelName.charCodeAt(0);
  // 0x23 #, 0x26 &, 0x21 !, 0x2B + — RFC 2812 chanstring sigils.
  const isChannel = first === 0x23 || first === 0x26 || first === 0x21 || first === 0x2b;
  return {
    networkSlug,
    channelName,
    kind: isChannel ? "channel" : "query",
  };
}
