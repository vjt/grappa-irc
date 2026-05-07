import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", () => ({
  listArchive: vi.fn(),
  setOn401Handler: vi.fn(),
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
