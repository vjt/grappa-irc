import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomePane from "../HomePane";
import { channelKey } from "../lib/channelKey";
import { SHARE_SESSION_LABEL } from "../lib/shareModal";
import { LIST_WINDOW_NAME } from "../lib/windowKinds";

// UX-4 bucket B (2026-05-18). HomePane renders one of two sub-panes
// based on `homeData()`:
//
//   * homeData() === null     → HomePaneVisitor (cic-only help, NO input)
//   * homeData() !== null     → HomePaneRegistered (networks list)
//
// Click semantics:
//   * :parked / :failed row → patchNetwork(slug, {connection_state: "connected"})
//   * :connected row → setSelectedChannel($server window for that slug)
//
// UX-5 bucket BR (2026-05-19): :parked / :failed rows ALSO render an
// explicit `[Reconnect]` chip + inline error text on failure
// (friendlyApiError). The whole-row click semantics for :connected
// (jump-to-$server) are preserved.
//
// Mocks: home.ts (homeData signal), api.ts (patchNetwork REST), auth.ts
// (token), selection.ts (setSelectedChannel).

type HomeNetworkRowLocal = {
  slug: string;
  nick: string;
  connection_state: "connected" | "parked" | "failed";
  connection_state_reason: string | null;
  connection_state_changed_at: string | null;
  // #581 (D2) — REQUIRED on the production wire (pinned by wireTypesAssert.ts);
  // optional here so the many recover-agnostic mock rows omit it (absent →
  // falsy → "not recoverable", a valid state). The #581 tests set it.
  recoverable?: boolean;
};
type HomeDataLocal = {
  networks: HomeNetworkRowLocal[];
  available_networks: { slug: string }[];
};

const homeDataMock = vi.fn<() => HomeDataLocal | null>(() => null);
const patchNetworkMock = vi.fn<(t: string, slug: string, body: unknown) => Promise<void>>(() =>
  Promise.resolve(),
);
// #211 phase 6 — the available-networks section one-taps accretion.
const addNetworkMock = vi.fn<(t: string, slug: string) => Promise<void>>(() => Promise.resolve());
const refetchUserMock = vi.fn<() => void>();
const refetchNetworksMock = vi.fn<() => void>();
const setSelectedChannelMock = vi.fn<(sel: unknown) => void>();
const tokenMock = vi.fn<() => string | null>(() => "test-token");
// #85 — featured channels: per-network fetch on home display + join/open.
const getFeaturedMock = vi.fn<
  (t: string, slug: string) => Promise<{ name: string; description: string | null }[]>
>(() => Promise.resolve([]));
const postJoinMock = vi.fn<
  (t: string, slug: string, name: string, key: string | null) => Promise<void>
>(() => Promise.resolve());
const windowStateMock = vi.fn<() => Record<string, string>>(() => ({}));
const userMock = vi.fn<() => unknown>(() => null);
// #211 phase 6 — visitorSlug() now derives from the list-shaped
// networks() store (the singular me.network_slug is gone). Mock it.
const networksMock = vi.fn<() => unknown[]>(() => []);
// #283 — ConnectedRow's Disconnect button routes through the #195 confirm
// modal (windowClose.confirmDisconnectNetwork — "Disconnect from <slug>?"),
// the SAME verb the sidebar/bottom-bar × fires. Mock it so the unit test
// asserts the row REUSES that path (not raw disconnectNetwork / patchNetwork).
const confirmDisconnectNetworkMock = vi.fn<(slug: string) => void>();
const confirmRemoveNetworkMock = vi.fn<(slug: string, onError: (m: string) => void) => void>();
// #349 — the "Register nick" launcher's three lib boundaries: the flavor
// resolver, the identity source, and the wizard open verb. Defaults
// hide the button (no flavor), so the pre-#349 row assertions are
// unaffected. `networkIdBySlugMock` drives the identity lookup path.
//
// #388 — the identity source is the server's NORMALIZED verdict, not a
// umode letter list. The launcher no longer knows what `+r` is.
const flavorForSlugMock = vi.fn<(slug: string) => string | null>(() => null);
const identifiedForNetworkMock = vi.fn<(id: number) => boolean>(() => false);
const openRegistrationWizardMock = vi.fn<(slug: string) => void>();
const networkIdBySlugMock = vi.fn<(slug: string) => number | undefined>(() => undefined);
// #392 — the home "open on another device" button flips the shared share-
// modal open signal. Mock the open verb so the click is observable without
// mounting the modal (its behaviour is in ShareSessionModal.test.tsx).
const openShareModalMock = vi.fn<() => void>();
// #238 — ConnectedRow's 🗺 Map button pushes LINKS. Mock the socket boundary
// so the REAL socket.ts (a top-level createRoot effect that reads token() at
// import time) stays out of this test's module graph — importing it eagerly
// trips the token mock's init order (the same trap flavorForSlug is mocked to
// avoid; see the registrationTemplates mock note below).
const pushLinksMock = vi.fn<(id: number, mask: string | null) => Promise<void>>(() =>
  Promise.resolve(),
);
// #581 — ConnectedRow's 🔑 Recover identity button pushes the recover verb.
// Same socket-boundary mock rationale as pushLinks.
const pushRecoverMock = vi.fn<(id: number) => Promise<void>>(() => Promise.resolve());

vi.mock("../lib/home", () => ({
  homeData: () => homeDataMock(),
  patchHomeNetwork: vi.fn(),
}));

vi.mock("../lib/api", async () => {
  // #2409 — the REAL class, not a lookalike: HomePane narrows with
  // `err instanceof ApiError` against the class it imports from
  // `lib/apiError.ts`, and a stub defined here would never match it.
  const { ApiError } = await import("../lib/apiError");
  return {
    patchNetwork: (t: string, slug: string, body: unknown) => patchNetworkMock(t, slug, body),
    addNetwork: (t: string, slug: string) => addNetworkMock(t, slug),
    getFeaturedChannels: (t: string, slug: string) => getFeaturedMock(t, slug),
    postJoin: (t: string, slug: string, name: string, key: string | null) =>
      postJoinMock(t, slug, name, key),
    ApiError,
  };
});

vi.mock("../lib/networks", () => ({
  user: () => userMock(),
  networks: () => networksMock(),
  refetchUser: () => refetchUserMock(),
  refetchNetworks: () => refetchNetworksMock(),
  // #349 — the registration button resolves the network id here to look
  // up the identity verdict. Controllable so a test can exercise the
  // identified branch.
  networkIdBySlug: (slug: string) => networkIdBySlugMock(slug),
}));
// channelKey is a pure fn — use the real one (mock at boundaries, not
// pure helpers) so the joined-state key shape matches production exactly.
vi.mock("../lib/windowState", () => ({ windowStateByChannel: () => windowStateMock() }));

vi.mock("../lib/auth", () => ({
  token: () => tokenMock(),
}));

// #349 — mock the registration lib boundaries. `registerableFlavor`
// mirrors the real production predicate (Azzurra ONLY — see
// registrationTemplates.ts "Why Azzurra ONLY"); `flavorForSlug` is the
// controllable source (mocked so its real `networkBySlug` transitive
// import stays out of this test's module graph — it'd trip the token
// mock's init order); `openRegistrationWizard` is the open verb.
vi.mock("../lib/registrationTemplates", () => ({
  registerableFlavor: (f: string | null) => f === "azzurra",
  flavorForSlug: (slug: string) => flavorForSlugMock(slug),
}));

vi.mock("../lib/registrationWizard", () => ({
  openRegistrationWizard: (slug: string) => openRegistrationWizardMock(slug),
}));

// #462 — spread the REAL module so the label under test is the declared one,
// not a copy of it typed into this factory.
vi.mock("../lib/shareModal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/shareModal")>()),
  openShareModal: () => openShareModalMock(),
}));

vi.mock("../lib/socket", () => ({
  pushLinks: (id: number, mask: string | null) => pushLinksMock(id, mask),
  pushRecover: (id: number) => pushRecoverMock(id),
}));

vi.mock("../lib/identity", () => ({
  identifiedForNetwork: (id: number) => identifiedForNetworkMock(id),
}));

vi.mock("../lib/selection", () => ({
  setSelectedChannel: (sel: unknown) => setSelectedChannelMock(sel),
  applySeedEnvelope: vi.fn(),
}));

// #283 — mock the confirm-modal disconnect verb. HomePane imports only
// `confirmDisconnectNetwork` from windowClose (the ConnectedRow Disconnect
// button); the underlying park verb (disconnectNetwork) is unit-tested in
// windowClose.test.ts, and the confirm-modal wiring itself is covered by
// the #283 e2e (issue283-home-disconnect.spec.ts).
vi.mock("../lib/windowClose", () => ({
  confirmDisconnectNetwork: (slug: string) => confirmDisconnectNetworkMock(slug),
  // issue 2219 — the Remove confirm takes the row's error sink as its
  // second argument, so the stub forwards both and the tests can drive the
  // failure path by calling the captured callback.
  confirmRemoveNetwork: (slug: string, onError: (m: string) => void) =>
    confirmRemoveNetworkMock(slug, onError),
}));

vi.mock("../lib/friendlyApiError", () => ({
  // UX-5 BR: identity-stub so failure-path tests can assert the chip
  // surfaces the ApiError's message verbatim. The real mapping is unit-
  // tested in friendlyApiError.test.ts (19+ cases); HomePane only
  // needs to prove it ROUTES through the helper, not re-test it.
  friendlyApiError: (err: { message: string }) => `friendly: ${err.message}`,
}));

describe("HomePane", () => {
  beforeEach(() => {
    homeDataMock.mockReturnValue(null);
    patchNetworkMock.mockClear();
    setSelectedChannelMock.mockClear();
    tokenMock.mockReturnValue("test-token");
    getFeaturedMock.mockReset();
    getFeaturedMock.mockResolvedValue([]);
    postJoinMock.mockReset();
    postJoinMock.mockResolvedValue(undefined);
    windowStateMock.mockReturnValue({});
    userMock.mockReturnValue(null);
    networksMock.mockReturnValue([]);
    confirmDisconnectNetworkMock.mockClear();
    flavorForSlugMock.mockReturnValue(null);
    identifiedForNetworkMock.mockReturnValue(false);
    openRegistrationWizardMock.mockClear();
    networkIdBySlugMock.mockReturnValue(undefined);
    openShareModalMock.mockClear();
    pushLinksMock.mockClear();
    pushRecoverMock.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const connectedNetworks = (slug: string): HomeDataLocal => ({
    networks: [
      {
        slug,
        nick: "vjt",
        connection_state: "connected",
        connection_state_reason: null,
        connection_state_changed_at: null,
      },
    ],
    available_networks: [],
  });

  describe("#85 featured channels", () => {
    it("fetches + renders featured channels per network; click joins and focuses", async () => {
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      getFeaturedMock.mockResolvedValue([{ name: "#sniffo", description: "il canale" }]);
      render(() => <HomePane />);

      const link = await screen.findByText("#sniffo");
      expect(screen.getByText("il canale")).toBeInTheDocument();
      expect(getFeaturedMock).toHaveBeenCalledWith("test-token", "azzurra");

      fireEvent.click(link);
      await waitFor(() =>
        expect(postJoinMock).toHaveBeenCalledWith("test-token", "azzurra", "#sniffo", null),
      );
      expect(setSelectedChannelMock).toHaveBeenCalledWith(
        expect.objectContaining({
          networkSlug: "azzurra",
          channelName: "#sniffo",
          kind: "channel",
        }),
      );
    });

    it("already-joined featured channel focuses without re-joining", async () => {
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      getFeaturedMock.mockResolvedValue([{ name: "#sniffo", description: null }]);
      windowStateMock.mockReturnValue({ [channelKey("azzurra", "#sniffo")]: "joined" });
      render(() => <HomePane />);

      const link = await screen.findByText("#sniffo");
      fireEvent.click(link);
      await waitFor(() =>
        expect(setSelectedChannelMock).toHaveBeenCalledWith(
          expect.objectContaining({ channelName: "#sniffo", kind: "channel" }),
        ),
      );
      expect(postJoinMock).not.toHaveBeenCalled();
    });

    it("visitor home renders featured for a connected network (via ConnectedRow)", async () => {
      // #211 phase 6 — the visitor home is the SAME data-driven component
      // as the user's: a connected network row renders FeaturedLinks.
      userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest" });
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      getFeaturedMock.mockResolvedValue([{ name: "#welcome", description: null }]);
      render(() => <HomePane />);

      await screen.findByText("#welcome");
      expect(getFeaturedMock).toHaveBeenCalledWith("test-token", "azzurra");
    });
  });

  describe("#349 register-nick launcher", () => {
    it("shows the button on a connected row for a registerable flavor while unidentified, and opens the wizard", async () => {
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      flavorForSlugMock.mockReturnValue("azzurra");
      networkIdBySlugMock.mockReturnValue(7);
      identifiedForNetworkMock.mockReturnValue(false); // not registered yet
      render(() => <HomePane />);

      const btn = await screen.findByTestId("home-register-nick-azzurra");
      expect(btn).toBeInTheDocument();
      // #529 — Register nick is now paired with Browse channels in the CTA
      // button row (same style, one pair), NOT a chip in the heading status
      // area where Disconnect lives.
      expect(btn.closest(".home-pane-network-cta")).not.toBeNull();
      expect(btn.closest(".home-pane-network-status")).toBeNull();
      fireEvent.click(btn);
      expect(openRegistrationWizardMock).toHaveBeenCalledWith("azzurra");
    });

    it("hides the button once the server reports identified (registration complete)", () => {
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      flavorForSlugMock.mockReturnValue("azzurra");
      networkIdBySlugMock.mockReturnValue(7);
      identifiedForNetworkMock.mockReturnValue(true); // registered → hidden
      render(() => <HomePane />);

      expect(screen.queryByTestId("home-register-nick-azzurra")).toBeNull();
    });

    it("hides the button for an unknown / unset services flavor", () => {
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      flavorForSlugMock.mockReturnValue(null);
      render(() => <HomePane />);

      expect(screen.queryByTestId("home-register-nick-azzurra")).toBeNull();
    });
  });

  describe("#581 recover-identity launcher", () => {
    // A connected row carrying (or not) a recoverable credential (D2 wire flag).
    const recoverableHome = (slug: string, recoverable: boolean): HomeDataLocal => ({
      networks: [
        {
          slug,
          nick: "guest",
          connection_state: "connected",
          connection_state_reason: null,
          connection_state_changed_at: null,
          recoverable,
        },
      ],
      available_networks: [],
    });

    it("shows the button for a visitor with a recoverable credential while unidentified, and pushes recover", async () => {
      userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest" });
      homeDataMock.mockReturnValue(recoverableHome("azzurra", true));
      networkIdBySlugMock.mockReturnValue(7);
      identifiedForNetworkMock.mockReturnValue(false); // not identified yet
      render(() => <HomePane />);

      const btn = await screen.findByTestId("home-recover-identity-azzurra");
      expect(btn).toBeInTheDocument();
      // Paired with Browse in the CTA row, not the heading status area.
      expect(btn.closest(".home-pane-network-cta")).not.toBeNull();
      expect(btn.closest(".home-pane-network-status")).toBeNull();

      fireEvent.click(btn);
      expect(pushRecoverMock).toHaveBeenCalledWith(7);
    });

    it("hides the button once the server reports identified", () => {
      userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest" });
      homeDataMock.mockReturnValue(recoverableHome("azzurra", true));
      networkIdBySlugMock.mockReturnValue(7);
      identifiedForNetworkMock.mockReturnValue(true); // identified → hidden
      render(() => <HomePane />);

      expect(screen.queryByTestId("home-recover-identity-azzurra")).toBeNull();
    });

    it("hides the button when the credential is not recoverable (no NickServ secret)", () => {
      userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest" });
      homeDataMock.mockReturnValue(recoverableHome("azzurra", false));
      networkIdBySlugMock.mockReturnValue(7);
      identifiedForNetworkMock.mockReturnValue(false);
      render(() => <HomePane />);

      expect(screen.queryByTestId("home-recover-identity-azzurra")).toBeNull();
    });

    it("hides the button for a non-visitor (user) session — recover is visitor-only", () => {
      userMock.mockReturnValue({ kind: "user", id: "u1", name: "vjt" });
      homeDataMock.mockReturnValue(recoverableHome("azzurra", true));
      networkIdBySlugMock.mockReturnValue(7);
      identifiedForNetworkMock.mockReturnValue(false);
      render(() => <HomePane />);

      expect(screen.queryByTestId("home-recover-identity-azzurra")).toBeNull();
    });
  });

  describe("visitor branch (#211 phase 6 — unified home)", () => {
    const visitorHome = (available: { slug: string }[]): HomeDataLocal => ({
      networks: [
        {
          slug: "azzurra",
          nick: "guest",
          connection_state: "connected",
          connection_state_reason: null,
          connection_state_changed_at: null,
        },
      ],
      available_networks: available,
    });

    it("renders the always-on welcome + the guest (48h) session line for a visitor (#135/#496)", () => {
      userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest" });
      homeDataMock.mockReturnValue(visitorHome([]));
      render(() => <HomePane />);

      // #496 — the always-on value prop (stable phrase the #135 e2e also pins).
      expect(screen.getByText(/Welcome to Grappa/i)).toBeInTheDocument();
      expect(screen.getByText(/keeps you connected to IRC/i)).toBeInTheDocument();
      // An UNREGISTERED visitor sees the honest 48h-inactivity line.
      const guest = screen.getByTestId("home-session-visitor-guest");
      expect(guest).toHaveTextContent(/48 hours/i);
    });

    it("renders the registered session line (7-day device login) naming nick+network for a registered visitor (#496)", () => {
      userMock.mockReturnValue({ kind: "visitor", id: "v1", registered: true });
      homeDataMock.mockReturnValue(visitorHome([]));
      render(() => <HomePane />);

      const reg = screen.getByTestId("home-session-visitor-registered");
      // Honest both-truths line: identity ∞ but the DEVICE login slides 7 days.
      expect(reg).toHaveTextContent(/7 days/i);
      // Exactly one network (azzurra/guest) → named honestly.
      expect(reg).toHaveTextContent(/azzurra/);
    });

    it("renders the always-on welcome + the USER (7-day) session line for a USER subject (#496)", () => {
      // #496 — the welcome is shown to EVERYONE now (was visitor-only). A user
      // gets the always-on prop + the honest 7-day DEVICE-login line, never the
      // guest 48h line.
      userMock.mockReturnValue({ kind: "user", id: "u1", name: "vjt" });
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      render(() => <HomePane />);

      expect(screen.getByText(/Welcome to Grappa/i)).toBeInTheDocument();
      const userSession = screen.getByTestId("home-session-user");
      expect(userSession).toHaveTextContent(/7 days/i);
      expect(screen.queryByTestId("home-session-visitor-guest")).toBeNull();
    });

    it("shows available-to-connect networks; click one-taps accretion (POST /session/networks)", async () => {
      userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest" });
      homeDataMock.mockReturnValue(visitorHome([{ slug: "libera" }]));
      render(() => <HomePane />);

      const connectBtn = screen.getByTestId("home-available-connect-libera");
      fireEvent.click(connectBtn);

      await waitFor(() => expect(addNetworkMock).toHaveBeenCalledWith("test-token", "libera"));
      // Accretion is NOT a park/connect PATCH.
      expect(patchNetworkMock).not.toHaveBeenCalled();
    });

    it("hides the available section when there are no available networks", () => {
      userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest" });
      homeDataMock.mockReturnValue(visitorHome([]));
      render(() => <HomePane />);

      expect(screen.queryByTestId("home-available")).toBeNull();
    });

    it("does NOT render any compose / input affordance (KISS, no-input outright)", () => {
      userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest" });
      homeDataMock.mockReturnValue(visitorHome([]));
      const { container } = render(() => <HomePane />);

      // No textarea, no input field, no compose-box. Home is read-only.
      expect(container.querySelector("textarea")).toBeNull();
      expect(container.querySelector("input")).toBeNull();
      expect(container.querySelector(".compose-box")).toBeNull();
    });
  });

  // #481 — the "available to connect" self-serve tier opens to BOTH
  // subjects (the visitor-only premise was a #461 relic). The section is
  // already subject-agnostic in the render; these pin that a USER sees +
  // one-taps it, and that the empty-networks copy stops telling a user to
  // "ask the operator" when they can self-connect an available network.
  describe("#481 — self-serve tier open to both subjects", () => {
    const userHome = (available: { slug: string }[]): HomeDataLocal => ({
      networks: [],
      available_networks: available,
    });

    it("USER subject sees + one-taps the available section (POST /session/networks)", async () => {
      userMock.mockReturnValue({ kind: "user", id: "u1", name: "vjt" });
      homeDataMock.mockReturnValue(userHome([{ slug: "libera" }]));
      render(() => <HomePane />);

      const connectBtn = screen.getByTestId("home-available-connect-libera");
      fireEvent.click(connectBtn);

      await waitFor(() => expect(addNetworkMock).toHaveBeenCalledWith("test-token", "libera"));
      expect(patchNetworkMock).not.toHaveBeenCalled();
    });

    it("USER with zero networks + available ones is guided to the picker, NOT 'ask the operator'", () => {
      userMock.mockReturnValue({ kind: "user", id: "u1", name: "vjt" });
      homeDataMock.mockReturnValue(userHome([{ slug: "libera" }]));
      render(() => <HomePane />);

      expect(screen.getByText(/pick a network below/i)).toBeInTheDocument();
      expect(screen.queryByText(/No networks bound/i)).toBeNull();
    });

    it("USER with zero networks AND no available ones still sees 'ask the operator'", () => {
      userMock.mockReturnValue({ kind: "user", id: "u1", name: "vjt" });
      homeDataMock.mockReturnValue(userHome([]));
      render(() => <HomePane />);

      expect(screen.getByText(/No networks bound/i)).toBeInTheDocument();
    });
  });

  describe("registered branch (homeData() !== null)", () => {
    const TWO_NETWORKS = {
      networks: [
        {
          slug: "azzurra",
          nick: "vjt",
          connection_state: "connected" as const,
          connection_state_reason: null,
          connection_state_changed_at: "2026-05-18T10:00:00Z",
        },
        {
          slug: "freenode",
          nick: "vjt-fn",
          connection_state: "parked" as const,
          connection_state_reason: "manual disconnect",
          connection_state_changed_at: "2026-05-18T09:00:00Z",
        },
      ],
      available_networks: [],
    };

    it("renders one row per network with slug + nick + state", () => {
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      render(() => <HomePane />);

      expect(screen.getByText("azzurra")).toBeInTheDocument();
      expect(screen.getByText("vjt")).toBeInTheDocument();
      expect(screen.getByText("connected")).toBeInTheDocument();

      expect(screen.getByText("freenode")).toBeInTheDocument();
      expect(screen.getByText("vjt-fn")).toBeInTheDocument();
      expect(screen.getByText("parked")).toBeInTheDocument();
      expect(screen.getByText("manual disconnect")).toBeInTheDocument();
    });

    it("renders 'No networks bound' fallback when array is empty", () => {
      homeDataMock.mockReturnValue({ networks: [], available_networks: [] });
      render(() => <HomePane />);

      expect(screen.getByText(/No networks bound/i)).toBeInTheDocument();
    });

    it(":parked row [Reconnect] chip click dispatches /connect via patchNetwork (UX-5 BR)", async () => {
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      render(() => <HomePane />);

      // UX-5 BR: explicit chip is now the canonical click target on
      // :parked / :failed rows (whole-row-as-button replaced — a button
      // inside a button is invalid HTML). The chip carries the visible
      // affordance; the whole row remains clickable too via a wrapping
      // div onClick for keyboard / accessibility parity, but the chip
      // is the assertion target.
      const reconnectBtn = screen.getByRole("button", { name: /reconnect freenode/i });
      fireEvent.click(reconnectBtn);

      await waitFor(() => {
        expect(patchNetworkMock).toHaveBeenCalledWith("test-token", "freenode", {
          connection_state: "connected",
        });
      });
      // NOT setSelectedChannel — chip click dispatches /connect only.
      expect(setSelectedChannelMock).not.toHaveBeenCalled();
    });

    it(":parked row chip surfaces friendlyApiError inline on PATCH failure (UX-5 BR)", async () => {
      // Pre-BR the failure path swallowed errors via console.warn
      // (violation of feedback_silent_retry_anti_pattern). Post-BR the
      // chip writes the friendly message into a per-row error span so
      // the operator sees what went wrong (e.g. 503 too_many_sessions
      // → "Too many sessions on this device").
      const { ApiError } = await import("../lib/api");
      patchNetworkMock.mockRejectedValueOnce(new ApiError(503, "too_many_sessions"));
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      render(() => <HomePane />);

      const reconnectBtn = screen.getByRole("button", { name: /reconnect freenode/i });
      fireEvent.click(reconnectBtn);

      await waitFor(() => {
        // Identity-stub friendlyApiError returns `friendly: <msg>`;
        // assertion proves the error routes through the helper.
        expect(screen.getByText(/friendly: 503 too_many_sessions/)).toBeInTheDocument();
      });
    });

    it(":failed row also renders a [Reconnect] chip (UX-5 BR — both non-connected states)", async () => {
      // Mirror the :parked path for :failed. Pre-BR :failed rows were
      // also click-to-connect via the whole row; post-BR they get the
      // same explicit chip so the affordance is visible in both states.
      const FAILED_NET: HomeDataLocal = {
        networks: [
          {
            slug: "libera",
            nick: "vjt-libera",
            connection_state: "failed",
            connection_state_reason: "k-line: nick banned",
            connection_state_changed_at: "2026-05-19T10:00:00Z",
          },
        ],
        available_networks: [],
      };
      homeDataMock.mockReturnValue(FAILED_NET);
      render(() => <HomePane />);

      const reconnectBtn = screen.getByRole("button", { name: /reconnect libera/i });
      fireEvent.click(reconnectBtn);

      await waitFor(() => {
        expect(patchNetworkMock).toHaveBeenCalledWith("test-token", "libera", {
          connection_state: "connected",
        });
      });
    });

    it(":connected row does NOT render a [Reconnect] chip (UX-5 BR — chip is non-connected only)", () => {
      // The chip is the explicit affordance for the non-connected
      // states only. :connected rows keep their jump-to-$server
      // shortcut (whole-row button) and do not surface a chip.
      const CONNECTED_ONLY: HomeDataLocal = {
        networks: [
          {
            slug: "azzurra",
            nick: "vjt",
            connection_state: "connected",
            connection_state_reason: null,
            connection_state_changed_at: "2026-05-18T10:00:00Z",
          },
        ],
        available_networks: [],
      };
      homeDataMock.mockReturnValue(CONNECTED_ONLY);
      render(() => <HomePane />);

      expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull();
    });

    it(":connected row click jumps to that network's $server window", () => {
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      render(() => <HomePane />);

      const azzurraBtn = screen.getByText("azzurra").closest("button");
      expect(azzurraBtn).not.toBeNull();
      if (!azzurraBtn) return;
      fireEvent.click(azzurraBtn);

      expect(setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "azzurra",
        channelName: "$server",
        kind: "server",
      });
      // NOT a REST call — :connected click is a UI shortcut.
      expect(patchNetworkMock).not.toHaveBeenCalled();
    });

    // #84 — E4: Browse channels affordance on connected rows.
    // Each :connected row renders a "Browse channels" button that opens the
    // per-network $list pseudo-window (DirectoryPane). Clicking it calls
    // setSelectedChannel with kind: "list" — no REST call involved.
    it(":connected row 'Browse channels' button opens $list window (#84 E4)", () => {
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      render(() => <HomePane />);

      // Find the browse button scoped to the connected "azzurra" row.
      const browseBtn = screen.getByRole("button", { name: /browse channels/i });
      expect(browseBtn).not.toBeNull();
      fireEvent.click(browseBtn);

      expect(setSelectedChannelMock).toHaveBeenCalledWith({
        networkSlug: "azzurra",
        channelName: LIST_WINDOW_NAME,
        kind: "list",
      });
      // Browse is a UI shortcut — no REST call.
      expect(patchNetworkMock).not.toHaveBeenCalled();
    });

    // #283 — per-network Disconnect on :connected rows, symmetric with the
    // Reconnect chip on :parked/:failed rows. It REUSES the #195 confirm
    // modal (windowClose.confirmDisconnectNetwork → "Disconnect from
    // <slug>?"), the SAME verb the sidebar/bottom-bar × fires — NOT a raw
    // park PATCH and NOT a jump. vjt decision (issue #283, 2026-07-20):
    // fire-and-forget behind the modal, no pending/error chip (that path is
    // for Reconnect's awaited PATCH; Disconnect matches the × exactly).
    it(":connected row 'Disconnect' button fires confirmDisconnectNetwork (#283)", () => {
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      render(() => <HomePane />);

      const disconnectBtn = screen.getByRole("button", { name: /disconnect azzurra/i });
      fireEvent.click(disconnectBtn);

      expect(confirmDisconnectNetworkMock).toHaveBeenCalledWith("azzurra");
      // Reuse the #195 modal — NOT a raw park PATCH, NOT a jump.
      expect(patchNetworkMock).not.toHaveBeenCalled();
      expect(setSelectedChannelMock).not.toHaveBeenCalled();
    });

    // #496/#513 — the per-network 🗺 Map button stays HIDDEN behind
    // `SHOW_NETWORK_MAP`. #513 fixed the /links defects, but vjt's product call
    // keeps the button hidden: the `/links` command is the sole entry point to
    // the topology map. The #238 onTopology wiring (jump-to-$server + pushLinks)
    // stays in source so a one-line flag flip restores it, but no Map control
    // renders on any row. (pushLinks + LinksModal stay covered by their own
    // tests / the /links slash command.)
    it(":connected row does NOT render the 🗺 Map button (#496/#513 — flag-hidden)", () => {
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      networkIdBySlugMock.mockReturnValue(7);
      render(() => <HomePane />);

      expect(screen.queryByRole("button", { name: /network map for azzurra/i })).toBeNull();
      expect(screen.queryByTestId("home-topology-azzurra")).toBeNull();
      // The other row controls stay present (uniform action area intact).
      expect(screen.getByRole("button", { name: /disconnect azzurra/i })).toBeInTheDocument();
    });

    it(":connected row Disconnect is identical for a VISITOR subject (#283 single path)", () => {
      // ConnectedRow is one shared component (HomePane.tsx) — the Disconnect
      // affordance is subject-agnostic. Rendering it for a visitor proves
      // "no behavioral divergence between users and visitors" trivially.
      userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest" });
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      render(() => <HomePane />);

      const disconnectBtn = screen.getByRole("button", { name: /disconnect azzurra/i });
      fireEvent.click(disconnectBtn);

      expect(confirmDisconnectNetworkMock).toHaveBeenCalledWith("azzurra");
    });

    // issue 2219 — Remove, the inverse of the one-tap connect above. It
    // sits on the DISCONNECTED row and not on the connected one, which
    // makes the two-step path (Disconnect, look at it, then Remove) the
    // only path and keeps the verb from ever firing against a live
    // session from the UI.
    it(":parked row 'Remove' button fires confirmRemoveNetwork (issue 2219)", () => {
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      render(() => <HomePane />);

      const removeBtn = screen.getByRole("button", { name: /remove freenode/i });
      fireEvent.click(removeBtn);

      expect(confirmRemoveNetworkMock).toHaveBeenCalledWith("freenode", expect.any(Function));
      // Behind the confirm, like Disconnect — never a raw call, never a jump.
      expect(patchNetworkMock).not.toHaveBeenCalled();
      expect(setSelectedChannelMock).not.toHaveBeenCalled();
    });

    it(":connected row does NOT render a Remove button (issue 2219)", () => {
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      render(() => <HomePane />);

      // azzurra is connected: Disconnect first, and the row becomes the one
      // that offers Remove. A live network cannot be removed in one tap.
      expect(screen.queryByRole("button", { name: /remove azzurra/i })).toBeNull();
      expect(screen.getByRole("button", { name: /remove freenode/i })).toBeInTheDocument();
    });

    it("a failed Remove surfaces its reason in the row's alert sink (issue 2219)", () => {
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      render(() => <HomePane />);

      fireEvent.click(screen.getByRole("button", { name: /remove freenode/i }));

      // The row hands the confirm its OWN error sink, so a removal that
      // does not happen says so rather than leaving a row the operator has
      // asked twice to be rid of with no clue why it stayed.
      const call = confirmRemoveNetworkMock.mock.calls[0];
      expect(call).toBeDefined();
      call?.[1]("remove failed");

      expect(screen.getByText("remove failed")).toBeInTheDocument();
    });

    it(":parked row does NOT render a Disconnect button (#283 — connected-only)", () => {
      // The Disconnect affordance is the :connected counterpart of the
      // Reconnect chip; a :parked/:failed row already shows Reconnect and
      // must NOT also offer Disconnect (there is no connected upstream to
      // park).
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      render(() => <HomePane />);

      // freenode is parked in TWO_NETWORKS → no Disconnect for it.
      expect(screen.queryByRole("button", { name: /disconnect freenode/i })).toBeNull();
      // azzurra is connected → it DOES get one.
      expect(screen.getByRole("button", { name: /disconnect azzurra/i })).toBeInTheDocument();
    });

    it("registered branch ALSO renders no compose / input affordance", () => {
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      const { container } = render(() => <HomePane />);

      expect(container.querySelector("textarea")).toBeNull();
      expect(container.querySelector(".compose-box")).toBeNull();
    });

    it("no-op when token is null (logout race) — UX-5 BR chip path", async () => {
      tokenMock.mockReturnValue(null);
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      render(() => <HomePane />);

      const reconnectBtn = screen.getByRole("button", { name: /reconnect freenode/i });
      fireEvent.click(reconnectBtn);

      // Brief microtask delay to let the promise chain settle.
      await new Promise((r) => setTimeout(r, 0));
      expect(patchNetworkMock).not.toHaveBeenCalled();
    });
  });

  // #392 — session-wide "open on another device" button, placed after the
  // network list. Opens the SAME modal the settings button opens
  // (openShareModal). #1306 — no longer visitor-gated: the server mints for
  // a user too, so the ONLY exclusion left here is #363's incognito visitor.
  describe("#392 open-on-another-device (home share button)", () => {
    it("shows the share button for a visitor and opens the share modal on click", () => {
      userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest" });
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      render(() => <HomePane />);

      const btn = screen.getByTestId("home-share-session");
      expect(btn).toBeInTheDocument();
      // #462 — the name comes from the shared constant, not from this file.
      expect(btn).toHaveTextContent(SHARE_SESSION_LABEL);
      fireEvent.click(btn);
      expect(openShareModalMock).toHaveBeenCalledTimes(1);
    });

    it("shows the share button for a user subject too (#1306)", () => {
      // The pre-#1306 gate hid this because /me/share-token 403'd a
      // password subject. It mints now, so hiding the button would be the
      // client refusing a door the server holds open.
      userMock.mockReturnValue({ kind: "user", id: "u1", name: "vjt" });
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      render(() => <HomePane />);

      const btn = screen.getByTestId("home-share-session");
      expect(btn).toBeInTheDocument();
      fireEvent.click(btn);
      expect(openShareModalMock).toHaveBeenCalledTimes(1);
    });

    it("hides the share button for an incognito visitor (#363)", () => {
      // With the visitor half of the gate gone, this is the ONLY exclusion
      // left — and it had no unit witness before #1306, only an e2e one.
      userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest", incognito: true });
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      render(() => <HomePane />);

      expect(screen.queryByTestId("home-share-session")).toBeNull();
    });
  });

  // #529 — connected-row restyle. Four structural outcomes, asserted by
  // role / pairing / grouping (the visible result), not by class names alone:
  //   1. Register nick is paired with Browse channels as one button pair.
  //   2. "Channels worth a look on <slug>:" is a real subsection heading.
  //   3. Disconnect (and, symmetric, Reconnect) sits with the state label.
  //   4. A horizontal rule precedes each network block.
  describe("#529 connected-row restyle", () => {
    const RESTYLE_NETWORKS: HomeDataLocal = {
      networks: [
        {
          slug: "azzurra",
          nick: "vjt",
          connection_state: "connected",
          connection_state_reason: null,
          connection_state_changed_at: null,
        },
        {
          slug: "freenode",
          nick: "vjt-fn",
          connection_state: "parked",
          connection_state_reason: "manual disconnect",
          connection_state_changed_at: null,
        },
      ],
      available_networks: [],
    };

    it("pairs Register nick with Browse channels in one button pair (#529.1)", async () => {
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      flavorForSlugMock.mockReturnValue("azzurra");
      networkIdBySlugMock.mockReturnValue(7);
      identifiedForNetworkMock.mockReturnValue(false);
      render(() => <HomePane />);

      const register = await screen.findByTestId("home-register-nick-azzurra");
      const browse = screen.getByRole("button", { name: /browse channels/i });
      // Same parent → side-by-side pair, Register to the right of Browse.
      expect(register.parentElement).toBe(browse.parentElement);
      expect(
        browse.compareDocumentPosition(register) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
      // Same visual weight → both carry the prominent browse style.
      expect(browse).toHaveClass("home-pane-network-browse");
      expect(register).toHaveClass("home-pane-network-browse");
    });

    it("renders the featured intro as a real subsection heading (#529.2)", async () => {
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      getFeaturedMock.mockResolvedValue([{ name: "#sniffo", description: null }]);
      render(() => <HomePane />);

      const heading = await screen.findByRole("heading", {
        name: /channels worth a look on azzurra/i,
      });
      expect(heading).toBeInTheDocument();
    });

    it("groups Disconnect with the connection-state label (#529.3)", () => {
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      render(() => <HomePane />);

      const disconnect = screen.getByRole("button", { name: /disconnect azzurra/i });
      const status = disconnect.closest(".home-pane-network-status");
      expect(status).not.toBeNull();
      // The state label it acts on lives in the SAME group.
      expect(status).toHaveTextContent(/connected/i);
    });

    it("groups Reconnect with the state label too — symmetric rows (#529.3)", () => {
      homeDataMock.mockReturnValue(RESTYLE_NETWORKS);
      render(() => <HomePane />);

      const reconnect = screen.getByRole("button", { name: /reconnect freenode/i });
      const status = reconnect.closest(".home-pane-network-status");
      expect(status).not.toBeNull();
      expect(status).toHaveTextContent(/parked/i);
    });

    it("precedes each network block with a horizontal rule (#529.4)", () => {
      homeDataMock.mockReturnValue(RESTYLE_NETWORKS);
      const { container } = render(() => <HomePane />);

      const rows = container.querySelectorAll(".home-pane-network-row");
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        const sep = row.querySelector(".home-pane-network-separator");
        expect(sep).not.toBeNull();
        expect(sep?.tagName).toBe("HR");
        // The rule OPENS the block: it is the row's first child, immediately
        // before the heading (a TRAILING rule — the pre-#529 shape — would
        // fail this while a bare count check would still pass).
        expect(row.firstElementChild).toBe(sep);
        expect(sep?.nextElementSibling).toHaveClass("home-pane-network-heading");
      }
      // …and each is a real <hr> (role=separator), both row types.
      expect(screen.getAllByRole("separator")).toHaveLength(2);
    });
  });
});
