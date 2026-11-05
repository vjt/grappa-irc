import { render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2430, X1 — the holder's side of a pairing opens a rendezvous with
// the caller's ephemeral key (the ECIES layer's). Issue 2549: grappa offers it
// to the account's other sessions, and this side shows no link, no QR and no
// copy button, only where to accept it.

const ID = "AbCdEfGhIjKlMnOpQrStUv";
const CURVE = "fJKDF4omlQo87Jaqp5pqfZqg9TcQO1PG5lS1Kzz5FIA";

const authHolder = vi.hoisted(() => ({ token: vi.fn<() => string | null>(() => "tok") }));
vi.mock("../lib/auth", () => ({ token: authHolder.token }));

const pairingHolder = vi.hoisted(() => ({
  openPairing: vi.fn(),
  openChannel: vi.fn(),
  handlers: null as null | { onMessage: (p: string) => void; onClosed: (r: string) => void },
  close: vi.fn(async () => undefined),
}));
vi.mock("../lib/e2e/pairing", async (orig) => ({
  ...(await orig<typeof import("../lib/e2e/pairing")>()),
  openPairing: pairingHolder.openPairing,
  openChannel: pairingHolder.openChannel,
}));

// issue 2537 — the key this tab offers, so its own offer is never shown back
// to it.
const offerHolder = vi.hoisted(() => ({ offeringFromHere: vi.fn() }));
vi.mock("../lib/e2e/pairingOffer", () => ({ offeringFromHere: offerHolder.offeringFromHere }));

import AddDeviceOffer from "../AddDeviceOffer";
import { ApiError } from "../lib/api";

const rendezvous = {
  id: ID,
  role: "creator",
  expires_at: new Date(Date.now() + 300_000).toISOString(),
};

beforeEach(() => {
  vi.clearAllMocks();
  pairingHolder.handlers = null;
  pairingHolder.openPairing.mockResolvedValue(rendezvous);
  pairingHolder.openChannel.mockImplementation((_t, r, handlers) => {
    pairingHolder.handlers = handlers;
    return {
      rendezvous: r,
      send: vi.fn(),
      catchUp: vi.fn(async () => undefined),
      close: pairingHolder.close,
    };
  });
});

describe("AddDeviceOffer", () => {
  it("opens a rendezvous with the caller's key and says where to accept it", async () => {
    const onChannel = vi.fn();
    render(() => (
      <AddDeviceOffer curve={CURVE} onChannel={onChannel} onMessage={vi.fn()} onClosed={vi.fn()} />
    ));
    const waiting = await screen.findByTestId("pair-waiting");
    expect(waiting.textContent).toContain("Pair this browser");
    expect(pairingHolder.openPairing).toHaveBeenCalledWith("tok", CURVE);
    expect(onChannel).toHaveBeenCalledTimes(1);
    expect(onChannel.mock.calls[0]?.[0].rendezvous).toEqual(rendezvous);
  });

  // A link opened outside the app pairs the browser it opens in, not the
  // app the user meant to pair: nothing here may carry the pairing.
  it("shows no pairing link, no QR code and no copy button", async () => {
    const { container } = render(() => (
      <AddDeviceOffer curve={CURVE} onChannel={vi.fn()} onMessage={vi.fn()} onClosed={vi.fn()} />
    ));
    await screen.findByTestId("pair-waiting");
    expect(container.querySelector("svg, img, a, button")).toBeNull();
    expect(container.textContent).not.toContain(ID);
    expect(container.textContent).not.toContain(CURVE);
    expect(container.textContent).not.toContain("/pair");
  });

  it("marks its key as this tab's own before the open can be offered back to it", async () => {
    render(() => (
      <AddDeviceOffer curve={CURVE} onChannel={vi.fn()} onMessage={vi.fn()} onClosed={vi.fn()} />
    ));
    await screen.findByTestId("pair-waiting");
    expect(offerHolder.offeringFromHere).toHaveBeenCalledExactlyOnceWith(CURVE);
    expect(offerHolder.offeringFromHere.mock.invocationCallOrder[0]).toBeLessThan(
      pairingHolder.openPairing.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("counts down to the rendezvous's expiry", async () => {
    render(() => (
      <AddDeviceOffer curve={CURVE} onChannel={vi.fn()} onMessage={vi.fn()} onClosed={vi.fn()} />
    ));
    expect((await screen.findByTestId("pair-countdown")).textContent).toMatch(/[45]:\d\d/);
  });

  it("shows why an open failed", async () => {
    pairingHolder.openPairing.mockRejectedValue(new ApiError(429, "rate_limited"));
    render(() => (
      <AddDeviceOffer curve={CURVE} onChannel={vi.fn()} onMessage={vi.fn()} onClosed={vi.fn()} />
    ));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("pair-waiting")).toBeNull();
  });

  // Why it ended is the caller's to say (AddDevicePanel): it alone knows
  // what the pairing came to.
  it("drops the waiting line once the rendezvous is gone, and tells its caller why", async () => {
    const onClosed = vi.fn();
    render(() => (
      <AddDeviceOffer curve={CURVE} onChannel={vi.fn()} onMessage={vi.fn()} onClosed={onClosed} />
    ));
    await screen.findByTestId("pair-waiting");
    pairingHolder.handlers?.onClosed("replaced");
    expect(onClosed).toHaveBeenCalledExactlyOnceWith("replaced");
    await waitFor(() => expect(screen.queryByTestId("pair-waiting")).toBeNull());
    expect(screen.queryByTestId("pair-ended")).toBeNull();
  });

  it("hands what the other side posts to onMessage", async () => {
    const onMessage = vi.fn();
    render(() => (
      <AddDeviceOffer curve={CURVE} onChannel={vi.fn()} onMessage={onMessage} onClosed={vi.fn()} />
    ));
    await screen.findByTestId("pair-waiting");
    pairingHolder.handlers?.onMessage("b3BhcXVl");
    expect(onMessage).toHaveBeenCalledWith("b3BhcXVl");
  });

  it("closes a rendezvous whose open was still in flight when it left the screen", async () => {
    let resolve: (r: typeof rendezvous) => void = () => undefined;
    pairingHolder.openPairing.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = render(() => (
      <AddDeviceOffer curve={CURVE} onChannel={vi.fn()} onMessage={vi.fn()} onClosed={vi.fn()} />
    ));
    await waitFor(() => expect(pairingHolder.openPairing).toHaveBeenCalled());
    unmount();
    resolve(rendezvous);
    await waitFor(() => expect(pairingHolder.close).toHaveBeenCalled());
  });

  it("closes the rendezvous when it leaves the screen", async () => {
    const { unmount } = render(() => (
      <AddDeviceOffer curve={CURVE} onChannel={vi.fn()} onMessage={vi.fn()} onClosed={vi.fn()} />
    ));
    await screen.findByTestId("pair-waiting");
    unmount();
    await waitFor(() => expect(pairingHolder.close).toHaveBeenCalled());
  });
});
