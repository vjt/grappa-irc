// issue 2537 — a pairing another device of this account OFFERS: grappa pushes
// the pairing's code (`e2e_pairing_offered`, protocol 55) to every device of
// the account, live when "add a device" opens and again in each user-topic
// join snapshot until someone joins, so a browser logged in after the pairing
// started hears of it too. Since issue 2549 this offer is the only way a
// pairing reaches another device: there is no QR or link.
//
// The offer becomes a banner (lib/errorBanners.ts) on a browser that has
// something to gain from it: one that does not hold the account's identity on
// some network (`identityElsewhere`). Its button opens `/pair`, which joins
// the account's offer. It never joins on its own: a rendezvous takes ONE
// joiner, so every eligible tab joining by itself would race, and the
// winner could be a tab nobody is looking at, its check code on the wrong
// screen.
//
// The offer ends when someone joins (the first `e2e_pairing_message`), when
// the rendezvous closes (`e2e_pairing_closed`), and at its `expires_at`, in
// case this tab missed the push saying so. The tab that opened the pairing is
// told its own offer back like every other device; the key in it, which that tab made,
// is how it knows the offer is its own.

import { createSignal } from "solid-js";
import { identityElsewhere } from "../encryptedChats";
import { identityScopedStore } from "../identityScopedStore";
import { networks } from "../networks";
import type { E2ePairingWireE2ePairingOfferedPayload } from "../wireTypes";
import type { PairCode } from "./pairing";

export type PairingOffer = E2ePairingWireE2ePairingOfferedPayload;

const exports_ = identityScopedStore((onIdentityChange) => {
  const [offer, setOffer] = createSignal<PairingOffer | null>(null);
  /** The keys of the pairings this tab opened. */
  const own = new Set<string>();
  let expiry: ReturnType<typeof setTimeout> | undefined;

  const clear = (): void => {
    clearTimeout(expiry);
    expiry = undefined;
    setOffer(null);
  };

  onIdentityChange(() => {
    own.clear();
    clear();
  });

  /** A pairing this tab opens with `curve`: its offer is never shown back here. */
  function offeringFromHere(curve: string): void {
    own.add(curve);
  }

  /**
   * The user-topic dispatch for `e2e_pairing_offered`. The offer already held
   * is left as it is: every rejoin's snapshot pushes it again, and clearing it
   * first would let the banner stack's re-arm forget its "Not now".
   */
  function deliverPairingOffer(next: PairingOffer): void {
    if (own.has(next.curve) || offer()?.rendezvous_id === next.rendezvous_id) return;
    const left = Date.parse(next.expires_at) - Date.now();
    if (!(left > 0)) return;
    clear();
    setOffer(next);
    expiry = setTimeout(() => pairingOfferEnded(next.rendezvous_id), left);
  }

  /** The rendezvous `id` was joined or is gone: its offer ends. */
  function pairingOfferEnded(id: string): void {
    if (offer()?.rendezvous_id === id) clear();
  }

  /** The offer, on a browser that does not hold the identity on some network. */
  function pairingOfferHere(): PairingOffer | null {
    const o = offer();
    if (o === null) return null;
    return (networks() ?? []).some((n) => identityElsewhere(n.slug)) ? o : null;
  }

  return { offeringFromHere, deliverPairingOffer, pairingOfferEnded, pairingOfferHere };
});

export const offeringFromHere = exports_.offeringFromHere;
export const deliverPairingOffer = exports_.deliverPairingOffer;
export const pairingOfferEnded = exports_.pairingOfferEnded;
export const pairingOfferHere = exports_.pairingOfferHere;

// Issue 2549 — the offer the user tapped "Pair this browser" on, handed to
// `/pair` across the document load the banner makes (the store above does not
// survive it). sessionStorage, so it never leaves this tab and no URL carries
// it: a link must not be able to pair a browser. `/pair` takes it ONCE, so a
// Back to `/pair`, a reload of it or an old link to it finds nothing and joins
// nothing, whatever the account has on offer at that moment.
export const PAIRING_ACCEPTED_KEY = "cicchetto.pairingAccepted";

/** The banner's verb: the next `/pair` in this tab joins `offer`. */
export function acceptPairingOffer(offer: PairingOffer): void {
  const code: PairCode = { id: offer.rendezvous_id, curve: offer.curve };
  sessionStorage.setItem(PAIRING_ACCEPTED_KEY, JSON.stringify(code));
}

/** The code the banner handed over, or null; the slot is cleared either way. */
export function takeAcceptedPairing(): PairCode | null {
  const raw = sessionStorage.getItem(PAIRING_ACCEPTED_KEY);
  sessionStorage.removeItem(PAIRING_ACCEPTED_KEY);
  if (raw === null) return null;
  // A storage boundary: anything at all can be in that slot.
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { id, curve } = parsed as Partial<PairCode>;
    return typeof id === "string" && typeof curve === "string" ? { id, curve } : null;
  } catch {
    return null;
  }
}
