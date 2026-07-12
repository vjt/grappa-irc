import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomePane from "../HomePane";
import { channelKey } from "../lib/channelKey";
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

vi.mock("../lib/home", () => ({
  homeData: () => homeDataMock(),
  patchHomeNetwork: vi.fn(),
}));

vi.mock("../lib/api", () => {
  // UX-5 BR: minimal ApiError stub for failure-path tests. Matches the
  // shape `friendlyApiError` consumes (`status` + `code` + Error
  // prototype chain). In-factory because `vi.mock` hoists above
  // top-level declarations; a module-local class would be undefined
  // at hoist time.
  class ApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string) {
      super(`${status} ${code}`);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  }
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
}));
// channelKey is a pure fn — use the real one (mock at boundaries, not
// pure helpers) so the joined-state key shape matches production exactly.
vi.mock("../lib/windowState", () => ({ windowStateByChannel: () => windowStateMock() }));

vi.mock("../lib/auth", () => ({
  token: () => tokenMock(),
}));

vi.mock("../lib/selection", () => ({
  setSelectedChannel: (sel: unknown) => setSelectedChannelMock(sel),
  applySeedEnvelope: vi.fn(),
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

    it("renders the welcome + orientation copy for a visitor subject (#135)", () => {
      userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest" });
      homeDataMock.mockReturnValue(visitorHome([]));
      render(() => <HomePane />);

      // Stable phrases the #135 visitor-home e2e also pins.
      expect(screen.getByText(/Welcome to Grappa/i)).toBeInTheDocument();
      expect(screen.getByText(/always-on IRC bouncer/i)).toBeInTheDocument();
    });

    it("does NOT render the welcome copy for a USER subject", () => {
      userMock.mockReturnValue({ kind: "user", id: "u1", name: "vjt" });
      homeDataMock.mockReturnValue(connectedNetworks("azzurra"));
      render(() => <HomePane />);

      expect(screen.queryByText(/Welcome to Grappa/i)).toBeNull();
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
});
