// The SINGLE client-side "does this line mention me?" predicate.
//
// The source is ONE list: the operator's watchlist = own nick ∪ the custom
// /hilight keyword list (#356). The own nick is just ANOTHER ENTRY in that
// list, NOT a special case — every term is matched the same way (word-boundary,
// case-insensitive). Mirror of the server SSOT `Grappa.Mentions.mentioned?/3`.
//
// #370 — ONE BODY predicate feeds EVERY client sink:
//   - in-message visual highlight (ScrollbackPane `.scrollback-mention` /
//     `.scrollback-highlight`, MentionsWindow),
//   - the live in-app beep + optimistic desktop-title bump (subscribe.ts),
// and is kept in parity with the client push mirror (pushTriggers.shouldNotify,
// a drift-guard tested against the shared server truth-table, no live caller).
//
// #370 read that as "the two ports can never diverge again" and it was too
// strong: a body predicate cannot answer a SENDER question. They diverged on
// exactly that axis until issue 1481 — see `isOwnRow` / `isMentionRow` below,
// which are the sender half and the row-level rule the render sinks fold.
// The server owns the remaining sinks (OS push + sidebar count) via the same
// `mentioned?/3` source. Before #370 the visual path and the live beep only
// ever matched the own nick, so a /hilight word fired the (server-side)
// notification yet rendered plain and stayed silent — the paths had forked.
//
// `matchesTerm` (private) is the per-term word-boundary primitive; it skips
// falsy terms, so a not-yet-resolved own nick still matches on patterns alone.
// RFC 2812 nick chars include `[`, `]`, `\` etc.; the regex metacharacter
// escape covers the cases that would otherwise blow up the RegExp constructor.

import { mircPlainText } from "./mircFormat";
import { nickEquals } from "./nickEquals";
import { isServerSender, isServicesSender } from "./servicesSender";

// #1786 — the anchor is conditional on the term's OWN edge, and that is a fix
// rather than a loosening.
//
// `\b` is a TRANSITION between a word char and a non-word one, so it is only
// satisfiable on a side where the term's edge character IS a word char. Wrapped
// unconditionally, a term like `QUACK!` demanded a word character immediately
// after the `!` — end-of-line and a space both fail it, so the term could never
// match anything. Found in prod as a whole watchlist of trailing-`!` terms the
// settings pane listed as active while they silently matched nothing.
//
// The lookarounds say what `\b` was always meant to say on those edges: "not
// glued to a word". They are NOT the same as dropping the anchor — `!list` must
// still refuse `foo!list` — which is the pair of cases the test file calls
// discriminating.
//
// The probe is a regex over the RAW term rather than a character-class literal
// so that it consults the SAME `\w` the anchor will: one definition, no second
// spelling to drift from it. Mirror of `Grappa.Mentions.build_matchers/1`; a
// change here lands in both ports together, per this module's header.
const termAnchors = (term: string): { readonly prefix: string; readonly suffix: string } => ({
  prefix: /^\w/.test(term) ? "\\b" : "(?<!\\w)",
  suffix: /\w$/.test(term) ? "\\b" : "(?!\\w)",
});

const matchesTerm = (body: string | null, term: string | null): boolean => {
  if (!body || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const { prefix, suffix } = termAnchors(term);
  return new RegExp(`${prefix}${escaped}${suffix}`, "i").test(body);
};

// issue 1908 — the predicate reads the RENDERED text, because that is the text
// the operator read when they typed the keyword into the settings pane.
//
// The failure the projection closes is narrower than "control bytes in the
// body", and the narrow reading is the load-bearing one. `\x02` `\x0f` `\x16`
// `\x1d` `\x1f` carry no arguments and are not word characters, so `\b` keeps
// its transition on both sides of a term and a bold-only sender always matched
// fine (measured on `rex`: 139 bold lines, zero misses). The COLOUR byte is
// different — it drags up to four numeric arguments into the text, and digits
// ARE word characters, so `\x0315QUACK!` reads to the regex as `...15QUACK!`
// and the term's left anchor has no transition left to sit on. A stripper that
// removed the control bytes alone would leave this bug fully intact.
//
// `mircPlainText` is that projection and it consumes the arguments (measured,
// not assumed): it runs the SAME `parseMircFormat` the renderer uses, so there
// is no second stripper to drift from the one that decides what is on screen.
//
// Stripped ONCE per call rather than inside `matchesTerm`, which runs per term.
// Mirror of `Grappa.Mentions`' projection at `body_matches?/2`; the two ports
// change together or the visual highlight and the OS push disagree again.
export const matchesWatchlist = (
  body: string | null,
  ownNick: string | null,
  patterns: string[],
): boolean => {
  const text = body === null ? null : mircPlainText(body);
  return [ownNick, ...patterns].some((term) => matchesTerm(text, term));
};

// #1674 — the SENDER half of the mention rule. Mirror of
// `Grappa.Mentions.mentionable_sender?/1`: being told something by a robot
// is not being mentioned by somebody. A NickServ login confirmation and the
// ircd's connect notices both spell your nick as a matter of routine, and
// on the server that lit the highest-severity badge grappa has.
//
// Keyed on the SENDER, not the kind: a human `/notice` IS conversation and
// still counts. Biased toward `true` — it only ever SUBTRACTS, so an empty
// sender stays mentionable and the other conjuncts decide it.
export const isMentionableSender = (sender: string): boolean =>
  !isServicesSender(sender) && !isServerSender(sender);

// issue 1481 — "is this row MINE?", and the single client spelling of it.
// Mirror of `Grappa.Push.Triggers.own_row?/2` (#532 C).
//
// Decided by sender IDENTITY, never by window shape: an OUTBOUND DM is
// persisted with `channel = peer` (only an INBOUND one carries `channel =
// own_nick`), so a shape test misroutes it and the operator's own watchlist
// then runs over the operator's own body.
//
// #1861 — pinned to `"ascii"`, deliberately, and this is now the ONE place
// that pin lives on the client. Both consumers are faithful transcriptions
// of SERVER predicates whose every fold is the arity-1
// `Identifier.canonical_target/1` (`own_row?/2`, `WindowCounts.mention_row?/3`).
// Folding harder here than the server folds would make cic disagree with the
// server's own answer on an rfc1459 network. When the server's mention folds
// become network-aware, this moves WITH them, not before.
export const isOwnRow = (sender: string, ownNick: string | null): boolean =>
  nickEquals(sender, ownNick, "ascii");

// issue 1481 — the ROW-level mention rule the RENDER port folds: the sender
// conjunct AND the body match, asked as one question so the three render
// sites cannot answer it three different ways.
//
// The render port used to call `matchesWatchlist` bare, from
// `ScrollbackPane`'s `isMention` + `isHighlight` and from `MentionsWindow`.
// Three open-coded copies of half a rule is exactly how this port drifted
// from the notify one, which has excluded own rows since #532 C — so your own
// line naming your own nick highlighted itself back at you (reported twice on
// IRC, by alk and by Mezmerize). `.scrollback-mention` is also what the
// below-the-fold mention badge reads off the DOM (`readMentionGeom` →
// `mentionsBelowViewport`), so that sink inherits this and needs no guard.
//
// Mirror of the server's `Grappa.Mentions.mention_row?/3` MINUS its
// `mentionable_sender?/1` conjunct: the render port has never subtracted
// services or the server, and #1674 scoped that axis to the badge and the OS
// push. Left as-is deliberately — a separate decision, not this one.
export const isMentionRow = (
  row: { readonly sender: string; readonly body: string | null },
  ownNick: string | null,
  patterns: string[],
): boolean => !isOwnRow(row.sender, ownNick) && matchesWatchlist(row.body, ownNick, patterns);
