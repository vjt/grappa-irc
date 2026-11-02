// Media share payload and flow — issue 2468; since issue 2501 shared by the
// media viewer and the audio mini player.
//
// Pure module (no SolidJS; the DOM only through `fetch`, `File` and
// `navigator.share` / `canShare`) — the `mediaAvailability.ts` /
// `textResource.ts` separation: this owns WHAT goes to the Web Share API and
// how one control's taps play out (`createMediaSharer`); the components own
// the button and where the reader is told (`MediaViewerModal.tsx` on its
// status line, `AudioMiniPlayer.tsx` in a toast).
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
// a slow link can outlast it and the share is then refused. NOT device-verified.
//
// `canShare({ files })` saying yes is NOT the platform agreeing to the file.
// Measured in Chromium's source: Blink's `canShare` checks only that the name
// is a safe base name, and the browser process then refuses anything whose
// extension OR type is off its own allowlist (`share_service_impl.cc`) with
// `NotAllowedError` — `.mov`, `.apng`, `.aac`, `.md` and every legacy
// extensionless `/uploads/<slug>` among what the viewer admits. That list is
// Chromium's and changes without telling us; Safari keeps none like it. So
// cic copies neither: a refused FILE is answered by offering the link on the
// next tap (the refusal has already spent the user activation, so the
// fallback cannot run in the same one). See `createMediaSharer`.

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
  // `canShare` is feature-detected separately from `share`: the session-link
  // door never needed it, and an engine with `share` but no `canShare` has no
  // way to say yes to a file. Asked BEFORE the fetch, so such an engine does
  // not spend the activation window downloading bytes it will throw away.
  if (typeof navigator.canShare !== "function" || !isSameOrigin(href, origin)) {
    return { url: href };
  }
  const file = await fetchFile(href, signal);
  return file !== undefined && navigator.canShare({ files: [file] })
    ? { files: [file] }
    : { url: href };
}

/**
 * One share control's taps. Returns `"busy"` for a tap that lands while the
 * previous share is still fetching or showing its sheet (the platform would
 * refuse it as a share already in progress, which is not a failure worth a
 * sentence); otherwise the settled attempt: `null` when there is nothing to
 * tell the reader, or the sentence to show.
 */
export type MediaSharer = (
  href: string,
  origin: string,
  signal: AbortSignal,
) => Promise<string | null> | "busy";

/**
 * The share flow, issue 2468's, lifted out of the media viewer in issue 2501
 * so the mini player runs the same one.
 *
 * AbortError is the reader dismissing the sheet (or the caller aborting
 * mid-fetch because its control is gone) — a choice, not a failure, and it says
 * nothing. Every OTHER rejection is named: a share that silently does nothing
 * is the inert control issue 1839 refused for copy.
 *
 * A `NotAllowedError` on a FILE share is the one rejection with a way out. It
 * is the platform refusing that file (Chromium's type allowlist, above) or the
 * activation window running out on a slow fetch, and either way the
 * activation is spent, so the link cannot follow in the same tap. The next tap
 * on the SAME href shares the link instead, and the sentence says so — the URL
 * fallback vjt's ruling promises, one tap later. Keyed on the href rather than
 * held as a flag because the mini player outlives every source it plays; for
 * the viewer, which is built per open, the two are the same.
 *
 * `DOMException`, not `Error`, in both tests: both doors reject with one, and
 * jsdom's does not descend from the realm's `Error`, so an `Error` test there
 * would let a cancelled sheet through as a failure.
 *
 * @param describe renders any other rejection as the sentence to show —
 *   `errorMessage` at both call sites, injected so this module stays pure.
 */
export function createMediaSharer(describe: (error: unknown) => string): MediaSharer {
  let sharing = false;
  let refusedFile: string | undefined;

  const attempt = async (
    href: string,
    origin: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    let data: ShareData | undefined;
    try {
      data = href === refusedFile ? { url: href } : await mediaShareData(href, origin, signal);
      await navigator.share(data);
      return null;
    } catch (value) {
      if (value instanceof DOMException && value.name === "AbortError") return null;
      if (
        data?.files !== undefined &&
        value instanceof DOMException &&
        value.name === "NotAllowedError"
      ) {
        refusedFile = href;
        return "this file could not be shared — tap share again to send the link";
      }
      return describe(value);
    } finally {
      sharing = false;
    }
  };

  return (href, origin, signal) => {
    if (sharing) return "busy";
    sharing = true;
    return attempt(href, origin, signal);
  };
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
