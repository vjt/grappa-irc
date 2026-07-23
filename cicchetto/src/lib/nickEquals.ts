// Case-insensitive IRC nickname comparison — the SINGLE client-side
// nick fold + equality helper.
//
// ## One fold, pinned to the server (#364 cross-surface S13)
//
// Azzurra runs bahamut (`CASEMAPPING=rfc1459`): besides ASCII `A-Z` it
// folds the four "national" chars `[ ] \ ~` → `{ } | ^`. The server's
// single source of truth is `Grappa.IRC.Identifier.canonical_nick/1`
// (byte-level ASCII). `rfc1459Fold` below is the ONE client mirror of
// that fold; `normalizeNick` and `nickEquals` are layered on it so the
// whole cic codebase folds nicks exactly as the server does — no
// two-policy drift class. `nickEquals.test.ts` enumerates the fold
// table as a drift gate.
//
// Pre-#364 this module folded ASCII-downcase-only (no bracket fold) as
// a documented simplification, while `notifyWatch.ts` carried a SECOND
// (Unicode-`toLowerCase`) fold for presence keys. Two folds for one
// identity invariant is exactly the "half-migrated creates two
// patterns" failure CLAUDE.md forbids: a `[user]`/`{user}` pair the
// server treats as ONE nick would fork here (members store phantoms,
// DM windows, own-nick checks). Consolidated onto `rfc1459Fold`.
//
// Bucket F H3 (retained): pre-fix members.ts and ScrollbackPane.tsx
// used bare `===` for nick comparison, producing phantom member entries
// (server emits `Alice` on JOIN, `alice` on QUIT — the QUIT didn't
// match the JOIN row and `Alice` lingered forever), missed self-JOIN
// banners, and ownModes lookup misses. Per CLAUDE.md "Total
// consistency or nothing" every nick comparison in cic goes through
// this helper.

// ASCII-byte-level rfc1459 fold — the single client mirror of
// `Grappa.IRC.Identifier.canonical_nick/1`. Folds `A-Z` + `[ ] \ ~` →
// `{ } | ^` by char code so multibyte (non-ASCII) sequences pass
// through untouched, byte-for-byte with the server's `fold_nick_byte/1`
// (JS `toLowerCase()` is Unicode-aware and would over-fold, e.g.
// `CAFÉ`→`café`, forking keys the server keeps distinct).
export const rfc1459Fold = (nick: string): string =>
  nick
    .replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
    .replace(/\[/g, "{")
    .replace(/\]/g, "}")
    .replace(/\\/g, "|")
    .replace(/~/g, "^");

// Normalize a nick to its case-folded comparison form. Use directly
// when storing a nick into a Map/Set keyed for case-insensitive lookup;
// for binary equality checks prefer `nickEquals`.
export const normalizeNick = (nick: string): string => rfc1459Fold(nick);

// Case-insensitive nick equality. Returns false when either side is
// null or undefined — the existing call sites (members.ts presence
// dispatch, ScrollbackPane self-banner / ownModes) all guard on
// non-null nicks at the outer scope; this internal null-safety just
// makes the helper composable.
export const nickEquals = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (a == null || b == null) return false;
  return normalizeNick(a) === normalizeNick(b);
};
