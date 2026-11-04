import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// issue 2537 — a pairing another device of the account offers, pushed on the
// user topic: shown on a browser that does not hold the identity on some
// network, never to the tab that opened it, gone when someone joins, when the
// rendezvous closes, and at its expiry.

vi.mock("../lib/auth", async () => {
  const { createSignal } = await import("solid-js");
  const [tok, setTok] = createSignal<string | null>("tokA");
  return { token: tok, setToken: setTok };
});

const holder = vi.hoisted(() => ({ elsewhere: new Set<string>() }));
vi.mock("../lib/encryptedChats", () => ({
  identityElsewhere: (slug: string) => holder.elsewhere.has(slug),
}));
vi.mock("../lib/networks", () => ({
  networks: () => [{ slug: "azzurra" }, { slug: "libera" }],
}));

import { setToken } from "../lib/auth";
import {
  deliverPairingOffer,
  offeringFromHere,
  type PairingOffer,
  pairingOfferEnded,
  pairingOfferHere,
} from "../lib/e2e/pairingOffer";

const CURVE = "fJKDF4omlQo87Jaqp5pqfZqg9TcQO1PG5lS1Kzz5FIA";

const offer = (id: string, ms: number, curve = CURVE): PairingOffer => ({
  kind: "e2e_pairing_offered",
  rendezvous_id: id,
  curve,
  expires_at: new Date(Date.now() + ms).toISOString(),
});

beforeEach(() => {
  vi.useFakeTimers();
  holder.elsewhere = new Set(["libera"]);
  pairingOfferEnded("AbCdEfGhIjKlMnOpQrStUv");
  pairingOfferEnded("ZyXwVuTsRqPoNmLkJiHgFe");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pairingOffer", () => {
  it("shows an offer on a browser that does not hold the identity on some network", () => {
    const o = offer("AbCdEfGhIjKlMnOpQrStUv", 300_000);
    deliverPairingOffer(o);
    expect(pairingOfferHere()).toEqual(o);
  });

  it("shows none on a browser that holds the identity on every network", () => {
    holder.elsewhere = new Set();
    deliverPairingOffer(offer("AbCdEfGhIjKlMnOpQrStUv", 300_000));
    expect(pairingOfferHere()).toBeNull();
  });

  it("never shows the tab that opened the pairing its own offer", () => {
    const own = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY";
    offeringFromHere(own);
    deliverPairingOffer(offer("AbCdEfGhIjKlMnOpQrStUv", 300_000, own));
    expect(pairingOfferHere()).toBeNull();
  });

  it("ends when its rendezvous is joined or gone, and not on another's", () => {
    deliverPairingOffer(offer("AbCdEfGhIjKlMnOpQrStUv", 300_000));
    pairingOfferEnded("ZyXwVuTsRqPoNmLkJiHgFe");
    expect(pairingOfferHere()?.rendezvous_id).toBe("AbCdEfGhIjKlMnOpQrStUv");
    pairingOfferEnded("AbCdEfGhIjKlMnOpQrStUv");
    expect(pairingOfferHere()).toBeNull();
  });

  it("ends at its expiry, even with no push saying so", () => {
    deliverPairingOffer(offer("AbCdEfGhIjKlMnOpQrStUv", 60_000));
    vi.advanceTimersByTime(59_000);
    expect(pairingOfferHere()).not.toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(pairingOfferHere()).toBeNull();
  });

  it("never shows an offer already past its expiry", () => {
    deliverPairingOffer(offer("AbCdEfGhIjKlMnOpQrStUv", -1_000));
    expect(pairingOfferHere()).toBeNull();
  });

  it("takes a newer offer in place of the old one, on the newer's clock", () => {
    deliverPairingOffer(offer("AbCdEfGhIjKlMnOpQrStUv", 10_000));
    deliverPairingOffer(offer("ZyXwVuTsRqPoNmLkJiHgFe", 60_000));
    expect(pairingOfferHere()?.rendezvous_id).toBe("ZyXwVuTsRqPoNmLkJiHgFe");
    vi.advanceTimersByTime(30_000);
    expect(pairingOfferHere()?.rendezvous_id).toBe("ZyXwVuTsRqPoNmLkJiHgFe");
  });

  it("drops the offer when another account logs in", () => {
    deliverPairingOffer(offer("AbCdEfGhIjKlMnOpQrStUv", 300_000));
    setToken("tokB");
    expect(pairingOfferHere()).toBeNull();
  });
});
