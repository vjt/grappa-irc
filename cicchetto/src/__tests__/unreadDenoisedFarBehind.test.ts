import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GapProbe, MessageKind, ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// issue 2071 — a counter that keeps growing on a DENOISED window the operator
// has already looked at, while the read cursor stands still.
//
// The far-behind record (#693) carries the SAME pair the server's
// `count_after_split/6` returns — a MESSAGES bucket and an EVENTS bucket — and
// it is SEEDED from exactly that call, taken behind
// `Grappa.PresenceFilter.Resolver`. It is then MAINTAINED client-side, and the
// maintenance counted raw kinds: `capScrollbackRing` opened the events bucket
// at `unreadHeld - contentHeld` and `appendPageToScrollback` accumulated
// arrivals at `!isContentKind`. Neither asked `presenceRowVisible`.
//
// On a channel showing presence those two populations coincide and nothing is
// visible. On a DENOISED one they differ by the whole presence volume of the
// channel: the seed excludes join/part/quit/nick_change/mode, the accumulator
// counts them, and the operator can never read the difference away because the
// pane does not render a single one of those rows. Measured on `4a33c6747`
// over a 3:1 noise log, 120 arrivals: the pill climbed 0 → 22 → 45 → 67 → 90
// against a server answer of 0 at every step.
//
// The oracle in every arm is the SERVER'S OWN ANSWER for the cursor the store
// currently holds, never a literal — same discipline as
// `unreadOneVariable.test.ts`, and it is what makes the presence-SHOWN control
// meaningful: that arm passes on both sides of the fix, so the cure is the
// filter and not a blanket change to the bucket.

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

// The suppressed set, restated as the FIXTURE's own noise definition. It is
// deliberately NOT imported from `presenceFilter`: this file is measuring
// whether the store agrees with that module, and taking the set from the
// module under test would make the two agree by construction.
const NOISE: ReadonlySet<MessageKind> = new Set(["join", "part", "quit", "nick_change", "mode"]);

// 3 presence rows for every content row — what a denoised channel looks like,
// and the ratio that makes a raw-vs-filtered mismatch visible at all. An
// all-content log cannot see this defect: the two populations coincide.
const kindOf = (id: number): MessageKind => (id % 4 === 1 ? "privmsg" : "join");

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

/**
 * A server that honours the DENOISE posture the way the real one does (#458):
 * the history reads AND the `/messages/count` probe both omit the suppressed
 * kinds for a window that hides presence, because both route through
 * `Grappa.PresenceFilter.Resolver`. The LIVE WS tail is UNFILTERED — cic
 * filters that at render, which is the whole asymmetry under test.
 */
class FakeServer {
  constructor(
    public tip: number,
    public cursor: number,
    public denoised: boolean,
  ) {}

  private visible(id: number): boolean {
    return !this.denoised || !NOISE.has(kindOf(id));
  }

  listMessages(before?: number): ScrollbackMessage[] {
    const hi = before === undefined ? this.tip : Math.min(this.tip, before - 1);
    const out: ScrollbackMessage[] = [];
    for (let i = hi; i >= 1 && out.length < DEFAULT_PAGE; i--) {
      if (this.visible(i)) out.push(row(i));
    }
    return out;
  }

  listMessagesAfter(after: number, limit: number): ScrollbackMessage[] {
    const out: ScrollbackMessage[] = [];
    for (let i = after + 1; i <= this.tip && out.length < limit; i++) {
      if (this.visible(i)) out.push(row(i));
    }
    return out;
  }

  /** The three numbers `count_after_split/6` returns, over this same log. */
  countMessagesAfter(after: number): GapProbe {
    let gap = 0;
    let messages = 0;
    for (let i = after + 1; i <= this.tip; i++) {
      if (!this.visible(i)) continue;
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

/** The operator's explicit per-channel "hide presence" pin (#222 / #449). */
const denoise = async (): Promise<void> => {
  const { setChannelPresencePref } = await import("../lib/presenceFilter");
  setChannelPresencePref(KEY, "hide");
};

/** What `subscribe.ts` does on every per-channel join, initial AND rejoin. */
const joinChannelTopic = async (): Promise<void> => {
  const { applyJoinReply } = await import("../lib/readCursor");
  const { setServerSeedCount } = await import("../lib/selection");
  applyJoinReply(SLUG, CHANNEL, server.cursor);
  const probe = server.countMessagesAfter(server.cursor);
  setServerSeedCount(KEY, { messages: probe.messages, events: probe.events });
};

/** The FIRST selection of a window — `selection.ts`'s load-once hydrate. */
const firstSelect = async (): Promise<void> => {
  const { loadInitialScrollback } = await import("../lib/scrollback");
  await loadInitialScrollback(SLUG, CHANNEL);
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

/** Live rows landing on the per-channel WS topic — UNFILTERED, as they are. */
const peerTraffic = async (n: number): Promise<void> => {
  const { appendToScrollback } = await import("../lib/scrollback");
  const { recordSeen } = await import("../lib/reconnectBackfill");
  for (let i = 0; i < n; i++) {
    server.tip += 1;
    const m = row(server.tip);
    appendToScrollback(KEY, m);
    recordSeen(KEY, m);
  }
};

const cursorNow = async (): Promise<number> => {
  const { getReadCursor } = await import("../lib/readCursor");
  return getReadCursor(SLUG, CHANNEL) ?? 0;
};

/** The two pills the sidebar renders for this window, right now. */
const pills = async (): Promise<{ messages: number; events: number }> => {
  const selection = await import("../lib/selection");
  return {
    messages: selection.messagesUnread()[KEY] ?? 0,
    events: selection.eventsUnread()[KEY] ?? 0,
  };
};

/** What the server would answer for the cursor the store currently holds. */
const truth = async (): Promise<{ messages: number; events: number }> => {
  const probe = server.countMessagesAfter(await cursorNow());
  return { messages: probe.messages, events: probe.events };
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
});

// The gesture as the reporter typed it. This arm PASSES on `4a33c6747` and is
// here to keep passing: the property it states — a count derived twice for the
// same window with the cursor standing still is the same count — is the one
// the issue names, and nothing below is allowed to break it.
describe("issue 2071 — the gesture: select, leave, re-select, cursor still", () => {
  it("does not move the pills on a DENOISED window with a live marker", async () => {
    // Raw gap 160 rows, 40 of them content: under the far-behind bound on both
    // the raw and the filtered reading, so the window keeps its in-pane marker.
    server = new FakeServer(1160, 1000, true);
    await wireServer();
    await denoise();
    await joinChannelTopic();
    await firstSelect();

    const pinned = await cursorNow();
    const before = await pills();
    expect(before).toEqual(await truth());

    await reSelect();
    expect(await pills()).toEqual(before);
    await reSelect();
    expect(await pills()).toEqual(before);
    expect(await cursorNow()).toBe(pinned);
  });
});

// The arm that FAILS on `4a33c6747`. Same gesture, one state further along:
// the window has gone far behind, so the pills are answered by the far-behind
// record rather than by the loaded rows — and that record is maintained in a
// population the operator's pane does not share.
describe("issue 2071 — the far-behind record under a presence filter", () => {
  const arrivalsTrackTheServer = async (denoised: boolean): Promise<void> => {
    // Raw gap 800, 200 of it content: the anchored hydrate fills the pane to
    // the retention bound, so the next arrivals push the unread region over it
    // and the far-behind record opens.
    server = new FakeServer(1800, 1000, denoised);
    await wireServer();
    if (denoised) await denoise();
    await joinChannelTopic();
    await firstSelect();

    const pinned = await cursorNow();
    // Four batches, so a per-batch drift is distinguishable from a one-off.
    for (let batch = 0; batch < 4; batch++) {
      await peerTraffic(30);
      expect(await pills()).toEqual(await truth());
      // Nothing here reads, scrolls or sends: the cursor must not have moved,
      // or the oracle above is answering a different question each time.
      expect(await cursorNow()).toBe(pinned);
    }

    // And the gesture itself still carries no information.
    const settled = await pills();
    await reSelect();
    expect(await pills()).toEqual(settled);
  };

  it("tracks the server's own answer on a DENOISED window", async () => {
    await arrivalsTrackTheServer(true);
  });

  // The control. It passes on BOTH sides of the fix: with presence shown the
  // raw and the filtered populations coincide, so a cure that merely changed
  // the bucket — rather than teaching it the filter — would show up HERE.
  it("tracks the server's own answer with presence SHOWN", async () => {
    await arrivalsTrackTheServer(false);
  });
});
