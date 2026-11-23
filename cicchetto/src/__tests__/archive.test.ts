import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ArchiveEntry } from "../lib/api";
import { warmGraph } from "./helpers/warmGraph";

vi.mock("../lib/api", () => ({
  listArchive: vi.fn(),
  setOn401Handler: vi.fn(),
  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2):
  // selection.ts now imports isContentKind from api.ts for the badge
  // memo derivation. Any test importing selection (directly or
  // transitively) needs the classifier in its api mock.
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
}));

// UX-2 (2026-05-17) — `visibleArchiveForNetwork` reads
// `channelsBySlug` + `queryWindowsByNetwork` to derive the live-entries
// filter. Default mocks return empty live sets; per-test overrides
// thread the active windows in via `vi.doMock` + `vi.resetModules`.
vi.mock("../lib/networks", () => ({
  // #1861 — casemappingForSlug (lib/casemapping.ts) resolves the fold
  // through this map, so the mock has to carry it.
  networkIdBySlug: () => undefined,
  channelsBySlug: () => ({}),
  // issue 1985 — `navDrawsNetwork` resolves the network here to ask whether
  // it is parked. Unresolved is not parked, so the default keeps every case
  // below on the pre-1985 subtraction; the parked case mocks it explicitly.
  networkBySlug: () => undefined,
}));

vi.mock("../lib/queryWindows", () => ({
  queryWindowsByNetwork: () => ({}),
}));

vi.mock("../lib/windowState", () => ({
  windowStateByChannel: () => ({}),
}));

// #781 — see helpers/warmGraph.ts. `lib/api` is NOT warmed: the factory at
// the top of this file fully replaces it, so the real module never loads.
beforeAll(() => warmGraph(() => import("../lib/archive")));

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
      { target: "vjt-peer", kind: "query", last_activity: 300 },
      { target: "#sniffo", kind: "channel", last_activity: 200 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    expect(archive.archivedBySlug().freenode).toEqual([
      { target: "vjt-peer", kind: "query", last_activity: 300 },
      { target: "#sniffo", kind: "channel", last_activity: 200 },
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
      .mockResolvedValueOnce([{ target: "#a", kind: "channel", last_activity: 100 }])
      .mockResolvedValueOnce([{ target: "#b", kind: "channel", last_activity: 200 }]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");
    await archive.loadArchive("libera");

    expect(archive.archivedBySlug().freenode).toEqual([
      { target: "#a", kind: "channel", last_activity: 100 },
    ]);
    expect(archive.archivedBySlug().libera).toEqual([
      { target: "#b", kind: "channel", last_activity: 200 },
    ]);
  });

  it("re-load on the same slug overwrites the previous entries (lazy refresh)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive)
      .mockResolvedValueOnce([{ target: "#a", kind: "channel", last_activity: 100 }])
      .mockResolvedValueOnce([{ target: "#a", kind: "channel", last_activity: 999 }]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");
    await archive.loadArchive("freenode");

    expect(archive.archivedBySlug().freenode).toEqual([
      { target: "#a", kind: "channel", last_activity: 999 },
    ]);
  });

  it("drops a stale response that resolves AFTER a newer load (out-of-order guard)", async () => {
    // Regression: two loadArchive(slug) calls overlap — the first (stale,
    // pre-PART state) resolves LAST, the second (fresh, post-PART state)
    // resolves FIRST. Without ordering the stale response overwrites the
    // fresh one, erasing a just-archived window from an open modal (the
    // cp15-b6 re-PART-while-open race). The last-STARTED load must win.
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");

    let resolveStale!: (v: ArchiveEntry[]) => void;
    let resolveFresh!: (v: ArchiveEntry[]) => void;
    const stalePromise = new Promise<ArchiveEntry[]>((r) => {
      resolveStale = r;
    });
    const freshPromise = new Promise<ArchiveEntry[]>((r) => {
      resolveFresh = r;
    });
    vi.mocked(api.listArchive)
      .mockReturnValueOnce(stalePromise) // call #1 — started first
      .mockReturnValueOnce(freshPromise); // call #2 — started last, authoritative

    const archive = await import("../lib/archive");
    const stale = archive.loadArchive("freenode"); // seq 1
    const fresh = archive.loadArchive("freenode"); // seq 2

    // Fresh (call #2) resolves first → store reflects the post-PART set.
    resolveFresh([{ target: "#bofh", kind: "channel", last_activity: 999 }]);
    await fresh;
    expect(archive.archivedBySlug().freenode).toEqual([
      { target: "#bofh", kind: "channel", last_activity: 999 },
    ]);

    // Stale (call #1) resolves LAST → its result is dropped, store unchanged.
    resolveStale([{ target: "#old", kind: "channel", last_activity: 100 }]);
    await stale;
    expect(archive.archivedBySlug().freenode).toEqual([
      { target: "#bofh", kind: "channel", last_activity: 999 },
    ]);
  });
});

describe("archive.clearArchive — identity-scoped cleanup", () => {
  it("wipes all archivedBySlug entries", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "#a", kind: "channel", last_activity: 100 },
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
      { target: "#bofh", kind: "channel", last_activity: 200 },
      { target: "vjt-peer", kind: "query", last_activity: 100 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    expect(archive.visibleArchiveForNetwork("freenode", 1)).toEqual([
      { target: "#bofh", kind: "channel", last_activity: 200 },
      { target: "vjt-peer", kind: "query", last_activity: 100 },
    ]);
  });

  it("filters out archive channels currently in channelsBySlug for the slug", async () => {
    vi.doMock("../lib/networks", () => ({
      // issue 1985 — a network the store cannot resolve is not parked, so
      // `navDrawsNetwork` says the nav draws it and the subtraction below is
      // the pre-1985 one. These cases are all about that subtraction.
      networkBySlug: () => undefined,
      channelsBySlug: () => ({
        freenode: [{ name: "#sniffo", joined: true, source: "joined" }],
      }),
    }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({}),
    }));
    vi.doMock("../lib/windowState", () => ({
      windowStateByChannel: () => ({}),
    }));
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "#sniffo", kind: "channel", last_activity: 200 },
      { target: "#bofh", kind: "channel", last_activity: 100 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    expect(archive.visibleArchiveForNetwork("freenode", 1)).toEqual([
      { target: "#bofh", kind: "channel", last_activity: 100 },
    ]);
  });

  it("filters out archive queries currently in queryWindowsByNetwork for the network", async () => {
    vi.doMock("../lib/networks", () => ({
      // issue 1985 — a network the store cannot resolve is not parked, so
      // `navDrawsNetwork` says the nav draws it and the subtraction below is
      // the pre-1985 one. These cases are all about that subtraction.
      networkBySlug: () => undefined,
      channelsBySlug: () => ({ freenode: [] }),
    }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({
        1: [{ targetNick: "vjt-peer", openedAt: "2026-05-04T10:00:00Z" }],
      }),
    }));
    vi.doMock("../lib/windowState", () => ({
      windowStateByChannel: () => ({}),
    }));
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "vjt-peer", kind: "query", last_activity: 200 },
      { target: "alice-peer", kind: "query", last_activity: 100 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    expect(archive.visibleArchiveForNetwork("freenode", 1)).toEqual([
      { target: "alice-peer", kind: "query", last_activity: 100 },
    ]);
  });

  // #372 — an open query window suppresses its differently-cased
  // archived variant. A service replied as `DebugServ` (archived under
  // that casing) while the user's open window is `debugserv`; a raw
  // Set.has left the archived split visible. The filter folds both sides
  // under ASCII casemapping (`normalizeNick`, A-Z only) so the active window releases it.
  it("filters out an archived query whose casing folds to an active window (#372)", async () => {
    vi.doMock("../lib/networks", () => ({
      // issue 1985 — a network the store cannot resolve is not parked, so
      // `navDrawsNetwork` says the nav draws it and the subtraction below is
      // the pre-1985 one. These cases are all about that subtraction.
      networkBySlug: () => undefined,
      channelsBySlug: () => ({ freenode: [] }),
    }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({
        1: [{ targetNick: "debugserv", openedAt: "2026-07-23T10:00:00Z" }],
      }),
    }));
    vi.doMock("../lib/windowState", () => ({
      windowStateByChannel: () => ({}),
    }));
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "DebugServ", kind: "query", last_activity: 200 },
      { target: "alice-peer", kind: "query", last_activity: 100 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    // `DebugServ` folds to the active `debugserv` → suppressed; the
    // unrelated peer survives.
    expect(archive.visibleArchiveForNetwork("freenode", 1)).toEqual([
      { target: "alice-peer", kind: "query", last_activity: 100 },
    ]);
  });

  // UX-5 bucket BK (2026-05-19) — pseudo-row dedup: any (slug, name) in
  // windowStateByChannel renders as a Sidebar pseudo-row (pending /
  // failed / kicked / parked); the matching archive entry MUST be
  // suppressed so the same window doesn't appear in both surfaces.
  // Operator clicks × on the pseudo-row → setParted drops the
  // windowState key → this filter releases → archive shows the row.
  it("filters out archive entries whose target is in windowStateByChannel for the slug", async () => {
    vi.doMock("../lib/networks", () => ({
      // issue 1985 — a network the store cannot resolve is not parked, so
      // `navDrawsNetwork` says the nav draws it and the subtraction below is
      // the pre-1985 one. These cases are all about that subtraction.
      networkBySlug: () => undefined,
      channelsBySlug: () => ({ freenode: [] }),
    }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({}),
    }));
    vi.doMock("../lib/windowState", () => ({
      windowStateByChannel: () => ({
        "freenode #it-opers": "failed",
        "freenode #kicked-from": "kicked",
      }),
    }));
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "#it-opers", kind: "channel", last_activity: 300 },
      { target: "#kicked-from", kind: "channel", last_activity: 200 },
      { target: "#old-chan", kind: "channel", last_activity: 100 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    expect(archive.visibleArchiveForNetwork("freenode", 1)).toEqual([
      { target: "#old-chan", kind: "channel", last_activity: 100 },
    ]);
  });

  // cp15-b6 (#473) — a STALE `:joined` windowState must NOT hide an
  // archived channel. On a re-PART the user-topic `channels_changed`
  // (drops the channel from channelsBySlug) and the per-channel PART
  // message (fires setParted, clearing windowState) have NO cross-topic
  // ordering guarantee at the WS edge: channels_changed can land first,
  // leaving windowState[ch]="joined" (stale) while channelsBySlug has
  // already dropped it. `:joined` is a LIVE-ROW state — covered by the
  // channelsBySlug filter, NOT a pseudo-row — so `pseudoChannelsForNetwork`
  // excludes it (its documented ghost-row guard). This filter MUST mirror
  // that exclusion; otherwise a just-archived, genuinely-parted channel
  // is wrongly suppressed from an OPEN ArchiveModal — the intermittent
  // cp15-b6 re-PART-while-open flake (server returns the row, the modal
  // renders 0 for the whole assert window).
  it("does NOT hide an archived channel whose windowState is a stale :joined (re-PART transient)", async () => {
    vi.doMock("../lib/networks", () => ({
      // issue 1985 — a network the store cannot resolve is not parked, so
      // `navDrawsNetwork` says the nav draws it and the subtraction below is
      // the pre-1985 one. These cases are all about that subtraction.
      networkBySlug: () => undefined,
      // channels_changed already dropped #bofh from the live set.
      channelsBySlug: () => ({ freenode: [] }),
    }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({}),
    }));
    vi.doMock("../lib/windowState", () => ({
      // setParted has NOT yet fired for the re-PART — the stale
      // per-channel `:joined` lingers in the map.
      windowStateByChannel: () => ({ "freenode #bofh": "joined" }),
    }));
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "#bofh", kind: "channel", last_activity: 200 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    // The server placed #bofh in the archive (it IS parted) and it is not
    // in channelsBySlug — the stale `:joined` must NOT suppress it.
    expect(archive.visibleArchiveForNetwork("freenode", 1)).toEqual([
      { target: "#bofh", kind: "channel", last_activity: 200 },
    ]);
  });

  // BK regression: windowStateByChannel keys for OTHER networks must NOT
  // affect this network's archive view. The pseudoNames Set is scoped
  // by slug via decodeChannelKey.
  it("does NOT filter when the windowStateByChannel key belongs to a different slug", async () => {
    vi.doMock("../lib/networks", () => ({
      // issue 1985 — a network the store cannot resolve is not parked, so
      // `navDrawsNetwork` says the nav draws it and the subtraction below is
      // the pre-1985 one. These cases are all about that subtraction.
      networkBySlug: () => undefined,
      channelsBySlug: () => ({ freenode: [] }),
    }));
    vi.doMock("../lib/queryWindows", () => ({
      queryWindowsByNetwork: () => ({}),
    }));
    vi.doMock("../lib/windowState", () => ({
      windowStateByChannel: () => ({ "libera #it-opers": "failed" }),
    }));
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "#it-opers", kind: "channel", last_activity: 100 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    expect(archive.visibleArchiveForNetwork("freenode", 1)).toEqual([
      { target: "#it-opers", kind: "channel", last_activity: 100 },
    ]);
  });

  it("returns empty array when the slug has never been loaded", async () => {
    const archive = await import("../lib/archive");
    expect(archive.visibleArchiveForNetwork("unloaded", 99)).toEqual([]);
  });

  // issue 1985 — a PARKED network draws no sidebar row of ANY kind (the ONE
  // `<For>` in `Sidebar.tsx` drops the whole network), so this filter must
  // subtract nothing for it: the archive is the only surface its windows have
  // left, and that is what vjt's ruling ("the history is reachable from the
  // archive") rests on.
  //
  // The channel leg is NOT hypothetical and it is not the pseudo-row leg.
  // `GET /networks/:slug/channels` returns the union of the credential's
  // AUTOJOIN list and the live session's channels (`ChannelsController.index`
  // → `Networks.merge_channel_sources/2`); a parked network has no session, so
  // the union is exactly the autojoin list, with `joined: false`. That list
  // lands in `channelsBySlug` and this filter subtracts it. Before the sidebar
  // filter those rows were drawn (greyed) — after it, subtracting them leaves
  // one window and ZERO surfaces.
  it("subtracts NOTHING for a parked network — its autojoin channels keep their archive row", async () => {
    vi.doMock("../lib/networks", () => ({
      networkIdBySlug: () => undefined,
      // What the REST channel list returns for a parked network: the autojoin
      // set, never joined because there is no session to join it.
      channelsBySlug: () => ({ freenode: [{ name: "#autojoin", joined: false }] }),
      networkBySlug: (slug: string) =>
        slug === "freenode" ? { kind: "user", id: 1, slug, connection_state: "parked" } : undefined,
    }));
    vi.doMock("../lib/queryWindows", () => ({ queryWindowsByNetwork: () => ({}) }));
    vi.doMock("../lib/windowState", () => ({
      windowStateByChannel: () => ({ "freenode #kicked-from": "kicked" }),
    }));
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "#autojoin", kind: "channel", last_activity: 300 },
      { target: "#kicked-from", kind: "channel", last_activity: 200 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    expect(archive.visibleArchiveForNetwork("freenode", 1)).toEqual([
      { target: "#autojoin", kind: "channel", last_activity: 300 },
      { target: "#kicked-from", kind: "channel", last_activity: 200 },
    ]);
  });

  // The control that keeps the release narrow: a FAILED network keeps its
  // greyed sidebar row, so its live rows are still drawn and must still be
  // subtracted. If this one ever turns, the parked release has been widened
  // into "any non-connected state" — the generalisation networkParked.ts
  // exists to refuse.
  it("still subtracts a FAILED network's live channels (its greyed row is drawn)", async () => {
    vi.doMock("../lib/networks", () => ({
      networkIdBySlug: () => undefined,
      channelsBySlug: () => ({ freenode: [{ name: "#autojoin", joined: false }] }),
      networkBySlug: (slug: string) =>
        slug === "freenode" ? { kind: "user", id: 1, slug, connection_state: "failed" } : undefined,
    }));
    vi.doMock("../lib/queryWindows", () => ({ queryWindowsByNetwork: () => ({}) }));
    vi.doMock("../lib/windowState", () => ({ windowStateByChannel: () => ({}) }));
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listArchive).mockResolvedValue([
      { target: "#autojoin", kind: "channel", last_activity: 300 },
      { target: "#old-chan", kind: "channel", last_activity: 100 },
    ]);

    const archive = await import("../lib/archive");
    await archive.loadArchive("freenode");

    expect(archive.visibleArchiveForNetwork("freenode", 1)).toEqual([
      { target: "#old-chan", kind: "channel", last_activity: 100 },
    ]);
  });
});

// #473 — archiveModalOpen is a boolean open/closed flag (superseding the
// per-network slug signal `archiveModalNetwork`). The grouped ArchiveModal
// now renders ALL networks as collapsible groups on both form factors, so
// the modal no longer tracks a single network — only whether it is
// visible. Lives inside identityScopedStore so token rotation closes it.
describe("archive.archiveModalOpen signal", () => {
  it("defaults to false (modal closed at boot)", async () => {
    const archive = await import("../lib/archive");
    expect(archive.archiveModalOpen()).toBe(false);
  });

  it("setArchiveModalOpen(true) opens the modal", async () => {
    const archive = await import("../lib/archive");
    archive.setArchiveModalOpen(true);
    expect(archive.archiveModalOpen()).toBe(true);
  });

  it("setArchiveModalOpen(false) closes", async () => {
    const archive = await import("../lib/archive");
    archive.setArchiveModalOpen(true);
    archive.setArchiveModalOpen(false);
    expect(archive.archiveModalOpen()).toBe(false);
  });

  it("clearArchive() ALSO closes the modal (identity rotation safety)", async () => {
    const archive = await import("../lib/archive");
    archive.setArchiveModalOpen(true);
    expect(archive.archiveModalOpen()).toBe(true);
    archive.clearArchive();
    expect(archive.archiveModalOpen()).toBe(false);
  });
});
