import { createEffect, createRoot, on } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// #1288 — the COST of ingesting a catch-up page, and the invariants that cost
// is not allowed to buy.
//
// `refreshScrollback` used to ingest its REST page one `appendToScrollback`
// per row. Each of those is a duplicate SCAN over everything the pane already
// holds, a copy of the whole row array, a copy of the channel map, and its own
// Solid signal write — so a 200-row page ran the pane's reactive graph 200
// times and did O(page x pane) work. A reporter's Firefox Profiler trace put
// 1917 of 2002 cicchetto samples under that verb, ~1 s of saturated main
// thread per burst.
//
// Two oracles here, both DELIBERATELY host-independent — a wall-clock
// threshold in a shared-runner suite goes red on load rather than on a
// regression, so the committed guard measures WORK, not time:
//
//   * reactive passes — an effect on the store signal counts one tick per
//     store write. The honest user-visible unit: each pass is a render the
//     browser pays for. 200 -> 1.
//   * id reads — every row is handed to the store with `id` behind a getter
//     that counts. The dedupe scan reads every loaded row's id once per
//     ARRIVING row in the per-row shape (O(P*N)) and once in total in the
//     batched one (O(P+N)). The number is exact, reproducible and moves with
//     the mutation: restore the loop and it goes back up by two orders of
//     magnitude on a full page.
//
// Both are asserted with DISPLACEMENT — the same measurement at several page
// and pane sizes — because a single before/after pair cannot tell a constant
// factor from a changed complexity class.
//
// The third block asserts what the fix must NOT cost. The issue proposed
// reusing `mergeIntoScrollback` (already batched, in this same module); it is
// NOT the same verb. It deliberately applies no S20 ring cap (a scroll-up
// prepend must not be truncated mid-scroll) and so never invalidates the
// loadMore exhausted latch either. Swapping it in would have removed the ring
// cap from the reconnect path — the very path S20's own comment names — with
// every existing cap test still green, because they all drive
// `appendToScrollback` directly.

vi.mock("../lib/api", () => ({
  listMessages: vi.fn(),
  listMessagesAfter: vi.fn(),
  countMessagesAfter: vi.fn(),
  sendMessage: vi.fn(),
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
}));

const mockGetResumeCursor = vi.fn<(slug: string, chan: string) => number | null>(() => null);
vi.mock("../lib/reconnectBackfill", () => ({
  getResumeCursor: (slug: string, chan: string) => mockGetResumeCursor(slug, chan),
  recordSeen: vi.fn(),
}));

const mockGetReadCursor = vi.fn<(slug: string, chan: string) => number | null>(() => null);
vi.mock("../lib/readCursor", () => ({
  getReadCursor: (slug: string, chan: string) => mockGetReadCursor(slug, chan),
  setReadCursor: vi.fn(),
}));

const SLUG = "freenode";
const CHAN = "#grappa";
const KEY = channelKey(SLUG, CHAN);

// Row whose `id` is a counting getter. Every read the store performs — the
// dedupe scan, the tail comparison, the ring-cap protection scan, a sort — is
// one tick. `counter` is a shared box so a whole page reports into one number.
const countingRow = (id: number, counter: { reads: number }): ScrollbackMessage => {
  const row = {
    network: SLUG,
    channel: CHAN,
    server_time: id * 1000,
    kind: "privmsg" as const,
    sender: "alice",
    body: `line ${id}`,
    meta: {},
  };
  Object.defineProperty(row, "id", {
    get() {
      counter.reads++;
      return id;
    },
    enumerable: true,
  });
  return row as ScrollbackMessage;
};

const plainRow = (id: number): ScrollbackMessage => ({
  id,
  network: SLUG,
  channel: CHAN,
  server_time: id * 1000,
  kind: "privmsg",
  sender: "alice",
  body: `line ${id}`,
  meta: {},
});

// Fill a pane with `n` rows through the LIVE path. The seeded rows count
// their id reads too — they are what the dedupe scan walks, so leaving them
// plain would under-report the quadratic term by half.
const seedPane = (
  scrollback: typeof import("../lib/scrollback"),
  n: number,
  counter: { reads: number },
): void => {
  for (let i = 1; i <= n; i++) scrollback.appendToScrollback(KEY, countingRow(i, counter));
};

// Drive ONE catch-up page of `pageSize` rows through refreshScrollback and
// report both oracles. The counter is zeroed after seeding, so only the
// catch-up page is measured.
const ingestPage = async (
  scrollback: typeof import("../lib/scrollback"),
  api: typeof import("../lib/api"),
  paneSize: number,
  pageSize: number,
  counter: { reads: number },
): Promise<{ reads: number; passes: number }> => {
  const page = Array.from({ length: pageSize }, (_, i) => countingRow(paneSize + 1 + i, counter));
  mockGetResumeCursor.mockReturnValue(paneSize);
  vi.mocked(api.listMessagesAfter).mockResolvedValue(page);

  let passes = 0;
  const dispose = createRoot((d) => {
    // `defer: true` so subscribing does not count as a pass.
    createEffect(on(scrollback.scrollbackByChannel, () => void passes++, { defer: true }));
    return d;
  });
  counter.reads = 0;

  await scrollback.refreshScrollback(SLUG, CHAN);
  await new Promise((r) => queueMicrotask(() => r(undefined)));
  dispose();
  return { reads: counter.reads, passes };
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  localStorage.setItem("grappa-token", "tok");
  mockGetReadCursor.mockReturnValue(null);
  mockGetResumeCursor.mockReturnValue(null);
});

describe("#1288 — a catch-up page costs ONE reactive pass", () => {
  it("runs the pane's reactive graph once per PAGE, at every page size", async () => {
    // Displacement on the page axis: the per-row shape scales this number
    // linearly with the page (1 / 50 / 200); one write per page pins it at 1.
    for (const pageSize of [1, 50, 200]) {
      vi.resetModules();
      const api = await import("../lib/api");
      const scrollback = await import("../lib/scrollback");
      const counter = { reads: 0 };
      seedPane(scrollback, 100, counter);
      const { passes } = await ingestPage(scrollback, api, 100, pageSize, counter);
      expect({ pageSize, passes }).toEqual({ pageSize, passes: 1 });
    }
  });

  it("writes nothing at all when every row of the page is already loaded", async () => {
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    seedPane(scrollback, 50, { reads: 0 });
    // The page repeats rows 41..50, all of which the pane already holds: a
    // wholly-duplicate page must not re-render the pane.
    const page = Array.from({ length: 10 }, (_, i) => plainRow(41 + i));
    mockGetResumeCursor.mockReturnValue(40);
    vi.mocked(api.listMessagesAfter).mockResolvedValue(page);

    let passes = 0;
    const dispose = createRoot((d) => {
      createEffect(on(scrollback.scrollbackByChannel, () => void passes++, { defer: true }));
      return d;
    });
    await scrollback.refreshScrollback(SLUG, CHAN);
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    dispose();

    expect(passes).toBe(0);
    expect((scrollback.scrollbackByChannel()[KEY] ?? []).length).toBe(50);
  });
});

// The PAGE axis is the discriminating one, and it is the only one asserted
// here. A displacement on the PANE axis was written first and DELETED: both
// shapes are linear in the pane (the loop scans it P times, the batch indexes
// it once), so quadrupling the pane moves both numbers and the ratios sit
// 2.86 vs 2.67 — measured, not reasoned. Worse, the S20 ring cap pins the pane
// at 1000, so a "4x pane" is not one. It passed against the unfixed code, which
// is the definition of an assertion that is scenery rather than coverage.
describe("#1288 — ingest work is O(page + pane), not O(page x pane)", () => {
  it("reads each loaded row's id a bounded number of times per page", async () => {
    const paneSize = 500;
    const pageSize = 200;
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    const counter = { reads: 0 };
    seedPane(scrollback, paneSize, counter);
    const { reads } = await ingestPage(scrollback, api, paneSize, pageSize, counter);
    // Linear: one index build over the pane plus a constant number of reads
    // per arriving row. The per-row loop reads ~paneSize ids for EVERY row of
    // the page (~240_000 here, measured); the bound below is ~85x under that,
    // so it cannot be met by a constant-factor tweak of the quadratic shape.
    expect(reads).toBeLessThan(4 * (paneSize + pageSize));
  });

  it("scales linearly in the page (displacement on the page axis)", async () => {
    const measure = async (pageSize: number): Promise<number> => {
      vi.resetModules();
      const api = await import("../lib/api");
      const scrollback = await import("../lib/scrollback");
      const counter = { reads: 0 };
      seedPane(scrollback, 500, counter);
      const { reads } = await ingestPage(scrollback, api, 500, pageSize, counter);
      return reads;
    };
    // Quadrupling the page against a fixed pane multiplies the per-row scan by
    // 4 in the quadratic shape (measured: 5.09x, super-linear because each
    // ingested row joins the pane the next row must scan). Batched, the pane
    // index is built once and only the per-row constant grows, so the ratio
    // stays near 1.
    const small = await measure(50);
    const large = await measure(200);
    expect(large / small).toBeLessThan(2);
  });
});

describe("#1288 — the batched ingest keeps every per-row invariant", () => {
  it("applies the S20 ring cap to a catch-up page (mergeIntoScrollback would not)", async () => {
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    const cap = scrollback.SCROLLBACK_RING_CAP;
    mockGetReadCursor.mockReturnValue(null); // no divider → free eviction
    seedPane(scrollback, cap, { reads: 0 });
    expect((scrollback.scrollbackByChannel()[KEY] ?? []).length).toBe(cap);

    const page = Array.from({ length: 200 }, (_, i) => plainRow(cap + 1 + i));
    mockGetResumeCursor.mockReturnValue(cap);
    vi.mocked(api.listMessagesAfter).mockResolvedValue(page);
    // A full page also triggers the #693 gap probe; answer "nothing more" so
    // the ingest is the only thing under test.
    vi.mocked(api.countMessagesAfter).mockResolvedValue(0);
    await scrollback.refreshScrollback(SLUG, CHAN);

    const rows = scrollback.scrollbackByChannel()[KEY] ?? [];
    expect(rows.length).toBe(cap);
    expect(rows[0]?.id).toBe(201);
    expect(rows[rows.length - 1]?.id).toBe(cap + 200);
  });

  it("never evicts a row at/after the read cursor when ingesting a page", async () => {
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    const cap = scrollback.SCROLLBACK_RING_CAP;
    const cursor = 5;
    mockGetReadCursor.mockReturnValue(cursor);
    seedPane(scrollback, cap, { reads: 0 });

    const page = Array.from({ length: 200 }, (_, i) => plainRow(cap + 1 + i));
    mockGetResumeCursor.mockReturnValue(cap);
    vi.mocked(api.listMessagesAfter).mockResolvedValue(page);
    vi.mocked(api.countMessagesAfter).mockResolvedValue(0);
    await scrollback.refreshScrollback(SLUG, CHAN);

    const ids = (scrollback.scrollbackByChannel()[KEY] ?? []).map((m) => m.id);
    // The divider anchor and every unread row survive, above the cap.
    for (let i = cursor; i <= cap + 200; i++) expect(ids).toContain(i);
    // Only the read rows below the cursor were evictable.
    expect(ids).not.toContain(cursor - 1);
  });

  it("resets the loadMore exhausted latch when a page evicts older history", async () => {
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    const cap = scrollback.SCROLLBACK_RING_CAP;
    mockGetReadCursor.mockReturnValue(null);
    seedPane(scrollback, cap, { reads: 0 });

    // Latch loadMore as exhausted, then prove a page-driven eviction clears it.
    vi.mocked(api.listMessages).mockResolvedValueOnce([]);
    await scrollback.loadMore(SLUG, CHAN);
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    await scrollback.loadMore(SLUG, CHAN);
    expect(api.listMessages).toHaveBeenCalledTimes(1);

    const page = Array.from({ length: 200 }, (_, i) => plainRow(cap + 1 + i));
    mockGetResumeCursor.mockReturnValue(cap);
    vi.mocked(api.listMessagesAfter).mockResolvedValue(page);
    vi.mocked(api.countMessagesAfter).mockResolvedValue(0);
    await scrollback.refreshScrollback(SLUG, CHAN);
    expect(scrollback.scrollbackByChannel()[KEY]?.some((m) => m.id === 1)).toBe(false);

    vi.mocked(api.listMessages).mockResolvedValueOnce([]);
    await scrollback.loadMore(SLUG, CHAN);
    expect(api.listMessages).toHaveBeenCalledTimes(2);
  });

  it("re-sorts a page that interleaves with rows already at the tail (#423)", async () => {
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    // A live WS row landed at the tail during the await; the REST gap page
    // sorts BEFORE it. Store order IS display order, so the result must be
    // canonical, not arrival-ordered.
    scrollback.appendToScrollback(KEY, plainRow(9));
    mockGetResumeCursor.mockReturnValue(5);
    vi.mocked(api.listMessagesAfter).mockResolvedValue([plainRow(6), plainRow(7), plainRow(8)]);
    await scrollback.refreshScrollback(SLUG, CHAN);

    expect((scrollback.scrollbackByChannel()[KEY] ?? []).map((m) => m.id)).toEqual([6, 7, 8, 9]);
  });

  it("keeps first-write-wins on a row the pane already holds", async () => {
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    scrollback.appendToScrollback(KEY, { ...plainRow(6), body: "live" });
    mockGetResumeCursor.mockReturnValue(5);
    vi.mocked(api.listMessagesAfter).mockResolvedValue([
      { ...plainRow(6), body: "fetched-dupe" },
      { ...plainRow(7), body: "fresh" },
    ]);
    await scrollback.refreshScrollback(SLUG, CHAN);

    const rows = scrollback.scrollbackByChannel()[KEY] ?? [];
    expect(rows.map((m) => m.body)).toEqual(["live", "fresh"]);
  });

  it("drops an id repeated WITHIN one page, as the per-row loop did", async () => {
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    mockGetResumeCursor.mockReturnValue(5);
    vi.mocked(api.listMessagesAfter).mockResolvedValue([
      { ...plainRow(6), body: "first" },
      { ...plainRow(6), body: "second" },
      { ...plainRow(7), body: "next" },
    ]);
    await scrollback.refreshScrollback(SLUG, CHAN);

    const rows = scrollback.scrollbackByChannel()[KEY] ?? [];
    expect(rows.map((m) => m.body)).toEqual(["first", "next"]);
  });
});
