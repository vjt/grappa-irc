import { render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2430, X1 — the `/pair` route a scanned pairing QR opens. The code
// is read from the fragment, as `/share` reads its token.

const ID = "AbCdEfGhIjKlMnOpQrStUv";
const CURVE = "fJKDF4omlQo87Jaqp5pqfZqg9TcQO1PG5lS1Kzz5FIA";

const routerHolder = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@solidjs/router", () => ({ useNavigate: () => routerHolder.navigate }));

const authHolder = vi.hoisted(() => ({
  token: vi.fn<() => string | null>(),
}));
vi.mock("../lib/auth", () => ({ token: authHolder.token }));

const pairingHolder = vi.hoisted(() => ({
  joinPairing: vi.fn(),
  openChannel: vi.fn(),
  handlers: null as null | { onMessage: (p: string) => void; onClosed: (r: string) => void },
  close: vi.fn(async () => undefined),
}));
vi.mock("../lib/e2e/pairing", async (orig) => ({
  ...(await orig<typeof import("../lib/e2e/pairing")>()),
  joinPairing: pairingHolder.joinPairing,
  openChannel: pairingHolder.openChannel,
}));

import { ApiError } from "../lib/api";
import PairScan from "../PairScan";

const landOn = (hash: string) => window.history.replaceState(null, "", `/pair${hash}`);

beforeEach(() => {
  vi.clearAllMocks();
  authHolder.token.mockReturnValue("tok");
  pairingHolder.openChannel.mockImplementation((_t, rendezvous, handlers) => {
    pairingHolder.handlers = handlers;
    return {
      rendezvous,
      send: vi.fn(),
      catchUp: vi.fn(async () => undefined),
      close: pairingHolder.close,
    };
  });
  landOn(`#pair=${ID}.${CURVE}`);
});

describe("PairScan", () => {
  it("joins the rendezvous the code names and opens its channel", async () => {
    const rendezvous = { id: ID, role: "joiner", expires_at: "2026-10-22T18:00:00Z" };
    pairingHolder.joinPairing.mockResolvedValue(rendezvous);
    render(() => <PairScan />);
    await waitFor(() => expect(pairingHolder.joinPairing).toHaveBeenCalledWith("tok", ID));
    await waitFor(() => expect(pairingHolder.openChannel).toHaveBeenCalled());
    expect(pairingHolder.openChannel.mock.calls[0]?.[1]).toEqual(rendezvous);
    expect(await screen.findByTestId("pair-joined")).toBeTruthy();
  });

  it("scrubs the code from the address bar before joining", async () => {
    pairingHolder.joinPairing.mockImplementation(async () => {
      expect(window.location.hash).toBe("");
      return { id: ID, role: "joiner", expires_at: "2026-10-22T18:00:00Z" };
    });
    render(() => <PairScan />);
    await waitFor(() => expect(pairingHolder.joinPairing).toHaveBeenCalled());
    expect(window.location.pathname).toBe("/pair");
  });

  it("says so when the link carries no valid code, and joins nothing", async () => {
    landOn("#pair=nope");
    render(() => <PairScan />);
    expect(await screen.findByTestId("pair-invalid")).toBeTruthy();
    expect(pairingHolder.joinPairing).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });

  it("asks for a login first on a device that has none", async () => {
    authHolder.token.mockReturnValue(null);
    render(() => <PairScan />);
    expect(await screen.findByTestId("pair-login")).toBeTruthy();
    expect(pairingHolder.joinPairing).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("");
  });

  it("tells a second scanner the code is used", async () => {
    pairingHolder.joinPairing.mockRejectedValue(new ApiError(409, "pairing_already_joined"));
    render(() => <PairScan />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("already been used");
  });

  it("says the other device ended it when the rendezvous closes", async () => {
    pairingHolder.joinPairing.mockResolvedValue({
      id: ID,
      role: "joiner",
      expires_at: "2026-10-22T18:00:00Z",
    });
    render(() => <PairScan />);
    await waitFor(() => expect(pairingHolder.handlers).not.toBeNull());
    pairingHolder.handlers?.onClosed("expired");
    expect((await screen.findByTestId("pair-ended")).textContent).toContain("expired");
  });

  it("cancel closes the rendezvous and leaves the route", async () => {
    pairingHolder.joinPairing.mockResolvedValue({
      id: ID,
      role: "joiner",
      expires_at: "2026-10-22T18:00:00Z",
    });
    render(() => <PairScan />);
    (await screen.findByTestId("pair-cancel")).click();
    await waitFor(() => expect(routerHolder.navigate).toHaveBeenCalledWith("/", { replace: true }));
    expect(pairingHolder.close).toHaveBeenCalled();
  });

  it("closes the rendezvous when it leaves the route", async () => {
    pairingHolder.joinPairing.mockResolvedValue({
      id: ID,
      role: "joiner",
      expires_at: "2026-10-22T18:00:00Z",
    });
    const { unmount } = render(() => <PairScan />);
    await screen.findByTestId("pair-joined");
    unmount();
    await waitFor(() => expect(pairingHolder.close).toHaveBeenCalled());
  });

  it("closes a rendezvous whose join was still in flight when it left the route", async () => {
    let resolve: (r: unknown) => void = () => undefined;
    pairingHolder.joinPairing.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = render(() => <PairScan />);
    await waitFor(() => expect(pairingHolder.joinPairing).toHaveBeenCalled());
    unmount();
    resolve({ id: ID, role: "joiner", expires_at: "2026-10-22T18:00:00Z" });
    await waitFor(() => expect(pairingHolder.close).toHaveBeenCalled());
  });
});
