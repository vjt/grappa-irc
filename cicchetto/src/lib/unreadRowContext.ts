// issue 2045 — ONE way to answer "who is the operator, in this window?".
//
// `unreadCount.ts` publishes the predicates (`countsAsUnreadMessage`,
// `countsAsUnreadEvent`, `isOperatorOwnedRow`) and takes the answer as a
// parameter, deliberately: it stays pure and reaches for no store. Somebody
// still has to build that parameter, and until now exactly one caller did —
// `selection.ts`, inline, in the middle of its per-key loop.
//
// 🔴 Why that had to be extracted before a SECOND caller appeared, rather
// than copied. `far.missed` is written by two producers — the server's
// `Scrollback.count_after_split/6` and cic's own far-behind maintenance — and
// issue 2045 is what happens when the two answer the same question with one
// term of difference. A second hand-built context would be the same failure
// one level down: two spellings of "who am I here", free to drift, feeding
// two counts that are supposed to be one number. The context is the shared
// input, so it gets one home.
//
// Every field is load-bearing and none is guessable:
//
//   * `ownNick` is PER-NETWORK (`net.nick`), never the account name.
//     `api.ts`'s own warning on `ownNickForNetwork` spells out why: after a
//     NickServ ghost recovery the account is "vjt" while the IRC nick is
//     "vjt-grappa", and substituting one for the other is the cic H3
//     DM-misrouting root cause from the 2026-05-08 review.
//   * `casemapping` is per-network too (#537 axis 2), so the nick MATCH folds
//     the way that network's ircd folds.
//   * `isSelfWindow` is the #396 carve-out: the pane keyed to your own nick is
//     the ONE window where own content is legitimate payload (a note-to-self),
//     so it is NOT excluded there. Mirrors the server's `self_window?` in
//     `count_after_split/6`.
//
// A `null` network — not hydrated yet, or unknown slug — yields a `null`
// nick, and `nickEquals` is null-safe, so the exclusion is simply inert until
// the resource lands. That is the honest degradation: count everything rather
// than guess an identity.

import { ownNickForNetwork } from "./api";
import { casemappingForNetwork } from "./isupport";
import { networkBySlug, user } from "./networks";
import { nickEquals } from "./nickEquals";
import type { UnreadRowContext } from "./unreadCount";

/**
 * Resolve the operator's identity for the window `(slug, name)`.
 *
 * Reactive: reads the `networks` and `user` signals, so a caller inside a memo
 * or an effect re-runs when the network resource hydrates or the identity
 * rotates.
 *
 * @param slug the network slug the window belongs to.
 * @param name the window's channel or peer-nick name, RAW (the fold happens
 *             inside, via `nickEquals`).
 */
export const unreadRowContextFor = (slug: string, name: string): UnreadRowContext => {
  const net = networkBySlug(slug);
  const ownNick = net ? ownNickForNetwork(net, user()) : null;
  const casemapping = casemappingForNetwork(net?.id ?? null);
  return { ownNick, casemapping, isSelfWindow: nickEquals(name, ownNick, casemapping) };
};
