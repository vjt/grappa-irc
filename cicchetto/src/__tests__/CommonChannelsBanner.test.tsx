import { render, screen } from "@solidjs/testing-library";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";
import { warmGraph } from "./helpers/warmGraph";

vi.mock("../lib/api", () => ({
  listCommonChannels: vi.fn(),
}));

// #781 — see helpers/warmGraph.ts. The per-test `await import` pays
// vite's transform for this graph on the FIRST import only; warming it
// in `beforeAll` moves that cost onto the 10s `hookTimeout` instead of
// the 5s per-test budget.
beforeAll(() => warmGraph(() => import("../CommonChannelsBanner")));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

// Issue 2449 — CommonChannelsBanner render states. The banner's effect
// fetches the snapshot on mount (query focus) and derives the live
// list from `membersByChannel`; every module is dynamically imported
// per test (after `vi.resetModules`) so the component under test reads
// the SAME store instances the test drives — a static import would bind
// the pre-reset instances and the test's seeds would never land.

type Setup = {
  api: typeof import("../lib/api");
  auth: typeof import("../lib/auth");
  members: typeof import("../lib/members");
  ws: typeof import("../lib/windowState");
  selection: typeof import("../lib/selection");
  Banner: typeof import("../CommonChannelsBanner").default;
};

const setup = async (): Promise<Setup> => {
  const api = await import("../lib/api");
  const auth = await import("../lib/auth");
  const members = await import("../lib/members");
  const ws = await import("../lib/windowState");
  const selection = await import("../lib/selection");
  const { default: Banner } = await import("../CommonChannelsBanner");
  return { api, auth, members, ws, selection, Banner };
};

const seedPeerIn = (setup_: Setup, channel: string, peer: string): void => {
  setup_.ws.setJoined(channelKey("azzurra", channel));
  setup_.members.seedMembers(channelKey("azzurra", channel), [{ nick: peer, modes: [] }]);
};

describe("CommonChannelsBanner", () => {
  it("shows loading while the snapshot is in flight", async () => {
    const s = await setup();
    let resolve!: (v: string[]) => void;
    const pending = new Promise<string[]>((r) => {
      resolve = r;
    });
    vi.mocked(s.api.listCommonChannels).mockReturnValue(pending);
    s.auth.setToken("tok");

    render(() => <s.Banner networkSlug="azzurra" peer="alice" />);

    expect(screen.getByTestId("common-channels-banner").textContent).toContain("shared channels…");
    expect(s.api.listCommonChannels).toHaveBeenCalledWith("tok", "azzurra", "alice");
    resolve(["#test"]);
  });

  it("shows the fetched channels as buttons once loaded", async () => {
    const s = await setup();
    seedPeerIn(s, "#test", "alice");
    vi.mocked(s.api.listCommonChannels).mockResolvedValue(["#test"]);
    s.auth.setToken("tok");

    render(() => <s.Banner networkSlug="azzurra" peer="alice" />);

    const button = await screen.findByRole("button", { name: "#test" });
    expect(button).toBeInTheDocument();
    expect(screen.getByTestId("common-channels-banner").textContent).toContain("Also in");
  });

  it("shows 'No channels in common' for an empty snapshot", async () => {
    const s = await setup();
    vi.mocked(s.api.listCommonChannels).mockResolvedValue([]);
    s.auth.setToken("tok");

    render(() => <s.Banner networkSlug="azzurra" peer="alice" />);

    expect(await screen.findByText("No channels in common")).toBeInTheDocument();
  });

  it("renders nothing when the fetch fails", async () => {
    const s = await setup();
    vi.mocked(s.api.listCommonChannels).mockRejectedValue(new Error("boom"));
    s.auth.setToken("tok");

    render(() => <s.Banner networkSlug="azzurra" peer="alice" />);

    // The fetch rejects on a microtask; give the banner a tick to store
    // the null and unmount, then assert absence.
    await vi.waitFor(() => {
      expect(screen.queryByTestId("common-channels-banner")).toBeNull();
    });
    // It mounted as loading first — the null arrives only after reject.
    expect(s.api.listCommonChannels).toHaveBeenCalledTimes(1);
  });

  it("jumps to the channel when its button is clicked", async () => {
    const s = await setup();
    seedPeerIn(s, "#test", "alice");
    vi.mocked(s.api.listCommonChannels).mockResolvedValue(["#test"]);
    s.auth.setToken("tok");

    render(() => <s.Banner networkSlug="azzurra" peer="alice" />);

    const button = await screen.findByRole("button", { name: "#test" });
    button.click();
    expect(s.selection.selectedChannel()).toEqual({
      networkSlug: "azzurra",
      channelName: "#test",
      kind: "channel",
    });
  });

  it("follows live presence: a PART drops the channel without refetch", async () => {
    const s = await setup();
    seedPeerIn(s, "#test", "alice");
    vi.mocked(s.api.listCommonChannels).mockResolvedValue(["#test"]);
    s.auth.setToken("tok");

    render(() => <s.Banner networkSlug="azzurra" peer="alice" />);
    await screen.findByRole("button", { name: "#test" });

    s.members.applyPresenceEvent(
      channelKey("azzurra", "#test"),
      {
        id: 9,
        network: "azzurra",
        channel: "#test",
        server_time: 0,
        kind: "part",
        sender: "alice",
        body: null,
        meta: {},
      },
      "ascii",
    );

    expect(await screen.findByText("No channels in common")).toBeInTheDocument();
    expect(s.api.listCommonChannels).toHaveBeenCalledTimes(1);
  });
});
