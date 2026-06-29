import { render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CrtSplash from "../CrtSplash";

// #134 — retro CRT loading splash. The splash is the LOADING-ONLY
// content of the Shell main-pane `<Switch fallback>`: it renders while
// cic is still booting (before `/me` resolves and the channels resource
// settles) and HANDS OFF to the home window the instant load completes.
//
// A transient loading screen is e2e-hostile (gone the moment the page
// finishes loading), so the honest proof level is this component test:
// drive the loading predicate directly and assert (a) the CRT splash +
// its boot/LOADING text render while loading, and (b) nothing renders
// once loaded (the hand-off contract). The loading predicate mirrors
// Shell's cold-load auto-select wait EXACTLY: `!user()` (/, me not yet
// resolved) OR `channelsBySlug() === undefined` (resource still loading;
// a resolved `{}` is truthy and means "loaded, no channels yet").
//
// Mocks: networks.ts (user + channelsBySlug signals).

const userMock = vi.fn<() => unknown>(() => null);
const channelsBySlugMock = vi.fn<() => unknown>(() => undefined);

vi.mock("../lib/networks", () => ({
  user: () => userMock(),
  channelsBySlug: () => channelsBySlugMock(),
}));

describe("CrtSplash (#134 — retro CRT loading splash)", () => {
  beforeEach(() => {
    userMock.mockReturnValue(null);
    channelsBySlugMock.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders the CRT splash while /me is unresolved (cold boot)", () => {
    userMock.mockReturnValue(null);
    channelsBySlugMock.mockReturnValue(undefined);
    render(() => <CrtSplash />);

    expect(screen.getByTestId("crt-splash")).toBeInTheDocument();
    // The retro boot/LOADING text is the visible payload — assert it so a
    // future refactor that drops the text fails loudly (no vacuous green).
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("still renders while the channels resource is loading (user resolved, channels undefined)", () => {
    userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest", network_slug: "azzurra" });
    channelsBySlugMock.mockReturnValue(undefined);
    render(() => <CrtSplash />);

    expect(screen.getByTestId("crt-splash")).toBeInTheDocument();
  });

  it("hands off — renders nothing once both /me and channels have loaded", () => {
    userMock.mockReturnValue({ kind: "visitor", id: "v1", nick: "guest", network_slug: "azzurra" });
    // A resolved empty object is truthy: load is DONE, there just are no
    // channels yet. The splash must hand off (render null), not linger.
    channelsBySlugMock.mockReturnValue({});
    render(() => <CrtSplash />);

    expect(screen.queryByTestId("crt-splash")).toBeNull();
  });
});
