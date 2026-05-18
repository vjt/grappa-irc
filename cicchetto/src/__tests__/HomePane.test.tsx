import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import HomePane from "../HomePane";

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
// Mocks: home.ts (homeData signal), api.ts (patchNetwork REST), auth.ts
// (token), selection.ts (setSelectedChannel).

type HomeNetworkRowLocal = {
  slug: string;
  nick: string;
  connection_state: "connected" | "parked" | "failed";
  connection_state_reason: string | null;
  connection_state_changed_at: string | null;
};
type HomeDataLocal = { networks: HomeNetworkRowLocal[] };

const homeDataMock = vi.fn<() => HomeDataLocal | null>(() => null);
const patchNetworkMock = vi.fn<(t: string, slug: string, body: unknown) => Promise<void>>(() =>
  Promise.resolve(),
);
const setSelectedChannelMock = vi.fn<(sel: unknown) => void>();
const tokenMock = vi.fn<() => string | null>(() => "test-token");

vi.mock("../lib/home", () => ({
  homeData: () => homeDataMock(),
  patchHomeNetwork: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  patchNetwork: (t: string, slug: string, body: unknown) => patchNetworkMock(t, slug, body),
}));

vi.mock("../lib/auth", () => ({
  token: () => tokenMock(),
}));

vi.mock("../lib/selection", () => ({
  setSelectedChannel: (sel: unknown) => setSelectedChannelMock(sel),
}));

describe("HomePane", () => {
  beforeEach(() => {
    homeDataMock.mockReturnValue(null);
    patchNetworkMock.mockClear();
    setSelectedChannelMock.mockClear();
    tokenMock.mockReturnValue("test-token");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("visitor branch (homeData() === null)", () => {
    it("renders HomePaneVisitor with help text", () => {
      homeDataMock.mockReturnValue(null);
      render(() => <HomePane />);

      expect(screen.getByText(/Welcome to Grappa/i)).toBeInTheDocument();
      expect(screen.getByText(/You are connected as a visitor/i)).toBeInTheDocument();
    });

    it("does NOT render any compose / input affordance (KISS, no-input outright)", () => {
      homeDataMock.mockReturnValue(null);
      const { container } = render(() => <HomePane />);

      // No textarea, no input field, no compose-box. Visitor home is
      // read-only per the spec's KISS pick.
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
      homeDataMock.mockReturnValue({ networks: [] });
      render(() => <HomePane />);

      expect(screen.getByText(/No networks bound/i)).toBeInTheDocument();
    });

    it(":parked row click dispatches /connect via patchNetwork", async () => {
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      render(() => <HomePane />);

      const freenodeBtn = screen.getByText("freenode").closest("button");
      expect(freenodeBtn).not.toBeNull();
      if (!freenodeBtn) return;
      fireEvent.click(freenodeBtn);

      await waitFor(() => {
        expect(patchNetworkMock).toHaveBeenCalledWith("test-token", "freenode", {
          connection_state: "connected",
        });
      });
      // NOT setSelectedChannel — click on parked dispatches /connect only.
      expect(setSelectedChannelMock).not.toHaveBeenCalled();
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

    it("registered branch ALSO renders no compose / input affordance", () => {
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      const { container } = render(() => <HomePane />);

      expect(container.querySelector("textarea")).toBeNull();
      expect(container.querySelector(".compose-box")).toBeNull();
    });

    it("no-op when token is null (logout race)", async () => {
      tokenMock.mockReturnValue(null);
      homeDataMock.mockReturnValue(TWO_NETWORKS);
      render(() => <HomePane />);

      const freenodeBtn = screen.getByText("freenode").closest("button");
      if (!freenodeBtn) return;
      fireEvent.click(freenodeBtn);

      // Brief microtask delay to let the promise chain settle.
      await new Promise((r) => setTimeout(r, 0));
      expect(patchNetworkMock).not.toHaveBeenCalled();
    });
  });
});
