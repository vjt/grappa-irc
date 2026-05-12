// Case-insensitive IRC nickname comparison.
//
// RFC 2812 §2.2 declares nicknames case-insensitive and specifies a
// custom case-fold mapping where `[`, `]`, `\` are uppercase forms of
// `{`, `}`, `|` (the "rfc1459" / "ascii" casemapping). We use ASCII
// `.toLowerCase()` here — the simplification is acceptable for the
// bouncer scope because:
//
//   * subscribe.ts already uses bare `.toLowerCase()` for the same
//     comparisons (lines 183, 319, 328, 556) and has been correct in
//     production for months. Going stricter here would create a
//     two-policy split and silently fail on networks where one
//     comparison passes and the other doesn't.
//   * Users on networks that distinguish `{` vs `[` in nicks are
//     vanishingly rare; the false-equal class (`{user}` matches
//     `[user]` under our rule but not under strict RFC 2812) is
//     a shrug-worthy false positive vs. the demonstrated bug class
//     this helper closes (members store growing phantom rows on
//     JOIN→QUIT casing mismatches like `Alice` then `alice`).
//   * If a future network needs strict RFC 2812 casemapping we extend
//     this helper and migrate all callsites — single source of truth
//     means no drift class.
//
// Bucket F H3 fix: pre-fix members.ts (lines 57, 62, 69, 76) and
// ScrollbackPane.tsx (lines 461, 562) used bare `===` for nick
// comparison while subscribe.ts already used `.toLowerCase()`. The
// drift produced phantom member entries (server emits `Alice` on JOIN,
// `alice` on QUIT — pre-fix the QUIT didn't match the JOIN row and
// `Alice` lingered forever), missed self-JOIN banners (server emits
// JOIN with original-casing nick, banner check compared against lowered
// own-nick), and ownModes lookup misses (members store had server-cased
// nick, ownModes compared against own-nick — mismatch → no @ → ops
// items disabled even when the operator IS an op).
//
// Per CLAUDE.md "Total consistency or nothing": every nick comparison
// in the cic codebase goes through this helper. subscribe.ts callsites
// also delegate to it for single-source-of-truth, even though their
// `.toLowerCase()` form was already correct — the goal is one rule,
// one knob.

// Normalize a nick to its case-folded comparison form. Use directly
// when storing a nick into a Map/Set keyed for case-insensitive lookup;
// for binary equality checks prefer `nickEquals`.
export const normalizeNick = (nick: string): string => nick.toLowerCase();

// Case-insensitive nick equality. Returns false when either side is
// null or undefined — the existing call sites (members.ts presence
// dispatch, ScrollbackPane self-banner / ownModes) all guard on
// non-null nicks at the outer scope; this internal null-safety just
// makes the helper composable.
export const nickEquals = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (a == null || b == null) return false;
  return normalizeNick(a) === normalizeNick(b);
};
