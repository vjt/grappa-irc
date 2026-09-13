import { createSignal } from "solid-js";
import type { WireUserEvent } from "./api";
import { identityScopedStore } from "./identityScopedStore";

// issue 2089 — the MIRROR of the DCC offers the bouncer is holding.
//
// A peer's `DCC SEND` is never acted on unprompted: the server parses the
// offer, dials nothing, stores nothing, and HOLDS it until the operator
// says yes. This store is the client half of that hold — it exists so a
// consent surface has something to render, and it originates nothing.
//
// ## cic does not originate state, and here that is load-bearing twice
//
// The held set lives in `Grappa.Session.Server`, fans out on the user
// topic, and is re-emitted on a cold subscribe. So: no optimistic insert
// when the operator clicks accept, and no local removal either — both
// doors are REST calls whose EFFECT arrives back as `dcc_offer_resolved`,
// on every device. A local drop would make the phone and the laptop
// disagree about an offer that is still live, which is the #976 shape one
// issue later, with a file attached.
//
// The second reason is sharper than housekeeping: an offer this store
// invented would be a consent prompt for something the server will not
// honour, and the operator's yes would go nowhere.
//
// ## Keyed by `offer_id`, placed by `channel`
//
// `offer_id` is the opaque handle the accept + refuse doors take; it is
// minted server-side per offer and is not derivable from anything the peer
// sent. `channel` says WHERE to render — and it is frequently `$server`,
// because an offer from someone with no open conversation routes there
// (`EventRouter.ctcp_query_channel/3`, the #546 rule: a stranger's CTCP
// mints no window). A surface that assumed a DM window would strand most
// offers, so the placement is read, never assumed.
//
// Deliberately NOT folded into `windowStateByChannel`: an offer is placed
// in a window, it is not one. The server's payload carries no `state`
// field for exactly that reason, and mirroring it into the window map
// would draw a pseudo-window for a file nobody has accepted.

export type DccOffer = Omit<Extract<WireUserEvent, { kind: "dcc_offer" }>, "kind">;

const exports_ = identityScopedStore((onIdentityChange) => {
  const [dccOffersById, setDccOffersById] = createSignal<Record<string, DccOffer>>({});

  onIdentityChange(() => setDccOffersById({}));

  // Re-asserting an offer_id already held is a replace, not a duplicate:
  // the cold-subscribe backfill re-emits every held offer, and a reload
  // must not stack a second banner on the same file.
  const holdDccOffer = (offer: DccOffer): void => {
    setDccOffersById((prev) => ({ ...prev, [offer.offer_id]: offer }));
  };

  // One drop for all three resolutions. The server sends `accepted`,
  // `refused` and `expired` through a single event precisely because the
  // client reaction is identical — the banner goes — and the reason is for
  // copy, not for control flow. Unknown ids are a silent no-op: a resolve
  // can arrive for an offer this device never saw (held before the socket
  // connected, then refused on the phone), and that is the event doing its
  // job rather than an error.
  const resolveDccOffer = (offerId: string): void => {
    setDccOffersById((prev) => {
      if (!(offerId in prev)) return prev;
      const next = { ...prev };
      delete next[offerId];
      return next;
    });
  };

  return { dccOffersById, holdDccOffer, resolveDccOffer };
});

export const dccOffersById = exports_.dccOffersById;
export const holdDccOffer = exports_.holdDccOffer;
export const resolveDccOffer = exports_.resolveDccOffer;
