import { createEffect, createRoot, on } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// Boundary: mock REST (`lib/api`) only. CP14 B3 removed `lib/networks`
// dependency from `scrollback.ts` (the own-nick query filter that
// needed it is gone — server-side `:dm_with` now provides bidirectional
// DM history without client-side filtering). The store exposes pure
// verbs (`loadInitialScrollback`, `loadMore`, `sendMessage`,
// `appendToScrollback`) that read/write the per-channel signal store
// without any WS coupling — the WS path is exercised by
// `subscribe.test.ts` separately.

vi.mock("../lib/api", () => ({
  listNetworks: vi.fn(),
  listChannels: vi.fn(),
  listMessages: vi.fn(),
  listMessagesAfter: vi.fn(),
  sendMessage: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setOn401Handler: vi.fn(),
  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2):
  // selection.ts now imports isContentKind from api.ts for the badge
  // memo derivation. Any test importing selection (directly or
  // transitively) needs the classifier in its api mock.
  isContentKind: (k: string) => k === "privmsg" || k === "notice" || k === "action",
  isPresenceKind: (k: string) => !(k === "privmsg" || k === "notice" || k === "action"),
}));

// CP29 R-5: refreshScrollback consumes `getResumeCursor` from
// reconnectBackfill (live high-water mark > server cursor > null).
// Stub it so each test can drive the cursor source deterministically.
// `recordSeen` is also exported by reconnectBackfill but refreshScrollback
// calls it as a side-effect during ingestion — stub as a no-op so we
// don't have to wire the high-water-mark map back here.
const mockGetResumeCursor = vi.fn<(slug: string, chan: string) => number | null>(() => null);
vi.mock("../lib/reconnectBackfill", () => ({
  getResumeCursor: (slug: string, chan: string) => mockGetResumeCursor(slug, chan),
  recordSeen: vi.fn(),
}));

// 2026-06-01 (unread-badges-from-cursor cluster, bucket D):
// scrollback.sendMessage now plumbs the persisted row's id into a
// forward-only cursor advance via readCursor. Mock the readCursor
// surface so the test can drive `getReadCursor` deterministically
// and assert `setReadCursor` was invoked with the expected id without
// hitting the real fetch path.
const mockGetReadCursor = vi.fn<(slug: string, chan: string) => number | null>(() => null);
const mockSetReadCursor =
  vi.fn<(bearer: string, slug: string, chan: string, id: number) => Promise<void>>();
vi.mock("../lib/readCursor", () => ({
  getReadCursor: (slug: string, chan: string) => mockGetReadCursor(slug, chan),
  setReadCursor: (bearer: string, slug: string, chan: string, id: number) =>
    mockSetReadCursor(bearer, slug, chan, id),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  mockGetReadCursor.mockReturnValue(null);
  mockSetReadCursor.mockResolvedValue(undefined);
});

describe("scrollback verbs", () => {
  // Server-shaped row for (freenode, #grappa). server_time decoupled
  // from id so the merge's (server_time, id) sort is exercised honestly.
  const mkRow = (id: number, serverTime: number): import("../lib/api").ScrollbackMessage => ({
    id,
    network: "freenode",
    channel: "#grappa",
    server_time: serverTime,
    kind: "privmsg",
    sender: "peer",
    body: `line ${id}`,
    meta: {},
  });

  // Seed one rendered row into (freenode, #grappa) so sendMessage's
  // anti-poison gate (#50) treats the window as a focused pane that
  // already has content — the bucket-D cursor advance applies there, not
  // to a brand-new EMPTY query window (covered by its own test below).
  const seedRendered = (scrollback: typeof import("../lib/scrollback"), id: number): void =>
    scrollback.appendToScrollback(channelKey("freenode", "#grappa"), {
      id,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "privmsg",
      sender: "carol",
      body: "prior",
      meta: {},
    });

  it("loadInitialScrollback merges REST DESC page into ASC scrollback", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      {
        id: 3,
        network: "freenode",
        channel: "#grappa",
        server_time: 300,
        kind: "privmsg",
        sender: "carol",
        body: "newest",
        meta: {},
      },
      {
        id: 2,
        network: "freenode",
        channel: "#grappa",
        server_time: 200,
        kind: "privmsg",
        sender: "bob",
        body: "middle",
        meta: {},
      },
      {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 100,
        kind: "privmsg",
        sender: "alice",
        body: "oldest",
        meta: {},
      },
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("freenode", "#grappa");
    const key = channelKey("freenode", "#grappa");
    expect(scrollback.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([1, 2, 3]);
  });

  it("loadInitialScrollback runs once per channel — second call is a no-op", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("freenode", "#grappa");
    await scrollback.loadInitialScrollback("freenode", "#grappa");
    expect(api.listMessages).toHaveBeenCalledTimes(1);
  });

  // #156 — a tail-only page (server default ~50 newest rows) loses the
  // in-pane unread-divider anchor whenever unread exceeds that window:
  // the read cursor is OLDER than every loaded row, so the last-read row
  // and the first-unread row (the divider's anchor) are never fetched.
  // When a read cursor exists, fetch AROUND it instead:
  //   * listMessagesAfter(cursor, 200) → the unread region (id > cursor, ASC)
  //   * listMessages(cursor + 1)       → read-context (id <= cursor, DESC)
  // and merge both, so the anchor rows are present and the divider lands
  // between the last-read and first-unread rows with context above it.
  it("loadInitialScrollback does an ANCHORED fetch when a read cursor exists (#156)", async () => {
    localStorage.setItem("grappa-token", "tok");
    mockGetReadCursor.mockReturnValue(100);
    const api = await import("../lib/api");
    // after(100, 200): server returns the unread region ASC by id.
    vi.mocked(api.listMessagesAfter).mockResolvedValue([
      mkRow(101, 1101),
      mkRow(102, 1102),
      mkRow(103, 1103),
    ]);
    // before(101): server returns the read-context page DESC by id; the
    // last-read row (100) heads it.
    vi.mocked(api.listMessages).mockResolvedValue([
      mkRow(100, 1100),
      mkRow(99, 1099),
      mkRow(98, 1098),
    ]);

    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("freenode", "#grappa");

    // Anchored: unread region after the cursor (capped at the server max
    // 200) + the before-context page anchored at cursor+1. The tail-only
    // listMessages(t, slug, name) (3 args, no before) MUST NOT be used —
    // it's the call that loses the anchor.
    expect(api.listMessagesAfter).toHaveBeenCalledWith("tok", "freenode", "#grappa", 100, 200);
    expect(api.listMessages).toHaveBeenCalledWith("tok", "freenode", "#grappa", 101);
    expect(api.listMessages).not.toHaveBeenCalledWith("tok", "freenode", "#grappa");

    const key = channelKey("freenode", "#grappa");
    const ids = scrollback.scrollbackByChannel()[key]?.map((m) => m.id);
    // Both divider-anchor rows present: the last-read row (100, from the
    // before page) AND the first-unread row (101, from the after page).
    expect(ids).toContain(100);
    expect(ids).toContain(101);
  });

  it("loadMore fetches with before=oldest_id and prepends older entries", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValueOnce([
      {
        id: 5,
        network: "freenode",
        channel: "#grappa",
        server_time: 500,
        kind: "privmsg",
        sender: "z",
        body: "now",
        meta: {},
      },
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("freenode", "#grappa");
    vi.mocked(api.listMessages).mockResolvedValueOnce([
      {
        id: 3,
        network: "freenode",
        channel: "#grappa",
        server_time: 300,
        kind: "privmsg",
        sender: "y",
        body: "older",
        meta: {},
      },
    ]);
    await scrollback.loadMore("freenode", "#grappa");
    const key = channelKey("freenode", "#grappa");
    // CP29 R-2: cursor flipped from oldest.server_time (500) to oldest.id (5).
    expect(api.listMessages).toHaveBeenLastCalledWith("tok", "freenode", "#grappa", 5);
    expect(scrollback.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([3, 5]);
  });

  it("sendMessage POSTs to api.sendMessage with token, slug, channel, body", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: 1,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "privmsg",
      sender: "alice",
      body: "hello",
      meta: {},
    });
    const scrollback = await import("../lib/scrollback");
    await scrollback.sendMessage("freenode", "#grappa", "hello world");
    expect(api.sendMessage).toHaveBeenCalledWith("tok", "freenode", "#grappa", "hello world");
  });

  // Bucket D — post-success cursor advance. The id from the 201 body
  // must drive a `setReadCursor` write (forward-only) so the in-pane
  // unread marker collapses and any second device of this operator
  // drops the just-sent row from its derived badge count. Gated on a
  // non-empty pane (#50) — these tests seed a rendered row so the gate
  // is satisfied and they exercise the forward-only branch, not the
  // empty-pane skip (its own test follows).
  it("sendMessage advances the read cursor to the returned row id when no cursor is set", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: 42,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "privmsg",
      sender: "alice",
      body: "hello",
      meta: {},
    });
    mockGetReadCursor.mockReturnValue(null);
    const scrollback = await import("../lib/scrollback");
    seedRendered(scrollback, 41);
    await scrollback.sendMessage("freenode", "#grappa", "hello world");
    expect(mockSetReadCursor).toHaveBeenCalledWith("tok", "freenode", "#grappa", 42);
  });

  it("sendMessage advances the read cursor when the returned id strictly exceeds the current cursor", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: 100,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "privmsg",
      sender: "alice",
      body: "hi",
      meta: {},
    });
    mockGetReadCursor.mockReturnValue(50);
    const scrollback = await import("../lib/scrollback");
    seedRendered(scrollback, 50);
    await scrollback.sendMessage("freenode", "#grappa", "hi");
    expect(mockSetReadCursor).toHaveBeenCalledWith("tok", "freenode", "#grappa", 100);
  });

  it("sendMessage does NOT write the cursor when the returned id is not strictly greater than the current cursor", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: 50,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "privmsg",
      sender: "alice",
      body: "stale",
      meta: {},
    });
    mockGetReadCursor.mockReturnValue(50);
    const scrollback = await import("../lib/scrollback");
    // Seed so the skip is genuinely the forward-only branch (id 50 not >
    // cursor 50), not the empty-pane anti-poison gate.
    seedRendered(scrollback, 40);
    await scrollback.sendMessage("freenode", "#grappa", "stale");
    expect(mockSetReadCursor).not.toHaveBeenCalled();
  });

  // #50 (m6) anti-poison — 2026-06-09. A `/msg` to a brand-new nick opens
  // an EMPTY query window, then sends. If sendMessage advances the read
  // cursor to the just-sent id while the pane has no rendered row, that
  // cursor poisons refreshScrollback's resume point: getResumeCursor falls
  // back to the read cursor (no row was ever recordSeen'd), so the join-ok
  // recovery fetches `?after=<own-id>` → empty → the row is never recovered
  // and the pane stays "no messages yet" until reload. The cursor must NOT
  // advance past an unrendered row; with the pane empty it stays put so
  // refreshScrollback resumes from 0 (see the refreshScrollback id=0 test)
  // and recovers the send.
  it("sendMessage does NOT advance the read cursor when the local pane is empty (issue #50 anti-poison)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: 42,
      network: "freenode",
      channel: "newbie",
      server_time: 0,
      kind: "privmsg",
      sender: "vjt",
      body: "hi there",
      meta: {},
    });
    mockGetReadCursor.mockReturnValue(null);
    const scrollback = await import("../lib/scrollback");
    // No appendToScrollback for (freenode, newbie) → the pane is empty/
    // absent, exactly the brand-new query-window shape.
    await scrollback.sendMessage("freenode", "newbie", "hi there");
    expect(mockSetReadCursor).not.toHaveBeenCalled();
  });

  it("sendMessage with no token short-circuits before POST and does not touch the cursor", async () => {
    // No grappa-token in localStorage → token() returns null.
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    await scrollback.sendMessage("freenode", "#grappa", "ignored");
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(mockSetReadCursor).not.toHaveBeenCalled();
  });

  // Send-relatch (2026-06-09): sendMessage publishes the channel-key on
  // `lastOwnSend` so ScrollbackPane can hide the frozen unread-marker on
  // a focused send. Fires on EVERY successful send.
  it("sendMessage publishes the channel-key on lastOwnSend", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: 100,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "privmsg",
      sender: "alice",
      body: "hi",
      meta: {},
    });
    mockGetReadCursor.mockReturnValue(50);
    const scrollback = await import("../lib/scrollback");
    expect(scrollback.lastOwnSend()).toBeNull();
    await scrollback.sendMessage("freenode", "#grappa", "hi");
    expect(scrollback.lastOwnSend()).toBe(channelKey("freenode", "#grappa"));
  });

  // Even when the cursor advance is skipped (returned id not strictly
  // greater than the current cursor), the marker must still hide — so
  // lastOwnSend fires regardless of the cursor branch.
  it("sendMessage publishes lastOwnSend even when the cursor write is skipped", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.sendMessage).mockResolvedValue({
      id: 50,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "privmsg",
      sender: "alice",
      body: "stale",
      meta: {},
    });
    mockGetReadCursor.mockReturnValue(50);
    const scrollback = await import("../lib/scrollback");
    // Seed so the cursor skip is the forward-only branch (id 50 not > 50),
    // not the empty-pane anti-poison gate — lastOwnSend must fire either way.
    seedRendered(scrollback, 40);
    await scrollback.sendMessage("freenode", "#grappa", "stale");
    expect(mockSetReadCursor).not.toHaveBeenCalled();
    expect(scrollback.lastOwnSend()).toBe(channelKey("freenode", "#grappa"));
  });

  it("sendMessage with no token does not publish lastOwnSend", async () => {
    const scrollback = await import("../lib/scrollback");
    await scrollback.sendMessage("freenode", "#grappa", "ignored");
    expect(scrollback.lastOwnSend()).toBeNull();
  });

  // Send-relatch dedup guard (2026-06-09): `lastOwnSend` is an EVENT
  // signal (`equals: false`). Two sends to the SAME channel write the
  // same key string — the marker must re-hide on the SECOND one too
  // (real case: send → switch away → peer msg → switch back, marker
  // re-shows → reply → must hide). With the default Object.is dedup the
  // second set is a no-op and a subscriber never re-runs. This pins the
  // real signal notifying on every send, repeats included.
  it("lastOwnSend notifies on EVERY send, even repeats to the same channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const row = (id: number): ScrollbackMessage => ({
      id,
      network: "freenode",
      channel: "#grappa",
      server_time: 0,
      kind: "privmsg",
      sender: "vjt",
      body: "x",
      meta: {},
    });
    vi.mocked(api.sendMessage).mockResolvedValueOnce(row(100)).mockResolvedValueOnce(row(101));
    mockGetReadCursor.mockReturnValue(50);
    const scrollback = await import("../lib/scrollback");

    let fires = 0;
    const dispose = createRoot((d) => {
      // `defer: true` so creation doesn't count — only real sends do.
      createEffect(on(scrollback.lastOwnSend, () => void fires++, { defer: true }));
      return d;
    });

    await scrollback.sendMessage("freenode", "#grappa", "one");
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect(fires).toBe(1);

    // Second send → SAME channel-key string. Must still notify.
    await scrollback.sendMessage("freenode", "#grappa", "two");
    await new Promise((r) => queueMicrotask(() => r(undefined)));
    expect(fires).toBe(2);

    dispose();
  });

  it("appendToScrollback dedupes by id (first wins)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const scrollback = await import("../lib/scrollback");
    const key = channelKey("freenode", "#grappa");
    scrollback.appendToScrollback(key, {
      id: 7,
      network: "freenode",
      channel: "#grappa",
      server_time: 100,
      kind: "privmsg",
      sender: "alice",
      body: "first",
      meta: {},
    });
    scrollback.appendToScrollback(key, {
      id: 7,
      network: "freenode",
      channel: "#grappa",
      server_time: 100,
      kind: "privmsg",
      sender: "alice",
      body: "second-ignored",
      meta: {},
    });
    expect(scrollback.scrollbackByChannel()[key]?.length).toBe(1);
    expect(scrollback.scrollbackByChannel()[key]?.[0]?.body).toBe("first");
  });

  it("appendToScrollback preserves arrival order across distinct ids", async () => {
    localStorage.setItem("grappa-token", "tok");
    const scrollback = await import("../lib/scrollback");
    const key = channelKey("freenode", "#grappa");
    scrollback.appendToScrollback(key, {
      id: 1,
      network: "freenode",
      channel: "#grappa",
      server_time: 100,
      kind: "privmsg",
      sender: "a",
      body: "first",
      meta: {},
    });
    scrollback.appendToScrollback(key, {
      id: 2,
      network: "freenode",
      channel: "#grappa",
      server_time: 200,
      kind: "privmsg",
      sender: "b",
      body: "second",
      meta: {},
    });
    expect(scrollback.scrollbackByChannel()[key]?.map((m) => m.body)).toEqual(["first", "second"]);
  });

  // Codebase audit cic M3 — same-millisecond messages must use `id` as
  // secondary sort key. Mirrors server-side `Scrollback.fetch/5`'s
  // `order_by: [desc: m.server_time, desc: m.id]` (DESC there, ASC here).
  // Without it, REST DESC pages with same-server_time bursts and WS
  // append ordering can disagree across reload — the user sees a
  // visible reorder of bursty messages on refresh.
  it("mergeIntoScrollback uses id as secondary sort for same-server_time burst", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    // Server returns DESC [id=3, id=1, id=2] all with server_time=500
    // (a buggy upstream burst sort or out-of-order REST page). Cic must
    // re-sort by (server_time ASC, id ASC) → [1, 2, 3].
    vi.mocked(api.listMessages).mockResolvedValue([
      {
        id: 3,
        network: "freenode",
        channel: "#grappa",
        server_time: 500,
        kind: "privmsg",
        sender: "c",
        body: "third",
        meta: {},
      },
      {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 500,
        kind: "privmsg",
        sender: "a",
        body: "first",
        meta: {},
      },
      {
        id: 2,
        network: "freenode",
        channel: "#grappa",
        server_time: 500,
        kind: "privmsg",
        sender: "b",
        body: "second",
        meta: {},
      },
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("freenode", "#grappa");
    const key = channelKey("freenode", "#grappa");
    expect(scrollback.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// CP14 B2 — loadMore concurrency guard + end-of-history latch
// ---------------------------------------------------------------------------
//
// `loadMore` is wired up to the scroll-up handler in `ScrollbackPane.tsx`.
// Two failure modes the UI wiring exposes that the verb itself must
// defend against (so the call site stays a one-liner — the verb is the
// boundary):
//
//   1. **Concurrency guard.** A scroll-event burst (the user flicks the
//      scrollbar, the browser fires `scroll` 5+ times in a frame) used
//      to fan-out into 5+ REST requests, all carrying the same `before=`
//      cursor. The dedupe-by-id in `mergeIntoScrollback` keeps the
//      result *correct*, but the wasted bandwidth + DB load is real.
//      **Rule**: while a `loadMore` is in flight for a given channel
//      key, a second call for the same key is a no-op. This is the
//      long-deferred concurrency guard from S22 Phase 3 review C5
//      (see `docs/todo.md` "Phase 5 hardening (NEW from S22... C5)").
//
//   2. **End-of-history latch.** When `loadMore` returns 0 fresh rows
//      (server has no rows older than `oldest.server_time`), the
//      channel is *exhausted*. Subsequent `loadMore` calls for that
//      key are no-ops — every scroll-to-top would otherwise hit REST
//      and get an empty page over and over. Latch is forward-only:
//      once exhausted, stays exhausted for the lifetime of the
//      identity (cleared on token rotation, same as `loadedChannels`).

describe("loadMore — B2 concurrency guard + end-of-history latch", () => {
  // Seed scrollback with one message so loadMore has an `oldest` cursor
  // to work with (loadMore early-returns on empty scrollback).
  const seedOne = (scrollback: typeof import("../lib/scrollback")): void => {
    const key = channelKey("freenode", "#grappa");
    scrollback.appendToScrollback(key, {
      id: 100,
      network: "freenode",
      channel: "#grappa",
      server_time: 1000,
      kind: "privmsg",
      sender: "alice",
      body: "tail",
      meta: {},
    });
  };

  it("concurrency guard — two parallel loadMore calls fire only one REST request", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    // Slow listMessages so both loadMore calls overlap. Resolve only
    // after the second call has a chance to short-circuit on the
    // in-flight guard.
    let resolveFetch: ((v: ScrollbackMessage[]) => void) | null = null;
    vi.mocked(api.listMessages).mockImplementation(
      () =>
        new Promise<ScrollbackMessage[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const scrollback = await import("../lib/scrollback");
    seedOne(scrollback);
    // Fire two loadMore calls back-to-back without awaiting the first.
    const p1 = scrollback.loadMore("freenode", "#grappa");
    const p2 = scrollback.loadMore("freenode", "#grappa");
    // The second call should resolve immediately (no-op) without
    // adding a second REST request.
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    // Resolve the in-flight fetch with one fresh row.
    if (!resolveFetch) throw new Error("resolveFetch never bound");
    (resolveFetch as (v: ScrollbackMessage[]) => void)([
      {
        id: 50,
        network: "freenode",
        channel: "#grappa",
        server_time: 500,
        kind: "privmsg",
        sender: "bob",
        body: "older",
        meta: {},
      },
    ]);
    await Promise.all([p1, p2]);
    // After both resolve, still only one REST call total.
    expect(api.listMessages).toHaveBeenCalledTimes(1);
  });

  it("end-of-history latch — second loadMore after empty page is a no-op", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([]);
    const scrollback = await import("../lib/scrollback");
    seedOne(scrollback);
    // First loadMore: REST returns [] → exhausted latch fires.
    await scrollback.loadMore("freenode", "#grappa");
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    // Second loadMore: latch makes this a no-op (no REST).
    await scrollback.loadMore("freenode", "#grappa");
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    // Third loadMore: still latched.
    await scrollback.loadMore("freenode", "#grappa");
    expect(api.listMessages).toHaveBeenCalledTimes(1);
  });

  it("in-flight guard releases on resolve — subsequent loadMore can fire fresh REST", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValueOnce([
      {
        id: 50,
        network: "freenode",
        channel: "#grappa",
        server_time: 500,
        kind: "privmsg",
        sender: "bob",
        body: "older",
        meta: {},
      },
    ]);
    const scrollback = await import("../lib/scrollback");
    seedOne(scrollback);
    await scrollback.loadMore("freenode", "#grappa");
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    // Fresh page came back non-empty → not exhausted. Second call,
    // serial (in-flight cleared), fires a second REST request.
    vi.mocked(api.listMessages).mockResolvedValueOnce([
      {
        id: 25,
        network: "freenode",
        channel: "#grappa",
        server_time: 250,
        kind: "privmsg",
        sender: "carol",
        body: "even older",
        meta: {},
      },
    ]);
    await scrollback.loadMore("freenode", "#grappa");
    expect(api.listMessages).toHaveBeenCalledTimes(2);
  });

  it("in-flight guard releases on REST error — subsequent loadMore can retry", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockRejectedValueOnce(new Error("boom"));
    const scrollback = await import("../lib/scrollback");
    seedOne(scrollback);
    await scrollback.loadMore("freenode", "#grappa");
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    // Failed call must NOT latch as exhausted — error is transient.
    // User scrolls again; REST retries.
    vi.mocked(api.listMessages).mockResolvedValueOnce([]);
    await scrollback.loadMore("freenode", "#grappa");
    expect(api.listMessages).toHaveBeenCalledTimes(2);
  });
});

// #161 — loadNewer forward-paging guard + growing-tail latch.
//
// `loadNewer` is the mirror of `loadMore`: it pages NEWER rows on scroll-
// to-bottom, closing the #156 regression where a channel with > 200 unread
// loaded only [cursor .. cursor+200] and the newest rows were unreachable
// (no forward handler, and the WS join-ok refreshScrollback hit the same
// 200 cap). It shares loadMore's in-flight + exhausted guards, with ONE
// domain difference: the tail GROWS via live appends, so its latch is
// invalidated by a CAPPED refreshScrollback (a >200-message reconnect
// re-opens the gap) but NOT by ordinary contiguous appends — invalidating
// per-append would storm one empty forward probe per live message at a
// busy tail. These tests pin the fetch shape, both guards, and the
// asymmetric latch (capped-refresh invalidates, short-refresh does not).
describe("loadNewer — #161 forward-paging guard + growing-tail latch", () => {
  const key = channelKey("freenode", "#grappa");
  const mkRow = (id: number): ScrollbackMessage => ({
    id,
    network: "freenode",
    channel: "#grappa",
    server_time: id * 1000,
    kind: "privmsg",
    sender: "peer",
    body: `line ${id}`,
    meta: {},
  });
  // Seed one tail row so loadNewer has a `newest` cursor (it early-returns
  // on an empty pane).
  const seedTail = (scrollback: typeof import("../lib/scrollback"), id = 100): void =>
    scrollback.appendToScrollback(key, mkRow(id));

  it("fetches listMessagesAfter(newestId, 200) and merges the forward page onto the tail", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessagesAfter).mockResolvedValue([mkRow(101), mkRow(102)]);
    const scrollback = await import("../lib/scrollback");
    seedTail(scrollback, 100);
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledWith("tok", "freenode", "#grappa", 100, 200);
    const list = scrollback.scrollbackByChannel()[key] ?? [];
    expect(list.map((m) => m.id)).toEqual([100, 101, 102]);
  });

  it("is a no-op without a token", async () => {
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    seedTail(scrollback, 100);
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).not.toHaveBeenCalled();
  });

  it("is a no-op on an empty pane (no `newest` cursor to page from)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    // No seedTail → the (freenode, #grappa) pane is absent.
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).not.toHaveBeenCalled();
  });

  it("concurrency guard — two parallel loadNewer calls fire only one REST request", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    // Slow the fetch so both calls overlap; the second must short-circuit
    // on the in-flight guard before the first resolves.
    let resolveFetch: ((v: ScrollbackMessage[]) => void) | null = null;
    vi.mocked(api.listMessagesAfter).mockImplementation(
      () =>
        new Promise<ScrollbackMessage[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const scrollback = await import("../lib/scrollback");
    seedTail(scrollback, 100);
    const p1 = scrollback.loadNewer("freenode", "#grappa");
    const p2 = scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(1);
    if (!resolveFetch) throw new Error("resolveFetch never bound");
    (resolveFetch as (v: ScrollbackMessage[]) => void)([mkRow(101)]);
    await Promise.all([p1, p2]);
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(1);
  });

  it("growing-tail latch — a loadNewer after an empty forward page is a no-op (no storm)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessagesAfter).mockResolvedValue([]);
    const scrollback = await import("../lib/scrollback");
    seedTail(scrollback, 100);
    // Empty forward page = the local tail IS the live server tail → latch.
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(1);
    // Latched: subsequent scroll-to-bottom events must NOT re-fetch — this
    // is the anti-storm guarantee at a busy live tail.
    await scrollback.loadNewer("freenode", "#grappa");
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(1);
  });

  it("in-flight guard releases on resolve — a non-empty page lets the next call page the next chunk", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessagesAfter).mockResolvedValueOnce([mkRow(101)]);
    const scrollback = await import("../lib/scrollback");
    seedTail(scrollback, 100);
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(1);
    // Non-empty page → not latched → next scroll-to-bottom fires again,
    // paging from the NEW tail (101), not the stale seed (100).
    vi.mocked(api.listMessagesAfter).mockResolvedValueOnce([mkRow(102)]);
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.listMessagesAfter).mock.calls[1]).toEqual([
      "tok",
      "freenode",
      "#grappa",
      101,
      200,
    ]);
  });

  it("in-flight guard releases on REST error — a transient failure does not latch", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessagesAfter).mockRejectedValueOnce(new Error("boom"));
    const scrollback = await import("../lib/scrollback");
    seedTail(scrollback, 100);
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(1);
    // Error must NOT latch as exhausted — the user scrolls again, REST retries.
    vi.mocked(api.listMessagesAfter).mockResolvedValueOnce([]);
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(2);
  });

  it("a CAPPED refreshScrollback invalidates the tail latch; a SHORT page does not", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    seedTail(scrollback, 100);

    // Reach the tail: an empty forward page latches loadNewer.
    vi.mocked(api.listMessagesAfter).mockResolvedValueOnce([]);
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(1);
    // Latched — no fetch.
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(1);

    // A SHORT refresh page (< REFRESH_LIMIT) drained everything after the
    // resume cursor → no forward gap → the latch stays valid.
    mockGetResumeCursor.mockReturnValue(100);
    vi.mocked(api.listMessagesAfter).mockResolvedValueOnce([mkRow(101), mkRow(102)]);
    await scrollback.refreshScrollback("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(2);
    // Still latched → the next scroll-to-bottom is a no-op.
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(2);

    // A FULL-cap refresh page (=== REFRESH_LIMIT = 200) means the tail may
    // be further ahead (a >200-message reconnect) → invalidate the latch.
    const bigPage = Array.from({ length: 200 }, (_, i) => mkRow(200 + i));
    mockGetResumeCursor.mockReturnValue(102);
    vi.mocked(api.listMessagesAfter).mockResolvedValueOnce(bigPage);
    await scrollback.refreshScrollback("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(3);
    // Latch invalidated → the next scroll-to-bottom pages forward again.
    vi.mocked(api.listMessagesAfter).mockResolvedValueOnce([]);
    await scrollback.loadNewer("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(4);
  });
});

// CP29 R-5: refreshScrollback — refresh-on-WS-join-ok verb.
//
// Called from subscribe.ts's 5 join callbacks on EVERY successful
// per-channel join (initial + every auto-rejoin). Closes the cp13-S5
// race class. Tests cover the contract:
//   1. cursor source: getResumeCursor(slug, chan) drives the ?after=
//      param; null cursor = no fetch (cold-load owns seeding).
//   2. fetch shape: ?after=<cursor>&limit=200 ASC by id.
//   3. ingestion: each row goes through appendToScrollback (id-deduped).
//   4. in-flight guard: bursty rejoins converge to one REST request.
//   5. error tolerance: a transient REST error doesn't latch out
//      future retries.
//
// recordSeen mock from the module-level vi.mock is a no-op — the
// high-water-mark roll-forward behavior lives in reconnectBackfill.ts
// and is exercised by reconnectBackfill.test.ts.
describe("refreshScrollback (CP29 R-5)", () => {
  const sample = (id: number, body = "x"): ScrollbackMessage => ({
    id,
    network: "freenode",
    channel: "#grappa",
    server_time: id * 1000,
    kind: "privmsg",
    sender: "alice",
    body,
    meta: {},
  });

  beforeEach(() => {
    mockGetResumeCursor.mockReset();
    mockGetResumeCursor.mockReturnValue(null);
  });

  it("falls back to id=0 when getResumeCursor is null AND local pane is empty/absent", async () => {
    // CP29 R-5 cp13-S5 race shape: a freshly-opened window whose
    // resume-cursor sources are both null (no live high-water mark, no
    // server-side cursor) STILL fires a refresh from id=0 so a row
    // that landed during the WS-subscribe gap is recovered. The
    // append-by-id dedupe + the per-key in-flight guard make a
    // concurrent loadInitialScrollback safe.
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    mockGetResumeCursor.mockReturnValue(null);
    vi.mocked(api.listMessagesAfter).mockResolvedValue([]);

    await scrollback.refreshScrollback("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledWith("tok", "freenode", "#grappa", 0, 200);
  });

  it("uses the local pane's tail id when getResumeCursor is null but the pane has rows", async () => {
    // After the REST seed has landed but before any live row was
    // recordSeen'd: the high-water mark is null, the local pane has
    // the seed's tail. Resume from there to recover any row whose
    // persist landed AFTER the seed but BEFORE the WS-subscribe
    // completed.
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    const key = channelKey("freenode", "#grappa");
    scrollback.appendToScrollback(key, sample(11, "seed-tail"));
    mockGetResumeCursor.mockReturnValue(null);
    vi.mocked(api.listMessagesAfter).mockResolvedValue([]);

    await scrollback.refreshScrollback("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledWith("tok", "freenode", "#grappa", 11, 200);
  });

  it("is a no-op without a token", async () => {
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    mockGetResumeCursor.mockReturnValue(42);

    await scrollback.refreshScrollback("freenode", "#grappa");
    expect(api.listMessagesAfter).not.toHaveBeenCalled();
  });

  it("calls listMessagesAfter with the resume cursor + limit=200", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    mockGetResumeCursor.mockReturnValue(42);
    vi.mocked(api.listMessagesAfter).mockResolvedValue([]);

    await scrollback.refreshScrollback("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledWith("tok", "freenode", "#grappa", 42, 200);
  });

  it("appends each fetched row through appendToScrollback (id-deduped)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    mockGetResumeCursor.mockReturnValue(5);
    vi.mocked(api.listMessagesAfter).mockResolvedValue([
      sample(6, "missed-1"),
      sample(7, "missed-2"),
    ]);

    await scrollback.refreshScrollback("freenode", "#grappa");

    const key = channelKey("freenode", "#grappa");
    const list = scrollback.scrollbackByChannel()[key] ?? [];
    expect(list.map((m) => m.id)).toEqual([6, 7]);
  });

  it("dedupes rows whose id is already in the per-channel list", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    const key = channelKey("freenode", "#grappa");
    // Pre-seed via the live WS path; refresh then races the same id back.
    scrollback.appendToScrollback(key, sample(6, "live"));
    mockGetResumeCursor.mockReturnValue(5);
    vi.mocked(api.listMessagesAfter).mockResolvedValue([sample(6, "fetched-dupe")]);

    await scrollback.refreshScrollback("freenode", "#grappa");

    const list = scrollback.scrollbackByChannel()[key] ?? [];
    expect(list.length).toBe(1);
    // First-write wins (live arrival kept); the refresh row is dropped.
    expect(list[0]?.body).toBe("live");
  });

  it("guards against overlapping in-flight refreshes on the same topic", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    mockGetResumeCursor.mockReturnValue(5);

    let resolveFirst: (v: ScrollbackMessage[]) => void = () => {};
    const firstPromise = new Promise<ScrollbackMessage[]>((res) => {
      resolveFirst = res;
    });
    vi.mocked(api.listMessagesAfter).mockReturnValueOnce(firstPromise);

    const a = scrollback.refreshScrollback("freenode", "#grappa");
    const b = scrollback.refreshScrollback("freenode", "#grappa");

    expect(api.listMessagesAfter).toHaveBeenCalledTimes(1);

    resolveFirst([]);
    await Promise.all([a, b]);
  });

  it("releases the in-flight guard on REST error — subsequent refreshes can retry", async () => {
    localStorage.setItem("grappa-token", "tok");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    mockGetResumeCursor.mockReturnValue(5);

    vi.mocked(api.listMessagesAfter).mockRejectedValueOnce(new Error("network down"));
    await scrollback.refreshScrollback("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalled();

    vi.mocked(api.listMessagesAfter).mockResolvedValueOnce([]);
    await scrollback.refreshScrollback("freenode", "#grappa");
    expect(api.listMessagesAfter).toHaveBeenCalledTimes(2);

    consoleSpy.mockRestore();
  });
});

describe("purgeScrollback (UX-7-B 2026-05-22)", () => {
  it("drops scrollbackByChannel[key] for the targeted channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      {
        id: 1,
        network: "bahamut",
        channel: "#bofh",
        server_time: 100,
        kind: "privmsg",
        sender: "seed-bot",
        body: "seed line #1",
        meta: {},
      },
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("bahamut", "#bofh");

    const key = channelKey("bahamut", "#bofh");
    expect(scrollback.scrollbackByChannel()[key]).toHaveLength(1);

    scrollback.purgeScrollback(key);

    // The Solid signal returns a fresh map without the purged key.
    expect(scrollback.scrollbackByChannel()[key]).toBeUndefined();
  });

  it("clears the loaded-once gate so the next loadInitialScrollback refetches", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      {
        id: 1,
        network: "bahamut",
        channel: "#bofh",
        server_time: 100,
        kind: "privmsg",
        sender: "seed-bot",
        body: "seed line #1",
        meta: {},
      },
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("bahamut", "#bofh");
    expect(api.listMessages).toHaveBeenCalledTimes(1);

    // Without purge: second loadInitialScrollback would be a no-op.
    await scrollback.loadInitialScrollback("bahamut", "#bofh");
    expect(api.listMessages).toHaveBeenCalledTimes(1);

    // After purge: load-once gate reset, REST fires again.
    scrollback.purgeScrollback(channelKey("bahamut", "#bofh"));
    await scrollback.loadInitialScrollback("bahamut", "#bofh");
    expect(api.listMessages).toHaveBeenCalledTimes(2);
  });

  it("clears the load-more exhausted latch so a re-JOIN can paginate again", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValueOnce([
      {
        id: 5,
        network: "bahamut",
        channel: "#bofh",
        server_time: 500,
        kind: "privmsg",
        sender: "alice",
        body: "tail",
        meta: {},
      },
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("bahamut", "#bofh");

    // Latch the channel as exhausted via an empty loadMore.
    vi.mocked(api.listMessages).mockResolvedValueOnce([]);
    await scrollback.loadMore("bahamut", "#bofh");
    expect(api.listMessages).toHaveBeenCalledTimes(2);

    // Subsequent loadMore: exhausted latch short-circuits, no REST.
    await scrollback.loadMore("bahamut", "#bofh");
    expect(api.listMessages).toHaveBeenCalledTimes(2);

    // After purge + reseed: loadMore can fire again.
    scrollback.purgeScrollback(channelKey("bahamut", "#bofh"));
    vi.mocked(api.listMessages).mockResolvedValueOnce([
      {
        id: 6,
        network: "bahamut",
        channel: "#bofh",
        server_time: 600,
        kind: "privmsg",
        sender: "alice",
        body: "post-rejoin",
        meta: {},
      },
    ]);
    await scrollback.loadInitialScrollback("bahamut", "#bofh");
    vi.mocked(api.listMessages).mockResolvedValueOnce([]);
    await scrollback.loadMore("bahamut", "#bofh");
    expect(api.listMessages).toHaveBeenCalledTimes(4);
  });

  it("leaves other channels untouched", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockImplementation(async (_t, _slug, channel) => [
      {
        id: 1,
        network: "bahamut",
        channel,
        server_time: 100,
        kind: "privmsg" as const,
        sender: "alice",
        body: `body for ${channel}`,
        meta: {},
      },
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("bahamut", "#bofh");
    await scrollback.loadInitialScrollback("bahamut", "#sniffo");

    scrollback.purgeScrollback(channelKey("bahamut", "#bofh"));

    expect(scrollback.scrollbackByChannel()[channelKey("bahamut", "#bofh")]).toBeUndefined();
    expect(scrollback.scrollbackByChannel()[channelKey("bahamut", "#sniffo")]).toHaveLength(1);
  });

  it("is a no-op for keys the local tab never opened (sibling-tab race guard)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      {
        id: 1,
        network: "bahamut",
        channel: "#sniffo",
        server_time: 100,
        kind: "privmsg",
        sender: "alice",
        body: "sniffo line",
        meta: {},
      },
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("bahamut", "#sniffo");

    // Tab never opened #bofh via REST or WS — purge must NOT disturb
    // load-once gate for a channel this tab DID open (would mask a
    // sibling-tab race where #sniffo's mid-flight REST hadn't landed).
    scrollback.purgeScrollback(channelKey("bahamut", "#bofh"));

    // #sniffo still present + load-once gate held: second load is no-op.
    expect(scrollback.scrollbackByChannel()[channelKey("bahamut", "#sniffo")]).toHaveLength(1);
    await scrollback.loadInitialScrollback("bahamut", "#sniffo");
    expect(api.listMessages).toHaveBeenCalledTimes(1);
  });

  it("purges keys populated via the WS path (appendToScrollback only — no REST load-once gate)", async () => {
    // Regression guard: auto-joined channels populate
    // `scrollbackByChannel[key]` via `subscribe.ts:joinOk →
    // refreshScrollback → appendToScrollback` WITHOUT ever calling
    // `loadInitialScrollback`. If purgeScrollback gates only on the
    // load-once Set, these auto-joined cases leak ghosts on archive-
    // delete + re-JOIN (the original UX-7-B bug). The fix: gate on
    // signal-presence OR load-once-gate, not Set membership alone.
    localStorage.setItem("grappa-token", "tok");
    const scrollback = await import("../lib/scrollback");
    const key = channelKey("bahamut", "#bofh");
    scrollback.appendToScrollback(key, {
      id: 1,
      network: "bahamut",
      channel: "#bofh",
      server_time: 100,
      kind: "privmsg",
      sender: "seed-bot",
      body: "auto-joined seed line",
      meta: {},
    });
    expect(scrollback.scrollbackByChannel()[key]).toHaveLength(1);

    scrollback.purgeScrollback(key);

    expect(scrollback.scrollbackByChannel()[key]).toBeUndefined();
  });
});

// S20 (codebase review 2026-07-08) — the scrollback store only grew (append
// live, prepend history, append refresh); the only removals were
// archive-delete + identity reset. A PWA kept open for days accumulated
// every live message in memory with no cap. Fix: a per-channel ring cap on
// the LIVE-append path (`appendToScrollback`) that evicts the OLDEST rows —
// but NEVER a row at/after the read cursor, so the in-pane `── XX unread ──`
// divider (anchored on the cursor) and its unread rows are always preserved.
// An eviction also resets the `loadMore` exhausted latch so scroll-up can
// re-page the now-missing older history.
describe("appendToScrollback — S20 per-channel ring cap", () => {
  const mkRow = (id: number): import("../lib/api").ScrollbackMessage => ({
    id,
    network: "freenode",
    channel: "#grappa",
    server_time: id,
    kind: "privmsg",
    sender: "peer",
    body: `line ${id}`,
    meta: {},
  });

  it("caps the per-channel ring, evicting the OLDEST rows when no cursor gates eviction", async () => {
    localStorage.setItem("grappa-token", "tok");
    mockGetReadCursor.mockReturnValue(null); // no divider → free eviction
    const scrollback = await import("../lib/scrollback");
    const cap = scrollback.SCROLLBACK_RING_CAP;
    const key = channelKey("freenode", "#grappa");
    const total = cap + 50;
    for (let i = 1; i <= total; i++) scrollback.appendToScrollback(key, mkRow(i));
    const rows = scrollback.scrollbackByChannel()[key] ?? [];
    expect(rows.length).toBe(cap);
    // Oldest 50 evicted; the newest row is retained (live tail).
    expect(rows[0]?.id).toBe(51);
    expect(rows[rows.length - 1]?.id).toBe(total);
  });

  it("never evicts a row at/after the read cursor (unread divider boundary is preserved)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const scrollback = await import("../lib/scrollback");
    const cap = scrollback.SCROLLBACK_RING_CAP;
    const key = channelKey("freenode", "#grappa");
    // Cursor near the very start → almost the whole buffer is "unread"
    // (id > cursor). Appending well past the cap must NOT drop any row
    // with id >= cursor — dropping the boundary would break the divider.
    const cursor = 5;
    mockGetReadCursor.mockReturnValue(cursor);
    const total = cap + 200;
    for (let i = 1; i <= total; i++) scrollback.appendToScrollback(key, mkRow(i));
    const ids = (scrollback.scrollbackByChannel()[key] ?? []).map((m) => m.id);
    // The divider anchor (the cursor row) + every unread row survive, even
    // though that leaves the buffer temporarily above the cap.
    expect(ids).toContain(cursor);
    for (let i = cursor; i <= total; i++) expect(ids).toContain(i);
    // Only the read rows below the cursor (id < cursor) are evictable.
    expect(ids).not.toContain(1);
    expect(ids).not.toContain(cursor - 1);
  });

  it("resets the loadMore exhausted latch on eviction so scroll-up can re-page older history", async () => {
    localStorage.setItem("grappa-token", "tok");
    mockGetReadCursor.mockReturnValue(null);
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    const cap = scrollback.SCROLLBACK_RING_CAP;
    const key = channelKey("freenode", "#grappa");
    scrollback.appendToScrollback(key, mkRow(1));
    // Latch loadMore as exhausted (server has no older history yet).
    vi.mocked(api.listMessages).mockResolvedValueOnce([]);
    await scrollback.loadMore("freenode", "#grappa");
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    // Latched: a second loadMore is a no-op.
    await scrollback.loadMore("freenode", "#grappa");
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    // Grow past the cap so eviction fires → the seed (id 1) is dropped, so
    // there IS older history again → the exhausted latch must clear.
    for (let i = 2; i <= cap + 5; i++) scrollback.appendToScrollback(key, mkRow(i));
    expect(scrollback.scrollbackByChannel()[key]?.some((m) => m.id === 1)).toBe(false);
    vi.mocked(api.listMessages).mockResolvedValueOnce([]);
    await scrollback.loadMore("freenode", "#grappa");
    expect(api.listMessages).toHaveBeenCalledTimes(2);
  });
});
