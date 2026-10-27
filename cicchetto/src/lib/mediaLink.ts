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
// 1. Host NOT in the admitted set → re-rooting is off the table, and the
//    link is modal-eligible only through the EXTERNAL branch below. The
//    admitted set is the page-origin host ∪ the deployment's
//    server-provided HTTP host aliases (`aliasHosts` param, #324 — from
//    `serverSettings()`'s `httpHostAliases`, ultimately `Grappa.HttpHosts`;
//    NEVER a client-baked list). A foreign host used to be excluded from
//    the viewer outright; #607 carved out https audio and #1240 finished
//    the job for image + video (`externalMediaLink`) — see that function
//    for the per-kind admission and why the href is returned UNCHANGED.
//    #324 — a deployment can answer on several hostname aliases
//    (`irc.sindro.me`, `irc.sniffo.org`) that reverse-proxy to ONE
//    instance + shared /uploads store; a link minted under one alias
//    viewed from another must still open the viewer. Because the
//    returned `href` is re-rooted on the PAGE origin (below), the modal's
//    `<img src>` stays SAME-ORIGIN even for an alias link. A foreign host
//    is NEVER re-rooted onto the page origin (that would 404 / load the
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
// 2. LEGACY own upload URL (`/uploads/<26-char-base32-slug>`, NO
//    extension — mirrors Grappa.Uploads @slug_regex) + trailing 📸/🎬/🎵
//    in the text immediately preceding the URL → image/video/audio. This
//    is the FALLBACK for links minted before #418: the slug carried no
//    extension, so the emoji prefix was the only type signal on the wire.
//    📄 documents are deliberately excluded: rendering a PDF needs
//    <embed>/<iframe>, which the design rejects (X-Frame-Options /
//    frame-src). No emoji → null (type unknowable; anchor default stands).
// 3. Same-origin URL with an image/video/audio file EXTENSION → kind by
//    extension (EXTENSION_KIND). Since #418 this is the PRIMARY path for
//    own-upload URLs, which the server now mints as `/uploads/<slug>.<ext>`
//    (extension from Grappa.Uploads.MimeExt) — the type is intrinsic to
//    the URL and the emoji is NOT consulted here. Also covers any other
//    same-origin direct-served media.
// 4. ADMITTED-HOST ONLY, `.txt` / `.md` → "text" (#1764,
//    TEXT_EXTENSION_KIND). Deliberately absent from the external branch:
//    see the CSP note below.
//
// ## Why "text" is admitted-host only, and must stay that way (#1764)
//
// Every other kind hangs an ELEMENT off the URL — `<img src>`, `<video
// src>` — and those are governed by `img-src` / `media-src`, both widened
// to `https:` (#1240, #607) so a foreign host works. A text viewer has no
// such element: it FETCHES the bytes and puts them in the DOM, which goes
// through `connect-src`, and `connect-src` is `'self'` plus the captcha
// hosts and `api.somafm.com` — NOT widened to `https:`
// (GrappaWeb.Plugs.SecurityHeaders). That asymmetry is deliberate: an
// element source can only be rendered, whereas `fetch` can read a
// response body, so widening it is exfiltration surface in a way the two
// media directives are not. Admitting a cross-host `.txt` here would open
// a modal the CSP then refuses to fill — strictly worse than the plain
// anchor it replaced. Do NOT "fix" that by widening `connect-src`.
//
// ## Why the URL extension is the durable fix (#418)
//
// Before #418 the emoji (rule 2) was the SOLE type signal, carried by
// presentation text: any copy/locale/relay/alias-expansion change to how
// the message was composed — or a control code split between the emoji
// and the URL across mIRC runs (`\x0304📸\x03 https://…`) — severed it
// silently and the viewer guessed wrong. Encoding the type in the URL
// makes rule 3 authoritative; rule 2 survives only for historical rows.
//
// IRC stays text-only: this module changes what a CLICK does, not what
// scrollback renders. No previews, no on-arrival rendering — the
// modal is on-click only (vjt-approved spec, 2026-06-10).

export type MediaKind = "image" | "video" | "audio" | "text";

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

// Same-origin file extension → media kind. Since #418 the server mints
// own-upload URLs as `/uploads/<slug>.<ext>` (extension from
// Grappa.Uploads.MimeExt, lib/grappa/uploads/mime_ext.ex), so this table
// is the PRIMARY type source for uploads — the emoji is now only a
// fallback for legacy extensionless links. CROSS-LANGUAGE CONTRACT: every
// viewer-relevant extension MimeExt can mint MUST be classified, or a
// fresh upload loses its in-app viewer. Pinned by the "server-mintable
// viewer extensions" test in mediaLink.test.ts.
//
// This half is the ELEMENT-BACKED set (an `<img>` / `<video>` / `<audio>`
// src), and it is the one the external branch may use. The fetch-backed
// text set is separate, right below, for the CSP reason in the moduledoc.
const EXTENSION_KIND: Record<string, Exclude<MediaKind, "text">> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  avif: "image",
  svg: "image",
  apng: "image", // #418 — server MimeExt mints image/apng → .apng
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  mp3: "audio",
  ogg: "audio",
  oga: "audio",
  m4a: "audio",
  aac: "audio", // #418 — server MimeExt mints audio/aac → .aac
  opus: "audio",
  flac: "audio",
  wav: "audio",
};

// #1764 — the FETCH-backed half, admitted-host only. Same cross-language
// contract as EXTENSION_KIND (MimeExt mints text/plain → .txt and
// text/markdown → .md) and pinned by the same test, but kept a separate
// table because the two are reachable from different branches: an element
// source is `img-src`/`media-src` and may be foreign, a fetched body is
// `connect-src` and may not. One merged table would make that distinction
// a comment instead of a type.
//
// `.md` is here as SOURCE, not as markdown: vjt ruled out rendering
// outright (#sbiffo 2026-08-24, "nono nessun rendering di gesu,
// assolutamente solo il sorgente txt e md"), which also keeps generated
// HTML out of a client that has no sanitisation surface anywhere today.
const TEXT_EXTENSION_KIND: Record<string, Extract<MediaKind, "text">> = {
  txt: "text",
  md: "text",
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
 * Whether a viewer href is on the page ORIGIN — the question every fetch and
 * every `download` anchor in the viewer has to ask first, and a stricter one
 * than `sameHostUrl`'s host match. A `fetch` of anything else is refused by
 * `connect-src` (not widened to `https:`, see the moduledoc), and a `download`
 * attribute on anything else is ignored, so the anchor navigates instead.
 * An admitted alias host never reaches this answering false: `classifyMediaLink`
 * has already re-rooted it on the page origin. Unparseable → false.
 */
export function isSameOrigin(href: string, origin: string): boolean {
  try {
    return new URL(href).origin === origin;
  } catch {
    return false;
  }
}

/**
 * Classify a scrollback link as modal-viewable media. Returns the kind
 * plus the viewer-safe href — re-rooted on the page origin (path, query
 * and hash preserved) for an admitted host, returned UNCHANGED for a
 * foreign one — or null when the default anchor behavior should stand.
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
 *   a third-party host takes the `externalMediaLink` branch instead
 *   (https + media extension, href unchanged). Empty set = page origin
 *   only (pre-#324 behaviour). Injected so the classifier stays pure.
 */
export function classifyMediaLink(
  href: string,
  precedingText: string,
  origin: string,
  aliasHosts: readonly string[],
): MediaLink | null {
  const match = sameHostUrl(href, origin, aliasHosts);
  // Foreign host (or non-http(s) / unparseable): an https link with a media
  // extension still reaches the viewer, with its href UNCHANGED.
  if (match === null) return externalMediaLink(href);

  const kind = kindOf(match.url, precedingText);
  if (kind === null) return null;

  return { kind, href: match.rooted };
}

function extensionOf(url: URL): string {
  return url.pathname.split(".").pop()?.toLowerCase() ?? "";
}

// Element-backed kinds only — safe for a foreign host under the widened
// `img-src`/`media-src`. See the moduledoc's CSP note.
function extensionKind(url: URL): MediaKind | null {
  return EXTENSION_KIND[extensionOf(url)] ?? null;
}

function kindOf(url: URL, precedingText: string): MediaKind | null {
  if (UPLOADS_PATH_RE.test(url.pathname)) {
    // Legacy extensionless shape: the emoji is the only type signal, and 📄
    // names every document type at once (pdf/odt/docx included, all still out
    // of scope) — so it cannot resolve to "text" and stays unclassified.
    const emoji = TRAILING_EMOJI_RE.exec(precedingText)?.[1];
    return emoji !== undefined ? (EMOJI_KIND[emoji] ?? null) : null;
  }

  // Admitted host: both halves are in play, the fetch-backed one included.
  return extensionKind(url) ?? TEXT_EXTENSION_KIND[extensionOf(url)] ?? null;
}

/**
 * External branch (#607 audio, #1240 image + video). A genuinely third-party
 * host is modal-eligible by URL EXTENSION alone, and the absolute href is
 * returned UNCHANGED: a foreign host is NEVER re-rooted onto the page origin
 * (that would 404 / load the wrong file).
 *
 * - https only — an http media element on the https page is mixed content and
 *   is blocked (the same-host branch stays scheme-agnostic for legacy uploads;
 *   that leniency deliberately does NOT extend to foreign hosts).
 * - the emoji fallback (rule 2) does NOT apply: it keys off a same-host
 *   extensionless `/uploads/<slug>` shape we only mint ourselves, so a foreign
 *   link without an extension has no type signal and stays null.
 * - `.txt` / `.md` (#1764) do NOT apply either, and this is the load-bearing
 *   omission rather than an oversight: `extensionKind` is consulted here and
 *   `TEXT_EXTENSION_KIND` is not, because a text viewer reads the body through
 *   `fetch` (`connect-src`, not widened) instead of pointing an element at the
 *   URL. See the moduledoc.
 *
 * #607 admitted audio first, for the docked mini-player (#115) — cross-channel
 * playback the iOS Safari view can't give. #1240 admitted image and video: the
 * motivating case is an upload link minted by ANOTHER grappa instance, tapped
 * from this one, which #324's alias set cannot cover because the two instances
 * are genuinely different deployments.
 *
 * CSP is the load-bearing half of that admission — an element the policy
 * blocks yields an EMPTY modal, strictly worse than the anchor it replaced.
 * `media-src 'self' blob: https:` already covers <audio> and <video> (#607
 * widened it); `img-src` gets `https:` in the #1240 change for <img>. No
 * `crossorigin` attribute on any of them — it would require
 * `Access-Control-Allow-Origin` from the foreign host and break otherwise
 * working loads; scrub/seek is best-effort on the remote server's Range
 * support.
 */
function externalMediaLink(href: string): MediaLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;

  const kind = extensionKind(url);
  return kind === null ? null : { kind, href };
}
