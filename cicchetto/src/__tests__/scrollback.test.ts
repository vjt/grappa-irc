import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Network, ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// Boundary: mock REST (`lib/api`) + `lib/networks` (for own-nick
// resolution used by the own-nick query filter). `scrollback.ts`
// exposes pure verbs (`loadInitialScrollback`, `loadMore`,
// `sendMessage`, `appendToScrollback`) that read/write the per-channel
// signal store without any WS coupling — the WS path is exercised by
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

// Default: one network "freenode" with no nick (most existing tests
// don't set own-nick and shouldn't be affected by the filter).
// Own-nick filter tests override via seedNetworkWithNick() helper.
vi.mock("../lib/networks", () => ({
  networks: vi.fn(() => [{ id: 1, slug: "freenode", inserted_at: "x", updated_at: "y" }]),
  user: vi.fn(() => null),
  channelsBySlug: vi.fn(() => ({})),
  refetchChannels: vi.fn(),
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
// Own-nick query filter — shouldKeepInOwnNickQuery
// ---------------------------------------------------------------------------
//
// When the scrollback channel key targets the operator's own IRC nick
// (i.e. the query "window" is the operator talking to themselves),
// REST history must only show self-msg rows (kind=privmsg/action,
// sender===ownNick). NOTICEs from services/servers AND inbound PRIVMSGs
// from other nicks must be filtered out — they are history-pollution
// artefacts from the server-side persistence keying (IRC PRIVMSG/NOTICE
// to target="grappa" is stored as channel="grappa" regardless of source).
//
// The filter is applied in `loadInitialScrollback` (REST page) and
// `appendToScrollback` (live WS defensive gate).

// Helper: build a minimal ScrollbackMessage with sensible defaults.
const msg = (
  overrides: Partial<ScrollbackMessage> & { kind: ScrollbackMessage["kind"] },
): ScrollbackMessage => ({
  id: 1,
  network: "freenode",
  channel: "grappa",
  server_time: 100,
  sender: "grappa",
  body: "hi",
  meta: {},
  ...overrides,
});

describe("shouldKeepInOwnNickQuery — unit (via loadInitialScrollback filter)", () => {
  // These tests drive the filter by seeding listMessages with rows that
  // should be filtered and asserting they never appear in the store.
  // The network mock supplies own-nick = "grappa" for slug "freenode".

  const seedNetworkWithNick = async (nick: string) => {
    const nets = await import("../lib/networks");
    // networks is a SolidJS Resource — cast to MockedFunction to seed
    // the return value for the own-nick resolution in scrollback.ts.
    (nets.networks as unknown as { mockReturnValue(v: Network[]): void }).mockReturnValue([
      { id: 1, slug: "freenode", nick, inserted_at: "x", updated_at: "y" },
    ]);
  };

  it("keeps self-msg (kind=privmsg, sender=ownNick) in own-nick query window", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedNetworkWithNick("grappa");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      msg({ id: 1, kind: "privmsg", sender: "grappa", body: "self-msg" }),
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("freenode", "grappa");
    const key = channelKey("freenode", "grappa");
    expect(scrollback.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([1]);
  });

  it("keeps self-action (kind=action, sender=ownNick) in own-nick query window", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedNetworkWithNick("grappa");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      msg({ id: 2, kind: "action", sender: "grappa", body: "/me does thing" }),
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("freenode", "grappa");
    const key = channelKey("freenode", "grappa");
    expect(scrollback.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([2]);
  });

  it("filters NOTICE from NickServ (service) out of own-nick query window", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedNetworkWithNick("grappa");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      msg({ id: 3, kind: "notice", sender: "NickServ", body: "identify your nick" }),
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("freenode", "grappa");
    const key = channelKey("freenode", "grappa");
    expect(scrollback.scrollbackByChannel()[key]).toEqual([]);
  });

  it("filters NOTICE from server hostname (sender contains dot) out of own-nick query window", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedNetworkWithNick("grappa");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      msg({ id: 4, kind: "notice", sender: "raccooncity.azzurra.chat", body: "welcome" }),
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("freenode", "grappa");
    const key = channelKey("freenode", "grappa");
    expect(scrollback.scrollbackByChannel()[key]).toEqual([]);
  });

  it("filters inbound PRIVMSG from another user out of own-nick query window", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedNetworkWithNick("grappa");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      msg({ id: 5, kind: "privmsg", sender: "vjt", body: "hey grappa" }),
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("freenode", "grappa");
    const key = channelKey("freenode", "grappa");
    expect(scrollback.scrollbackByChannel()[key]).toEqual([]);
  });

  it("does not filter own-nick query window when network.nick is absent (visitor case)", async () => {
    localStorage.setItem("grappa-token", "tok");
    // Network has no nick field — visitor / unknown: no filter applied.
    const nets = await import("../lib/networks");
    (nets.networks as unknown as { mockReturnValue(v: Network[]): void }).mockReturnValue([
      { id: 1, slug: "freenode", inserted_at: "x", updated_at: "y" },
    ]);
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      msg({ id: 6, kind: "notice", sender: "NickServ", body: "identify" }),
    ]);
    const scrollback = await import("../lib/scrollback");
    // Channel name "grappa" but no nick configured → pass through.
    await scrollback.loadInitialScrollback("freenode", "grappa");
    const key = channelKey("freenode", "grappa");
    expect(scrollback.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([6]);
  });

  it("does not filter regular channel scrollback (non-own-nick target)", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedNetworkWithNick("grappa");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      msg({ id: 7, kind: "notice", sender: "ChanServ", channel: "#grappa", body: "welcome" }),
    ]);
    const scrollback = await import("../lib/scrollback");
    // "#grappa" !== "grappa" → not own-nick key → no filter.
    await scrollback.loadInitialScrollback("freenode", "#grappa");
    const key = channelKey("freenode", "#grappa");
    expect(scrollback.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([7]);
  });

  it("mixes kept + filtered rows — only self-msgs survive", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedNetworkWithNick("grappa");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([
      msg({ id: 10, kind: "privmsg", sender: "grappa", body: "my note" }),
      msg({ id: 11, kind: "notice", sender: "NickServ", body: "hi" }),
      msg({ id: 12, kind: "privmsg", sender: "vjt", body: "inbound dm" }),
      msg({ id: 13, kind: "action", sender: "grappa", body: "stretches" }),
    ]);
    const scrollback = await import("../lib/scrollback");
    await scrollback.loadInitialScrollback("freenode", "grappa");
    const key = channelKey("freenode", "grappa");
    expect(scrollback.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([10, 13]);
  });
});

describe("appendToScrollback — own-nick query filter (defensive WS gate)", () => {
  const seedNetworkWithNick = async (nick: string) => {
    const nets = await import("../lib/networks");
    (nets.networks as unknown as { mockReturnValue(v: Network[]): void }).mockReturnValue([
      { id: 1, slug: "freenode", nick, inserted_at: "x", updated_at: "y" },
    ]);
  };

  it("drops NOTICE appended to own-nick query channel key", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedNetworkWithNick("grappa");
    const scrollback = await import("../lib/scrollback");
    const key = channelKey("freenode", "grappa");
    scrollback.appendToScrollback(
      key,
      msg({ id: 20, kind: "notice", sender: "NickServ", body: "identify" }),
    );
    expect(scrollback.scrollbackByChannel()[key] ?? []).toEqual([]);
  });

  it("drops inbound PRIVMSG from other user appended to own-nick query channel key", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedNetworkWithNick("grappa");
    const scrollback = await import("../lib/scrollback");
    const key = channelKey("freenode", "grappa");
    scrollback.appendToScrollback(
      key,
      msg({ id: 21, kind: "privmsg", sender: "vjt", body: "hey" }),
    );
    expect(scrollback.scrollbackByChannel()[key] ?? []).toEqual([]);
  });

  it("keeps self-msg appended to own-nick query channel key", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedNetworkWithNick("grappa");
    const scrollback = await import("../lib/scrollback");
    const key = channelKey("freenode", "grappa");
    scrollback.appendToScrollback(
      key,
      msg({ id: 22, kind: "privmsg", sender: "grappa", body: "my-note" }),
    );
    expect(scrollback.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([22]);
  });

  it("passes through all messages on non-own-nick channel keys", async () => {
    localStorage.setItem("grappa-token", "tok");
    await seedNetworkWithNick("grappa");
    const scrollback = await import("../lib/scrollback");
    const key = channelKey("freenode", "#grappa");
    scrollback.appendToScrollback(
      key,
      msg({ id: 23, kind: "notice", sender: "ChanServ", channel: "#grappa", body: "welcome" }),
    );
    expect(scrollback.scrollbackByChannel()[key]?.map((m) => m.id)).toEqual([23]);
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
