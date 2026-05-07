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
  sendMessage: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setOn401Handler: vi.fn(),
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

  it("loadMore fetches with before=oldest_server_time and prepends older entries", async () => {
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
    expect(api.listMessages).toHaveBeenLastCalledWith("tok", "freenode", "#grappa", 500);
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
