import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HolderState } from "../lib/e2e/pairingSession";

// issue 2430, X1-crypto — the master's side of a pairing, as the user sees
// it. The session (lib/e2e/pairingSession) is the boundary: faked at its
// interface, so these tests pin what each stage shows and which verb each
// control reaches. AddDeviceQr is a stub that hands the test its props,
// except where a test asks for the real one (over a faked relay).

const CURVE = "fJKDF4omlQo87Jaqp5pqfZqg9TcQO1PG5lS1Kzz5FIA";

const authHolder = vi.hoisted(() => ({ token: vi.fn<() => string | null>(() => "tok") }));
vi.mock("../lib/auth", () => ({ token: authHolder.token }));

const holder = vi.hoisted(() => ({
  session: null as null | Record<string, ReturnType<typeof vi.fn>>,
  deps: { marker: "deps" },
  qr: null as null | {
    curve: string;
    onChannel: (c: unknown) => void;
    onMessage: (p: string) => void;
    onClosed: (r: string) => void;
  },
  pairingDeps: vi.fn(),
  holderPairing: vi.fn(),
  realQr: false,
}));
vi.mock("../lib/e2e/pairingDeps", () => ({ pairingDeps: holder.pairingDeps }));
vi.mock("../lib/e2e/pairingSession", () => ({ holderPairing: holder.holderPairing }));
vi.mock("../AddDeviceQr", async (orig) => {
  const real = (await orig<typeof import("../AddDeviceQr")>()).default;
  return {
    default: (props: NonNullable<typeof holder.qr>) => {
      holder.qr = props;
      if (holder.realQr) return real(props);
      const el = document.createElement("div");
      el.dataset.testid = "qr-stub";
      el.dataset.curve = props.curve;
      return el;
    },
  };
});

// The relay the real AddDeviceQr opens: its close handler, for a test to end it.
const relay = vi.hoisted(() => ({
  onClosed: null as null | ((reason: string) => void),
}));
vi.mock("../lib/e2e/pairing", async (orig) => ({
  ...(await orig<typeof import("../lib/e2e/pairing")>()),
  openPairing: vi.fn(async () => ({
    id: "AbCdEfGhIjKlMnOpQrStUv",
    role: "creator",
    expires_at: new Date(Date.now() + 300_000).toISOString(),
  })),
  openChannel: vi.fn((_t, rendezvous, handlers: { onClosed: (reason: string) => void }) => {
    relay.onClosed = handlers.onClosed;
    return { rendezvous, send: vi.fn(), catchUp: vi.fn(), close: vi.fn(async () => undefined) };
  }),
}));

const { default: AddDevicePanel } = await import("../AddDevicePanel");

const waiting = (): HolderState => ({
  stage: "waiting",
  offered: [],
  full: [],
  notMaster: [],
  results: [],
  ended: null,
});

let setState: (s: HolderState) => void;

beforeEach(() => {
  vi.clearAllMocks();
  holder.qr = null;
  holder.realQr = false;
  relay.onClosed = null;
  authHolder.token.mockReturnValue("tok");
  const [state, set] = createSignal<HolderState>(waiting());
  setState = set;
  const session = {
    state,
    curve: CURVE,
    attach: vi.fn(),
    onPayload: vi.fn(),
    // The real session ends on a close that comes before it is done.
    onClosed: vi.fn((reason: string) => {
      if (state().stage !== "done") set({ ...state(), stage: "ended", ended: reason as never });
    }),
    submitCode: vi.fn(),
    cancel: vi.fn(),
  };
  holder.session = session as never;
  holder.pairingDeps.mockResolvedValue(holder.deps);
  holder.holderPairing.mockReturnValue(session);
});

const mount = async () => {
  const onClose = vi.fn();
  const view = render(() => <AddDevicePanel onClose={onClose} />);
  await screen.findByTestId("qr-stub");
  return { ...view, onClose };
};

describe("AddDevicePanel", () => {
  it("shows the QR of the session's key, then the code input, then the results per network", async () => {
    await mount();
    expect(holder.pairingDeps).toHaveBeenCalledWith("tok");
    expect(holder.holderPairing).toHaveBeenCalledWith(holder.deps);
    expect(screen.getByTestId("qr-stub").dataset.curve).toBe(CURVE);
    expect(screen.getByTestId("qr-slot").hidden).toBe(false);
    expect(screen.queryByTestId("pair-code-input")).toBeNull();

    setState({ ...waiting(), stage: "code" });
    const slot = screen.getByTestId("qr-slot");
    // The QR component stays mounted (leaving would close the channel) but is out of sight.
    expect(slot.hidden).toBe(true);
    expect(screen.getByText("Type the code shown on the new device")).toBeTruthy();
    const input = screen.getByTestId("pair-code-input") as HTMLInputElement;
    expect(input.getAttribute("inputmode")).toBe("numeric");
    expect(input.maxLength).toBe(2);

    setState({ ...waiting(), stage: "offered", offered: ["azzurra"] });
    expect(screen.getByText("Waiting for the new browser to confirm…")).toBeTruthy();
    expect(screen.queryByText("Adding the new device…")).toBeNull();
    expect(screen.queryByTestId("pair-code-input")).toBeNull();

    setState({ ...waiting(), stage: "signing", offered: ["azzurra"] });
    expect(screen.getByText("Adding the new device…")).toBeTruthy();
    expect(screen.queryByText("Waiting for the new browser to confirm…")).toBeNull();

    setState({
      ...waiting(),
      stage: "done",
      offered: ["azzurra", "libera", "oftc", "efnet", "ircnet"],
      full: ["oftc"],
      notMaster: ["efnet"],
      results: [
        { network: "azzurra", outcome: "added" },
        { network: "libera", outcome: "paired" },
        { network: "ircnet", outcome: "list-changed" },
        { network: "rizon", outcome: "failed" },
        { network: "snoonet", outcome: "full" },
      ],
    });
    expect(screen.getByTestId("pair-result-azzurra").textContent).toContain("added");
    expect(screen.getByTestId("pair-result-libera").textContent).toContain("already paired");
    expect(screen.getByTestId("pair-result-ircnet").textContent).toContain(
      "the list changed, try again",
    );
    expect(screen.getByTestId("pair-result-rizon").textContent).toContain("failed");
    expect(screen.getByTestId("pair-result-snoonet").textContent).toContain(
      "already has 4 devices",
    );
    expect(screen.getByTestId("pair-full").textContent).toContain("oftc");
    expect(screen.getByTestId("pair-not-master").textContent).toContain("efnet");
    expect(screen.queryByTestId("pair-unconfirmed")).toBeNull();
  });

  it("wires the QR component to the session: channel, payloads and closing", async () => {
    await mount();
    const channel = { send: vi.fn() };
    holder.qr?.onChannel(channel);
    holder.qr?.onMessage("b3BhcXVl");
    holder.qr?.onClosed("expired");
    expect(holder.session?.attach).toHaveBeenCalledWith(channel);
    expect(holder.session?.onPayload).toHaveBeenCalledWith("b3BhcXVl");
    expect(holder.session?.onClosed).toHaveBeenCalledWith("expired");
  });

  it("submits exactly the two digits typed, and only once there are two", async () => {
    await mount();
    setState({ ...waiting(), stage: "code" });
    const input = screen.getByTestId("pair-code-input") as HTMLInputElement;
    const submit = screen.getByTestId("pair-code-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.input(input, { target: { value: "4" } });
    expect(submit.disabled).toBe(true);
    fireEvent.input(input, { target: { value: "4x" } });
    expect(submit.disabled).toBe(true);
    fireEvent.input(input, { target: { value: " 42 " } });
    expect(submit.disabled).toBe(false);
    expect(holder.session?.submitCode).not.toHaveBeenCalled();
    fireEvent.click(submit);
    expect(holder.session?.submitCode).toHaveBeenCalledExactlyOnceWith("42");
  });

  it("a wrong code shows the codes-did-not-match copy", async () => {
    await mount();
    setState({ ...waiting(), stage: "ended", ended: "code-mismatch" });
    expect(screen.getByTestId("code-mismatch").textContent).toBe(
      "The codes did not match. Nothing was added.",
    );
    expect(screen.queryByTestId("pair-code-input")).toBeNull();
  });

  it("says why a pairing ended otherwise, and keeps what was added before it", async () => {
    await mount();
    setState({
      ...waiting(),
      stage: "ended",
      ended: "expired",
      results: [{ network: "azzurra", outcome: "failed" }],
    });
    expect(screen.getByTestId("pair-ended").textContent).toContain("expired");
    expect(screen.queryByTestId("code-mismatch")).toBeNull();
    expect(screen.getByTestId("pair-result-azzurra")).toBeTruthy();
  });

  it("shows added plus the unconfirmed line when the new browser never confirmed", async () => {
    await mount();
    setState({
      ...waiting(),
      stage: "done",
      ended: "closed",
      results: [{ network: "azzurra", outcome: "added" }],
    });
    expect(screen.getByTestId("pair-result-azzurra").textContent).toContain("added");
    expect(screen.getByTestId("pair-unconfirmed").textContent).toBe(
      "The new browser did not confirm. If it shows an error, pair it again.",
    );
    expect(screen.queryByTestId("pair-ended")).toBeNull();
  });

  it("a holder with nothing to offer says so, with each network's reason", async () => {
    await mount();
    setState({
      ...waiting(),
      stage: "ended",
      ended: "nothing-to-offer",
      full: ["oftc"],
      notMaster: ["efnet"],
      results: [{ network: "rizon", outcome: "failed" }],
    });
    expect(screen.getByTestId("pair-ended").textContent).toBe(
      "There is no network this browser can add the new device to.",
    );
    expect(screen.getByTestId("pair-full").textContent).toContain("oftc");
    expect(screen.getByTestId("pair-not-master").textContent).toContain("efnet");
    expect(screen.getByTestId("pair-result-rizon").textContent).toContain("failed");
  });

  // The pane hosts the panel and drops it on onClose (EncryptedChatPane).
  it("closing the panel tells the pane, and the pane dropping it cancels the pairing", async () => {
    const [open, setOpen] = createSignal(true);
    const onClose = vi.fn(() => setOpen(false));
    render(() => (
      <Show when={open()}>
        <AddDevicePanel onClose={onClose} />
      </Show>
    ));
    await screen.findByTestId("qr-stub");
    expect(holder.session?.cancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("add-device-close"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(holder.session?.cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("add-device-panel")).toBeNull();
  });

  // The QR component stays mounted, out of sight, while the pairing lives:
  // the copy that says why it ended is the panel's alone.
  it("a relay that ends the pairing leaves one ended copy on the page", async () => {
    holder.realQr = true;
    render(() => <AddDevicePanel onClose={vi.fn()} />);
    await screen.findByTestId("pair-qr");

    relay.onClosed?.("expired");

    await waitFor(() => expect(screen.getAllByTestId("pair-ended")).toHaveLength(1));
    expect(screen.getByTestId("pair-ended").textContent).toContain("expired");
    expect(screen.queryByTestId("pair-qr")).toBeNull();
  });

  it("cancels the pairing when it leaves the screen", async () => {
    const { unmount } = await mount();
    unmount();
    expect(holder.session?.cancel).toHaveBeenCalledTimes(1);
  });

  it("says so when there is no login, and starts nothing", async () => {
    authHolder.token.mockReturnValue(null);
    render(() => <AddDevicePanel onClose={vi.fn()} />);
    expect((await screen.findByTestId("pair-failed")).textContent).toContain("Log in");
    expect(holder.holderPairing).not.toHaveBeenCalled();
  });

  it("says so when the browser cannot be prepared for pairing", async () => {
    holder.pairingDeps.mockRejectedValue(new Error("no binding"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    render(() => <AddDevicePanel onClose={vi.fn()} />);
    expect(await screen.findByTestId("pair-failed")).toBeTruthy();
    expect(holder.holderPairing).not.toHaveBeenCalled();
  });
});
