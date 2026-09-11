import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GapProbe, MessageKind, RawNetwork, ScrollbackMessage } from "../lib/api";
import { type ChannelKey, channelKey } from "../lib/channelKey";

// issue 2045 — `far.missed` has TWO producers and they disagree on one term.
//
//   * the PROBE — `Scrollback.count_after_split/6`, server — counts content
//     kinds with own-authored EXCLUDED (`exclude_own_authored/3`).
//   * the PRUNE — `capScrollbackRing`, client — counted content kinds with
//     own-authored INCLUDED. One line, `isContentKind(m.kind)`, and no
//     own-nick arm anywhere in the function.
//
// The server's answer is the right one and it is not a preference: a line the
// operator typed is read BY DEFINITION (#576 content), and a self-PART or a
// KICK they issued is an action they performed rather than something to catch
// up on (#532 A presence). `count_after_split/6` says so in its own comment,
// and cic already agrees everywhere else — `unreadCount.ts` publishes
// `countsAsUnreadMessage`, whose moduledoc says it mirrors that very function.
// The far-behind maintenance path was the one place that never asked.
//
// Why it bites NOW: before #2037 A the prune path accumulated RAW row counts
// while the probe returned a split, so the two were obviously different
// quantities. A narrowed the prune path to the content unit, and the two now
// agree on everything except this term. That is worse in one specific way, and
// it is the heart of the issue: two numbers that differ by a lot are visibly
// two numbers; two numbers that differ by three are indistinguishable from one
// number until somebody counts.
//
// ## The oracle
//
// Every arm compares against the SERVER'S OWN ANSWER for the cursor the store
// currently holds, never against a literal — the same discipline as
// `unreadDenoisedFarBehind.test.ts`. `FakeServer.countMessagesAfter` therefore
// implements BOTH halves of `exclude_own_authored/3`, including the #396
// self-window carve-out, because a fake that only implemented the half under
// test would make the fix agree with itself.
//
// ## Presence is SHOWN in every arm, deliberately
//
// The sibling defect (issue 2071) is on the PRESENCE axis of the same two
// buckets. Leaving presence shown collapses that axis — the raw and filtered
// populations coincide — so anything these arms measure is the own-authored
// term and nothing else.

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
const DEFAULT_PAGE = 50;

// 🔴 The per-network IRC nick, and it is NOT the account name by construction.
// `ownNickForNetwork(net, me)` returns `net.nick`, and the api moduledoc warns
// at length that the two differ after a NickServ ghost recovery. A fixture that
// made them equal would pass with the account name substituted for the nick —
// exactly the H3 bug that warning exists for.
const OWN_NICK = "vjt-grappa";
const PEER_NICK = "bob";

const NET: RawNetwork = {
  kind: "user",
  id: 1,
  slug: SLUG,
  nick: OWN_NICK,
  connection_state: "connected",
  connection_state_reason: null,
  connection_state_changed_at: null,
  inserted_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
};

// 🔴 ONE law, read by BOTH sides. Authorship lives in this map and nowhere
// else: the FakeServer's count and the rows it hands the client both read it,
// so the oracle can never describe a log the client was not given.
//
// It is a map and not `id % 3` because the arms need to steer authorship of
// the LIVE tail. An earlier version selected ids by skipping the ones whose
// author did not match — which left the server counting rows that were never
// delivered, and the client then read LOWER than the server. That is the
// opposite of the defect under test, and it is exactly what the two control
// arms are here to catch.
const senders = new Map<number, string>();
const senderOf = (id: number): string => senders.get(id) ?? PEER_NICK;

/** Seed the backlog: one row in three is the operator's own. */
const seedBacklog = (tip: number): void => {
  senders.clear();
  kinds.clear();
  for (let i = 1; i <= tip; i++) senders.set(i, i % 3 === 0 ? OWN_NICK : PEER_NICK);
};

// The kinds law, same shape and same discipline as the senders one: written
// once, read by the fake server AND by the rows it hands the client. Content
// unless an arm says otherwise — presence is SHOWN throughout, so a `join` here
// is a visible event row and not a filtered one.
const kinds = new Map<number, MessageKind>();
const kindOf = (id: number): MessageKind => kinds.get(id) ?? "privmsg";
const isContent = (id: number): boolean => kindOf(id) === "privmsg";

const row = (id: number, channel: string): ScrollbackMessage => ({
  id,
  network: SLUG,
  channel,
  server_time: id,
  kind: kindOf(id),
  sender: senderOf(id),
  body: `m${id}`,
  meta: {},
});

/**
 * A server that answers `/messages/count` the way the real one does. The
 * own-authored exclusion mirrors `Scrollback.exclude_own_authored/3` INCLUDING
 * the #396 self-window carve-out: in the window keyed to the operator's own
 * nick, own content is a legitimate note-to-self and still counts.
 */
class FakeServer {
  constructor(
    public tip: number,
    public cursor: number,
    public channel: string,
  ) {}

  private get selfWindow(): boolean {
    return this.channel === OWN_NICK;
  }

  /**
   * `exclude_own_authored/3`, in the order the real query applies it: the row
   * is dropped from the result set BEFORE the content/event grouping, so the
   * exclusion narrows BOTH buckets rather than just the content one.
   *
   *   * peer / channel window — own CONTENT (#576) and own PRESENCE (#532 A)
   *     are both excluded.
   *   * self window (#396) — own content is a legitimate note-to-self and
   *     survives; own PRESENCE is still stripped.
   */
  private excluded(id: number): boolean {
    if (senderOf(id) !== OWN_NICK) return false;
    return this.selfWindow ? !isContent(id) : true;
  }

  listMessages(before?: number): ScrollbackMessage[] {
    const hi = before === undefined ? this.tip : Math.min(this.tip, before - 1);
    const out: ScrollbackMessage[] = [];
    for (let i = hi; i >= 1 && out.length < DEFAULT_PAGE; i--) out.push(row(i, this.channel));
    return out;
  }

  listMessagesAfter(after: number, limit: number): ScrollbackMessage[] {
    const out: ScrollbackMessage[] = [];
    for (let i = after + 1; i <= this.tip && out.length < limit; i++)
      out.push(row(i, this.channel));
    return out;
  }

  /** The pair `count_after_split/6` returns over this same log. */
  countMessagesAfter(after: number): GapProbe {
    let gap = 0;
    let messages = 0;
    let events = 0;
    for (let i = after + 1; i <= this.tip; i++) {
      if (this.excluded(i)) continue;
      gap++;
      if (isContent(i)) messages++;
      else events++;
    }
    return { gap, messages, events };
  }
}

let server: FakeServer;

const wireServer = async (): Promise<void> => {
  const api = await import("../lib/api");
  vi.mocked(api.listNetworks).mockResolvedValue([NET]);
  vi.mocked(api.listMessages).mockImplementation(async (_t, _s, _c, before) =>
    server.listMessages(before),
  );
  vi.mocked(api.listMessagesAfter).mockImplementation(async (_t, _s, _c, after, limit) =>
    server.listMessagesAfter(after, limit ?? DEFAULT_PAGE),
  );
  vi.mocked(api.countMessagesAfter).mockImplementation(async (_t, _s, _c, after) =>
    server.countMessagesAfter(after),
  );
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      const id = JSON.parse(init.body).message_id as number;
      if (id > server.cursor) server.cursor = id;
      return { ok: true, status: 200, json: async () => ({}) };
    }),
  );
  // The own nick only exists once BOTH the me() and the networks resource have
  // hydrated. Without this wait `networkBySlug` is undefined, `ownNick` is null
  // and the exclusion is inert — the arms would pass for the wrong reason.
  const auth = await import("../lib/auth");
  const networks = await import("../lib/networks");
  auth.setToken("tok2045");
  await vi.waitFor(() => {
    expect(networks.networkBySlug(SLUG)?.nick).toBe(OWN_NICK);
  });
};

const keyFor = (): ChannelKey => channelKey(SLUG, server.channel);

/** What `subscribe.ts` does on every per-channel join. */
const joinChannelTopic = async (): Promise<void> => {
  const { applyJoinReply } = await import("../lib/readCursor");
  const { setServerSeedCount } = await import("../lib/selection");
  applyJoinReply(SLUG, server.channel, server.cursor);
  const probe = server.countMessagesAfter(server.cursor);
  setServerSeedCount(keyFor(), { messages: probe.messages, events: probe.events });
};

const firstSelect = async (): Promise<void> => {
  const { loadInitialScrollback } = await import("../lib/scrollback");
  await loadInitialScrollback(SLUG, server.channel);
};

const reSelect = async (): Promise<void> => {
  const { refreshScrollback } = await import("../lib/scrollback");
  await refreshScrollback(SLUG, server.channel);
};

/**
 * Live rows landing on the per-channel WS topic.
 *
 * ⚠️ `own` is the case that makes this defect non-theoretical: it is the
 * MULTI-DEVICE one. Lines the operator sends from their phone are echoed to
 * every other connected client, so they land here — past the laptop's read
 * cursor, authored by the operator, and counted by a laptop that has no idea
 * they are its own. Bounded in practice by how much the operator types
 * elsewhere; unbounded in principle.
 */
const traffic = async (n: number, who: "own" | "peer" | "mixed"): Promise<void> => {
  const { appendToScrollback } = await import("../lib/scrollback");
  const { recordSeen } = await import("../lib/reconnectBackfill");
  for (let i = 0; i < n; i++) {
    // CONSECUTIVE ids, every one of them delivered. Authorship is written into
    // the shared law rather than searched for, so the server's log and the
    // client's store hold exactly the same rows.
    server.tip += 1;
    const mine = who === "mixed" ? server.tip % 3 === 0 : who === "own";
    senders.set(server.tip, mine ? OWN_NICK : PEER_NICK);
    const m = row(server.tip, server.channel);
    appendToScrollback(keyFor(), m);
    recordSeen(keyFor(), m);
  }
};

const cursorNow = async (): Promise<number> => {
  const { getReadCursor } = await import("../lib/readCursor");
  return getReadCursor(SLUG, server.channel) ?? 0;
};

/** The messages pill the sidebar renders for this window, right now. */
const messagesPill = async (): Promise<number> => {
  const selection = await import("../lib/selection");
  return selection.messagesUnread()[keyFor()] ?? 0;
};

/** Its faint sibling — the EVENTS pill for the same window. */
const eventsPill = async (): Promise<number> => {
  const selection = await import("../lib/selection");
  return selection.eventsUnread()[keyFor()] ?? 0;
};

/** What the server would answer for the cursor the store currently holds. */
const truth = async (): Promise<number> => server.countMessagesAfter(await cursorNow()).messages;

/** The same, for the events bucket. */
const eventsTruth = async (): Promise<number> =>
  server.countMessagesAfter(await cursorNow()).events;

/**
 * Presence rows landing live, authored by the operator or by a peer. A `part`
 * the operator issued from another client is the events-bucket twin of the
 * multi-device message case: an action they performed, echoed here.
 */
const presenceTraffic = async (n: number, who: "own" | "peer"): Promise<void> => {
  const { appendToScrollback } = await import("../lib/scrollback");
  const { recordSeen } = await import("../lib/reconnectBackfill");
  for (let i = 0; i < n; i++) {
    server.tip += 1;
    senders.set(server.tip, who === "own" ? OWN_NICK : PEER_NICK);
    kinds.set(server.tip, "join");
    const m = row(server.tip, server.channel);
    appendToScrollback(keyFor(), m);
    recordSeen(keyFor(), m);
  }
};

/** Proof the window really is in the far-behind state these arms are about. */
const isFarBehind = async (): Promise<boolean> => {
  const { farBehindByChannel } = await import("../lib/scrollback");
  return farBehindByChannel()[keyFor()] !== undefined;
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
  localStorage.setItem("grappa-token", "tok2045");
});

describe("issue 2045 — far.missed counts own-authored content the server excludes", () => {
  // Gap 800 with a third of it the operator's own. This is far past
  // `isFarBehind`'s one-page bound at hydrate time, so the record is opened by
  // the PROBE — `anchorAtTail` writing the server's own answer. The arms built
  // on this helper therefore exercise the ACCUMULATE producer
  // (`appendPageToScrollback`), which is the other writer of the same number.
  const openFarBehindByProbe = async (): Promise<void> => {
    seedBacklog(1800);
    server = new FakeServer(1800, 1000, CHANNEL);
    await wireServer();
    await joinChannelTopic();
    await firstSelect();
    await traffic(30, "peer");
    expect(await isFarBehind()).toBe(true);
  };

  // 🔴 The OTHER door into the same state, and the one the issue's own framing
  // turns on: "the same window, at the same cursor, reports a different
  // far-behind figure depending on whether it went far behind by LOCAL
  // EVICTION (prune) or by a gap probe on open."
  //
  // Here the window opens NEAR — 50 unread, under `isFarBehind`'s one-page
  // bound — so the hydrate runs no probe and writes no record. Arrivals then
  // push the unread region past `UNREAD_RETENTION_CAP`, `capScrollbackRing`
  // bites, and the record is OPENED by the prune with `missed: contentHeld`.
  // That is the line the issue names, and nothing else in this file reaches it.
  const openFarBehindByEviction = async (): Promise<void> => {
    seedBacklog(1050);
    server = new FakeServer(1050, 1000, CHANNEL);
    await wireServer();
    await joinChannelTopic();
    await firstSelect();
    expect(await isFarBehind()).toBe(false);
    // Past the retention bound in one run, a third of it the operator's own.
    await traffic(260, "mixed");
    expect(await isFarBehind()).toBe(true);
  };

  it("opens the record on the server's number when the PRUNE opens it", async () => {
    // The producer the issue names, in isolation: `capScrollbackRing`'s
    // content count over the rows the pane holds, a third of which are the
    // operator's own.
    await openFarBehindByEviction();
    expect(await messagesPill()).toBe(await truth());
  });

  it("agrees with the PROBE-opened window on the same cursor", async () => {
    // The other producer. Not a duplicate of the arm above: this one asserts
    // the number the record opens with when `anchorAtTail` writes it, and it
    // passes on both sides of the fix — it is what says the cure moved the
    // client TOWARDS the server rather than moving both.
    await openFarBehindByProbe();
    expect(await messagesPill()).toBe(await truth());
  });

  it("does not grow by lines the operator sent from another device", async () => {
    // 🔴 The multi-device case, and the ACCUMULATE producer rather than the
    // seed one: past the bound the record grows by what ARRIVED, so an own
    // line echoed from the phone lands here and is added to a laptop's
    // catch-up count. Four batches, so a per-batch drift is distinguishable
    // from a one-off.
    await openFarBehindByProbe();
    const pinned = await cursorNow();
    for (let batch = 0; batch < 4; batch++) {
      await traffic(10, "own");
      expect(await messagesPill()).toBe(await truth());
      // Nothing here reads, scrolls or sends from THIS device: the cursor must
      // not have moved, or the oracle is answering a different question each
      // time.
      expect(await cursorNow()).toBe(pinned);
    }
  });

  it("still counts what a PEER sends — the exclusion is not a mute", async () => {
    // The negative control. It passes on BOTH sides of the fix: a cure that
    // simply stopped the bucket growing would show up HERE, and a fix that
    // matched on the account name rather than the per-network nick would too,
    // since `OWN_NICK` is deliberately not the account name.
    await openFarBehindByProbe();
    const before = await messagesPill();
    await traffic(12, "peer");
    const after = await messagesPill();
    expect(after).toBe(await truth());
    expect(after).toBeGreaterThan(before);
  });

  it("counts the operator's OWN lines in the SELF window (#396)", async () => {
    // The carve-out, and the reason this asserts the real predicate rather
    // than a blanket own-nick strip: the pane keyed to your own nick is the one
    // window where own content is legitimate payload (a note-to-self), so the
    // server counts it there and so must cic. A fix that passed
    // `isSelfWindow: false` unconditionally would pass every arm above and
    // fail this one.
    seedBacklog(1800);
    server = new FakeServer(1800, 1000, OWN_NICK);
    await wireServer();
    await joinChannelTopic();
    await firstSelect();
    await traffic(30, "peer");
    expect(await isFarBehind()).toBe(true);

    const pinned = await cursorNow();
    const before = await messagesPill();
    expect(before).toBe(await truth());
    await traffic(10, "own");
    expect(await messagesPill()).toBe(await truth());
    expect(await messagesPill()).toBeGreaterThan(before);
    expect(await cursorNow()).toBe(pinned);
  });

  it("carries the same number across a re-select — one producer, not two", async () => {
    // The issue's own framing: the same window at the same cursor must not
    // report a different figure depending on which producer answered. A
    // re-select runs the gap probe, so this arm puts BOTH producers on the
    // same window and demands they agree.
    await openFarBehindByProbe();
    await traffic(10, "own");
    const pinned = await cursorNow();
    const settled = await messagesPill();
    expect(settled).toBe(await truth());
    await reSelect();
    expect(await messagesPill()).toBe(settled);
    expect(await cursorNow()).toBe(pinned);
  });
});

// issue 2045, the sibling bucket. NOT named by the issue, which scopes itself
// to `far.missed` — recorded here and in DESIGN_NOTES as a deliberate widening,
// on one measurement: the server applies `exclude_own_authored/3` BEFORE the
// content/event grouping in `count_after_split/6`, so the exclusion narrows
// BOTH buckets. `far.events` therefore had the identical divergence, one line
// below the one the issue names and from the same term.
//
// Fixing only the content half would have left `countsAsUnreadMessage(...)` on
// one line and a hand-rolled `!isContentKind(...)` on the next — the module's
// own published sibling ignored right beside it, which is the half-migration
// CLAUDE.md warns propagates.
describe("issue 2045 — the EVENTS bucket carries the same term", () => {
  const openFarBehindByProbe = async (): Promise<void> => {
    seedBacklog(1800);
    server = new FakeServer(1800, 1000, CHANNEL);
    await wireServer();
    await joinChannelTopic();
    await firstSelect();
    await traffic(30, "peer");
    expect(await isFarBehind()).toBe(true);
  };

  it("does not grow by presence the operator caused from another device", async () => {
    // A JOIN or PART the operator issued elsewhere is an action they performed
    // (#532 A), not something to catch up on — and the server has never
    // counted it.
    await openFarBehindByProbe();
    const pinned = await cursorNow();
    for (let batch = 0; batch < 3; batch++) {
      await presenceTraffic(10, "own");
      expect(await eventsPill()).toBe(await eventsTruth());
      expect(await cursorNow()).toBe(pinned);
    }
  });

  it("still counts a PEER's presence — the exclusion is not a mute here either", async () => {
    // The negative control for this bucket. Passes on both sides of the fix.
    await openFarBehindByProbe();
    const before = await eventsPill();
    await presenceTraffic(12, "peer");
    const after = await eventsPill();
    expect(after).toBe(await eventsTruth());
    expect(after).toBeGreaterThan(before);
  });

  it("strips own presence even in the SELF window, where own CONTENT counts", async () => {
    // The asymmetry the #396 carve-out actually draws, and the sharpest test of
    // whether the real predicate is being used: in the self window own content
    // is payload and own PRESENCE is still stripped. A cure that passed
    // `isSelfWindow` through to both buckets uniformly fails here.
    seedBacklog(1800);
    server = new FakeServer(1800, 1000, OWN_NICK);
    await wireServer();
    await joinChannelTopic();
    await firstSelect();
    await traffic(30, "peer");
    expect(await isFarBehind()).toBe(true);

    const pinned = await cursorNow();
    const messagesBefore = await messagesPill();
    await traffic(10, "own");
    await presenceTraffic(10, "own");
    // Own content STILL counts here…
    expect(await messagesPill()).toBe(await truth());
    expect(await messagesPill()).toBeGreaterThan(messagesBefore);
    // …and own presence still does not.
    expect(await eventsPill()).toBe(await eventsTruth());
    expect(await cursorNow()).toBe(pinned);
  });
});
