import { render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2430, X1 — the showing side of a pairing: open a rendezvous, show
// its code as a QR. The ephemeral key comes from the caller (the ECIES
// layer, w1's); this component only puts it in the code.

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

import AddDeviceQr from "../AddDeviceQr";
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

describe("AddDeviceQr", () => {
  it("opens a rendezvous and shows its code as a QR and as a link", async () => {
    const onChannel = vi.fn();
    render(() => (
      <AddDeviceQr curve={CURVE} onChannel={onChannel} onMessage={vi.fn()} onClosed={vi.fn()} />
    ));
    const qr = await screen.findByTestId("pair-qr");
    expect(qr.querySelector("svg")?.getAttribute("aria-label")).toBe("pairing QR code");
    expect(screen.getByTestId("pair-url").textContent).toBe(
      `${window.location.origin}/pair#pair=${ID}.${CURVE}`,
    );
    expect(pairingHolder.openPairing).toHaveBeenCalledWith("tok");
    expect(onChannel).toHaveBeenCalledTimes(1);
    expect(onChannel.mock.calls[0]?.[0].rendezvous).toEqual(rendezvous);
  });

  it("counts down to the rendezvous's expiry", async () => {
    render(() => (
      <AddDeviceQr curve={CURVE} onChannel={vi.fn()} onMessage={vi.fn()} onClosed={vi.fn()} />
    ));
    expect((await screen.findByTestId("pair-countdown")).textContent).toMatch(/[45]:\d\d/);
  });

  it("shows why an open failed", async () => {
    pairingHolder.openPairing.mockRejectedValue(new ApiError(429, "rate_limited"));
    render(() => (
      <AddDeviceQr curve={CURVE} onChannel={vi.fn()} onMessage={vi.fn()} onClosed={vi.fn()} />
    ));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByTestId("pair-qr")).toBeNull();
  });

  // Why it ended is the caller's to say (AddDevicePanel): it alone knows
  // what the pairing came to.
  it("drops the QR once the rendezvous is gone, and tells its caller why", async () => {
    const onClosed = vi.fn();
    render(() => (
      <AddDeviceQr curve={CURVE} onChannel={vi.fn()} onMessage={vi.fn()} onClosed={onClosed} />
    ));
    await screen.findByTestId("pair-qr");
    pairingHolder.handlers?.onClosed("replaced");
    expect(onClosed).toHaveBeenCalledExactlyOnceWith("replaced");
    await waitFor(() => expect(screen.queryByTestId("pair-qr")).toBeNull());
    expect(screen.queryByTestId("pair-ended")).toBeNull();
  });

  it("hands what the other side posts to onMessage", async () => {
    const onMessage = vi.fn();
    render(() => (
      <AddDeviceQr curve={CURVE} onChannel={vi.fn()} onMessage={onMessage} onClosed={vi.fn()} />
    ));
    await screen.findByTestId("pair-qr");
    pairingHolder.handlers?.onMessage("b3BhcXVl");
    expect(onMessage).toHaveBeenCalledWith("b3BhcXVl");
  });

  it("closes a rendezvous whose open was still in flight when it left the screen", async () => {
    let resolve: (r: typeof rendezvous) => void = () => undefined;
    pairingHolder.openPairing.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = render(() => (
      <AddDeviceQr curve={CURVE} onChannel={vi.fn()} onMessage={vi.fn()} onClosed={vi.fn()} />
    ));
    await waitFor(() => expect(pairingHolder.openPairing).toHaveBeenCalled());
    unmount();
    resolve(rendezvous);
    await waitFor(() => expect(pairingHolder.close).toHaveBeenCalled());
  });

  it("closes the rendezvous when it leaves the screen", async () => {
    const { unmount } = render(() => (
      <AddDeviceQr curve={CURVE} onChannel={vi.fn()} onMessage={vi.fn()} onClosed={vi.fn()} />
    ));
    await screen.findByTestId("pair-qr");
    unmount();
    await waitFor(() => expect(pairingHolder.close).toHaveBeenCalled());
  });
});
