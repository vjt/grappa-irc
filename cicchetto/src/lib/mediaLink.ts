// Media-link classifier — media-viewer cluster (2026-06-11).
//
// Decides whether a scrollback URL gets the on-click in-app media
// viewer modal instead of the default anchor navigation. Pure module
// (no SolidJS, no DOM) — same separation as `linkify.ts`; renderRun in
// ScrollbackPane is the call site, `mediaViewer.ts` owns the modal
// state.
//
// ## Why this exists
//
// Own upload URLs (`📸/🎬 https://host/uploads/<slug>`) are
// SAME-ORIGIN, and the PWA manifest has no `scope` key (start_url "/")
// so the whole origin is in-scope. iOS standalone navigates in-scope
// links IN PLACE regardless of `target="_blank"` — the PWA window
// becomes a raw media document with zero browser chrome and no back
// control; returning reloads cic. Out-of-scope (cross-origin) links
// open in the iOS Safari view with full controls and are NOT broken —
// they keep the plain anchor path untouched.
//
// ## Classification rules
//
// 1. Cross-HOST → null, always. Two independent reasons: (a) the
//    CSP (`img-src 'self' data:`, `media-src 'self' blob:`) would
//    block the modal's media element anyway — the modal must not
//    require a CSP loosening; (b) cross-host links don't have the
//    standalone bug in the first place.
//    Host-equality, NOT full-origin equality: pre-fix prod minted
//    `http://host/uploads/<slug>` (Endpoint `url:` carried no scheme
//    key) while the PWA runs at `https://host`. Those bodies are
//    permanent scrollback history — a strict origin check would dead-
//    letter every historical upload link. The viewer must NEVER load
//    an http src on the https page (mixed content), so the returned
//    `href` is re-rooted on the page origin (path + query + hash
//    preserved — `#t=` media fragments survive). One return value, not
//    a separate normalize step: a classify-but-forget-to-normalize
//    call site would ship the mixed-content block this exists to
//    prevent. Schemes other than http/https (linkify also admits ftp)
//    are excluded.
//
// ## Known limitation — emoji split across mIRC runs
//
// The 📸/🎬 signal is read from the text segment immediately preceding
// the URL within ONE mIRC formatting run. A body that interleaves
// control codes between emoji and URL (`\x0304📸\x03 https://…`, e.g.
// a colorizing relay bridge) splits them into separate runs and the
// link silently falls back to the plain anchor — the standalone
// navigate-in-place behavior returns for those rows. cic's own mints
// are always plain `📸 <url>`, so the real-world surface today is
// zero. The durable fix is server-side: mint `/uploads/<slug>.<ext>`
// so the URL itself carries the type — recorded in todo, not worth a
// control-char-tolerant scan here.
// 2. Own upload URL (`/uploads/<26-char-base32-slug>` — mirrors
//    Grappa.Uploads @slug_regex) + trailing 📸/🎬 in the text
//    immediately preceding the URL → image/video. The slug carries no
//    extension, so the uploadOrchestrator's emoji prefix is the only
//    type signal on the wire. 📄 documents are deliberately excluded:
//    rendering a PDF needs <embed>/<iframe>, which the design rejects
//    (X-Frame-Options / frame-src). No emoji → null (type unknowable;
//    anchor default stands).
// 3. Same-origin URL with an image/video/audio file extension →
//    kind by extension. No such URLs exist in grappa today (uploads
//    are slug-only), but the rule costs one map lookup and covers any
//    future same-origin direct-served media.
//
// IRC stays text-only: this module changes what a CLICK does, not what
// scrollback renders. No previews, no on-arrival rendering — the
// modal is on-click only (vjt-approved spec, 2026-06-10).

export type MediaKind = "image" | "video" | "audio";

// Mirrors Grappa.Uploads @slug_regex (26 chars of lowercase base32).
const UPLOADS_PATH_RE = /^\/uploads\/[a-z2-7]{26}$/;

// Emoji at the END of the preceding text segment — uploadOrchestrator
// emits `📸 <url>`, so after linkify the URL segment's preceding text
// ends with the emoji (possibly with relay prefixes before it).
const TRAILING_EMOJI_RE = /(📸|🎬)\s*$/u;

const EMOJI_KIND: Record<string, MediaKind> = {
  "📸": "image",
  "🎬": "video",
};

const EXTENSION_KIND: Record<string, MediaKind> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  svg: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  mp3: "audio",
  ogg: "audio",
  oga: "audio",
  m4a: "audio",
  opus: "audio",
  flac: "audio",
  wav: "audio",
};

export type MediaLink = { kind: MediaKind; href: string };

// Page-origin host cache — origin is window.location.origin at the
// only production call site, constant for the page lifetime; renderRun
// classifies every URL segment on every scrollback re-render, so skip
// re-parsing the same origin string each call.
let cachedOrigin: string | null = null;
let cachedOriginHost: string | null = null;

function hostOf(origin: string): string | null {
  if (origin !== cachedOrigin) {
    cachedOrigin = origin;
    try {
      cachedOriginHost = new URL(origin).host;
    } catch {
      cachedOriginHost = null;
    }
  }
  return cachedOriginHost;
}

/**
 * Classify a scrollback link as modal-viewable media. Returns the kind
 * plus the viewer-safe href (re-rooted on the page origin — path,
 * query and hash preserved), or null when the default anchor behavior
 * should stand.
 *
 * @param href urlSegment.href (always scheme-qualified — linkify's
 *   toHref prepends https:// to bare-www matches).
 * @param precedingText the text immediately before the URL in the same
 *   formatting run ("" when the URL starts the run).
 * @param origin window.location.origin at the call site — injected so
 *   the classifier stays pure and table-testable.
 */
export function classifyMediaLink(
  href: string,
  precedingText: string,
  origin: string,
): MediaLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Host (hostname + port) equality — see the moduledoc on why scheme
  // is deliberately NOT compared.
  if (url.host !== hostOf(origin)) return null;

  const kind = kindOf(url, precedingText);
  if (kind === null) return null;

  return { kind, href: `${origin}${url.pathname}${url.search}${url.hash}` };
}

function kindOf(url: URL, precedingText: string): MediaKind | null {
  if (UPLOADS_PATH_RE.test(url.pathname)) {
    const emoji = TRAILING_EMOJI_RE.exec(precedingText)?.[1];
    return emoji !== undefined ? (EMOJI_KIND[emoji] ?? null) : null;
  }

  const extension = url.pathname.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_KIND[extension] ?? null;
}
