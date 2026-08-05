import { render } from "@solidjs/testing-library";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { warmGraph } from "./helpers/warmGraph";

// #402 — the mobile surface UNION for a non-joined window.
//
// UX-5 bucket BK states the rule as "one window, one surface": the archive
// filter (`visibleArchiveForNetwork`) subtracts EVERY row the shared
// pseudo-row projection yields, on the premise that the nav renders it.
// That premise holds on desktop (Sidebar renders every non-joined state)
// and NOT on mobile: the Sidebar is a whole absent JSX branch there
// (`Shell.tsx` mobile layout) and `BottomBar` narrows the same projection
// to `state === "invited"` (#71 INC-3, a deliberate space-scarcity
// choice). So on mobile a `pending` / `failed` / `kicked` / `parked`
// window is subtracted from the archive by a surface that does not render
// it: one window, ZERO surfaces.
//
// These tests assert the USER OUTCOME on the mobile form factor — the
// channel is reachable from exactly one of the two mobile surfaces — not
// that any particular function was called.
//
// Boundary mocks: the reactive data sources only. The projection under
// test (`lib/pseudoChannels`), the archive filter (`lib/archive`), the
// channel-key codec and `BottomBar` itself are all REAL.

// THE form factor under test. `isMobile()` is the signal Shell branches its
// layout on and the one `navPseudoChannelsForNetwork` reads; jsdom has no
// matchMedia, so without this the whole file would silently measure desktop.
vi.mock("../lib/theme", () => ({
  isMobile: () => true,
  prefersDark: () => false,
  applyTheme: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  listArchive: vi.fn(),
  setOn401Handler: vi.fn(),
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
}));

vi.mock("../lib/selection", () => ({
  selectedChannel: () => null,
  setSelectedChannel: vi.fn(),
  isActiveSelection: () => false,
  unreadCounts: () => ({}),
  messagesUnread: () => ({}),
  eventsUnread: () => ({}),
  applySeedEnvelope: vi.fn(),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => ({}),
  setServerMention: vi.fn(),
}));

vi.mock("../lib/scrollToBottomCommand", () => ({
  requestScrollToBottom: vi.fn(),
  scrollToBottomRequest: () => 0,
}));

vi.mock("../lib/windowClose", () => ({
  closeQueryWindow: vi.fn(),
  confirmLeaveChannel: vi.fn(),
  confirmDisconnectNetwork: vi.fn(),
  dismissPseudoWindow: vi.fn(),
}));

vi.mock("../lib/queryWindows", () => ({
  queryWindowsByNetwork: () => ({}),
}));

beforeAll(() =>
  warmGraph(
    () => import("../lib/archive"),
    () => import("../BottomBar"),
  ),
);

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

// The scenario of the report, step by step:
//   1. the session reconnects, the rejoin of a +i channel fails → the
//      window carries scrollback and shows up in Archive;
//   2. `/cs invite` lands, the server auto-JOINs and broadcasts
//      `window_pending` on the user topic → cic stores `pending`;
//   3. the archive filter releases nothing and the bottom bar renders
//      nothing → the window is gone from the UI.
async function mobileSurfacesFor(state: string): Promise<{
  bottomBarTabs: string[];
  archiveTargets: string[];
}> {
  vi.doMock("../lib/networks", () => ({
    networks: () => [{ id: 1, slug: "azzurra", inserted_at: "", updated_at: "" }],
    // No live channel: the JOIN never resolved.
    channelsBySlug: () => ({ azzurra: [] }),
  }));
  vi.doMock("../lib/windowState", () => ({
    windowStateByChannel: () => ({ "azzurra #gated": state }),
  }));

  localStorage.setItem("grappa-token", "tok");
  const api = await import("../lib/api");
  vi.mocked(api.listArchive).mockResolvedValue([
    { target: "#gated", kind: "channel", last_activity: 300, row_count: 42 },
  ]);

  const archive = await import("../lib/archive");
  await archive.loadArchive("azzurra");

  const { default: BottomBar } = await import("../BottomBar");
  const { container } = render(() => <BottomBar />);
  const bottomBarTabs = Array.from(
    container.querySelectorAll<HTMLElement>("[data-window-name]"),
  ).map((el) => el.dataset.windowName ?? "");

  return {
    bottomBarTabs,
    archiveTargets: archive.visibleArchiveForNetwork("azzurra", 1).map((e) => e.target),
  };
}

describe("#402 — mobile surfaces for a non-joined window with scrollback", () => {
  // `pending` is the state the ChanServ self-invite path lands
  // (`{:rejoin_invited, _}` → `record_in_flight_join/2`), i.e. the exact
  // sequence in the report.
  it.each(["pending", "failed", "kicked", "parked"])(
    "keeps a %s window reachable from exactly one mobile surface",
    async (state) => {
      const { bottomBarTabs, archiveTargets } = await mobileSurfacesFor(state);

      const surfaces = [
        bottomBarTabs.includes("#gated") ? "bottom-bar" : null,
        archiveTargets.includes("#gated") ? "archive" : null,
      ].filter((s) => s !== null);

      expect(surfaces).toHaveLength(1);
    },
  );

  // The counter-case that keeps the fix honest: `invited` IS rendered by
  // the bottom bar, so the archive MUST stay suppressed — one surface,
  // not two.
  it("keeps an invited window on the bottom bar and out of the archive", async () => {
    const { bottomBarTabs, archiveTargets } = await mobileSurfacesFor("invited");

    expect(bottomBarTabs).toContain("#gated");
    expect(archiveTargets).not.toContain("#gated");
  });
});
