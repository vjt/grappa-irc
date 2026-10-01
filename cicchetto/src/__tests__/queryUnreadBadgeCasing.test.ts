import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

// #973 — the unread badge on a QUERY window never resets.
//
// The cursor map was written under the peer nick as the operator's window
// carries it (`query_windows.target_nick` is case-preserving server-side, and
// `canonicalQueryNick` deliberately returns that CASING, not a fold) while the
// badge memo looks the cursor up under the FOLDED name it decodes out of a
// `ChannelKey`. Two keys, one map: the write landed on `azzurra Mezmerize`,
// the read asked for `azzurra mezmerize`, missed, and counted every row as
// unread forever. Channels were spared only because a channel name arrives
// already canonical, so raw === folded and the fork was invisible.
//
// This file runs the REAL cursor store — same reason unreadBadgeFocused.test.ts
// does: the property under test is that the badge falls when the cursor moves,
// so a stubbed store would assert nothing. The writers driven here are the
// production entry points (`applyReadCursorSet` = the `read_cursor_set` WS
// event, `applyJoinReply` = the Phoenix join reply, `applyMeEnvelope` = the
// `/me` cold load), each handed the RAW mixed-case nick exactly as subscribe.ts
// and ScrollbackPane hand it to them.

vi.mock(import("../lib/api"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listNetworks: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([]),
    listMessages: vi.fn().mockResolvedValue([]),
    sendMessage: vi.fn(),
    me: vi.fn().mockResolvedValue({
      kind: "user",
      id: "u-test",
      name: "alice",
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
// The casing the operator's window actually carries: `target_nick` preserves
// first-opened input, and selection.ts resolves a query selection to
// `match.targetNick` verbatim.
const PEER_RAW = "Mezmerize";
const PEER_FOLDED = "mezmerize";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

const seedThreeDms = async (): Promise<ReturnType<typeof channelKey>> => {
  const scrollback = await import("../lib/scrollback");
  const key = channelKey(SLUG, PEER_RAW);
  for (const id of [1, 2, 3]) {
    scrollback.appendToScrollback(key, {
      id,
      network: SLUG,
      channel: PEER_RAW,
      server_time: id,
      kind: "privmsg",
      sender: PEER_RAW,
      body: `dm ${id}`,
      meta: {},
    });
  }
  return key;
};

describe("#973 query-window unread badge across nick casing", () => {
  it("clears when the WS cursor echo arrives under the raw peer nick", async () => {
    localStorage.setItem("grappa-token", "tok");
    const selection = await import("../lib/selection");
    const readCursor = await import("../lib/readCursor");
    const key = await seedThreeDms();

    selection.setSelectedChannel({
      networkSlug: SLUG,
      channelName: PEER_RAW,
      kind: "query",
    });
    expect(selection.messagesUnread()[key]).toBe(3);

    // subscribe.ts's `read_cursor_set` arm passes the handler's `name`
    // closure, which is the raw target the window was opened with.
    readCursor.applyReadCursorSet(SLUG, PEER_RAW, 3);

    expect(selection.messagesUnread()[key]).toBeUndefined();
  });

  it("keeps falling one row at a time — it does not merely snap to zero", async () => {
    localStorage.setItem("grappa-token", "tok");
    const selection = await import("../lib/selection");
    const readCursor = await import("../lib/readCursor");
    const key = await seedThreeDms();

    selection.setSelectedChannel({
      networkSlug: SLUG,
      channelName: PEER_RAW,
      kind: "query",
    });

    readCursor.applyReadCursorSet(SLUG, PEER_RAW, 1);
    expect(selection.messagesUnread()[key]).toBe(2);
    readCursor.applyReadCursorSet(SLUG, PEER_RAW, 2);
    expect(selection.messagesUnread()[key]).toBe(1);
    readCursor.applyReadCursorSet(SLUG, PEER_RAW, 3);
    expect(selection.messagesUnread()[key]).toBeUndefined();
  });

  it("clears when the join reply carries the cursor under the raw peer nick", async () => {
    localStorage.setItem("grappa-token", "tok");
    const selection = await import("../lib/selection");
    const readCursor = await import("../lib/readCursor");
    const key = await seedThreeDms();

    // subscribe.ts:790 — the per-channel join reply, on every rejoin.
    readCursor.applyJoinReply(SLUG, PEER_RAW, 3);

    expect(selection.messagesUnread()[key]).toBeUndefined();
  });

  it("does not resurrect the count when the /me cold load re-seeds the folded key", async () => {
    localStorage.setItem("grappa-token", "tok");
    const selection = await import("../lib/selection");
    const readCursor = await import("../lib/readCursor");
    const key = await seedThreeDms();

    // The one writer that already landed the folded key. It is authoritative
    // and REPLACES the map, so a later raw write must land on the same key or
    // the two hydration sources fork — the exact shape of the report (right at
    // page load, then monotonically wrong).
    readCursor.applyMeEnvelope({ [SLUG]: { [PEER_FOLDED]: 2 } });
    expect(selection.messagesUnread()[key]).toBe(1);

    readCursor.applyReadCursorSet(SLUG, PEER_RAW, 3);
    expect(selection.messagesUnread()[key]).toBeUndefined();
  });
});

describe("#973 read-cursor store keys on the folded identifier", () => {
  it("reads back a raw-nick write under the folded nick, and vice versa", async () => {
    const { applyReadCursorSet, getReadCursor, clearReadCursors } = await import(
      "../lib/readCursor"
    );
    clearReadCursors();

    applyReadCursorSet(SLUG, PEER_RAW, 200);

    expect(getReadCursor(SLUG, PEER_FOLDED)).toBe(200);
    expect(getReadCursor(SLUG, PEER_RAW)).toBe(200);
  });

  it("folds idempotently — /me hands it keys the server already folded", async () => {
    const { applyMeEnvelope, readCursors, getReadCursor, clearReadCursors } = await import(
      "../lib/readCursor"
    );
    clearReadCursors();

    applyMeEnvelope({ [SLUG]: { [PEER_FOLDED]: 100 } });

    expect(Object.keys(readCursors())).toEqual([`${SLUG} ${PEER_FOLDED}`]);
    expect(getReadCursor(SLUG, PEER_FOLDED)).toBe(100);
  });

  it("stores under the key the badge memo decodes out of a ChannelKey", async () => {
    const { decodeChannelKey } = await import("../lib/channelKey");
    const { applyReadCursorSet, readCursors, clearReadCursors } = await import("../lib/readCursor");
    clearReadCursors();

    applyReadCursorSet(SLUG, PEER_RAW, 7);

    // selection.ts:414 builds its lookup key exactly this way.
    const decoded = decodeChannelKey(channelKey(SLUG, PEER_RAW));
    if (decoded === null) throw new Error("channelKey did not decode");
    expect(readCursors()[`${decoded.slug} ${decoded.name}`]).toBe(7);
  });

  it("keeps the optimistic forward-only gate on the same key as the hydrated cursor", async () => {
    const { applyReadCursorSet, getReadCursor, setReadCursor, clearReadCursors } = await import(
      "../lib/readCursor"
    );
    clearReadCursors();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    applyReadCursorSet(SLUG, PEER_RAW, 500);
    // A stale settle for an OLDER row, posted with the raw nick. Under the
    // forked keys this read `undefined` on the raw key and clobbered the map
    // backwards; the gate has to see the 500.
    await setReadCursor("tok", SLUG, PEER_RAW, 400);

    expect(getReadCursor(SLUG, PEER_FOLDED)).toBe(500);
    vi.unstubAllGlobals();
  });

  it("leaves the POST target raw — the server folds at ingress, the wire does not", async () => {
    const { setReadCursor, clearReadCursors } = await import("../lib/readCursor");
    clearReadCursors();
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);

    await setReadCursor("tok", SLUG, PEER_RAW, 42);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/channels/${PEER_RAW}/read-cursor`);
    vi.unstubAllGlobals();
  });

  it("is a no-op for a channel, whose name is already canonical", async () => {
    const { applyReadCursorSet, readCursors, getReadCursor, clearReadCursors } = await import(
      "../lib/readCursor"
    );
    clearReadCursors();

    applyReadCursorSet(SLUG, "#sniffo", 300);

    expect(Object.keys(readCursors())).toEqual([`${SLUG} #sniffo`]);
    expect(getReadCursor(SLUG, "#sniffo")).toBe(300);
  });
});
