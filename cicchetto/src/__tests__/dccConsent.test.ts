import { beforeEach, describe, expect, it, vi } from "vitest";
import { dccOffersById, holdDccOffer, resolveDccOffer } from "../lib/dccOffers";

// issue 2089 — the two answers to a held DCC offer.
//
// What is under test is NOT that a fetch happens (that would be a mirror of
// the implementation). It is the two properties the consent design rests on:
// the operator's answer reaches the server through the door that owns it,
// and NEITHER answer touches the client-side mirror. The banner goes away
// when `dcc_offer_resolved` arrives, on every device — a local drop would
// make the phone and the laptop disagree about a file that is still held.

const acceptMock = vi.fn<(t: string, slug: string, offerId: string) => Promise<void>>(() =>
  Promise.resolve(),
);
const refuseMock = vi.fn<(t: string, slug: string, offerId: string) => Promise<void>>(() =>
  Promise.resolve(),
);
const { tokenMock } = vi.hoisted(() => ({
  tokenMock: vi.fn<() => string | null>(() => "tok"),
}));

vi.mock("../lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/api")>();
  return {
    ...actual,
    postDccOfferAccept: (t: string, slug: string, offerId: string) => acceptMock(t, slug, offerId),
    deleteDccOffer: (t: string, slug: string, offerId: string) => refuseMock(t, slug, offerId),
  };
});

vi.mock("../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/auth")>();
  return { ...actual, token: () => tokenMock() };
});

const SLUG = "azzurra";
const OFFER_ID = "aaaabbbbccccddddeeeeffffgg";

const held = () => ({
  network: SLUG,
  channel: "$server",
  offer_id: OFFER_ID,
  from: "stranger",
  filename: "holiday.tar.gz",
  size: 4096,
});

// Wait out the promise chain a fire-and-forget verb leaves behind, so a
// rejection is delivered to its `.catch` BEFORE the assertion runs (and an
// UNHANDLED one would surface here rather than in a later, unrelated test).
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  vi.clearAllMocks();
  tokenMock.mockReturnValue("tok");
  acceptMock.mockResolvedValue(undefined);
  refuseMock.mockResolvedValue(undefined);
  for (const id of Object.keys(dccOffersById())) resolveDccOffer(id);
});

describe("acceptDccOffer (#2089)", () => {
  it("posts the operator's yes to the accept door, keyed by the server-minted handle", async () => {
    const { acceptDccOffer } = await import("../lib/dccConsent");
    acceptDccOffer(SLUG, OFFER_ID);

    expect(acceptMock).toHaveBeenCalledWith("tok", SLUG, OFFER_ID);
  });

  it("does NOT drop the offer from the mirror — the server's resolution does", async () => {
    holdDccOffer(held());
    const { acceptDccOffer } = await import("../lib/dccConsent");
    acceptDccOffer(SLUG, OFFER_ID);
    await settle();

    // The transfer runs detached (the door answers 202) and its outcome
    // arrives as a scrollback row. Dropping the banner here would tell this
    // device the offer is gone while the phone still shows it held.
    expect(dccOffersById()[OFFER_ID]).toBeDefined();
  });

  it("does nothing without a token — a post-logout click has nothing to accept with", async () => {
    tokenMock.mockReturnValue(null);
    const { acceptDccOffer } = await import("../lib/dccConsent");
    acceptDccOffer(SLUG, OFFER_ID);

    expect(acceptMock).not.toHaveBeenCalled();
  });

  it("logs a failed accept instead of throwing into an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    acceptMock.mockRejectedValue(new Error("not_held"));
    const { acceptDccOffer } = await import("../lib/dccConsent");
    acceptDccOffer(SLUG, OFFER_ID);
    await settle();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("refuseDccOffer (#2089)", () => {
  it("sends the operator's no to the refuse door", async () => {
    const { refuseDccOffer } = await import("../lib/dccConsent");
    refuseDccOffer(SLUG, OFFER_ID);

    expect(refuseMock).toHaveBeenCalledWith("tok", SLUG, OFFER_ID);
  });

  it("does NOT drop the offer from the mirror either", async () => {
    holdDccOffer(held());
    const { refuseDccOffer } = await import("../lib/dccConsent");
    refuseDccOffer(SLUG, OFFER_ID);
    await settle();

    // Same reason as the accept: `dcc_offer_resolved` is what clears it, and
    // it reaches every device. An optimistic drop is the #976 shape with a
    // file attached.
    expect(dccOffersById()[OFFER_ID]).toBeDefined();
  });

  it("does nothing without a token", async () => {
    tokenMock.mockReturnValue(null);
    const { refuseDccOffer } = await import("../lib/dccConsent");
    refuseDccOffer(SLUG, OFFER_ID);

    expect(refuseMock).not.toHaveBeenCalled();
  });

  it("logs a failed refuse instead of throwing into an unhandled rejection", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    refuseMock.mockRejectedValue(new Error("not_held"));
    const { refuseDccOffer } = await import("../lib/dccConsent");
    refuseDccOffer(SLUG, OFFER_ID);
    await settle();

    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
