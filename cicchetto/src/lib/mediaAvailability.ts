// Media availability probe — issue 1889.
//
// Pure module (no SolidJS, no DOM beyond `fetch`) — same separation as
// `mediaLink.ts` and `textResource.ts`: this owns "what did the server say
// about this URL", `MediaViewerModal.tsx` owns what the reader is told.
//
// ## Why this exists
//
// An upload link posted in channel keeps its href forever, but the bytes do
// not: the row is soft-deleted (admin delete, reaper expiry) or hard-deleted,
// and from that moment `GET /uploads/<slug>.<ext>` answers 404. The viewer
// used to render that exactly like a broken image — "failed to load — try
// open in browser" — and that advice is wrong twice over: the browser did not
// fail, and "open in browser" lands on the same route, which serves
// `{"error":"not_found"}` as JSON. Two operators went looking for a client bug
// because of it.
//
// ## Why a separate request, and why HEAD
//
// The `error` event of `<img>` / `<video>` / `<audio>` carries NO status —
// there is no response to read off the element that failed. Only the `text`
// arm fetches, and it already discards the status inside `fetchTextResource`.
// So the status has to be asked for, and one probe for all four kinds beats
// one probe plus a special case: the round-trip is paid ONLY on the failure
// path, which is cold.
//
// HEAD rather than GET because the question is "does the server still have
// this?", not "give me the bytes": a 200-but-undecodable response (corrupt
// image, wrong mime) must not be downloaded a second time to be told it is
// not a 404. `Plug.Head` sits above the router in the endpoint, so HEAD shares
// the GET route and returns the SAME status the element saw — there is no
// second server code path to keep in step.
//
// ## Same-origin is a GATE, not an optimisation
//
// `connect-src` is `'self'` plus the captcha hosts and two audio hosts — it is
// deliberately NOT widened to `https:`, unlike `img-src` / `media-src`
// (GrappaWeb.Plugs.SecurityHeaders). So a cross-host probe would be REFUSED by
// the policy: no answer, plus a `securitypolicyviolation` the e2e `_cspGuard`
// fixture fails specs on. This is the same boundary that keeps `.txt` /`.md`
// admitted-host only (see `mediaLink.ts`) — reused, not invented.
//
// It costs nothing in coverage: `classifyMediaLink` RE-ROOTS an admitted host
// (page origin ∪ the #324 deployment aliases) onto the page origin, so every
// own upload arrives here same-origin by construction, and a genuinely foreign
// host keeps its absolute href and is excluded — which is right, because
// another deployment's 404 is not ours to interpret.
//
// ORIGIN equality, deliberately not the HOST equality `mediaLink.sameHostHref`
// does. That one is scheme-agnostic on purpose (legacy `http://` upload links
// in permanent scrollback) and then re-roots; `'self'` is scheme + host + port,
// so host equality would admit a probe the CSP then refuses. The near-miss is
// exactly the kind of reuse that would look right and fail in production only.
// issue 2468 moved the check itself into `mediaLink.isSameOrigin`: the viewer's
// download and share verbs ask the same question for the same CSP reason.

import { isSameOrigin } from "./mediaLink";

/**
 * What the server said about a media URL that failed to load.
 *
 * `"gone"` is a POSITIVE answer — a 404 was actually read off the wire.
 * `"unknown"` is everything else, including every way the probe itself can
 * fail. A closed set of two rather than a status number: the only distinction
 * the reader is owed is "the server says there is nothing here" vs "we do not
 * know", and a number would invite a third caller to invent a third sentence.
 */
export type MediaAvailability = "gone" | "unknown";

/**
 * Ask the server whether a media URL is still there.
 *
 * 🔴 A failure of the PROBE never produces `"gone"`. Network down, CSP
 * refusal, an abort when the viewer closes mid-flight, a response we cannot
 * make sense of — all answer `"unknown"`, and the caller keeps today's generic
 * failure text. Telling a reader "this is gone" because OUR request failed is
 * a worse lie than the generic message this whole change exists to replace.
 *
 * @param href the viewer-safe href from `classifyMediaLink` — re-rooted on the
 *   page origin for an admitted host, unchanged (and therefore skipped here)
 *   for a foreign one.
 * @param origin `window.location.origin` at the call site — injected so this
 *   module stays pure and table-testable.
 * @param signal aborts the probe when the viewer closes mid-flight.
 */
export async function probeMediaAvailability(
  href: string,
  origin: string,
  signal: AbortSignal,
): Promise<MediaAvailability> {
  // Checked BEFORE the request, not after a rejection: a cross-host probe is a
  // CSP violation event, and the e2e guard fails on those whether or not we
  // handle the resulting error.
  if (!isSameOrigin(href, origin)) return "unknown";

  try {
    const response = await fetch(href, { method: "HEAD", signal });
    return response.status === 404 ? "gone" : "unknown";
  } catch {
    return "unknown";
  }
}
