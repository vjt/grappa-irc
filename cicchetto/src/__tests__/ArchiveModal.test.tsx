import { fireEvent, render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

// #473 — the ONE grouped archive modal (both form factors).
//
// Driven by the boolean `archiveModalOpen()` signal (was the per-network
// slug `archiveModalNetwork`). When open it renders EVERY network as a
// collapsible `<details>` group; each group's rows come from
// `visibleArchiveForNetwork(slug, id)` and are loaded LAZILY on the
// group's first expand (the `<details onToggle>` fires `loadArchive`).
//
// Tests cover: closed-state (renders nothing), open (plain "Archive"
// header + one group per network, collapsed), lazy-load-on-expand (NOT
// eager on open), rows per group, empty-group banner, tap entry (selects
// from its group's slug + closes), tap delete twice (arms + calls
// deleteArchiveEntry), tap close × / backdrop (closes via
// setArchiveModalOpen(false)).

vi.mock("../lib/selection", () => ({
  setSelectedChannel: vi.fn(),
  applySeedEnvelope: vi.fn(),
  // #532 B — the archive row reads the same server unread seed the sidebar does.
  messagesUnread: () => mockMessagesUnread(),
  eventsUnread: () => mockEventsUnread(),
}));

vi.mock("../lib/mentions", () => ({
  mentionCounts: () => mockMentionCounts(),
}));

vi.mock("../lib/networks", () => ({
  networks: () => [
    { id: 1, slug: "freenode", inserted_at: "", updated_at: "" },
    { id: 2, slug: "libera", inserted_at: "", updated_at: "" },
  ],
}));

// #804 — `canonicalQueryNick` is NOT a stub here: an identity stub would
// pass whatever the component hands it straight back and blind the test
// to the casing it actually resolves. It mirrors the real resolver
// (lib/queryWindows.ts) over `mockOpenQueryNicks()`, folding with the
// production `nickEquals`.
vi.mock("../lib/queryWindows", async () => {
  const { nickEquals } = await import("../lib/nickEquals");
  return {
    openQueryWindowState: vi.fn(),
    canonicalQueryNick: (_networkId: number, nick: string) =>
      mockOpenQueryNicks().find((open) => nickEquals(open, nick)) ?? nick,
  };
});

vi.mock("../lib/api", () => ({
  deleteArchiveEntry: vi.fn().mockResolvedValue(undefined),
  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2):
  // selection.ts now imports isContentKind from api.ts for the badge
  // memo derivation. Any test importing selection (directly or
  // transitively) needs the classifier in its api mock.
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
}));

vi.mock("../lib/auth", () => ({
  token: () => "test-token",
}));

const {
  mockOpen,
  mockEntries,
  mockArchivedBySlug,
  setArchiveModalOpen,
  loadArchive,
  mockMessagesUnread,
  mockEventsUnread,
  mockMentionCounts,
  mockOpenQueryNicks,
} = vi.hoisted(() => ({
  mockOpen: vi.fn<() => boolean>(() => false),
  mockEntries: vi.fn<
    (
      slug: string,
      id: number,
    ) => Array<{
      target: string;
      kind: "channel" | "query";
      last_activity: number;
      row_count: number;
    }>
  >(() => []),
  mockArchivedBySlug: vi.fn<() => Record<string, unknown[]>>(() => ({})),
  setArchiveModalOpen: vi.fn(),
  loadArchive: vi.fn<(slug: string) => Promise<void>>().mockResolvedValue(undefined),
  mockMessagesUnread: vi.fn<() => Record<string, number>>(() => ({})),
  mockEventsUnread: vi.fn<() => Record<string, number>>(() => ({})),
  mockMentionCounts: vi.fn<() => Record<string, number>>(() => ({})),
  mockOpenQueryNicks: vi.fn<() => string[]>(() => []),
}));

vi.mock("../lib/archive", () => ({
  archiveModalOpen: () => mockOpen(),
  archivedBySlug: () => mockArchivedBySlug(),
  setArchiveModalOpen,
  loadArchive,
  visibleArchiveForNetwork: (slug: string, id: number) => mockEntries(slug, id),
}));

import ArchiveModal from "../ArchiveModal";
import * as apiMod from "../lib/api";
import * as qwMod from "../lib/queryWindows";
import * as selMod from "../lib/selection";

beforeEach(() => {
  vi.clearAllMocks();
  mockOpen.mockReturnValue(false);
  mockEntries.mockReturnValue([]);
  mockArchivedBySlug.mockReturnValue({});
  mockMessagesUnread.mockReturnValue({});
  mockEventsUnread.mockReturnValue({});
  mockMentionCounts.mockReturnValue({});
  mockOpenQueryNicks.mockReturnValue([]);
});

describe("ArchiveModal (#473 grouped)", () => {
  it("renders nothing when archiveModalOpen() is false", () => {
    const { container } = render(() => <ArchiveModal />);
    expect(container.querySelector(".archive-modal-backdrop")).toBeNull();
  });

  it("renders the dialog with a plain 'Archive' header when open", () => {
    mockOpen.mockReturnValue(true);
    render(() => <ArchiveModal />);
    expect(screen.getByText("Archive")).toBeInTheDocument();
  });

  it("renders one collapsible group per network, collapsed by default", () => {
    mockOpen.mockReturnValue(true);
    const { container } = render(() => <ArchiveModal />);
    const groups = container.querySelectorAll("details.archive-modal-group");
    expect(groups.length).toBe(2);
    expect(screen.getByTestId("archive-modal-group-freenode")).toBeInTheDocument();
    expect(screen.getByTestId("archive-modal-group-libera")).toBeInTheDocument();
    for (const g of groups) expect((g as HTMLDetailsElement).open).toBe(false);
  });

  it("shows each network's slug as its group summary", () => {
    mockOpen.mockReturnValue(true);
    render(() => <ArchiveModal />);
    expect(screen.getByText("freenode")).toBeInTheDocument();
    expect(screen.getByText("libera")).toBeInTheDocument();
  });

  it("does NOT eagerly load any network on open (lazy contract, trap #2)", () => {
    mockOpen.mockReturnValue(true);
    render(() => <ArchiveModal />);
    expect(loadArchive).not.toHaveBeenCalled();
  });

  it("expanding a group calls loadArchive(slug) for THAT network only (lazy per group)", () => {
    mockOpen.mockReturnValue(true);
    render(() => <ArchiveModal />);
    const group = screen.getByTestId("archive-modal-group-freenode") as HTMLDetailsElement;
    group.open = true;
    group.dispatchEvent(new Event("toggle"));
    expect(loadArchive).toHaveBeenCalledWith("freenode");
    expect(loadArchive).not.toHaveBeenCalledWith("libera");
  });

  it("renders one row per visible entry within its network group", () => {
    mockOpen.mockReturnValue(true);
    mockEntries.mockImplementation((slug) =>
      slug === "freenode"
        ? [
            { target: "vjt-peer", kind: "query", last_activity: 100, row_count: 4 },
            { target: "#bofh", kind: "channel", last_activity: 200, row_count: 8 },
          ]
        : [],
    );
    render(() => <ArchiveModal />);
    const freenodeGroup = screen.getByTestId("archive-modal-group-freenode");
    expect(freenodeGroup.querySelectorAll(".archive-modal-row").length).toBe(2);
    expect(screen.getByText("vjt-peer")).toBeInTheDocument();
    expect(screen.getByText("#bofh")).toBeInTheDocument();
  });

  it("shows an empty banner in each LOADED group with no visible entries", () => {
    mockOpen.mockReturnValue(true);
    mockEntries.mockReturnValue([]);
    // both groups fetched (present in archivedBySlug) but genuinely empty
    mockArchivedBySlug.mockReturnValue({ freenode: [], libera: [] });
    render(() => <ArchiveModal />);
    // one per network group (both empty in this fixture)
    expect(screen.getAllByText("no archived windows").length).toBe(2);
  });

  it("does NOT show the empty banner for a group not yet loaded (no false-empty flash)", () => {
    mockOpen.mockReturnValue(true);
    mockEntries.mockReturnValue([]);
    // nothing fetched yet — archivedBySlug has no keys, so a group about to
    // lazy-load renders no banner (the retired Sidebar rendered an empty list
    // during load, not the misleading "no archived windows").
    mockArchivedBySlug.mockReturnValue({});
    render(() => <ArchiveModal />);
    expect(screen.queryByText("no archived windows")).toBeNull();
  });

  it("clicking the × close button calls setArchiveModalOpen(false)", () => {
    mockOpen.mockReturnValue(true);
    render(() => <ArchiveModal />);
    fireEvent.click(screen.getByLabelText("close archive"));
    expect(setArchiveModalOpen).toHaveBeenCalledWith(false);
  });

  it("clicking the backdrop calls setArchiveModalOpen(false)", () => {
    mockOpen.mockReturnValue(true);
    const { container } = render(() => <ArchiveModal />);
    const backdrop = container.querySelector(".archive-modal-backdrop") as HTMLElement;
    fireEvent.click(backdrop);
    expect(setArchiveModalOpen).toHaveBeenCalledWith(false);
  });

  it("clicking the dialog itself does NOT close (stopPropagation)", () => {
    mockOpen.mockReturnValue(true);
    const { container } = render(() => <ArchiveModal />);
    const dialog = container.querySelector(".archive-modal") as HTMLElement;
    fireEvent.click(dialog);
    expect(setArchiveModalOpen).not.toHaveBeenCalled();
  });

  it("clicking a channel entry selects it (from its group's slug) + closes", () => {
    mockOpen.mockReturnValue(true);
    mockEntries.mockImplementation((slug) =>
      slug === "freenode"
        ? [{ target: "#bofh", kind: "channel", last_activity: 200, row_count: 8 }]
        : [],
    );
    render(() => <ArchiveModal />);
    fireEvent.click(screen.getByText("#bofh"));
    expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#bofh",
      kind: "channel",
    });
    expect(setArchiveModalOpen).toHaveBeenCalledWith(false);
  });

  it("clicking a query entry selects it (from its group's slug) + closes", () => {
    mockOpen.mockReturnValue(true);
    mockEntries.mockImplementation((slug) =>
      slug === "libera"
        ? [{ target: "vjt-peer", kind: "query", last_activity: 100, row_count: 4 }]
        : [],
    );
    render(() => <ArchiveModal />);
    fireEvent.click(screen.getByText("vjt-peer"));
    expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "libera",
      channelName: "vjt-peer",
      kind: "query",
    });
    // UX-3 Z — a re-opened archived DM MUST also re-subscribe to its
    // per-channel topic, else server NOTICEs (e.g. 401) drop on the floor.
    expect(qwMod.openQueryWindowState).toHaveBeenCalledWith(2, "vjt-peer", expect.any(String));
    expect(setArchiveModalOpen).toHaveBeenCalledWith(false);
  });

  it("resolves a query entry's casing to the open window's, for BOTH legs (#804)", () => {
    mockOpen.mockReturnValue(true);
    // `dm_with` is stored RAW (#121/#372) and `list_archive` groups on the
    // fold but selects one arbitrary row's spelling, so the archive row's
    // casing need not match the window the peer is already open under.
    mockOpenQueryNicks.mockReturnValue(["VJT-Peer"]);
    mockEntries.mockImplementation((slug) =>
      slug === "libera"
        ? [{ target: "vjt-peer", kind: "query", last_activity: 100, row_count: 4 }]
        : [],
    );
    render(() => <ArchiveModal />);
    fireEvent.click(screen.getByText("vjt-peer"));
    // Selection must land on the EXISTING row's key, not fork a phantom
    // pane under the archive spelling (#731 / #799 shape).
    expect(selMod.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "libera",
      channelName: "VJT-Peer",
      kind: "query",
    });
    expect(qwMod.openQueryWindowState).toHaveBeenCalledWith(2, "VJT-Peer", expect.any(String));
  });

  it("renders the unread msg badge for an archived DM holding unread (#532 B)", () => {
    mockOpen.mockReturnValue(true);
    mockEntries.mockImplementation((slug) =>
      slug === "libera"
        ? [{ target: "DebugServ", kind: "query", last_activity: 100, row_count: 4 }]
        : [],
    );
    // Seed is keyed by the server's CANONICAL nick (DM keys fold, #532 D);
    // the row must fold the DISPLAY-cased "DebugServ" to hit "libera debugserv".
    mockMessagesUnread.mockReturnValue({ "libera debugserv": 3 });

    render(() => <ArchiveModal />);

    const badge = screen.getByTestId("archive-unread-libera-DebugServ");
    expect(badge.textContent).toContain("3");
  });

  it("renders the event badge for an archived channel holding unread (#532 B)", () => {
    mockOpen.mockReturnValue(true);
    mockEntries.mockImplementation((slug) =>
      slug === "freenode"
        ? [{ target: "#bofh", kind: "channel", last_activity: 200, row_count: 8 }]
        : [],
    );
    mockEventsUnread.mockReturnValue({ "freenode #bofh": 2 });

    render(() => <ArchiveModal />);

    const badge = screen.getByTestId("archive-unread-freenode-#bofh");
    expect(badge.textContent).toContain("2");
  });

  it("renders NO unread cluster for an archived window read to the tail (#532 B)", () => {
    mockOpen.mockReturnValue(true);
    mockEntries.mockImplementation((slug) =>
      slug === "libera"
        ? [{ target: "quietpeer", kind: "query", last_activity: 100, row_count: 4 }]
        : [],
    );
    // No seed entry for this window → nothing pending.
    render(() => <ArchiveModal />);

    expect(screen.queryByTestId("archive-unread-libera-quietpeer")).toBeNull();
  });

  it("first click on × delete arms; second calls deleteArchiveEntry with token + slug + target", async () => {
    mockOpen.mockReturnValue(true);
    mockEntries.mockImplementation((slug) =>
      slug === "freenode"
        ? [{ target: "vjt-peer", kind: "query", last_activity: 100, row_count: 4 }]
        : [],
    );
    render(() => <ArchiveModal />);
    const deleteBtn = screen.getByTestId("archive-modal-delete-freenode-vjt-peer");
    expect(deleteBtn.textContent).toBe("×");
    fireEvent.click(deleteBtn);
    expect(deleteBtn.textContent).toBe("really delete?");
    expect(apiMod.deleteArchiveEntry).not.toHaveBeenCalled();
    fireEvent.click(deleteBtn);
    await new Promise((r) => setTimeout(r, 0));
    expect(apiMod.deleteArchiveEntry).toHaveBeenCalledWith("test-token", "freenode", "vjt-peer");
  });
});
