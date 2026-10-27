// Media share payload — issue 2468.
//
// Pure module (no SolidJS; the DOM only through `fetch`, `File` and
// `navigator.canShare`) — the `mediaAvailability.ts` / `textResource.ts`
// separation: this owns WHAT goes to the Web Share API, `MediaViewerModal.tsx`
// owns the button, the call and what the reader is told.
//
// vjt's ruling on the issue: share the FILE where `canShare({ files })` allows
// it, the URL otherwise. The file is what the report was about — forwarding a
// picture into another app — and a link to it is the fallback, not the goal.
//
// The bytes are fetched on the tap, not when the viewer opens. For an image the
// element has just loaded them, so the request is a cache hit; prefetching
// instead would pull a whole video on every open to serve a share that is
// rarely made. The cost is the user-activation window: `navigator.share` must
// run within it, and the fetch spends part of it. Chromium and WebKit grant
// several seconds, which a cached image never comes near, but a large video on
// a slow link can outlast it and the share is then refused — the viewer names
// that refusal rather than eating it. NOT device-verified.

import { isSameOrigin } from "./mediaLink";

/**
 * What to hand `navigator.share` for a viewer href: `{ files: [file] }` when
 * the bytes could be fetched and the platform accepts them, `{ url: href }` in
 * every other case.
 *
 * 🔴 A cross-origin href is never FETCHED — `connect-src` is not widened to
 * `https:`, so the request would be a `securitypolicyviolation` whether or not
 * the rejection is handled (the issue 1889 probe rule). It goes out as a link.
 *
 * A fetch that fails or answers non-2xx also degrades to the link: the reader
 * asked to share, and the URL is still a working way to do it. An ABORT is the
 * one failure that is rethrown — the viewer closed mid-fetch, and a share sheet
 * must not open over a viewer that is gone.
 *
 * @param href the viewer-safe href from `classifyMediaLink`.
 * @param origin `window.location.origin` at the call site — injected so this
 *   module stays pure.
 * @param signal aborts the fetch when the viewer closes.
 */
export async function mediaShareData(
  href: string,
  origin: string,
  signal: AbortSignal,
): Promise<ShareData> {
  const file = isSameOrigin(href, origin) ? await fetchFile(href, signal) : undefined;
  // `canShare` is feature-detected separately from `share`: the session-link
  // door never needed it, and an engine with `share` but no `canShare` has no
  // way to say yes to a file.
  const filesAccepted =
    file !== undefined &&
    typeof navigator.canShare === "function" &&
    navigator.canShare({ files: [file] });
  return filesAccepted ? { files: [file] } : { url: href };
}

async function fetchFile(href: string, signal: AbortSignal): Promise<File | undefined> {
  try {
    const res = await fetch(href, { signal });
    if (!res.ok) return undefined;
    const blob = await res.blob();
    // Named after the link's last path segment — the upload route mints
    // `<slug>.<ext>` (#418), and the extension is what lets the receiving app
    // recognise a picture. Typed from what the server SERVED, not guessed from
    // that name. The raw segment, never `decodeURIComponent`'d: a malformed
    // escape there throws, and a slug carries none to decode.
    return new File([blob], new URL(href).pathname.split("/").pop() ?? "", { type: blob.type });
  } catch (value) {
    if (signal.aborted) throw value;
    return undefined;
  }
}
