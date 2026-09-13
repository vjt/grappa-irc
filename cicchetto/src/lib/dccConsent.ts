import { deleteDccOffer, postDccOfferAccept } from "./api";
import { token } from "./auth";

// issue 2089 — the two answers to a held DCC offer, and nothing else.
//
// The consent design's whole point is that a peer's `DCC SEND` is never
// acted on unprompted: the server parses the offer, dials nothing, and HOLDS
// it. These are the two verbs that end that hold — the operator's yes and
// their no — and they are the exact twins of `channelJoin`'s
// `acceptInvite` / `declineInvite`: two answers to one question, so they
// live together, thin, over the two doors that own them.
//
// ## Neither verb touches the mirror, and that is not laziness
//
// `dccOffers.ts` drops an offer when the server says `dcc_offer_resolved`,
// never when a button is pressed. An optimistic local drop would be wrong
// twice over:
//
//   * the accept door answers **202** — the transfer runs detached and can
//     still fail (refused connect, truncated, over quota), and its outcome
//     is a scrollback row. Removing the banner on the click would report a
//     success that has not happened yet;
//   * the resolution fans out to EVERY device. Dropping it here and nowhere
//     else makes the phone and the laptop disagree about a file that is
//     still held — the #976 shape one issue later, with a file attached.
//
// So there is no store import in this file at all. If a future reader is
// tempted to add one, that is the rule they are about to break.
//
// ## Fire-and-forget, like its invite twins
//
// No dedicated error surface: a failure is logged, not thrown. The realistic
// failure is `not_held` — BOTH doors answer it, because both ask the same
// question (is this offer still in the held set?) and both lose the same
// race: the hold ran out, or the offer was already answered on another
// device. In that case `dcc_offer_resolved` has already been broadcast or is
// about to be, so the banner is on its way out regardless, and a modal for a
// race the server is resolving would be noise.
//
// The token is the DECIDED REST vocabulary, not something observed from
// here — nothing on this branch serves either door yet. Nothing reads it,
// either: it is logged whole and never matched on, so a different spelling
// costs a log line's accuracy and no behaviour.

export function acceptDccOffer(networkSlug: string, offerId: string): void {
  const t = token();
  if (!t) return; // post-logout race — nothing to accept with.
  void postDccOfferAccept(t, networkSlug, offerId).catch((err: unknown) => {
    console.warn(`[#2089 dcc] failed to accept offer ${offerId} on ${networkSlug}:`, err);
  });
}

export function refuseDccOffer(networkSlug: string, offerId: string): void {
  const t = token();
  if (!t) return; // post-logout race — nothing to refuse with.
  void deleteDccOffer(t, networkSlug, offerId).catch((err: unknown) => {
    console.warn(`[#2089 dcc] failed to refuse offer ${offerId} on ${networkSlug}:`, err);
  });
}
