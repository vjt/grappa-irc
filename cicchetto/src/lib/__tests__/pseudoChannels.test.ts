import { beforeEach, describe, expect, it, vi } from "vitest";

// pseudoChannelsForNetwork — the ONE shared projection (extracted from
// Sidebar, #71 INC-3) that derives synthetic non-joined window rows from
// windowStateByChannel. Characterizes the behavior locked by the
// pre-existing Sidebar.test.tsx suite at its new home.
//
// #902 — `invited` is deliberately NOT among the drawn states any more: an
// unanswered invite is announced by the stacked top banner
// (`lib/errorBanners.ts`), not by a greyed row. The exclusion is asserted
// below rather than merely omitted, because the `:invited` key is still a
// normal thing to find in the state map — the server still holds the window
// — so "no row" has to be a decision this projection makes, not an accident
// of never being handed one.
//
// Boundary mocks: the three reactive stores the projection reads. The
// channelKey / decodeChannelKey codec is the REAL pure function — keys
// are built via `channelKey(...)` so the test never re-implements the
// composite-key shape (CLAUDE.md "use production code in tests").

const state = vi.hoisted(() => ({
  ws: {} as Record<string, string>,
  cbs: undefined as Record<string, { name: string; joined: boolean }[]> | undefined,
  qw: {} as Record<number, { targetNick: string }[]>,
  mobile: false,
}));

vi.mock("../windowState", () => ({ windowStateByChannel: () => state.ws }));
vi.mock("../networks", () => ({ channelsBySlug: () => state.cbs }));
vi.mock("../queryWindows", () => ({ queryWindowsByNetwork: () => state.qw }));
// The form factor is an environment boundary (matchMedia); mocking the
// signal is what lets one jsdom run exercise both navs.
vi.mock("../theme", () => ({ isMobile: () => state.mobile }));

import { channelKey } from "../channelKey";
import { navPseudoChannelsForNetwork, pseudoChannelsForNetwork } from "../pseudoChannels";

beforeEach(() => {
  state.ws = {};
  state.cbs = {};
  state.qw = {};
  state.mobile = false;
});

describe("pseudoChannelsForNetwork", () => {
  it("returns a row for every DRAWN non-joined state (pending/failed/kicked/parked)", () => {
    state.ws = {
      [channelKey("freenode", "#pending")]: "pending",
      [channelKey("freenode", "#failed")]: "failed",
      [channelKey("freenode", "#kicked")]: "kicked",
      [channelKey("freenode", "#parked")]: "parked",
    };
    const rows = pseudoChannelsForNetwork("freenode", 1);
    expect(rows).toEqual(
      expect.arrayContaining([
        { name: "#pending", state: "pending" },
        { name: "#failed", state: "failed" },
        { name: "#kicked", state: "kicked" },
        { name: "#parked", state: "parked" },
      ]),
    );
    expect(rows.length).toBe(4);
  });

  // #902 — the banner owns this state. A row here would be the "second place
  // to look" the issue exists to remove.
  it("excludes :invited windows even though the state map still carries them", () => {
    state.ws = {
      [channelKey("freenode", "#invited")]: "invited",
      [channelKey("freenode", "#failed")]: "failed",
    };
    expect(pseudoChannelsForNetwork("freenode", 1)).toEqual([{ name: "#failed", state: "failed" }]);
  });

  it("excludes joined windows (channelsBySlug branch owns them)", () => {
    state.ws = {
      [channelKey("freenode", "#joined")]: "joined",
      [channelKey("freenode", "#failed")]: "failed",
    };
    const rows = pseudoChannelsForNetwork("freenode", 1);
    expect(rows).toEqual([{ name: "#failed", state: "failed" }]);
  });

  it("dedups a key already live in channelsBySlug (the live row wins)", () => {
    state.ws = { [channelKey("freenode", "#dup")]: "kicked" };
    state.cbs = { freenode: [{ name: "#dup", joined: true }] };
    expect(pseudoChannelsForNetwork("freenode", 1)).toEqual([]);
  });

  it("excludes query (DM) targets that also carry a windowState entry", () => {
    state.ws = { [channelKey("freenode", "alice")]: "kicked" };
    state.qw = { 1: [{ targetNick: "alice" }] };
    expect(pseudoChannelsForNetwork("freenode", 1)).toEqual([]);
  });

  it("filters to the requested network slug (ignores other networks' keys)", () => {
    state.ws = {
      [channelKey("freenode", "#here")]: "failed",
      [channelKey("libera", "#there")]: "failed",
    };
    expect(pseudoChannelsForNetwork("freenode", 1)).toEqual([{ name: "#here", state: "failed" }]);
  });

  it("returns [] when no windowState entries exist", () => {
    expect(pseudoChannelsForNetwork("freenode", 1)).toEqual([]);
  });

  it("tolerates an undefined channelsBySlug (no live map yet)", () => {
    state.ws = { [channelKey("freenode", "#failed")]: "failed" };
    state.cbs = undefined;
    expect(pseudoChannelsForNetwork("freenode", 1)).toEqual([{ name: "#failed", state: "failed" }]);
  });
});

// #402 — the form-factor view. This is the set the navs render AND the set
// the archive filter subtracts, so the two cannot disagree about which
// window has a surface. The narrowing used to be open-coded in BottomBar,
// where the archive could not see it.
describe("navPseudoChannelsForNetwork", () => {
  const everyDrawnState = () => {
    state.ws = {
      [channelKey("freenode", "#pending")]: "pending",
      [channelKey("freenode", "#failed")]: "failed",
      [channelKey("freenode", "#kicked")]: "kicked",
      [channelKey("freenode", "#parked")]: "parked",
    };
  };

  it("draws every non-joined state on desktop (the Sidebar renders them all)", () => {
    everyDrawnState();
    state.mobile = false;
    expect(navPseudoChannelsForNetwork("freenode", 1)).toEqual(
      pseudoChannelsForNetwork("freenode", 1),
    );
    expect(navPseudoChannelsForNetwork("freenode", 1)).toHaveLength(4);
  });

  // #902 — the `:invited` slice was the BottomBar's ENTIRE pseudo-row
  // content, and the banner replaced it, so mobile draws nothing here. The
  // archive reads this same function, so it now subtracts nothing on mobile
  // and a pending/failed/kicked/parked window is reachable there through the
  // archive — #402's "one window, one surface" rule, applied to the new
  // surface map rather than excepted from it.
  it("draws NOTHING on mobile — there is no mobile pseudo-row nav any more", () => {
    everyDrawnState();
    state.mobile = true;
    expect(navPseudoChannelsForNetwork("freenode", 1)).toEqual([]);
  });

  it("draws nothing on mobile even for a lone invited window (the banner has it)", () => {
    state.ws = { [channelKey("freenode", "#invited")]: "invited" };
    state.mobile = true;
    expect(navPseudoChannelsForNetwork("freenode", 1)).toEqual([]);
  });
});
