import { render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

// issue 2430, X1 — the `/pair` route, where a browser joins a pairing.
// Issue 2549: it joins only the offer the banner handed it (once, across the
// document load); nothing in the address bar names one, and a Back, a reload
// or an old link to `/pair` joins nothing.

const ID = "AbCdEfGhIjKlMnOpQrStUv";
const CURVE = "fJKDF4omlQo87Jaqp5pqfZqg9TcQO1PG5lS1Kzz5FIA";

const routerHolder = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock("@solidjs/router", () => ({ useNavigate: () => routerHolder.navigate }));

const authHolder = vi.hoisted(() => ({
  token: vi.fn<() => string | null>(),
}));
vi.mock("../lib/auth", () => ({ token: authHolder.token }));

const session = vi.hoisted(() => ({
  current: null as null | {
    onPayload: ReturnType<typeof vi.fn>;
    onClosed: ReturnType<typeof vi.fn>;
    attach: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
  },
  pairingDeps: vi.fn(),
  joinerPairing: vi.fn(),
  paired: vi.fn(),
  setState: null as null | ((s: unknown) => void),
}));
vi.mock("../lib/e2e/pairingDeps", () => ({ pairingDeps: session.pairingDeps }));
vi.mock("../lib/e2e/pairingSession", () => ({ joinerPairing: session.joinerPairing }));
vi.mock("../lib/encryptedChats", () => ({ pairedHere: session.paired }));

const offerHolder = vi.hoisted(() => ({ take: vi.fn() }));
vi.mock("../lib/e2e/pairingOffer", () => ({ takeAcceptedPairing: offerHolder.take }));

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
import type { JoinerState } from "../lib/e2e/pairingSession";

const { default: PairJoin } = await import("../PairJoin");

const landOn = (hash: string) => window.history.replaceState(null, "", `/pair${hash}`);

const joining = (): JoinerState => ({
  stage: "joining",
  checkCode: null,
  offered: [],
  full: [],
  results: [],
  ended: null,
});
const DEPS = { marker: "deps" };
const RENDEZVOUS = { id: ID, role: "joiner", expires_at: "2026-10-22T18:00:00Z" };
let setState: (s: JoinerState) => void;

beforeEach(() => {
  vi.clearAllMocks();
  pairingHolder.handlers = null;
  authHolder.token.mockReturnValue("tok");
  const [state, set] = createSignal<JoinerState>(joining());
  setState = set;
  const fake = {
    state,
    onPayload: vi.fn(),
    // The real session ends on a close that comes before it is done.
    onClosed: vi.fn((reason: string) => {
      if (state().stage !== "done") set({ ...state(), stage: "ended", ended: reason as never });
    }),
    attach: vi.fn(),
    confirm: vi.fn(),
    cancel: vi.fn(),
  };
  session.current = fake;
  session.pairingDeps.mockResolvedValue(DEPS);
  offerHolder.take.mockReturnValue({ id: ID, curve: CURVE });
  session.joinerPairing.mockReturnValue(fake);
  pairingHolder.openChannel.mockImplementation((_t, rendezvous, handlers) => {
    pairingHolder.handlers = handlers;
    return {
      rendezvous,
      send: vi.fn(),
      catchUp: vi.fn(async () => undefined),
      close: pairingHolder.close,
    };
  });
  landOn("");
});

describe("PairJoin", () => {
  it("joins the rendezvous the banner handed over and opens its channel", async () => {
    const rendezvous = { id: ID, role: "joiner", expires_at: "2026-10-22T18:00:00Z" };
    pairingHolder.joinPairing.mockResolvedValue(rendezvous);
    render(() => <PairJoin />);
    await waitFor(() => expect(pairingHolder.joinPairing).toHaveBeenCalledWith("tok", ID));
    expect(offerHolder.take).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(pairingHolder.openChannel).toHaveBeenCalled());
    expect(pairingHolder.openChannel.mock.calls[0]?.[1]).toEqual(rendezvous);
    expect(await screen.findByTestId("pair-joined")).toBeTruthy();
  });

  it("builds the joiner session from this browser's deps, with pairedHere, and hands it the channel and what arrives", async () => {
    pairingHolder.joinPairing.mockResolvedValue(RENDEZVOUS);
    render(() => <PairJoin />);
    await screen.findByTestId("pair-joined");
    expect(session.pairingDeps).toHaveBeenCalledWith("tok");
    const [deps, code] = session.joinerPairing.mock.calls[0] ?? [];
    expect(deps).toEqual({ ...DEPS, paired: session.paired });
    expect(code).toEqual({ id: ID, curve: CURVE });
    const channel = await pairingHolder.openChannel.mock.results[0]?.value;
    expect(session.current?.attach).toHaveBeenCalledWith(channel);
    pairingHolder.handlers?.onMessage("b3BhcXVl");
    expect(session.current?.onPayload).toHaveBeenCalledWith("b3BhcXVl");
    pairingHolder.handlers?.onClosed("expired");
    expect(session.current?.onClosed).toHaveBeenCalledWith("expired");
  });

  it("PairJoin shows the check code, then the offered networks and Pair this browser", async () => {
    pairingHolder.joinPairing.mockResolvedValue(RENDEZVOUS);
    render(() => <PairJoin />);
    await screen.findByTestId("pair-joined");
    expect(screen.queryByTestId("pair-check-code")).toBeNull();
    expect(screen.queryByTestId("pair-confirm")).toBeNull();

    setState({ ...joining(), stage: "code", checkCode: "07" });
    expect(screen.getByTestId("pair-check-code").textContent).toBe(
      "Type this code on the other device: 07",
    );
    expect(screen.queryByTestId("pair-joined")).toBeNull();
    expect(screen.queryByTestId("pair-confirm")).toBeNull();

    setState({
      ...joining(),
      stage: "confirm",
      checkCode: "07",
      offered: ["azzurra", "libera"],
      full: ["oftc"],
    });
    expect(screen.getByTestId("pair-offered-azzurra")).toBeTruthy();
    expect(screen.getByTestId("pair-offered-libera")).toBeTruthy();
    expect(screen.getByTestId("pair-full").textContent).toContain("oftc");
    expect(screen.queryByTestId("pair-check-code")).toBeNull();
    const confirm = screen.getByTestId("pair-confirm");
    expect(confirm.textContent).toBe("Pair this browser");
    confirm.click();
    expect(session.current?.confirm).toHaveBeenCalledTimes(1);

    setState({ ...joining(), stage: "joining-networks", offered: ["azzurra"] });
    expect(screen.getByText("Pairing…")).toBeTruthy();
    expect(screen.queryByTestId("pair-confirm")).toBeNull();
  });

  it("shows no full line when no network is full", async () => {
    pairingHolder.joinPairing.mockResolvedValue(RENDEZVOUS);
    render(() => <PairJoin />);
    await screen.findByTestId("pair-joined");
    setState({ ...joining(), stage: "confirm", checkCode: "07", offered: ["azzurra"] });
    expect(screen.queryByTestId("pair-full")).toBeNull();
  });

  it("shows paired, with the result per network, once done", async () => {
    pairingHolder.joinPairing.mockResolvedValue(RENDEZVOUS);
    render(() => <PairJoin />);
    await screen.findByTestId("pair-joined");
    setState({
      ...joining(),
      stage: "done",
      results: [
        { network: "azzurra", outcome: "added" },
        { network: "libera", outcome: "paired" },
      ],
    });
    expect(screen.getByTestId("pair-done").textContent).toContain("This browser is paired.");
    expect(screen.getByTestId("pair-result-azzurra").textContent).toContain("added");
    expect(screen.getByTestId("pair-result-libera").textContent).toContain("already paired");
    expect(screen.queryByTestId("pair-cancel")).toBeNull();
  });

  it("an all-failed done says this browser was not paired; one network added or already paired says it is", async () => {
    pairingHolder.joinPairing.mockResolvedValue(RENDEZVOUS);
    render(() => <PairJoin />);
    await screen.findByTestId("pair-joined");
    const done = (results: JoinerState["results"]) =>
      setState({ ...joining(), stage: "done", results });

    done([
      { network: "azzurra", outcome: "failed" },
      { network: "libera", outcome: "list-changed" },
    ]);
    expect(screen.getByTestId("pair-not-paired").textContent).toBe("This browser was not paired.");
    expect(screen.queryByTestId("pair-done")).toBeNull();
    expect(screen.getByTestId("pair-result-azzurra").textContent).toContain("failed");
    expect(screen.getByTestId("pair-result-libera").textContent).toContain(
      "the list changed, try again",
    );

    done([
      { network: "azzurra", outcome: "added" },
      { network: "libera", outcome: "failed" },
    ]);
    expect(screen.getByTestId("pair-done").textContent).toBe("This browser is paired.");
    expect(screen.queryByTestId("pair-not-paired")).toBeNull();

    done([{ network: "libera", outcome: "paired" }]);
    expect(screen.getByTestId("pair-done").textContent).toBe("This browser is paired.");
    expect(screen.queryByTestId("pair-not-paired")).toBeNull();
  });

  it("an offer of no network shows no Pair this browser: nothing to pair, and the networks already full", async () => {
    pairingHolder.joinPairing.mockResolvedValue(RENDEZVOUS);
    render(() => <PairJoin />);
    await screen.findByTestId("pair-joined");

    setState({ ...joining(), stage: "ended", ended: "nothing-to-pair", full: ["oftc"] });

    expect(screen.getByTestId("pair-ended").textContent).toBe(
      "Your other browser had no network to add this browser to.",
    );
    expect(screen.getByTestId("pair-full").textContent).toContain("oftc");
    expect(screen.queryByTestId("pair-confirm")).toBeNull();
    expect(screen.queryByTestId("pair-done")).toBeNull();
    // With no network full, no full line.
    setState({ ...joining(), stage: "ended", ended: "nothing-to-pair" });
    expect(screen.queryByTestId("pair-full")).toBeNull();
  });

  it("PairJoin says paired, not ended, when the holder closes after done", async () => {
    pairingHolder.joinPairing.mockResolvedValue(RENDEZVOUS);
    render(() => <PairJoin />);
    await screen.findByTestId("pair-joined");
    setState({ ...joining(), stage: "done", results: [{ network: "azzurra", outcome: "added" }] });
    pairingHolder.handlers?.onClosed("closed");
    expect(screen.getByTestId("pair-done")).toBeTruthy();
    expect(screen.queryByTestId("pair-ended")).toBeNull();
  });

  it("says a pairing that failed on this side failed, not that the other device ended it", async () => {
    pairingHolder.joinPairing.mockResolvedValue(RENDEZVOUS);
    render(() => <PairJoin />);
    await screen.findByTestId("pair-joined");
    setState({ ...joining(), stage: "ended", ended: "failed" });
    const ended = screen.getByTestId("pair-ended").textContent ?? "";
    expect(ended).toContain("failed");
    expect(ended).not.toContain("other device ended");
    // A failure may come after this browser started over or registered a
    // device: it claims nothing about what changed.
    expect(ended).not.toContain("Nothing was changed");
  });

  it("says so when this browser cannot be prepared for pairing, and joins nothing", async () => {
    session.pairingDeps.mockRejectedValue(new Error("no binding"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(() => <PairJoin />);
    expect((await screen.findByTestId("pair-failed")).textContent).toBe(
      "Could not prepare this browser for pairing.",
    );
    expect(pairingHolder.joinPairing).not.toHaveBeenCalled();
  });

  it("joins what the banner handed over, never a pairing code in the address bar", async () => {
    const other = "ZyXwVuTsRqPoNmLkJiHgFe";
    landOn(`#pair=${other}.${CURVE}`);
    pairingHolder.joinPairing.mockResolvedValue(RENDEZVOUS);
    render(() => <PairJoin />);
    await screen.findByTestId("pair-joined");
    expect(pairingHolder.joinPairing.mock.calls).toEqual([["tok", ID]]);
  });

  // A Back to `/pair`, a reload of it, an old link: the banner handed nothing
  // over, so nothing is joined, whatever the account has on offer.
  it("with nothing handed over by the banner, says where pairing starts and joins nothing", async () => {
    offerHolder.take.mockReturnValue(null);
    landOn(`#pair=${ID}.${CURVE}`);
    render(() => <PairJoin />);
    const none = await screen.findByTestId("pair-none");
    expect(none.textContent).toContain("add a device");
    expect(pairingHolder.joinPairing).not.toHaveBeenCalled();
    expect(session.joinerPairing).not.toHaveBeenCalled();
  });

  it("on a browser with no login, says where pairing starts, joins nothing, and uses up the hand-over", async () => {
    authHolder.token.mockReturnValue(null);
    render(() => <PairJoin />);
    expect((await screen.findByTestId("pair-none")).textContent).toContain("add a device");
    expect(offerHolder.take).toHaveBeenCalledTimes(1);
    expect(pairingHolder.joinPairing).not.toHaveBeenCalled();
  });

  it("joins nothing when it leaves the route while this browser is still being prepared", async () => {
    let resolve: (d: unknown) => void = () => undefined;
    session.pairingDeps.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = render(() => <PairJoin />);
    await waitFor(() => expect(session.pairingDeps).toHaveBeenCalled());
    unmount();
    resolve(DEPS);
    await new Promise((r) => setTimeout(r, 0));
    expect(pairingHolder.joinPairing).not.toHaveBeenCalled();
  });

  // `/pair` is outside the Shell, and an installed app has no address bar:
  // every page that ends here leads back, where the banner can ask again.
  it("leads back to grappa from every page that ends the pairing", async () => {
    const back = () => screen.queryByRole("link", { name: "Back to grappa" });

    offerHolder.take.mockReturnValue(null);
    const none = render(() => <PairJoin />);
    await screen.findByTestId("pair-none");
    expect(back()).toBeTruthy();
    none.unmount();

    offerHolder.take.mockReturnValue({ id: ID, curve: CURVE });
    pairingHolder.joinPairing.mockRejectedValueOnce(new ApiError(409, "pairing_already_joined"));
    const failed = render(() => <PairJoin />);
    await screen.findByRole("alert");
    expect(back()).toBeTruthy();
    failed.unmount();

    pairingHolder.joinPairing.mockResolvedValue(RENDEZVOUS);
    render(() => <PairJoin />);
    await screen.findByTestId("pair-joined");
    expect(back()).toBeNull();
    setState({ ...joining(), stage: "ended", ended: "replaced" });
    expect(screen.getByTestId("pair-ended").textContent).toContain("Go back to grappa");
    expect(back()).toBeTruthy();
    setState({ ...joining(), stage: "done", results: [{ network: "azzurra", outcome: "added" }] });
    expect(back()).toBeTruthy();
  });

  it("tells a second browser the pairing is taken", async () => {
    pairingHolder.joinPairing.mockRejectedValue(new ApiError(409, "pairing_already_joined"));
    render(() => <PairJoin />);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("already accepted this pairing");
  });

  it("says the other device ended it when the rendezvous closes", async () => {
    pairingHolder.joinPairing.mockResolvedValue({
      id: ID,
      role: "joiner",
      expires_at: "2026-10-22T18:00:00Z",
    });
    render(() => <PairJoin />);
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
    render(() => <PairJoin />);
    (await screen.findByTestId("pair-cancel")).click();
    await waitFor(() => expect(routerHolder.navigate).toHaveBeenCalledWith("/", { replace: true }));
    expect(pairingHolder.close).toHaveBeenCalled();
    expect(session.current?.cancel).toHaveBeenCalled();
  });

  it("closes the rendezvous when it leaves the route", async () => {
    pairingHolder.joinPairing.mockResolvedValue({
      id: ID,
      role: "joiner",
      expires_at: "2026-10-22T18:00:00Z",
    });
    const { unmount } = render(() => <PairJoin />);
    await screen.findByTestId("pair-joined");
    unmount();
    await waitFor(() => expect(pairingHolder.close).toHaveBeenCalled());
  });

  it("closes a rendezvous whose join was still in flight when it left the route", async () => {
    let resolve: (r: unknown) => void = () => undefined;
    pairingHolder.joinPairing.mockReturnValue(new Promise((r) => (resolve = r)));
    const { unmount } = render(() => <PairJoin />);
    await waitFor(() => expect(pairingHolder.joinPairing).toHaveBeenCalled());
    unmount();
    resolve({ id: ID, role: "joiner", expires_at: "2026-10-22T18:00:00Z" });
    await waitFor(() => expect(pairingHolder.close).toHaveBeenCalled());
  });
});
