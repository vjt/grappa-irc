import { beforeEach, describe, expect, it } from "vitest";
import type { DccOffer } from "../lib/dccOffers";
import { dccOffersById, holdDccOffer, resolveDccOffer } from "../lib/dccOffers";

// issue 2089 — the DCC offer mirror. What is asserted here is that the store
// MIRRORS and never originates: the server owns the held set, so every entry
// arrives from a `dcc_offer` event and leaves on a `dcc_offer_resolved` one.

const offer = (over: Partial<DccOffer> = {}): DccOffer => ({
  network: "azzurra",
  channel: "vjt",
  offer_id: "aaaabbbbccccddddeeeeffffgg",
  from: "vjt",
  filename: "holiday.tar.gz",
  size: 4096,
  ...over,
});

describe("dccOffers", () => {
  beforeEach(() => {
    for (const id of Object.keys(dccOffersById())) resolveDccOffer(id);
  });

  it("holds an offered file under its server-minted handle", () => {
    holdDccOffer(offer());

    expect(dccOffersById()).toEqual({ aaaabbbbccccddddeeeeffffgg: offer() });
  });

  it("keeps the window placement the server chose, including $server", () => {
    // An offer from someone with no open conversation routes to `$server`
    // (`EventRouter.ctcp_query_channel/3`, the #546 rule). A store that
    // assumed a DM window would strand most offers, so the placement is
    // read, never derived from `from`.
    holdDccOffer(offer({ channel: "$server", from: "stranger" }));

    expect(dccOffersById()).toMatchObject({ aaaabbbbccccddddeeeeffffgg: { channel: "$server" } });
  });

  it("re-asserting the same handle replaces rather than stacking", () => {
    // The cold-subscribe backfill re-emits every held offer, so a reload
    // must not draw a second banner for the same file.
    holdDccOffer(offer());
    holdDccOffer(offer({ filename: "renamed.bin" }));

    expect(Object.keys(dccOffersById())).toHaveLength(1);
    expect(dccOffersById()).toMatchObject({
      aaaabbbbccccddddeeeeffffgg: { filename: "renamed.bin" },
    });
  });

  it("holds several offers at once, keyed independently", () => {
    holdDccOffer(offer());
    holdDccOffer(offer({ offer_id: "zzzzyyyyxxxxwwwwvvvvuuuutt", from: "alice" }));

    expect(Object.keys(dccOffersById()).sort()).toEqual([
      "aaaabbbbccccddddeeeeffffgg",
      "zzzzyyyyxxxxwwwwvvvvuuuutt",
    ]);
  });

  it("drops the offer on every resolution, because the client reaction is one", () => {
    // `accepted` / `refused` / `expired` ride ONE event for exactly this
    // reason: the reason is copy, the action is identical. The store takes
    // no resolution argument at all, so a fourth exit cannot forget a case.
    for (const _ of ["accepted", "refused", "expired"]) {
      holdDccOffer(offer());
      resolveDccOffer("aaaabbbbccccddddeeeeffffgg");
      expect(dccOffersById()).toEqual({});
    }
  });

  it("resolving an unknown handle is a silent no-op, not an error", () => {
    // A resolve can name an offer this device never saw — held before the
    // socket connected, then refused on the phone. That is the fan-out
    // doing its job, not a fault.
    holdDccOffer(offer());
    resolveDccOffer("nevereverseenthishandleatall");

    expect(Object.keys(dccOffersById())).toHaveLength(1);
  });

  it("resolving leaves the other offers alone", () => {
    holdDccOffer(offer());
    holdDccOffer(offer({ offer_id: "zzzzyyyyxxxxwwwwvvvvuuuutt" }));
    resolveDccOffer("aaaabbbbccccddddeeeeffffgg");

    expect(Object.keys(dccOffersById())).toEqual(["zzzzyyyyxxxxwwwwvvvvuuuutt"]);
  });
});
