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
// 1. Host NOT in the admitted set → null, always. The admitted set is
//    the page-origin host ∪ the deployment's server-provided HTTP host
//    aliases (`aliasHosts` param, #324 — from `serverSettings()`'s
//    `httpHostAliases`, ultimately `Grappa.HttpHosts`; NEVER a client-
//    baked list). Two independent reasons a genuinely foreign host is
//    excluded: (a) the CSP (`img-src 'self' data:`, `media-src 'self'
//    blob:`) would block the modal's media element anyway — the modal
//    must not require a CSP loosening; (b) genuinely cross-host links
//    don't have the standalone bug and open fine in the iOS Safari view.
//    #324 — a deployment can answer on several hostname aliases
//    (`irc.sindro.me`, `irc.sniffo.org`) that reverse-proxy to ONE
//    instance + shared /uploads store; a link minted under one alias
//    viewed from another must still open the viewer. Because the
//    returned `href` is re-rooted on the PAGE origin (below), the modal's
//    `<img src>` stays SAME-ORIGIN even for an alias link → CSP
//    `img-src 'self'` is UNTOUCHED (no loosening). A foreign host is
//    NEVER re-rooted onto the page origin (that would 404 / load the
//    wrong file) — only admitted hosts pass.
//    Host-equality (hostname + port), NOT full-origin equality: pre-fix
//    prod minted `http://host/uploads/<slug>` (Endpoint `url:` carried
//    no scheme key) while the PWA runs at `https://host`. Those bodies
//    are permanent scrollback history — a strict origin check would dead-
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
// The 📸/🎬/🎵 signal is read from the text segment immediately preceding
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
//    Grappa.Uploads @slug_regex) + trailing 📸/🎬/🎵 in the text
//    immediately preceding the URL → image/video/audio. The slug carries
//    no extension, so the uploadOrchestrator's emoji prefix is the only
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
const TRAILING_EMOJI_RE = /(📸|🎬|🎵)\s*$/u;

const EMOJI_KIND: Record<string, MediaKind> = {
  "📸": "image",
  "🎬": "video",
  "🎵": "audio",
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

// Shared host-match + re-root core: parse, admit only http(s), require
// the host to be in the admitted set (page origin ∪ server-provided
// deployment aliases), and produce the origin-rooted href (path + query
// + hash preserved). `aliasHosts` are the deployment's #324 HTTP host
// aliases — bare, lowercased hostnames the server advertised; the page-
// origin host is ALWAYS admitted in addition, so a single-host or
// pre-snapshot deployment (empty aliasHosts) keeps the pre-#324
// behaviour. Injected (not read from a store here) so this module stays
// pure + table-testable.
function sameHostUrl(
  href: string,
  origin: string,
  aliasHosts: readonly string[],
): { url: URL; rooted: string } | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Host (hostname + port) membership — see the moduledoc on why scheme
  // is deliberately NOT compared. Page origin always admitted; #324
  // widens to any deployment alias so a sibling-hostname upload link
  // opens the viewer too.
  if (url.host !== hostOf(origin) && !aliasHosts.includes(url.host)) return null;

  return { url, rooted: `${origin}${url.pathname}${url.search}${url.hash}` };
}

/**
 * Same-host check + page-origin re-root WITHOUT media classification —
 * for links that are not modal-eligible but still have the
 * iOS-standalone navigate-in-place bug (📄 docs, emoji-split-run
 * fallbacks; review fix 2026-06-11). Returns the origin-rooted href,
 * or null for cross-host / non-http(s) / unparseable hrefs. Widens with
 * the SAME `aliasHosts` set as `classifyMediaLink` (#324) so the escape
 * path also routes through the in-app handler on a deployment alias.
 */
export function sameHostHref(
  href: string,
  origin: string,
  aliasHosts: readonly string[],
): string | null {
  return sameHostUrl(href, origin, aliasHosts)?.rooted ?? null;
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
 * @param aliasHosts the deployment's server-provided HTTP host aliases
 *   (#324, bare lowercased hostnames from `serverSettings()`'s
 *   `httpHostAliases`). A URL whose host is any of these — OR the page
 *   origin's own host — is admitted and re-rooted onto the page origin;
 *   a third-party host still returns null. Empty set = page origin only
 *   (pre-#324 behaviour). Injected so the classifier stays pure.
 */
export function classifyMediaLink(
  href: string,
  precedingText: string,
  origin: string,
  aliasHosts: readonly string[],
): MediaLink | null {
  const match = sameHostUrl(href, origin, aliasHosts);
  if (match === null) return null;

  const kind = kindOf(match.url, precedingText);
  if (kind === null) return null;

  return { kind, href: match.rooted };
}

function kindOf(url: URL, precedingText: string): MediaKind | null {
  if (UPLOADS_PATH_RE.test(url.pathname)) {
    const emoji = TRAILING_EMOJI_RE.exec(precedingText)?.[1];
    return emoji !== undefined ? (EMOJI_KIND[emoji] ?? null) : null;
  }

  const extension = url.pathname.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_KIND[extension] ?? null;
}
