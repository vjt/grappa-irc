import { beforeEach, describe, expect, it, vi } from "vitest";

// pseudoChannelsForNetwork — the ONE shared projection (extracted from
// Sidebar, #71 INC-3) that derives synthetic non-joined window rows from
// windowStateByChannel. Characterizes the behavior locked by the
// pre-existing Sidebar.test.tsx suite at its new home.
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
  it("returns a row for EVERY non-joined state (pending/invited/failed/kicked/parked)", () => {
    state.ws = {
      [channelKey("freenode", "#pending")]: "pending",
      [channelKey("freenode", "#invited")]: "invited",
      [channelKey("freenode", "#failed")]: "failed",
      [channelKey("freenode", "#kicked")]: "kicked",
      [channelKey("freenode", "#parked")]: "parked",
    };
    const rows = pseudoChannelsForNetwork("freenode", 1);
    expect(rows).toEqual(
      expect.arrayContaining([
        { name: "#pending", state: "pending" },
        { name: "#invited", state: "invited" },
        { name: "#failed", state: "failed" },
        { name: "#kicked", state: "kicked" },
        { name: "#parked", state: "parked" },
      ]),
    );
    expect(rows.length).toBe(5);
  });

  it("excludes joined windows (channelsBySlug branch owns them)", () => {
    state.ws = {
      [channelKey("freenode", "#joined")]: "joined",
      [channelKey("freenode", "#invited")]: "invited",
    };
    const rows = pseudoChannelsForNetwork("freenode", 1);
    expect(rows).toEqual([{ name: "#invited", state: "invited" }]);
  });

  it("dedups a key already live in channelsBySlug (the live row wins)", () => {
    state.ws = { [channelKey("freenode", "#dup")]: "invited" };
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
      [channelKey("freenode", "#here")]: "invited",
      [channelKey("libera", "#there")]: "invited",
    };
    expect(pseudoChannelsForNetwork("freenode", 1)).toEqual([{ name: "#here", state: "invited" }]);
  });

  it("returns [] when no windowState entries exist", () => {
    expect(pseudoChannelsForNetwork("freenode", 1)).toEqual([]);
  });

  it("tolerates an undefined channelsBySlug (no live map yet)", () => {
    state.ws = { [channelKey("freenode", "#invited")]: "invited" };
    state.cbs = undefined;
    expect(pseudoChannelsForNetwork("freenode", 1)).toEqual([
      { name: "#invited", state: "invited" },
    ]);
  });
});

// #402 — the form-factor view. This is the set the navs render AND the set
// the archive filter subtracts, so the two cannot disagree about which
// window has a surface. The narrowing used to be open-coded in BottomBar,
// where the archive could not see it.
describe("navPseudoChannelsForNetwork", () => {
  const everyNonJoinedState = () => {
    state.ws = {
      [channelKey("freenode", "#pending")]: "pending",
      [channelKey("freenode", "#invited")]: "invited",
      [channelKey("freenode", "#failed")]: "failed",
      [channelKey("freenode", "#kicked")]: "kicked",
      [channelKey("freenode", "#parked")]: "parked",
    };
  };

  it("draws every non-joined state on desktop (the Sidebar renders them all)", () => {
    everyNonJoinedState();
    state.mobile = false;
    expect(navPseudoChannelsForNetwork("freenode", 1)).toEqual(
      pseudoChannelsForNetwork("freenode", 1),
    );
    expect(navPseudoChannelsForNetwork("freenode", 1)).toHaveLength(5);
  });

  it("draws ONLY :invited on mobile (#71 INC-3 — the BottomBar is the only nav)", () => {
    everyNonJoinedState();
    state.mobile = true;
    expect(navPseudoChannelsForNetwork("freenode", 1)).toEqual([
      { name: "#invited", state: "invited" },
    ]);
  });

  it("inherits the base projection's exclusions on mobile (a live :invited dedups away)", () => {
    state.ws = { [channelKey("freenode", "#dup")]: "invited" };
    state.cbs = { freenode: [{ name: "#dup", joined: true }] };
    state.mobile = true;
    expect(navPseudoChannelsForNetwork("freenode", 1)).toEqual([]);
  });
});
