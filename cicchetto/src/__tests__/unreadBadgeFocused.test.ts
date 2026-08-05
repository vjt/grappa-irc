import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

// #887 — the badge on the FOCUSED window: visible, and falling as rows are
// marked read.
//
// Its own file because `selection.test.ts` mocks `../lib/readCursor` flat (a
// stub returning an empty map), which is the right boundary for the questions
// that file asks and exactly the wrong one here: the whole property under test
// is that the number tracks the cursor as the cursor MOVES. So this file runs
// the real cursor store and drives it through `applyReadCursorSet` — the same
// entry point the server's `read_cursor_set` WS event lands on, so what the
// test moves is what production moves.
//
// The complaint this pins (vjt, 2026-08-05): focus a channel you have been
// reading → the badge disappears; switch away → it comes back at 1832. Both
// halves were the suppression overwrite in `perChannelUnread`. What must
// replace them is a number that starts where it should and comes DOWN.

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

const SLUG = "freenode";
const CHANNEL = "#grappa";

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

const seedThreeMessages = async (): Promise<ReturnType<typeof channelKey>> => {
  const scrollback = await import("../lib/scrollback");
  const key = channelKey(SLUG, CHANNEL);
  for (const id of [1, 2, 3]) {
    scrollback.appendToScrollback(key, {
      id,
      network: SLUG,
      channel: CHANNEL,
      server_time: id,
      kind: "privmsg",
      sender: "bob",
      body: `msg ${id}`,
      meta: {},
    });
  }
  return key;
};

describe("#887 focused-window unread badge", () => {
  it("stays visible on select and falls one row at a time as the cursor advances", async () => {
    localStorage.setItem("grappa-token", "tok");
    const selection = await import("../lib/selection");
    const readCursor = await import("../lib/readCursor");
    const key = await seedThreeMessages();

    selection.setSelectedChannel({
      networkSlug: SLUG,
      channelName: CHANNEL,
      kind: "channel",
    });

    // Pre-#887 this read `undefined`: selecting the window hid the badge.
    expect(selection.messagesUnread()[key]).toBe(3);

    // Reading. Each cursor advance is one more row marked read, and the badge
    // must answer with the remainder — not hold, not vanish. Asserting the
    // INTERMEDIATE value is the point: a badge that only ever went 3 →
    // undefined would also pass a first-and-last check while being exactly
    // the vanishing behaviour #887 removed.
    readCursor.applyReadCursorSet(SLUG, CHANNEL, 1);
    expect(selection.messagesUnread()[key]).toBe(2);

    readCursor.applyReadCursorSet(SLUG, CHANNEL, 2);
    expect(selection.messagesUnread()[key]).toBe(1);

    // Fully read: the key drops out of the map entirely, which is how the
    // sidebar's `> 0` guard unmounts the pill.
    readCursor.applyReadCursorSet(SLUG, CHANNEL, 3);
    expect(selection.messagesUnread()[key]).toBeUndefined();
  });

  it("does not resurrect the count when the operator leaves a window they read", async () => {
    localStorage.setItem("grappa-token", "tok");
    const selection = await import("../lib/selection");
    const readCursor = await import("../lib/readCursor");
    const key = await seedThreeMessages();

    selection.setSelectedChannel({
      networkSlug: SLUG,
      channelName: CHANNEL,
      kind: "channel",
    });
    readCursor.applyReadCursorSet(SLUG, CHANNEL, 3);
    expect(selection.messagesUnread()[key]).toBeUndefined();

    // The other half of the report: leaving used to lift the suppression and
    // republish the whole pre-select count. With the count cursor-derived
    // everywhere, leaving is not an event the badge can even observe.
    selection.setSelectedChannel({
      networkSlug: SLUG,
      channelName: "#other",
      kind: "channel",
    });

    expect(selection.messagesUnread()[key]).toBeUndefined();
  });

  it("keeps counting rows that arrive in the focused window past the cursor", async () => {
    localStorage.setItem("grappa-token", "tok");
    const scrollback = await import("../lib/scrollback");
    const selection = await import("../lib/selection");
    const readCursor = await import("../lib/readCursor");
    const key = await seedThreeMessages();

    selection.setSelectedChannel({
      networkSlug: SLUG,
      channelName: CHANNEL,
      kind: "channel",
    });
    readCursor.applyReadCursorSet(SLUG, CHANNEL, 3);
    expect(selection.messagesUnread()[key]).toBeUndefined();

    // A message lands while the operator is looking at the window. The badge
    // shows it — the count is not silenced by focus. Bringing it back to zero
    // is the read-at-the-tail cursor advance (ScrollbackPane), which needs a
    // laid-out pane and is tested there; what belongs here is that the memo
    // reports the row at all, because the suppression used to eat it.
    scrollback.appendToScrollback(key, {
      id: 4,
      network: SLUG,
      channel: CHANNEL,
      server_time: 4,
      kind: "privmsg",
      sender: "bob",
      body: "arrives while you watch",
      meta: {},
    });

    expect(selection.messagesUnread()[key]).toBe(1);
  });
});
