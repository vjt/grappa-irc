import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GapProbe, MessageKind, ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// issue 2069 — "how many rows are behind my cursor in this window", answered
// by variables that disagree with each other and move on their own.
//
// Two of the three reported symptoms are reproduced HERE, at the store level,
// against the REAL scrollback + readCursor + selection stores and a fake
// server that honours `after` / `before` / `limit` and answers a probe from
// the same log it serves. A server that ignored its arguments would arm and
// clear far-behind for reasons of its own, and every number below would be
// the fake's rather than the store's.
//
// The oracle in every arm is the SERVER'S OWN ANSWER for the cursor the store
// currently holds (`server.countMessagesAfter(cursor).messages`), not a
// literal. A literal would pin the arithmetic of the fixture; the server
// answer pins the PROPERTY — the badge says what is actually behind the
// cursor — and it stays true when the fixture is edited.
//
// The third symptom (the in-pane divider and the sidebar badge counting
// different populations) is not here: the divider is a projection of
// `ScrollbackPane`, and its arms live in that file's suite, over the same
// four fixtures. The predicate both surfaces now share is pinned on its own
// in `unreadCount.test.ts`.
//
// WHAT THESE TESTS DO NOT COVER: the browser. jsdom gives the pane no
// geometry, so the read-at-the-tail cursor arm is driven through the
// cross-device echo instead of by scrolling, and nothing here says the
// numbers reach a rendered badge. That is the e2e's job.

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

// A MIXED log — every fourth id is a peer JOIN, the rest are peer messages.
// An all-content log cannot see a unit mismatch at all, and it also cannot see
// the accumulator bug in arm A: that one adds the kind of the row it EVICTS,
// which is indistinguishable from the kind of the row that arrived when every
// row has the same kind.
const kindOf = (id: number): MessageKind => (id % 4 === 0 ? "join" : "privmsg");

const row = (id: number): ScrollbackMessage => ({
  id,
  network: SLUG,
  channel: CHANNEL,
  server_time: id,
  kind: kindOf(id),
  sender: "bob",
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
    for (let i = hi; i >= lo; i--) out.push(row(i));
    return out;
  }

  listMessagesAfter(after: number, limit: number): ScrollbackMessage[] {
    const out: ScrollbackMessage[] = [];
    for (let i = after + 1; i <= this.tip && out.length < limit; i++) out.push(row(i));
    return out;
  }

  /** The three numbers `count_after_split/6` returns, over this same log. */
  countMessagesAfter(after: number): GapProbe {
    let gap = 0;
    let messages = 0;
    for (let i = after + 1; i <= this.tip; i++) {
      gap++;
      if (kindOf(i) === "privmsg") messages++;
    }
    return { gap, messages, events: gap - messages };
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
  // not the module: the optimistic local advance lives inside it.
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

/** The badge the sidebar renders for this window, right now. */
const badge = async (): Promise<number> => {
  const selection = await import("../lib/selection");
  return selection.messagesUnread()[KEY] ?? 0;
};

/** What the server would answer for the cursor the store currently holds. */
const truth = async (): Promise<number> => {
  const { getReadCursor } = await import("../lib/readCursor");
  return server.countMessagesAfter(getReadCursor(SLUG, CHANNEL) ?? 0).messages;
};

/**
 * A long absence drove this window into #693's far-behind state. Returns once
 * the state is armed — the premise of the arms below, not a claim of their own.
 */
const absenceThenReconnect = async (): Promise<void> => {
  const { refreshScrollback, farBehindByChannel } = await import("../lib/scrollback");
  await joinChannelTopic();
  await refreshScrollback(SLUG, CHANNEL);
  expect(farBehindByChannel()[KEY]).toBeDefined();
};

/**
 * Re-selecting an already-loaded window. `selection.ts`'s `selectedChannel`
 * effect fires exactly this verb for that gesture (the load-once
 * `loadInitialScrollback` fetches nothing on a second visit), so this is the
 * gesture and not an approximation of it.
 */
const reSelect = async (): Promise<void> => {
  const { refreshScrollback } = await import("../lib/scrollback");
  await refreshScrollback(SLUG, CHANNEL);
};

/** Live rows landing on the per-channel WS topic while the operator is away. */
const peerTraffic = async (n: number): Promise<void> => {
  const { appendToScrollback } = await import("../lib/scrollback");
  for (let i = 0; i < n; i++) {
    server.tip += 1;
    appendToScrollback(KEY, row(server.tip));
  }
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
  server = new FakeServer(6000, 1000);
});

// SYMPTOM A, as reported: "open a channel with hundreds unread → 500. Do not
// scroll. Select another window, then re-select the first → 800."
//
// Measured on `b7989f4ba`, this is TWO defects and the accusation in the issue
// named neither. A bare re-select with no traffic moves nothing. What moves is:
//
//   1. while the operator is away, `appendPageToScrollback` accumulates the
//      far-behind count by the CONTENT-NESS OF THE ROW IT EVICTED rather than
//      of the row that arrived — and adds nothing at all until the store
//      reaches `UNREAD_RETENTION_CAP`, so the count drifts BELOW the truth
//      (measured: 4012 against a true 4125 after 500 rows);
//   2. the re-select's `?after=` page comes back FULL, which fires the gap
//      probe, which re-anchors — OVERWRITING the drifted number with a fresh
//      server measurement. 4012 → 4125 in one step, with no scroll and no read.
//
// So the re-probe the issue asked us to look for is real, and it is the
// CORRECTION rather than the cause. Curing only the visible step (the jump)
// would leave the drift, which is the number the operator reads for as long as
// they stay away.
describe("issue 2069 A — the far-behind count while the operator is away", () => {
  it("tracks the server's own answer as peer traffic lands", async () => {
    await wireServer();
    await absenceThenReconnect();
    expect(await badge()).toBe(await truth());

    // Below the retention cap the store has not evicted anything yet: the arm
    // that under-reported by an entire page.
    await peerTraffic(100);
    expect(await badge()).toBe(await truth());

    // Past the cap, one eviction per arrival — where the kind mix decides
    // whether the old accumulator drifts up or down.
    await peerTraffic(400);
    expect(await badge()).toBe(await truth());
  });

  it("does not move on a re-select the operator learns nothing from", async () => {
    await wireServer();
    await absenceThenReconnect();
    await peerTraffic(500);

    const before = await badge();
    await reSelect();
    // The gesture is "look away, look back". It carries no reading and no
    // scrolling, so it may not change the answer — and it is the step the
    // report saw, because it is where the correction became visible.
    expect(await badge()).toBe(before);
    await reSelect();
    expect(await badge()).toBe(before);
  });

  it("is still the server's answer after the re-select", async () => {
    await wireServer();
    await absenceThenReconnect();
    await peerTraffic(500);
    await reSelect();

    // The companion of the arm above: "did not move" is satisfied by a number
    // that is stuck as well as by one that is right.
    expect(await badge()).toBe(await truth());
  });

  it("does not move on a re-select with no traffic at all", async () => {
    await wireServer();
    await absenceThenReconnect();

    const before = await badge();
    await reSelect();
    expect(await badge()).toBe(before);
    expect(await badge()).toBe(await truth());
  });
});

// SYMPTOM B, as reported: "badge and bar both read 2900 → take the jump →
// change channel → the window reads 200. 200 is the fetch page, not a fact
// about the conversation."
//
// Reproduced, and it is worse than reported: the number does not stop at the
// page size. `jumpToUnread` retires the far-behind record, the badge falls
// back to counting the rows the store holds, and as the operator reads through
// the one page the jump loaded the count reaches ZERO — on a window with
// thousands still unread. Measured on `b7989f4ba`: 3750 → 150 → 0, cursor at
// 1200, server answer 3600.
//
// The measurement that would have answered every one of those was already on
// file: `measuredUnreadByChannel` (#947), written by the very jump that caused
// this. Only the divider ever spent it.
describe("issue 2069 B — the count after a jump back into the unread region", () => {
  const jump = async (): Promise<void> => {
    const { jumpToUnread } = await import("../lib/scrollback");
    expect(await jumpToUnread(SLUG, CHANNEL)).toBe(true);
  };

  it("survives the jump that loaded one page out of thousands", async () => {
    await wireServer();
    await absenceThenReconnect();
    expect(await badge()).toBe(await truth());

    await jump();
    expect(await badge()).toBe(await truth());
  });

  it("still survives when the operator changes channel and comes back", async () => {
    await wireServer();
    await absenceThenReconnect();
    await jump();
    await reSelect();

    expect(await badge()).toBe(await truth());
  });

  it("falls by what the operator read, not to the page size", async () => {
    await wireServer();
    await absenceThenReconnect();
    await jump();
    const { applyReadCursorSet } = await import("../lib/readCursor");

    // Reading half the loaded page. The cross-device echo is the same cursor
    // write the pane's read-at-the-tail arm performs, without the geometry
    // jsdom cannot give it.
    applyReadCursorSet(SLUG, CHANNEL, 1100);
    expect(await badge()).toBe(await truth());

    // ...and all of it. This is where the count used to reach zero.
    applyReadCursorSet(SLUG, CHANNEL, 1200);
    expect(await badge()).toBe(await truth());
    expect(await badge()).toBeGreaterThan(0);
  });

  it("follows the operator paging forward through the region", async () => {
    await wireServer();
    await absenceThenReconnect();
    await jump();
    const { loadNewer } = await import("../lib/scrollback");
    const { applyReadCursorSet } = await import("../lib/readCursor");

    // Read the page, then scroll to the bottom of it — which pages the NEXT
    // page of the region in. The count must keep describing the conversation
    // and not the pane, all the way down.
    applyReadCursorSet(SLUG, CHANNEL, 1200);
    await loadNewer(SLUG, CHANNEL);
    expect(await badge()).toBe(await truth());

    applyReadCursorSet(SLUG, CHANNEL, 1400);
    await loadNewer(SLUG, CHANNEL);
    expect(await badge()).toBe(await truth());
  });

  it("stands down when the cursor leaves the run the pane can account for", async () => {
    await wireServer();
    await absenceThenReconnect();
    await jump();
    const api = await import("../lib/api");
    const scrollback = await import("../lib/scrollback");

    // The operator says something from the middle of the region. The send
    // carries the cursor to the TIP, past thousands of rows the pane never
    // held — so nothing local can say how many of the measured region it
    // consumed. The server's answer for the new cursor is ZERO, and a
    // measurement that kept subtracting only what the pane happens to hold
    // would answer thousands. It has to stand down instead.
    server.tip = 6001;
    vi.mocked(api.sendMessage).mockResolvedValue(row(6001));
    await scrollback.sendMessage(SLUG, CHANNEL, "ciao");

    expect(await truth()).toBe(0);
    expect(await badge()).toBe(0);
  });
});
