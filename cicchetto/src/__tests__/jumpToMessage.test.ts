import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// issue 2333 — `scrollback.jumpToMessage`: the store half of "tap a mention,
// land on the message". Boundary: REST (`lib/api`) and the read cursor are
// mocked; the store is real.

const listMessages = vi.fn();
const listMessagesAfter = vi.fn();
const countMessagesAfter = vi.fn();

vi.mock("../lib/api", () => ({
  listMessages: (...a: unknown[]) => listMessages(...a),
  listMessagesAfter: (...a: unknown[]) => listMessagesAfter(...a),
  countMessagesAfter: (...a: unknown[]) => countMessagesAfter(...a),
  listNetworks: vi.fn(),
  listChannels: vi.fn(),
  sendMessage: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setOn401Handler: vi.fn(),
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
}));

vi.mock("../lib/reconnectBackfill", () => ({
  getResumeCursor: () => null,
  recordSeen: vi.fn(),
}));

const mockGetReadCursor = vi.fn<(slug: string, chan: string) => number | null>(() => null);
vi.mock("../lib/readCursor", () => ({
  getReadCursor: (slug: string, chan: string) => mockGetReadCursor(slug, chan),
  setReadCursor: vi.fn(() => Promise.resolve()),
}));

const SLUG = "freenode";
const CHAN = "#grappa";
const key = channelKey(SLUG, CHAN);

const mkRow = (id: number): ScrollbackMessage => ({
  id,
  network: SLUG,
  channel: CHAN,
  server_time: id,
  kind: "privmsg",
  sender: "peer",
  body: `line ${id}`,
  meta: {},
});

// `ids` inclusive ranges → rows. The server answers `?before=` DESC and
// `?after=` ASC; the store sorts, so the order handed back does not matter
// to the verb — it is kept server-shaped anyway.
const range = (from: number, to: number): ScrollbackMessage[] => {
  const out: ScrollbackMessage[] = [];
  for (let i = from; i <= to; i++) out.push(mkRow(i));
  return out;
};

const ids = (rows: ScrollbackMessage[] | undefined): number[] => (rows ?? []).map((m) => m.id);

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  localStorage.setItem("grappa-token", "tok");
  mockGetReadCursor.mockReturnValue(null);
});

describe("jumpToMessage", () => {
  it("does not fetch when the message is already in the pane", async () => {
    const scrollback = await import("../lib/scrollback");
    for (const r of range(1, 10)) scrollback.appendToScrollback(key, r);

    const landed = await scrollback.jumpToMessage(SLUG, CHAN, 5);

    expect(landed).toBe(true);
    expect(listMessages).not.toHaveBeenCalled();
    expect(listMessagesAfter).not.toHaveBeenCalled();
    expect(ids(scrollback.scrollbackByChannel()[key])).toEqual(range(1, 10).map((m) => m.id));
  });

  it("replaces the pane with the region around the message when it is not loaded", async () => {
    const scrollback = await import("../lib/scrollback");
    for (const r of range(900, 910)) scrollback.appendToScrollback(key, r);
    listMessagesAfter.mockResolvedValue(range(51, 60));
    listMessages.mockResolvedValue(range(40, 50).reverse());

    const landed = await scrollback.jumpToMessage(SLUG, CHAN, 50);

    expect(landed).toBe(true);
    // The same fetch shape as `jumpToUnread`, anchored on the TARGET:
    // `after(id)` is `id > target`, `before(id + 1)` is `id <= target`.
    expect(listMessagesAfter).toHaveBeenCalledWith(
      "tok",
      SLUG,
      CHAN,
      50,
      scrollback.UNREAD_RETENTION_CAP,
    );
    expect(listMessages).toHaveBeenCalledWith("tok", SLUG, CHAN, 51);
    // REPLACED, not merged: the tail region and the target region are not
    // contiguous, and store order is display order.
    expect(ids(scrollback.scrollbackByChannel()[key])).toEqual(range(40, 60).map((m) => m.id));
  });

  it("leaves the pane untouched when the window does not hold the message", async () => {
    const scrollback = await import("../lib/scrollback");
    for (const r of range(900, 910)) scrollback.appendToScrollback(key, r);
    listMessagesAfter.mockResolvedValue(range(51, 60));
    listMessages.mockResolvedValue(range(40, 49).reverse());

    const landed = await scrollback.jumpToMessage(SLUG, CHAN, 50);

    expect(landed).toBe(false);
    expect(ids(scrollback.scrollbackByChannel()[key])).toEqual(range(900, 910).map((m) => m.id));
  });

  // #693 — a region above the read cursor with rows between the two not in
  // the pane. Every passive cursor writer offers the newest RENDERED id, so
  // without the freeze a scroll-settle would mark that hole read.
  it("freezes the cursor with the existing far-behind record when a hole opens below the region", async () => {
    mockGetReadCursor.mockReturnValue(10);
    const scrollback = await import("../lib/scrollback");
    const page = scrollback.UNREAD_RETENTION_CAP;
    listMessagesAfter.mockResolvedValue(range(1001, 1010));
    // A FULL before-page whose oldest row is still above the cursor: there
    // may be rows between the cursor and the region.
    listMessages.mockResolvedValue(range(1000 - page + 1, 1000).reverse());
    countMessagesAfter.mockResolvedValue({ messages: 1500, events: 30 });

    const landed = await scrollback.jumpToMessage(SLUG, CHAN, 1000);

    expect(landed).toBe(true);
    expect(countMessagesAfter).toHaveBeenCalledWith("tok", SLUG, CHAN, 10);
    expect(scrollback.farBehindByChannel()[key]).toEqual({
      missed: 1500,
      events: 30,
      resumeFrom: 10,
    });
  });

  it("does not freeze when the region reaches down to the cursor", async () => {
    mockGetReadCursor.mockReturnValue(10);
    const scrollback = await import("../lib/scrollback");
    listMessagesAfter.mockResolvedValue(range(51, 60));
    // A SHORT before-page: the server had nothing older to give, so nothing
    // sits between the cursor and the region.
    listMessages.mockResolvedValue(range(5, 50).reverse());

    const landed = await scrollback.jumpToMessage(SLUG, CHAN, 50);

    expect(landed).toBe(true);
    expect(countMessagesAfter).not.toHaveBeenCalled();
    expect(scrollback.farBehindByChannel()[key]).toBeUndefined();
  });

  it("refuses the jump when the hole cannot be measured, rather than leaving the cursor unfrozen", async () => {
    mockGetReadCursor.mockReturnValue(10);
    const scrollback = await import("../lib/scrollback");
    const page = scrollback.UNREAD_RETENTION_CAP;
    for (const r of range(5000, 5010)) scrollback.appendToScrollback(key, r);
    listMessagesAfter.mockResolvedValue(range(1001, 1010));
    listMessages.mockResolvedValue(range(1000 - page + 1, 1000).reverse());
    countMessagesAfter.mockRejectedValue(new Error("boom"));

    const landed = await scrollback.jumpToMessage(SLUG, CHAN, 1000);

    expect(landed).toBe(false);
    expect(ids(scrollback.scrollbackByChannel()[key])).toEqual(range(5000, 5010).map((m) => m.id));
    expect(scrollback.farBehindByChannel()[key]).toBeUndefined();
  });

  // issue 2069's measurement claims the pane is contiguous from its `at`.
  // A swap to another region makes that false without writing the record,
  // and `loadNewer` would go on extending `through` over rows that are gone.
  it("drops a carried unread measurement, which no longer describes the pane", async () => {
    const cursor = 10;
    mockGetReadCursor.mockReturnValue(cursor);
    const scrollback = await import("../lib/scrollback");
    const page = scrollback.UNREAD_RETENTION_CAP;
    // Enter far-behind the way production does (#1229 prune), then take the
    // jump back with a FULL after-page, which is what writes the measurement.
    const total = scrollback.SCROLLBACK_RING_CAP + 200;
    for (let i = 1; i <= total; i++) scrollback.appendToScrollback(key, mkRow(i));
    listMessagesAfter.mockResolvedValueOnce(range(cursor + 1, cursor + page));
    listMessages.mockResolvedValueOnce(range(1, cursor).reverse());
    expect(await scrollback.jumpToUnread(SLUG, CHAN)).toBe(true);
    expect(scrollback.measuredUnreadByChannel()[key]).toBeDefined();

    listMessagesAfter.mockResolvedValueOnce(range(801, 810));
    listMessages.mockResolvedValueOnce(range(800 - page + 1, 800).reverse());
    countMessagesAfter.mockResolvedValueOnce({ messages: 1190, events: 0 });
    expect(await scrollback.jumpToMessage(SLUG, CHAN, 800)).toBe(true);

    expect(scrollback.measuredUnreadByChannel()[key]).toBeUndefined();
  });

  // A tap from the mentions window MOUNTS the pane on a window this session
  // may never have loaded, so the selection's cold load and the jump race for
  // the same key. The cold load MERGES; landing after the swap it would splice
  // the tail into the target region — a silent hole, store order being display
  // order. The jump waits for it instead.
  it("waits for an in-flight cold load instead of racing it", async () => {
    const scrollback = await import("../lib/scrollback");
    let releaseCold: (rows: ScrollbackMessage[]) => void = () => {};
    listMessages.mockImplementation((_t: string, _s: string, _c: string, before?: number) =>
      before === undefined
        ? new Promise<ScrollbackMessage[]>((r) => {
            releaseCold = r;
          })
        : Promise.resolve(range(40, 50).reverse()),
    );
    listMessagesAfter.mockResolvedValue(range(51, 60));

    const cold = scrollback.loadInitialScrollback(SLUG, CHAN);
    const jump = scrollback.jumpToMessage(SLUG, CHAN, 50);
    // Give the jump every chance to finish on its own BEFORE the cold load
    // lands — the order that splices — then let the cold load land.
    await new Promise((r) => setTimeout(r, 0));
    releaseCold(range(900, 950).reverse());
    await cold;

    expect(await jump).toBe(true);
    expect(ids(scrollback.scrollbackByChannel()[key])).toEqual(range(40, 60).map((m) => m.id));
  });
});
