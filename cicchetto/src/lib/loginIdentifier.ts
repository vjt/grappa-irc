// #204 foolproof-login — ON-SUBMIT identifier classification.
//
// vjt override on the original as-typed proposal: do NOT rewrite the field
// while the user types. Classify + sanitize once, at submit time. The
// field is dual-purpose (nick OR email — registered users log in with an
// email), so the presence of "@" is the branch discriminator:
//
//   * contains "@" → EMAIL. Validated naively (a real address is the
//     server's problem; we only guard against obvious garbage so the
//     nick-sanitizer never mangles an email's "@"/".").
//   * no "@"       → NICKNAME. Trim edges, collapse internal whitespace
//     runs to a single "_" (the issue's headline example: `my nick` →
//     `my_nick`), strip everything outside the server's allowed nick set,
//     cap at the 30-char server limit, and reject an empty result or an
//     illegal first character (digit / dash).
//
// The allowed nick set mirrors `Grappa.IRC.Identifier`'s `@nick_regex`
// EXACTLY (single source of truth, server-side):
//   first char: A-Za-z [ ] \ ` _ ^ { | }
//   rest:       the above + 0-9 + -
// Doing the rule client-side turns a raw server `400 malformed_nick` into
// foolproof inline copy — but the SERVER stays the authority; this is a
// UX affordance, not a security boundary.

export type LoginIdentifier =
  | { kind: "nick"; value: string }
  | { kind: "email"; value: string }
  | { kind: "invalid" };

const MAX_NICK_LEN = 30;

// Character CLASSES (not anchored line regexes) so we can filter a string
// char-by-char. Kept byte-identical in spirit to the server's @nick_regex
// first-char vs rest split.
const NICK_FIRST = /[A-Za-z[\]\\`_^{|}]/;
const NICK_REST = /[A-Za-z0-9[\]\\`_^{|}-]/;

// Naive email check: a non-empty local part, an "@", and a domain carrying
// at least one dot with a non-empty label after it. Deliberately loose —
// the server + the upstream do the real validation; this only rejects the
// shapes a human obviously fat-fingered (`@example.com`, `alice@localhost`)
// so an @-bearing value never leaks into the nick sanitizer that would
// strip its "@"/".". Any @-bearing value stays in the email branch (→
// "email" or "invalid"), never "nick".
const EMAIL_NAIVE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function classifyEmail(trimmed: string): LoginIdentifier {
  return EMAIL_NAIVE.test(trimmed) ? { kind: "email", value: trimmed } : { kind: "invalid" };
}

function classifyNick(trimmed: string): LoginIdentifier {
  // Collapse any internal whitespace run to a single underscore first, so
  // `my   nick` → `my_nick` (the underscore is a legal nick char, so it
  // survives the strip below).
  const underscored = trimmed.replace(/\s+/g, "_");

  // Strip disallowed characters, then cap at the server length limit.
  const stripped = Array.from(underscored)
    .filter((ch) => NICK_REST.test(ch))
    .join("")
    .slice(0, MAX_NICK_LEN);

  if (stripped === "") return { kind: "invalid" };
  // First-char rule: a digit or dash lead is illegal server-side. Don't
  // silently drop it (that would change the nick the user intended); reject
  // so the form can show the rule.
  if (!NICK_FIRST.test(stripped[0] as string)) return { kind: "invalid" };

  return { kind: "nick", value: stripped };
}

export function classifyLoginIdentifier(raw: string): LoginIdentifier {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "invalid" };
  if (trimmed.includes("@")) return classifyEmail(trimmed);
  return classifyNick(trimmed);
}
