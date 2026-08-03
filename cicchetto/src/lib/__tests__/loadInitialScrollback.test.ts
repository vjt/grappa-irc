// RC2 (decouple-unread-badge) — opening a fresh channel marks its
// existing backlog as the read baseline.
//
// Root cause this pins: `loadInitialScrollback` fires on focus and
// pulls the REST backlog, but never recorded a read position. A
// channel visited then defocused BEFORE the backlog hydrated left the
// cursor nil, so the server's nil-cursor `unread_count` counted the
// whole backlog (200) plus the next inbound msg (→ badge "201" instead
// of "1"; the m2-irssi-to-chan-defocused e2e).
//
// The fix advances the cursor to the loaded page's tail (max id) ONLY
// when no cursor exists yet — a freshly-opened channel auto-scrolls to
// the newest row, so "cursor = tail" is the honest "you've seen the
// newest." Gating on null preserves an existing read position (and its
// in-pane unread marker), so a channel you already have a cursor for is
// never re-baselined.
//
// Three cases pin the contract: advance-on-cold-open, preserve-existing,
// skip-empty-page.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../api";

// Mock socket so importing scrollback's transitive graph doesn't open a
// real WebSocket against jsdom's about:blank base URL. Mirrors
// setCursorIfAdvances.test.ts / queryWindows.test.ts.
vi.mock("../socket", () => ({
  joinUser: vi.fn(() => ({ on: vi.fn(), push: vi.fn().mockReturnValue({ receive: vi.fn() }) })),
  joinChannel: vi.fn(() => ({
    join: vi.fn(() => ({ receive: vi.fn().mockReturnValue({ receive: vi.fn() }) })),
    on: vi.fn(),
  })),
  pushCloseQueryWindow: vi.fn(),
  pushOpenQueryWindow: vi.fn(),
  notifyClientClosing: vi.fn(),
  pushAwaySet: vi.fn(),
  pushAwayUnset: vi.fn(),
}));

// Mock auth so the token is test-controlled and writing it doesn't
// cascade into socket connect via the various on(token) subscribers.
let mockTokenValue: string | null = null;
vi.mock("../auth", () => ({
  token: () => mockTokenValue,
  setToken: vi.fn((v: string | null) => {
    mockTokenValue = v;
  }),
}));

// Stub the two REST verbs loadInitialScrollback can call; keep the rest
// of api live (the module just declares fetch wrappers — nothing runs at
// import). `listMessages` returns a server-shaped DESC page;
// `listMessagesAfter` (the #156 anchored arm, fired when a cursor
// exists) returns a server-shaped ASC page.
const listMessagesSpy = vi.fn<(...a: unknown[]) => Promise<ScrollbackMessage[]>>();
const listMessagesAfterSpy = vi.fn<(...a: unknown[]) => Promise<ScrollbackMessage[]>>();
const countMessagesAfterSpy = vi.fn<(...a: unknown[]) => Promise<number>>();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    listMessages: (...args: unknown[]) => listMessagesSpy(...args),
    listMessagesAfter: (...args: unknown[]) => listMessagesAfterSpy(...args),
    countMessagesAfter: (...args: unknown[]) => countMessagesAfterSpy(...args),
  };
});

// Spy setReadCursor without hitting fetch; keep the rest of readCursor
// live so getReadCursor / applyJoinReply / clearReadCursors are real.
const setReadCursorSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../readCursor", async () => {
  const actual = await vi.importActual<typeof import("../readCursor")>("../readCursor");
  return {
    ...actual,
    setReadCursor: (...args: Parameters<typeof actual.setReadCursor>) => setReadCursorSpy(...args),
  };
});

// Build a realistic server-shaped row. The server returns DESC, so the
// page's max id is the tail regardless of position — the impl must not
// assume page[0].
const row = (id: number): ScrollbackMessage => ({
  id,
  network: "net",
  channel: "#bofh",
  server_time: 1_700_000_000 + id,
  kind: "privmsg",
  sender: "peer",
  body: `line ${id}`,
  meta: {},
});

describe("loadInitialScrollback cursor baseline", () => {
  beforeEach(async () => {
    const { clearReadCursors } = await import("../readCursor");
    clearReadCursors();
    setReadCursorSpy.mockClear();
    listMessagesSpy.mockReset();
    listMessagesAfterSpy.mockReset();
    listMessagesAfterSpy.mockResolvedValue([]);
    countMessagesAfterSpy.mockReset();
    // Default: a small gap, i.e. the pre-#693 contiguous resume.
    countMessagesAfterSpy.mockResolvedValue(0);
    mockTokenValue = "test-bearer";
  });

  it("advances the cursor to the loaded page tail when no cursor exists", async () => {
    const { loadInitialScrollback } = await import("../scrollback");
    // Server-shaped DESC page; tail (max id) is 203, not page[0].id.
    listMessagesSpy.mockResolvedValue([row(203), row(202), row(201)]);

    await loadInitialScrollback("net", "#cold");

    expect(setReadCursorSpy).toHaveBeenCalledWith("test-bearer", "net", "#cold", 203);
  });

  it("does NOT touch the cursor when one already exists (preserves marker)", async () => {
    const { loadInitialScrollback } = await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    applyJoinReply("net", "#warm", 100);
    // #156 anchored arm: cursor present → after(cursor,200) + before(cursor+1).
    listMessagesAfterSpy.mockResolvedValue([row(101), row(102)]);
    listMessagesSpy.mockResolvedValue([row(100), row(99), row(98)]);

    await loadInitialScrollback("net", "#warm");

    // The existing read position is preserved — NO re-baseline (that
    // would clobber the in-pane unread marker on re-open).
    expect(setReadCursorSpy).not.toHaveBeenCalled();
  });

  it("does an ANCHORED fetch (after + before) when a read cursor exists (#156)", async () => {
    // Distinct channel from the case above — the scrollback module's
    // load-once `loadedChannels` gate persists across tests (no
    // vi.resetModules here), so reusing a name would short-circuit the
    // second load. (Same reason the cursor-baseline cases use #cold /
    // #warm / #empty.)
    const { loadInitialScrollback } = await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    applyJoinReply("net", "#anchored", 100);
    listMessagesAfterSpy.mockResolvedValue([row(101), row(102)]);
    listMessagesSpy.mockResolvedValue([row(100), row(99), row(98)]);

    await loadInitialScrollback("net", "#anchored");

    // Unread region after the cursor (capped at the server max 200) +
    // the before-context page anchored at cursor+1. NOT the tail-only
    // listMessages(t, slug, name) (3 args) that loses the anchor.
    expect(listMessagesAfterSpy).toHaveBeenCalledWith("test-bearer", "net", "#anchored", 100, 200);
    expect(listMessagesSpy).toHaveBeenCalledWith("test-bearer", "net", "#anchored", 101);
    expect(listMessagesSpy).not.toHaveBeenCalledWith("test-bearer", "net", "#anchored");
  });

  it("does NOT write a cursor for an empty backlog page", async () => {
    const { loadInitialScrollback } = await import("../scrollback");
    listMessagesSpy.mockResolvedValue([]);

    await loadInitialScrollback("net", "#empty");

    expect(setReadCursorSpy).not.toHaveBeenCalled();
  });
});

// #693 — returning after a long absence must land at the TAIL, not 200 rows
// into the past. The trigger is the GAP SIZE, not the absence: any gap bigger
// than one page leaves the anchored resume loading `[cursor .. cursor+200]`,
// the OLDEST end of the region, with the present hundreds of rows further on.
describe("#693 far-behind resume", () => {
  const tailOf = (rows: ScrollbackMessage[] | undefined): number | undefined =>
    rows && rows.length > 0 ? rows[rows.length - 1]?.id : undefined;

  beforeEach(async () => {
    const { clearReadCursors } = await import("../readCursor");
    clearReadCursors();
    setReadCursorSpy.mockClear();
    listMessagesSpy.mockReset();
    listMessagesAfterSpy.mockReset();
    listMessagesAfterSpy.mockResolvedValue([]);
    countMessagesAfterSpy.mockReset();
    countMessagesAfterSpy.mockResolvedValue(0);
    mockTokenValue = "test-bearer";
  });

  it("cold load with a gap LARGER than a page lands on the server tail", async () => {
    const { loadInitialScrollback, scrollbackByChannel } = await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    applyJoinReply("net", "#flood", 100);
    // 3000 rows accumulated while the operator was away; the tail is 3100.
    countMessagesAfterSpy.mockResolvedValue(3000);
    listMessagesSpy.mockResolvedValue([row(3100), row(3099), row(3098)]);

    await loadInitialScrollback("net", "#flood");

    // The newest loaded row is the TAIL, not cursor + one page.
    expect(tailOf(scrollbackByChannel()[channelKey("net", "#flood")])).toBe(3100);
    // The gap was MEASURED, at the anchor this branch would have used.
    expect(countMessagesAfterSpy).toHaveBeenCalledWith("test-bearer", "net", "#flood", 100);
    // ...and the oldest-end anchored page was never fetched.
    expect(listMessagesAfterSpy).not.toHaveBeenCalled();
  });

  it("records the missed count and the anchor so the jump affordance can show them", async () => {
    const { loadInitialScrollback, farBehindByChannel } = await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    applyJoinReply("net", "#missed", 100);
    countMessagesAfterSpy.mockResolvedValue(3000);
    listMessagesSpy.mockResolvedValue([row(3100)]);

    await loadInitialScrollback("net", "#missed");

    expect(farBehindByChannel()[channelKey("net", "#missed")]).toEqual({
      missed: 3000,
      resumeFrom: 100,
    });
  });

  it("cold load with a gap SMALLER than a page keeps the contiguous resume", async () => {
    const { loadInitialScrollback, farBehindByChannel } = await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    applyJoinReply("net", "#small", 100);
    countMessagesAfterSpy.mockResolvedValue(12);
    listMessagesAfterSpy.mockResolvedValue([row(101), row(102)]);
    listMessagesSpy.mockResolvedValue([row(100), row(99)]);

    await loadInitialScrollback("net", "#small");

    // Unchanged #156 shape: anchored after + before, no tail-only fetch.
    expect(listMessagesAfterSpy).toHaveBeenCalledWith("test-bearer", "net", "#small", 100, 200);
    expect(listMessagesSpy).toHaveBeenCalledWith("test-bearer", "net", "#small", 101);
    expect(listMessagesSpy).not.toHaveBeenCalledWith("test-bearer", "net", "#small");
    expect(farBehindByChannel()[channelKey("net", "#small")]).toBeUndefined();
  });

  it("keeps the contiguous resume when the gap probe is unavailable", async () => {
    // An older server has no /messages/count route. Degrade to the
    // pre-#693 behaviour rather than guessing — never throw away a pane on
    // an unanswered question.
    const { loadInitialScrollback, farBehindByChannel } = await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    applyJoinReply("net", "#oldserver", 100);
    countMessagesAfterSpy.mockRejectedValue(new Error("not_found"));
    listMessagesAfterSpy.mockResolvedValue([row(101)]);
    listMessagesSpy.mockResolvedValue([row(100)]);

    await loadInitialScrollback("net", "#oldserver");

    expect(listMessagesAfterSpy).toHaveBeenCalledWith("test-bearer", "net", "#oldserver", 100, 200);
    expect(farBehindByChannel()[channelKey("net", "#oldserver")]).toBeUndefined();
  });

  it("jumping back swaps the tail window for the anchor region and drops the flag", async () => {
    const { loadInitialScrollback, jumpToUnread, farBehindByChannel, scrollbackByChannel } =
      await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    const key = channelKey("net", "#jump");
    applyJoinReply("net", "#jump", 100);
    countMessagesAfterSpy.mockResolvedValue(3000);
    listMessagesSpy.mockResolvedValue([row(3100), row(3099)]);
    await loadInitialScrollback("net", "#jump");

    // Now the operator takes the affordance: after(100) + before(101).
    listMessagesAfterSpy.mockResolvedValue([row(101), row(102)]);
    listMessagesSpy.mockResolvedValue([row(100), row(99)]);
    await jumpToUnread("net", "#jump");

    const rows = scrollbackByChannel()[key] ?? [];
    expect(rows.map((m) => m.id)).toEqual([99, 100, 101, 102]);
    // REPLACED, not merged: keeping the tail rows next to these would render
    // a hole — 2998 missing rows drawn as if they were consecutive.
    expect(rows.some((m) => m.id === 3100)).toBe(false);
    expect(farBehindByChannel()[key]).toBeUndefined();
  });

  it("reconnect: a full backfill page with more than a page still missing lands at the tail", async () => {
    const { refreshScrollback, scrollbackByChannel, farBehindByChannel } = await import(
      "../scrollback"
    );
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    const key = channelKey("net", "#resume");
    applyJoinReply("net", "#resume", 500);
    // A full 200-row page — which says "at least 200 more", not how many.
    const fullPage = Array.from({ length: 200 }, (_, i) => row(501 + i));
    listMessagesAfterSpy.mockResolvedValue(fullPage);
    // ...and the probe says 2000 rows still sit past the last one ingested.
    countMessagesAfterSpy.mockResolvedValue(2000);
    listMessagesSpy.mockResolvedValue([row(2900), row(2899)]);

    await refreshScrollback("net", "#resume");

    // The DECISION is measured at the anchor just ingested (700)...
    expect(countMessagesAfterSpy).toHaveBeenCalledWith("test-bearer", "net", "#resume", 700);
    expect(tailOf(scrollbackByChannel()[key])).toBe(2900);
    // ...while the jump TARGET is the operator's read position (500) — see the
    // re-probe case below.
    expect(farBehindByChannel()[key]).toEqual({ missed: 2000, resumeFrom: 500 });
  });

  it("reconnect: a full backfill page that drains the gap keeps its rows", async () => {
    const { refreshScrollback, scrollbackByChannel, farBehindByChannel } = await import(
      "../scrollback"
    );
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    const key = channelKey("net", "#drained");
    applyJoinReply("net", "#drained", 500);
    const fullPage = Array.from({ length: 200 }, (_, i) => row(501 + i));
    listMessagesAfterSpy.mockResolvedValue(fullPage);
    // Only 10 rows behind after that page — one more scroll closes it, so the
    // pane must NOT be thrown away.
    countMessagesAfterSpy.mockResolvedValue(10);

    await refreshScrollback("net", "#drained");

    expect(tailOf(scrollbackByChannel()[key])).toBe(700);
    expect(farBehindByChannel()[key]).toBeUndefined();
    expect(listMessagesSpy).not.toHaveBeenCalled();
  });

  it("reconnect: a SHORT backfill page never pays for the probe", async () => {
    const { refreshScrollback } = await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    applyJoinReply("net", "#short", 500);
    listMessagesAfterSpy.mockResolvedValue([row(501), row(502)]);

    await refreshScrollback("net", "#short");

    expect(countMessagesAfterSpy).not.toHaveBeenCalled();
  });

  it("reconnect: the jump target is the READ CURSOR, not the ingested high-water", async () => {
    // Jumping back to the high-water mark would land a window whose every row
    // is already past the cursor — the divider would inject at index 0
    // labelled with the loaded count, the exact failure the suppression
    // exists to prevent. So the target is where the operator actually left
    // off, and the label is re-measured there rather than undercounting by
    // the page already ingested.
    const { refreshScrollback, farBehindByChannel } = await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    applyJoinReply("net", "#target", 500);
    listMessagesAfterSpy.mockResolvedValue(Array.from({ length: 200 }, (_, i) => row(501 + i)));
    // First probe (at the anchor 700) says 2000; the re-probe at the cursor
    // says 2200 — the same region plus the 200 rows just ingested.
    countMessagesAfterSpy.mockResolvedValueOnce(2000).mockResolvedValueOnce(2200);
    listMessagesSpy.mockResolvedValue([row(2900)]);

    await refreshScrollback("net", "#target");

    expect(countMessagesAfterSpy).toHaveBeenNthCalledWith(1, "test-bearer", "net", "#target", 700);
    expect(countMessagesAfterSpy).toHaveBeenNthCalledWith(2, "test-bearer", "net", "#target", 500);
    expect(farBehindByChannel()[channelKey("net", "#target")]).toEqual({
      missed: 2200,
      resumeFrom: 500,
    });
  });

  it("keeps a live row that landed while the tail page was in flight", async () => {
    // `appendToScrollback` has already rolled the high-water mark past such a
    // row, so a blind overwrite would drop it from the pane AND make it
    // unfetchable — the next `?after=` starts above it. It sits at the tail,
    // so keeping it opens no hole.
    const { loadInitialScrollback, appendToScrollback, scrollbackByChannel } = await import(
      "../scrollback"
    );
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    const key = channelKey("net", "#live");
    applyJoinReply("net", "#live", 100);
    countMessagesAfterSpy.mockResolvedValue(3000);
    listMessagesSpy.mockImplementation(async () => {
      // The WS delivers row 3101 while the tail page is in flight.
      appendToScrollback(key, row(3101));
      return [row(3100), row(3099)];
    });

    await loadInitialScrollback("net", "#live");

    expect((scrollbackByChannel()[key] ?? []).map((m) => m.id)).toEqual([3099, 3100, 3101]);
  });

  it("drops a racing anchored page rather than splicing a hole into a tail-anchored pane", async () => {
    // Cold-load and reconnect are not serialised for one key. If the refresh
    // re-anchors at the tail while the anchored pages are in flight, merging
    // them would draw [cursor+1..cursor+200] abutting the tail window with
    // thousands of rows silently missing between them.
    const { loadInitialScrollback, refreshScrollback, scrollbackByChannel } = await import(
      "../scrollback"
    );
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    const key = channelKey("net", "#race");
    applyJoinReply("net", "#race", 100);
    // The cold load sees a small gap and takes the anchored branch...
    countMessagesAfterSpy.mockResolvedValue(10);
    let releaseAnchored: (rows: ScrollbackMessage[]) => void = () => {};
    listMessagesAfterSpy.mockImplementation(
      () =>
        new Promise<ScrollbackMessage[]>((resolve) => {
          releaseAnchored = resolve;
        }),
    );
    listMessagesSpy.mockResolvedValue([row(100), row(99)]);
    const cold = loadInitialScrollback("net", "#race");

    // ...and while it is in flight, a reconnect anchors the same key at the tail.
    const { farBehindByChannel } = await import("../scrollback");
    expect(farBehindByChannel()[key]).toBeUndefined();
    listMessagesSpy.mockResolvedValue([row(3100), row(3099)]);
    countMessagesAfterSpy.mockResolvedValue(3000);
    listMessagesAfterSpy.mockResolvedValueOnce(Array.from({ length: 200 }, (_, i) => row(101 + i)));
    await refreshScrollback("net", "#race");
    expect(farBehindByChannel()[key]).toBeDefined();

    releaseAnchored([row(101), row(102)]);
    await cold;

    // The pane is the tail window the refresh left; the anchored pages are gone.
    expect((scrollbackByChannel()[key] ?? []).map((m) => m.id)).toEqual([3099, 3100]);
  });

  it("a failed jump reports it, leaves the pane, and stays retryable", async () => {
    const { loadInitialScrollback, jumpToUnread, farBehindByChannel, scrollbackByChannel } =
      await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    const key = channelKey("net", "#flaky");
    applyJoinReply("net", "#flaky", 100);
    countMessagesAfterSpy.mockResolvedValue(3000);
    listMessagesSpy.mockResolvedValue([row(3100)]);
    await loadInitialScrollback("net", "#flaky");

    listMessagesAfterSpy.mockRejectedValue(new Error("offline"));
    const jumped = await jumpToUnread("net", "#flaky");

    expect(jumped).toBe(false);
    expect((scrollbackByChannel()[key] ?? []).map((m) => m.id)).toEqual([3100]);
    // Still far behind → the affordance survives for a second attempt.
    expect(farBehindByChannel()[key]).toBeDefined();
  });

  it("a peer rename carries the far-behind record with the window (#373 set)", async () => {
    const { loadInitialScrollback, renameScrollbackKey, farBehindByChannel } = await import(
      "../scrollback"
    );
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    applyJoinReply("net", "oldpeer", 100);
    countMessagesAfterSpy.mockResolvedValue(3000);
    listMessagesSpy.mockResolvedValue([row(3100)]);
    await loadInitialScrollback("net", "oldpeer");

    renameScrollbackKey(channelKey("net", "oldpeer"), channelKey("net", "newpeer"));

    expect(farBehindByChannel()[channelKey("net", "newpeer")]).toEqual({
      missed: 3000,
      resumeFrom: 100,
    });
    expect(farBehindByChannel()[channelKey("net", "oldpeer")]).toBeUndefined();
  });

  it("dismissing marks the loaded tail read and drops the flag", async () => {
    const { loadInitialScrollback, dismissFarBehind, farBehindByChannel } = await import(
      "../scrollback"
    );
    const { applyJoinReply } = await import("../readCursor");
    const { channelKey } = await import("../channelKey");
    const key = channelKey("net", "#dismiss");
    applyJoinReply("net", "#dismiss", 100);
    countMessagesAfterSpy.mockResolvedValue(3000);
    listMessagesSpy.mockResolvedValue([row(3100), row(3099)]);
    await loadInitialScrollback("net", "#dismiss");

    dismissFarBehind("net", "#dismiss");

    // Advances to the newest LOADED row — the forward-only cursor contract
    // still holds; nothing invents an id the pane never showed.
    expect(setReadCursorSpy).toHaveBeenCalledWith("test-bearer", "net", "#dismiss", 3100);
    expect(farBehindByChannel()[key]).toBeUndefined();
  });
});
