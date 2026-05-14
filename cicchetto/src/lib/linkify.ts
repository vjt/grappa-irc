// Tiny URL linkifier — vendored to avoid pulling linkify-it (>10kB
// minified) for one regex. Detects http/https/ftp + bare-domain
// (`www.something`) shapes common in IRC.
//
// Returns an ordered list of segments — text + url alternating.
// Empty input → single empty text segment.
//
// ## Regex shape + trade-offs
//
// - Schemes covered: http://, https://, ftp:// (+ bare www.).
// - URL chars stop at whitespace or terminal punctuation (`.`, `,`,
//   `;`, `:`, `!`, `?`, closing `)`, `]`, `}`, `>`) so a sentence
//   like "see https://example.com." doesn't include the trailing
//   period in the link. (URLs that contain those chars internally
//   work fine — only TRAILING terminal punctuation is stripped.)
// - Parens balance: if a URL contains `(` and `)` in equal counts
//   (common for Wikipedia links), trailing `)` is preserved; if
//   unbalanced (a closing paren around the URL), it's stripped.
// - Bare-domain (`www.foo.com`) gets `https://` prepended at href
//   time so the link works even though the source text omits the
//   scheme.
// - IDN: pass-through (the regex matches non-ASCII via \S, and the
//   browser handles punycode at navigation time).
//
// ## Test coverage
//
// Pinned by linkify.test.ts:
// - positive: http/https/ftp/www-bare
// - negative: trailing-`.`/`,`/`)` exclusion, sentence boundaries
// - balanced parens, IDN pass-through
//
// ## Why a separate file
//
// renderRun in ScrollbackPane is the call site, but the linkifier is
// pure (no SolidJS, no DOM). Same separation pattern as
// `mircFormat.ts`, `mentionMatch.ts`, `nickEquals.ts`.

export type LinkifySegment =
  | { type: "text"; value: string }
  | { type: "url"; value: string; href: string };

// Match either a fully-qualified URL (scheme://) or a bare-domain
// starting with www. Stop on whitespace; trailing punctuation is
// stripped after the match.
//
// `[^\s]+?` would be nicer but matches too greedily — we want to
// match URL-shaped chars then strip terminal punctuation in a
// post-pass. Using `\S+` here + `stripTrailingPunctuation` keeps
// the regex simple and the cleanup explicit.
const URL_REGEX = /(?:https?:\/\/|ftp:\/\/|www\.)\S+/gi;

const TRAILING_PUNCT_RE = /[.,;:!?)\]}>]+$/;

function stripTrailingPunctuation(url: string): { url: string; trailing: string } {
  // Special-case: balanced parens count -- if `(` count === `)` count,
  // preserve the trailing `)` (common in Wikipedia links). Strip only
  // unbalanced trailing closing-parens.
  const opens = (url.match(/\(/g) ?? []).length;
  const closes = (url.match(/\)/g) ?? []).length;

  let stripped = url;
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

  return { url: stripped, trailing };
}

function toHref(matched: string): string {
  // Bare-domain (`www.example.com`) → prepend https:// so the link
  // works. Fully-qualified URLs pass through.
  if (/^www\./i.test(matched)) return `https://${matched}`;
  return matched;
}

export function linkify(input: string): LinkifySegment[] {
  if (!input) return [{ type: "text", value: "" }];

  const segments: LinkifySegment[] = [];
  let lastIndex = 0;

  // Reset regex state — global flag means lastIndex would persist
  // across calls otherwise.
  URL_REGEX.lastIndex = 0;

  while (true) {
    const match = URL_REGEX.exec(input);
    if (!match) break;

    const matchStart = match.index;
    const rawMatch = match[0];
    const { url, trailing } = stripTrailingPunctuation(rawMatch);

    // Pre-match text segment.
    if (matchStart > lastIndex) {
      segments.push({ type: "text", value: input.slice(lastIndex, matchStart) });
    }

    segments.push({ type: "url", value: url, href: toHref(url) });

    lastIndex = matchStart + url.length;

    if (trailing) {
      segments.push({ type: "text", value: trailing });
      lastIndex += trailing.length;
    }

    // Defensive: prevent zero-width-match infinite loop (shouldn't
    // happen with this regex but the `\S+` shape could in theory
    // match empty after trailing-strip — guard anyway).
    if (URL_REGEX.lastIndex === matchStart) URL_REGEX.lastIndex++;
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
