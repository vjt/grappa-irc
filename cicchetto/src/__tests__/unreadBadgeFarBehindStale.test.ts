import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GapProbe, ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// issue 2050 — a badge that no in-session gesture can clear, clean again after
// an app restart.
//
// The #693 far-behind record says "the unread region is NOT in this pane". Two
// consumers act on it: `selection.ts`'s `perChannelUnread` discards local truth
// and publishes a frozen server-side number instead, and `setCursorIfAdvances`
// FREEZES the read cursor. Both are right only while the cursor is still where
// it was when the record was written.
//
// WHICH frozen number moved under this file while it was being written. Until
// #2037 (landed 2026-09-10) the badge published `serverSeedCounts[key]`; it now
// publishes the far-behind record's OWN `missed`, so the record is not merely
// the gate on a frozen figure, it CARRIES it. Same defect, and the same cure —
// retiring the record releases both readings — which is why nothing here had to
// change but the wording and the fake's probe shape.
//
// It does not stay there. Two doors move the cursor without passing through the
// frozen one, and neither tells the far-behind record:
//
//   * `scrollback.sendMessage` — a DIRECT `setReadCursor`, deliberately not
//     routed through `setCursorIfAdvances` (import cycle; see its comment). So
//     it inherits neither the freeze nor any far-behind exit. Talking in the
//     window is enough, on ONE device.
//   * `applyReadCursorSet` — the cross-device echo, unconditional by contract.
//     A peer device reading the channel moves this device's cursor.
//
// Once either fires, the cursor is at the tip and nothing is unread — but the
// record still stands, so the badge keeps publishing a number taken at the
// moment of the decision, which nothing moves while the socket stays up (the
// seed is written only by a join reply or a `/me`; `missed` only by a ring-cap
// bite). Hence: unclearable in-session, clean after a restart (both stores are
// in-memory).
//
// These tests assert the OUTCOME — the badge, and whether the pane still offers
// a "jump back" bar — not the sequence of calls that produces it. They run the
// REAL scrollback + readCursor + selection stores against a fake server that
// honours `after` / `before` / `limit` and whose cursor the POST actually
// moves; a server that ignored its arguments would arm and clear far-behind for
// reasons of its own.
//
// Deliberately threshold-agnostic: every arm that moves the CURSOR leaves it at
// the channel TIP, where every candidate invalidation rule agrees. The rule
// itself (which bound retires the record) is a separate decision and no
// assertion in those arms depends on it.
//
// The last arm moves the WINDOW instead, with the cursor standing still, and it
// is the one place a bound is asserted at all — but on the record's own terms
// ("the unread region is not in this pane") rather than on any arithmetic:
// page the whole region back in and the record must be gone, page part of it
// and the record must stand. That is the caveat the chosen bound was accepted
// with, measured instead of argued.
//
// What these tests do NOT cover: the browser. This is store-level — jsdom gives
// the pane no geometry, so the read-at-the-tail door is driven through its
// published verb rather than by scrolling, and no assertion here says the fix
// reaches a rendered badge.

vi.mock(import("../lib/api"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listNetworks: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([]),
    listMessages: vi.fn(),
    listMessagesAfter: vi.fn(),
    countMessagesAfter: vi.fn(),
    sendMessage: vi.fn(),
    me: vi.fn().mockResolvedValue({
      kind: "user",
      id: "u-test",
      name: "vjt",
      is_admin: false,
      inserted_at: "2026-01-01T00:00:00Z",
      read_cursors: {},
    }),
    login: vi.fn(),
    logout: vi.fn(),
    setOn401Handler: vi.fn(),
  };
});

const SLUG = "azzurra";
const CHANNEL = "#grappa";
const KEY = channelKey(SLUG, CHANNEL);
const DEFAULT_PAGE = 50;
const CAUGHT_UP_AT = 1000;
// #1094's prepend seam is the pane's scroll-geometry compensation. A store-level
// test has no geometry to preserve, and `loadMore` documents `undefined` as a
// legitimate answer, so the seam opens onto nothing here. Same spelling as
// `scrollback.test.ts` / `scrollbackIngestCost.test.ts`.
const noSeam = (): undefined => undefined;
// A bound on the scroll-up loop below: the fake log is 6000 rows, so 120 pages
// covers all of it. Reaching this means paging stopped making progress — a red
// with a stack, not a five-second hang.
const PAGE_BUDGET = 200;

const row = (id: number, sender: string): ScrollbackMessage => ({
  id,
  network: SLUG,
  channel: CHANNEL,
  server_time: id,
  kind: "privmsg",
  sender,
  body: `m${id}`,
  meta: {},
});

/** Rows 1..tip, plus the server-side read cursor the POST moves. */
class FakeServer {
  constructor(
    public tip: number,
    public cursor: number,
  ) {}

  listMessages(before?: number): ScrollbackMessage[] {
    const hi = before === undefined ? this.tip : Math.min(this.tip, before - 1);
    const lo = Math.max(1, hi - DEFAULT_PAGE + 1);
    const out: ScrollbackMessage[] = [];
    for (let i = hi; i >= lo; i--) out.push(row(i, "bob"));
    return out;
  }

  listMessagesAfter(after: number, limit: number): ScrollbackMessage[] {
    const out: ScrollbackMessage[] = [];
    for (let i = after + 1; i <= this.tip && out.length < limit; i++) out.push(row(i, "bob"));
    return out;
  }

  // #2037 — the probe answers THREE numbers, not one: `gap` (raw rows, what
  // decides far-behind) and the `messages`/`events` split (what gets rendered).
  // Every row this log serves is a privmsg, so the split is degenerate here by
  // construction — which is the honest fake for THIS log, not a shortcut: an
  // events figure would have to come from rows the fake never produces.
  countMessagesAfter(after: number): GapProbe {
    const gap = Math.max(0, this.tip - after);
    return { gap, messages: gap, events: 0 };
  }
}

let server: FakeServer;

const wireServer = async (): Promise<void> => {
  const api = await import("../lib/api");
  vi.mocked(api.listMessages).mockImplementation(async (_t, _s, _c, before) =>
    server.listMessages(before),
  );
  vi.mocked(api.listMessagesAfter).mockImplementation(async (_t, _s, _c, after, limit) =>
    server.listMessagesAfter(after, limit ?? DEFAULT_PAGE),
  );
  vi.mocked(api.countMessagesAfter).mockImplementation(async (_t, _s, _c, after) =>
    server.countMessagesAfter(after),
  );
  // `readCursor.setReadCursor` POSTs through raw `fetch`. Stub the transport,
  // not the module: the optimistic local advance under test lives inside it.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      const id = JSON.parse(init.body).message_id as number;
      if (id > server.cursor) server.cursor = id;
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
};

/** What `subscribe.ts` does on every per-channel join, initial AND rejoin. */
const joinChannelTopic = async (): Promise<void> => {
  const { applyJoinReply } = await import("../lib/readCursor");
  const { setServerSeedCount } = await import("../lib/selection");
  applyJoinReply(SLUG, CHANNEL, server.cursor);
  const probe = server.countMessagesAfter(server.cursor);
  setServerSeedCount(KEY, { messages: probe.messages, events: probe.events });
};

/**
 * The reported setup: a long absence has left thousands of rows behind, the
 * socket comes back, and `refreshScrollback` drives the window into #693's
 * far-behind state. Returns once the state is armed.
 */
const absenceThenReconnect = async (): Promise<void> => {
  const { refreshScrollback, farBehindByChannel } = await import("../lib/scrollback");
  await joinChannelTopic();
  await refreshScrollback(SLUG, CHANNEL);
  // The arm is the premise of every assertion below, not a claim of its own.
  expect(farBehindByChannel()[KEY]).toBeDefined();
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
  localStorage.setItem("grappa-token", "tok");
  server = new FakeServer(6000, CAUGHT_UP_AT);
});

describe("issue 2050 — a far-behind badge the cursor has already retired", () => {
  it("drops the badge once the operator's own send carries the cursor to the tip", async () => {
    await wireServer();
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    const selection = await import("../lib/selection");
    const { getReadCursor } = await import("../lib/readCursor");
    await absenceThenReconnect();
    expect(selection.messagesUnread()[KEY]).toBe(5000);

    // The operator says something in the window. `sendMessage` advances the
    // cursor with a direct `setReadCursor`, so the #693 freeze does not apply.
    server.tip = 6001;
    vi.mocked(api.sendMessage).mockResolvedValue(row(6001, "vjt"));
    await scrollback.sendMessage(SLUG, CHANNEL, "ciao");

    // Both sides agree the channel is read to the tip...
    expect(getReadCursor(SLUG, CHANNEL)).toBe(6001);
    expect(server.cursor).toBe(6001);
    expect(server.countMessagesAfter(server.cursor).gap).toBe(0);
    // ...so there is nothing left to badge.
    expect(selection.messagesUnread()[KEY]).toBeUndefined();
  });

  it("drops the badge when a PEER DEVICE reads the channel to the tip", async () => {
    await wireServer();
    const selection = await import("../lib/selection");
    const { applyReadCursorSet, getReadCursor } = await import("../lib/readCursor");
    await absenceThenReconnect();
    expect(selection.messagesUnread()[KEY]).toBe(5000);

    // The laptop reads it all; the server fans `read_cursor_set` to the phone.
    // This is the arm that makes routing the SEND through the far-behind exit
    // insufficient on its own — no gesture happened on this device at all.
    server.cursor = 6000;
    applyReadCursorSet(SLUG, CHANNEL, 6000);

    expect(getReadCursor(SLUG, CHANNEL)).toBe(6000);
    expect(selection.messagesUnread()[KEY]).toBeUndefined();
  });

  it("stops offering 'jump back' once the cursor has consumed the region", async () => {
    await wireServer();
    const scrollback = await import("../lib/scrollback");
    const { applyReadCursorSet } = await import("../lib/readCursor");
    await absenceThenReconnect();

    server.cursor = 6000;
    applyReadCursorSet(SLUG, CHANNEL, 6000);

    // A test that watches only the badge lets this through: the record can be
    // hidden from the count and still stand, which leaves the pane showing a
    // "5000 unread — jump back" bar over a fully-read window AND keeps the
    // cursor frozen for every writer that goes through `setCursorIfAdvances`.
    expect(scrollback.farBehindByChannel()[KEY]).toBeUndefined();
  });

  it("keeps the badge and the bar while the cursor is still behind the region", async () => {
    await wireServer();
    const scrollback = await import("../lib/scrollback");
    const selection = await import("../lib/selection");
    const { applyReadCursorSet } = await import("../lib/readCursor");
    await absenceThenReconnect();

    // A cursor that moved but is still deep inside the abandoned region. The
    // operator is thousands behind and the affordance is the only way back:
    // retiring the record here is the destructive move #693 exists to refuse.
    // The id is far below every candidate invalidation bound, so this arm
    // does not take a side in that choice.
    server.cursor = CAUGHT_UP_AT + 1;
    applyReadCursorSet(SLUG, CHANNEL, CAUGHT_UP_AT + 1);

    expect(scrollback.farBehindByChannel()[KEY]).toBeDefined();
    expect(selection.messagesUnread()[KEY]).toBe(5000);
  });

  it("retires the record when scroll-up re-pages the region, and thaws without marking it read", async () => {
    await wireServer();
    const scrollback = await import("../lib/scrollback");
    const selection = await import("../lib/selection");
    const { getReadCursor } = await import("../lib/readCursor");
    await absenceThenReconnect();

    // The other axis. Every arm above moves the CURSOR up to the region; this
    // one leaves the cursor exactly where the absence left it and moves the
    // WINDOW down to the region instead — the operator scrolls up. `loadMore`
    // prepends OLDER rows, so it lowers the oldest loaded id, and paging far
    // enough back therefore satisfies the invalidation bound with nothing
    // having been read. That is the caveat the bound was accepted with, and
    // this arm is the measurement it was accepted WITHOUT.
    //
    // Three rows land live while the operator is still away from the tail —
    // the channel does not stop talking because someone is scrolling. Safe
    // under the #1229 ceiling: the pane holds one tail page, so the unread it
    // HOLDS is ~50, an order of magnitude under the cap that would collapse
    // the window.
    for (let id = 6001; id <= 6003; id++) {
      server.tip = id;
      scrollback.appendToScrollback(KEY, row(id, "bob"));
    }
    // 🔴 issue 2069 — these two lines expected 5000, and the comment called
    // that "demonstrably frozen: 5003 rows are unread and the badge says
    // 5000". It was demonstrating the DRIFT: the far-behind count grew by what
    // the ring cap EVICTED rather than by what arrived, so below the retention
    // cap three arrivals moved it by nothing. It is 5003 because three rows
    // arrived, and it says so at once instead of waiting for the next full
    // `?after=` page to fire the gap probe and correct it in one visible step.
    //
    // The arm loses a discriminator it used to lean on — the frozen number and
    // local truth are now the same number, so they cannot be told apart by
    // VALUE. That is what `farBehindByChannel()[KEY]` is asserted for directly
    // below, and a state assertion was always the better witness of "the
    // record still stands".
    expect(selection.messagesUnread()[KEY]).toBe(5003);

    // One page up is not enough and must not be — the pane still starts
    // thousands of rows above the read position, so the region is still
    // elsewhere. Without this step the arm cannot tell "retires when the hole
    // closes" from "retires as soon as you scroll".
    await scrollback.loadMore(SLUG, CHANNEL, noSeam);
    expect(scrollback.farBehindByChannel()[KEY]).toBeDefined();
    expect(selection.messagesUnread()[KEY]).toBe(5003);

    // Keep scrolling until the record lets go. The loop asserts no arithmetic
    // — the exit is the record's own state — so it holds for any bound that
    // honours what the record claims.
    let pages = 1;
    while (scrollback.farBehindByChannel()[KEY] !== undefined) {
      expect(pages).toBeLessThan(PAGE_BUDGET);
      await scrollback.loadMore(SLUG, CHANNEL, noSeam);
      pages++;
    }

    // Nothing was read: the cursor sits where the absence left it, on both
    // sides. Retiring the record THAWS — it stops the badge publishing the
    // frozen seed and hands the count back to local truth — it does not mark
    // anything read, and an implementation that "cleared the unread" by moving
    // the cursor would fail here rather than in some later session.
    expect(getReadCursor(SLUG, CHANNEL)).toBe(CAUGHT_UP_AT);
    expect(server.cursor).toBe(CAUGHT_UP_AT);

    // And local truth is the WHOLE region, not a slice of it: the record held
    // until every unread row was back in the pane. A bound that fired early
    // would leave the pane holed, local truth would be short, and the badge
    // would UNDER-report — which is the destructive unfreeze the far-behind
    // apparatus exists to refuse. (Pre-2069 this line ALSO said "no longer the
    // frozen seed", by being a different number from it. It cannot say that
    // any more — the two agree now — so the loop's exit condition above is
    // what carries "the record retired".)
    expect(selection.messagesUnread()[KEY]).toBe(5003);
  });

  it("keeps the record when an in-flight loadMore page lands after the pane re-anchored", async () => {
    await wireServer();
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");
    const { getReadCursor } = await import("../lib/readCursor");

    // The e2e (#1062) found this and it is a RACE, so it is pinned here where
    // the order is decided rather than raced: 3 reds in 5 runs there, 3/3
    // green with the guard, and every red rendering the SAME pane — rows
    // 1..22 and 212..260, a 189-row hole, with the "jump back" bar gone.
    //
    // `loadMore` computes its page as "older than the current head" and the
    // page only abuts the pane while that row IS still the head. `anchorAtTail`
    // (#693) replaces the whole window mid-flight, so the late page splices two
    // non-adjacent regions — the silent hole `anchorAtTail` refuses to create
    // and #1538 made an invariant of every path. The far-behind record is then
    // read off a pane whose `rows[0]` is BELOW the cursor with the region still
    // missing, which is exactly the false premise the bound cannot detect from
    // the inside.
    //
    // Hold the older page on the wire until the re-anchor has happened.
    let releaseOlder: (() => void) | null = null;
    vi.mocked(api.listMessages).mockImplementation(async (_t, _s, _c, before) => {
      if (before === undefined) return server.listMessages(undefined);
      return new Promise((resolve) => {
        releaseOlder = () => resolve(server.listMessages(before));
      });
    });

    // A window that is behind but NOT far behind: the resume drains it, so the
    // pane holds a contiguous region above the cursor and no record is armed.
    server.tip = CAUGHT_UP_AT + 250;
    await joinChannelTopic();
    await scrollback.refreshScrollback(SLUG, CHANNEL);
    expect(scrollback.farBehindByChannel()[KEY]).toBeUndefined();
    const headBefore = scrollback.scrollbackByChannel()[KEY]?.[0]?.id;
    expect(headBefore).toBe(CAUGHT_UP_AT + 1);

    // The operator scrolls up: the request goes out against THAT head.
    const older = scrollback.loadMore(SLUG, CHANNEL, noSeam);
    expect(releaseOlder).not.toBeNull();

    // While it is on the wire the channel floods and the next resume gives up
    // on contiguity: the window is replaced by the tail page and armed.
    server.tip = 6000;
    await scrollback.refreshScrollback(SLUG, CHANNEL);
    expect(scrollback.farBehindByChannel()[KEY]).toBeDefined();

    // Now the older page lands. It describes a window the pane has left.
    (releaseOlder as unknown as () => void)();
    await older;

    // The record stands — nothing has been recovered, and the operator still
    // has the only affordance that leads back to the region.
    expect(scrollback.farBehindByChannel()[KEY]).toBeDefined();
    expect(getReadCursor(SLUG, CHANNEL)).toBe(CAUGHT_UP_AT);

    // And the reason it stands: the pane was never holed. Asserted as the
    // general invariant rather than as "the page was dropped" — a future verb
    // that re-pages the region properly must be allowed to pass this.
    const ids = (scrollback.scrollbackByChannel()[KEY] ?? []).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    const gaps = ids.filter((id, i) => i > 0 && id !== (ids[i - 1] ?? 0) + 1);
    expect(gaps).toEqual([]);
  });
});
