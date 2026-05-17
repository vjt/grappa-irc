import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  listArchive: vi.fn(),
  setOn401Handler: vi.fn(),
}));

// UX-2 (2026-05-17) — `visibleArchiveForNetwork` reads
// `channelsBySlug` + `queryWindowsByNetwork` to derive the live-entries
// filter. Default mocks return empty live sets; per-test overrides
// thread the active windows in via `vi.doMock` + `vi.resetModules`.
vi.mock("../lib/networks", () => ({
  channelsBySlug: () => ({}),
}));

vi.mock("../lib/queryWindows", () => ({
  queryWindowsByNetwork: () => ({}),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("archive.loadArchive", () => {
  it("fetches /archive + populates archivedBySlug for the slug", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "vjt-peer", kind: "query", last_activity: 300, row_count: 8 },
      { target: "#sniffo", kind: "channel", last_activity: 200, row_count: 576 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    expect(archive.archivedBySlug().freenode).toEqual([
      { target: "vjt-peer", kind: "query", last_activity: 300, row_count: 8 },
      { target: "#sniffo", kind: "channel", last_activity: 200, row_count: 576 },
    ]);
  });

  it("does NOT call listArchive when token is absent", async () => {
    const api = await import("../lib/api");
    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");
    expect(api.listArchive).not.toHaveBeenCalled();
  });

  it("scopes by slug — separate slug call yields independent entries", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive)
      .mockResolvedValueOnce([{ target: "#a", kind: "channel", last_activity: 100, row_count: 1 }])
      .mockResolvedValueOnce([{ target: "#b", kind: "channel", last_activity: 200, row_count: 2 }]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");
    await archive.loadArchive("libera");

    expect(archive.archivedBySlug().freenode).toEqual([
      { target: "#a", kind: "channel", last_activity: 100, row_count: 1 },
    ]);
    expect(archive.archivedBySlug().libera).toEqual([
      { target: "#b", kind: "channel", last_activity: 200, row_count: 2 },
    ]);
  });

  it("re-load on the same slug overwrites the previous entries (lazy refresh)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive)
      .mockResolvedValueOnce([{ target: "#a", kind: "channel", last_activity: 100, row_count: 1 }])
      .mockResolvedValueOnce([{ target: "#a", kind: "channel", last_activity: 999, row_count: 5 }]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");
    await archive.loadArchive("freenode");

    expect(archive.archivedBySlug().freenode).toEqual([
      { target: "#a", kind: "channel", last_activity: 999, row_count: 5 },
    ]);
  });
});

describe("archive.clearArchive — identity-scoped cleanup", () => {
  it("wipes all archivedBySlug entries", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "#a", kind: "channel", last_activity: 100, row_count: 1 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");
    expect(archive.archivedBySlug().freenode).toHaveLength(1);

    archive.clearArchive();

    expect(archive.archivedBySlug()).toEqual({});
  });
});

// UX-2 (2026-05-17) — visibleArchiveForNetwork is the shared
// live-entries filter (lifted from Sidebar's inline helper). Sidebar
// + BottomBar chip + ArchiveModal all read through it. Server-side
// `Scrollback.list_archive/3` does the same exclusion via
// `active_keyset`, but the client cache survives JOIN echoes — a
// re-JOIN of an archived channel would otherwise duplicate the row
// in both Active + Archive sections (CP15 B5 fix).
describe("archive.visibleArchiveForNetwork", () => {
  it("returns the raw entry list when nothing is currently live", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "#bofh", kind: "channel", last_activity: 200, row_count: 8 },
      { target: "vjt-peer", kind: "query", last_activity: 100, row_count: 4 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    expect(archive.visibleArchiveForNetwork("freenode", 1)).toEqual([
      { target: "#bofh", kind: "channel", last_activity: 200, row_count: 8 },
      { target: "vjt-peer", kind: "query", last_activity: 100, row_count: 4 },
    ]);
  });

  it("filters out archive channels currently in channelsBySlug for the slug", async () => {
    vi.doMock("../lib/networks", () => ({
      channelsBySlug: () => ({
        freenode: [{ name: "#sniffo", joined: true, source: "joined" }],
      }),
    }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({}),
    }));
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "#sniffo", kind: "channel", last_activity: 200, row_count: 576 },
      { target: "#bofh", kind: "channel", last_activity: 100, row_count: 8 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    expect(archive.visibleArchiveForNetwork("freenode", 1)).toEqual([
      { target: "#bofh", kind: "channel", last_activity: 100, row_count: 8 },
    ]);
  });

  it("filters out archive queries currently in queryWindowsByNetwork for the network", async () => {
    vi.doMock("../lib/networks", () => ({
      channelsBySlug: () => ({ freenode: [] }),
    }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({
        1: [{ targetNick: "vjt-peer", openedAt: "2026-05-04T10:00:00Z" }],
      }),
    }));
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "vjt-peer", kind: "query", last_activity: 200, row_count: 8 },
      { target: "alice-peer", kind: "query", last_activity: 100, row_count: 4 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    expect(archive.visibleArchiveForNetwork("freenode", 1)).toEqual([
      { target: "alice-peer", kind: "query", last_activity: 100, row_count: 4 },
    ]);
  });

  it("returns empty array when the slug has never been loaded", async () => {
    const archive = await import("../lib/archive");
    expect(archive.visibleArchiveForNetwork("unloaded", 99)).toEqual([]);
  });
});

// UX-2 — archiveModalNetwork signal opens / closes the mobile modal.
// One slug at a time; `null` = closed. BottomBar's chip writes the
// slug on tap; ArchiveModal's close affordances write `null`.
describe("archive.archiveModalNetwork signal", () => {
  it("defaults to null (modal closed at boot)", async () => {
    const archive = await import("../lib/archive");
    expect(archive.archiveModalNetwork()).toBeNull();
  });

  it("setArchiveModalNetwork(slug) opens for that network", async () => {
    const archive = await import("../lib/archive");
    archive.setArchiveModalNetwork("freenode");
    expect(archive.archiveModalNetwork()).toBe("freenode");
  });

  it("setArchiveModalNetwork(null) closes", async () => {
    const archive = await import("../lib/archive");
    archive.setArchiveModalNetwork("freenode");
    archive.setArchiveModalNetwork(null);
    expect(archive.archiveModalNetwork()).toBeNull();
  });

  it("clearArchive() ALSO closes the modal (identity rotation safety)", async () => {
    const archive = await import("../lib/archive");
    archive.setArchiveModalNetwork("freenode");
    expect(archive.archiveModalNetwork()).toBe("freenode");
    archive.clearArchive();
    expect(archive.archiveModalNetwork()).toBeNull();
  });
});
