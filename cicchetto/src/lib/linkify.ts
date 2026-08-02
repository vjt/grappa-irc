// Tiny URL + channel tokenizer — vendored to avoid pulling linkify-it
// (>10kB minified) for one regex. Detects http/https/ftp + bare-domain
// (`www.something`, `host.tld/path`) shapes common in IRC, PLUS IRC
// channel tokens (`#sniffo`, #648) in the SAME single pass.
//
// Returns an ordered list of segments — text, url, and channel. Empty
// input → single empty text segment.
//
// ## Channel prefix (#648)
//
// `#` is the ONLY channel prefix tokenised. Azzurra (all of prod) serves
// only `#`; the other RFC 2812 prefixes (`&` local, `+` modeless, `!`
// safe) are near-nonexistent on modern networks AND heavy false-positive
// magnets in chat prose (`&`=HTML entities/"and", `+`="C++"/"+1", `!`=
// every exclamation). So `&foo`/`+foo`/`!foo` stay PLAIN TEXT — the
// explicit, non-silent handling: they are neither misrendered as channels
// nor swallowed. The `channel` segment type is the extension point — a
// future network needing `&` channels adds the prefix to TOKEN_REGEX's
// char class (one line) with its own false-positive tests.
//
// ## Regex shape + trade-offs
//
// - Schemes covered: http://, https://, ftp:// (+ bare www.).
// - Bare scheme-less domains (GH #212): a `host.tld/path` shape with a
//   REQUIRED slash after an alphabetic TLD (`github.com/vjt/grappa`).
//   The slash-after-TLD is the deliberate false-positive guard — bare
//   `example.com` with no path is NOT linkified (too many hits in chat
//   prose), nor are version strings (`1.2.3`), nor `node.js` (no
//   slash). The TLD label must be ≥2 ASCII letters, so a numeric last
//   label (`1.2/3`) is rejected. Consequence we accept: a filename-ish
//   `report.txt/section` DOES match (`.txt` is a valid TLD shape) —
//   rare in practice, and widening the guard to a real-TLD allowlist
//   isn't worth the bytes.
// - URL chars stop at whitespace or terminal punctuation (`.`, `,`,
//   `;`, `:`, `!`, `?`, closing `)`, `]`, `}`, `>`) so a sentence
//   like "see https://example.com." doesn't include the trailing
//   period in the link. (URLs that contain those chars internally
//   work fine — only TRAILING terminal punctuation is stripped.)
// - Parens balance: if a URL contains `(` and `)` in equal counts
//   (common for Wikipedia links), trailing `)` is preserved; if
//   unbalanced (a closing paren around the URL), it's stripped.
// - Bare-domain (`www.foo.com`, `host.tld/path`) gets `https://`
//   prepended at href time so the link works even though the source
//   text omits the scheme. A scheme-qualified URL is left untouched,
//   so the leading scheme alternative wins and a bare-domain match
//   never fires inside an already-matched `https://…`.
// - IDN: pass-through (the scheme/www alternatives match non-ASCII via
//   \S, and the browser handles punycode at navigation time). The
//   bare-domain alternative is ASCII-anchored on the host/TLD, so a
//   scheme-less non-ASCII host needs an explicit scheme to linkify.
//
// ## Test coverage
//
// Pinned by linkify.test.ts:
// - positive: http/https/ftp/www-bare + bare host.tld/path (#212)
// - negative: trailing-`.`/`,`/`)` exclusion, sentence boundaries,
//   bare-domain false-positive guards (no-path, versions, node.js)
// - balanced parens, IDN pass-through
// - channels (#648): positive (`#chan`, hyphen/underscore, digit-led
//   `#7dtd`), URL-wins-over-`#section`, trailing-punct + paren strip,
//   comma-stop, negatives (bare `#`, digits-only `#1`, `&`/`+`/`!`
//   prefixes), 50-char cap
//
// ## Why a separate file
//
// renderRun in ScrollbackPane is the call site, but the linkifier is
// pure (no SolidJS, no DOM). Same separation pattern as
// `mircFormat.ts`, `mentionMatch.ts`, `nickEquals.ts`.

export type LinkifySegment =
  | { type: "text"; value: string }
  | { type: "url"; value: string; href: string }
  // #648 — an IRC channel token (`#sniffo`). Tokenised in the SAME single
  // pass as URLs (see TOKEN_REGEX below), so a `#` inside a URL fragment
  // stays part of the URL and the trailing-punctuation cleanup is shared.
  // The renderer (MircText) turns it into a click-to-join affordance in
  // scrollback; surfaces without a channel-click handler render `value` as
  // plain text — exactly how a url segment degrades. `value` is the RAW,
  // display-cased channel (`#Sniffo`); keys fold downstream via
  // `canonicalChannel`.
  | { type: "channel"; value: string };

// Match a fully-qualified URL (scheme://), a bare www. domain, a
// scheme-less `host.tld/path` (GH #212), OR an IRC channel token (#648).
// Stop on whitespace; trailing punctuation is stripped after the match.
//
// `[^\s]+?` would be nicer but matches too greedily — we want to
// match URL-shaped chars then strip terminal punctuation in a
// post-pass. Using `\S+` here + `stripTrailingPunctuation` keeps
// the regex simple and the cleanup explicit.
//
// The bare-domain alternative requires ≥1 label + an alpha TLD (≥2
// letters) + a slash before consuming the rest with `\S*` — the slash
// is what disambiguates a URL from ordinary prose (see moduledoc).
//
// The URL/www/bare-domain alternatives are listed FIRST so a single
// left-to-right scan resolves all overlaps (the #648 single-pass
// invariant): a scheme-qualified URL is matched whole, and neither the
// bare-domain nor the channel branch fires inside it — a `#section`
// fragment is consumed by the URL's `\S+`, never re-tokenised as a
// channel. A `#` and a URL char never START at the same offset (`#` isn't
// in `[a-z0-9-]` and no scheme starts with `#`), so ordering fully
// resolves the URL-vs-channel overlap.
//
// Channel alternative (#648): `#` + 1..49 non-terminator octets (total
// ≤ 50 per RFC 2812), stopping at space / comma / BELL (`\x07`) — the
// RFC 2812 chanstring terminators relevant in a chat body. `#` is the
// ONLY prefix (see moduledoc "Channel prefix"). Trailing punctuation and
// the digits-only (`#1`) rejection are handled in `linkify` after the match.
const TOKEN_REGEX =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: `\x07` (BELL) is an RFC 2812 chanstring terminator — a channel name MUST stop at it, so matching it as a boundary is deliberate, not an accidental control char.
  /(?:https?:\/\/|ftp:\/\/|www\.)\S+|(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*|#[^\s,\x07]{1,49}/gi;

const TRAILING_PUNCT_RE = /[.,;:!?)\]}>]+$/;

function stripTrailingPunctuation(token: string): { value: string; trailing: string } {
  // Special-case: balanced parens count -- if `(` count === `)` count,
  // preserve the trailing `)` (common in Wikipedia links). Strip only
  // unbalanced trailing closing-parens.
  const opens = (token.match(/\(/g) ?? []).length;
  const closes = (token.match(/\)/g) ?? []).length;

  let stripped = token;
  let trailing = "";

  // Iteratively strip terminal punct except for the balanced-parens case.
  while (true) {
    const m = TRAILING_PUNCT_RE.exec(stripped);
    if (!m) break;
    const lastChar = stripped[stripped.length - 1];
    if (lastChar === ")" && opens >= closes) break;
    trailing = lastChar + trailing;
    stripped = stripped.slice(0, -1);
  }

  return { value: stripped, trailing };
}

// #648 — a matched `#…` token is a real channel only if, AFTER trailing-punct
// stripping, its NAME (the part past `#`) is non-empty AND not digits-only. A
// bare `#` can't reach here (the regex requires ≥1 name char), but `#1` / `#123`
// can — those are issue refs / prose hashtags, not channels. A name that merely
// STARTS with a digit but carries any non-digit (`#7dtd`) IS a channel.
function isChannelName(value: string): boolean {
  const name = value.slice(1);
  return name.length > 0 && !/^\d+$/.test(name);
}

function toHref(matched: string): string {
  // Scheme-qualified URLs (http/https/ftp) pass through untouched.
  // Everything else the regex admits is a bare domain (`www.foo.com`
  // or `host.tld/path`) → prepend https:// so the link works even
  // though the source text omits the scheme.
  if (/^(?:https?|ftp):\/\//i.test(matched)) return matched;
  return `https://${matched}`;
}

export function linkify(input: string): LinkifySegment[] {
  if (!input) return [{ type: "text", value: "" }];

  const segments: LinkifySegment[] = [];
  let lastIndex = 0;

  // Reset regex state — global flag means lastIndex would persist
  // across calls otherwise.
  TOKEN_REGEX.lastIndex = 0;

  while (true) {
    const match = TOKEN_REGEX.exec(input);
    if (!match) break;

    const matchStart = match.index;
    const rawMatch = match[0];
    const { value, trailing } = stripTrailingPunctuation(rawMatch);

    // Pre-match text segment.
    if (matchStart > lastIndex) {
      segments.push({ type: "text", value: input.slice(lastIndex, matchStart) });
    }

    // `#` prefix ⇒ channel branch; anything else the regex admits is a URL.
    // (`#` never starts a URL alternative, so this dispatch is exact.)
    if (rawMatch[0] === "#") {
      if (isChannelName(value)) {
        segments.push({ type: "channel", value });
        lastIndex = matchStart + value.length;
        if (trailing) {
          segments.push({ type: "text", value: trailing });
          lastIndex += trailing.length;
        }
      } else {
        // Bare-`#` can't match; a digits-only `#1`/`#123` reaches here — emit
        // the whole raw token (name + any stripped trailing) as plain text.
        segments.push({ type: "text", value: rawMatch });
        lastIndex = matchStart + rawMatch.length;
      }
    } else {
      segments.push({ type: "url", value, href: toHref(value) });
      lastIndex = matchStart + value.length;
      if (trailing) {
        segments.push({ type: "text", value: trailing });
        lastIndex += trailing.length;
      }
    }

    // Defensive: prevent zero-width-match infinite loop (shouldn't
    // happen with this regex but the `\S+` shape could in theory
    // match empty after trailing-strip — guard anyway).
    if (TOKEN_REGEX.lastIndex === matchStart) TOKEN_REGEX.lastIndex++;
  }

  // Tail text after last match.
  if (lastIndex < input.length) {
    segments.push({ type: "text", value: input.slice(lastIndex) });
  }

  // Empty input falls through to here with no segments — ensure at
  // least one text segment so consumers can map without special-casing.
  if (segments.length === 0) {
    segments.push({ type: "text", value: input });
  }

  // Coalesce consecutive text segments — trailing-punct strip can
  // produce {url, text(",")} followed by {text(" rest")}; merge so
  // consumers see one text segment per gap.
  const merged: LinkifySegment[] = [];
  for (const seg of segments) {
    const last = merged[merged.length - 1];
    if (seg.type === "text" && last && last.type === "text") {
      merged[merged.length - 1] = { type: "text", value: last.value + seg.value };
    } else {
      merged.push(seg);
    }
  }

  return merged;
}
