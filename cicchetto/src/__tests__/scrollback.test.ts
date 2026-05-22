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

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("scrollback verbs", () => {
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
