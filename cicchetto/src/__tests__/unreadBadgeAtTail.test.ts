import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

// #981 — no badge on a window the operator is sitting at the bottom of.
//
// The complaint (vjt, 2026-08-07): a channel is selected, the pane is already
// at the tail, a message lands — the badge blinks `1` and clears itself. The
// blink is the gap between the memo (synchronous) and the read-at-the-tail
// cursor arm (debounced 500 ms), so the fix suppresses the count for exactly
// the window the pane reports it is reading, via `readingAtTail`.
//
// Its own file, sibling to `unreadBadgeFocused.test.ts` and for the same
// reason: it runs the REAL scrollback + readCursor stores, because the #693
// far-behind guard below can only be set up by driving the production loader.
//
// What these tests DO NOT cover: the geometry itself. `atBottomNow` is a DOM
// measurement and jsdom reports zero-height boxes, so scrolled-up-vs-at-tail
// is not bindable here (measured under #887: deleting the gate left all 171
// pane tests green). These tests drive the pane's PUBLISHED answer directly;
// the pane's own publishing rules are pinned in `ScrollbackPane.test.tsx`, and
// the end-to-end "the badge never appears" property is an e2e.

vi.mock(import("../lib/api"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listNetworks: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([]),
    listMessages: vi.fn().mockResolvedValue([]),
    listMessagesAfter: vi.fn().mockResolvedValue([]),
    countMessagesAfter: vi.fn().mockResolvedValue(0),
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

// Keep the cursor store REAL (applyJoinReply / getReadCursor are the setup
// verbs) but stub the one member that would hit the network.
vi.mock("../lib/readCursor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/readCursor")>();
  return { ...actual, setReadCursor: vi.fn().mockResolvedValue(undefined) };
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
  localStorage.setItem("grappa-token", "tok");
});

const seedThreeMessages = async (channel: string): Promise<ReturnType<typeof channelKey>> => {
  const scrollback = await import("../lib/scrollback");
  const key = channelKey(SLUG, channel);
  for (const id of [1, 2, 3]) {
    scrollback.appendToScrollback(key, {
      id,
      network: SLUG,
      channel,
      server_time: id,
      kind: "privmsg",
      sender: "bob",
      body: `msg ${id}`,
      meta: {},
    });
  }
  return key;
};

describe("#981 unread badge on the window being read at the tail", () => {
  it("suppresses the count for the window the pane reports reading", async () => {
    const selection = await import("../lib/selection");
    const { setReadingAtTailKey } = await import("../lib/readingAtTail");
    const key = await seedThreeMessages(CHANNEL);

    // Without the pane's report the count is the plain #887 number.
    expect(selection.messagesUnread()[key]).toBe(3);

    setReadingAtTailKey(key);

    expect(selection.messagesUnread()[key]).toBeUndefined();
    expect(selection.unreadCounts()[key]).toBeUndefined();
  });

  it("suppresses event counts too — no badge means no badge", async () => {
    const scrollback = await import("../lib/scrollback");
    const selection = await import("../lib/selection");
    const { setReadingAtTailKey } = await import("../lib/readingAtTail");
    const key = channelKey(SLUG, CHANNEL);
    scrollback.appendToScrollback(key, {
      id: 1,
      network: SLUG,
      channel: CHANNEL,
      server_time: 1,
      kind: "join",
      sender: "bob",
      body: "",
      meta: {},
    });
    expect(selection.eventsUnread()[key]).toBe(1);

    setReadingAtTailKey(key);

    expect(selection.eventsUnread()[key]).toBeUndefined();
  });

  it("restores the count the moment the pane stops reporting (leave, scroll up, hide)", async () => {
    const selection = await import("../lib/selection");
    const { setReadingAtTailKey } = await import("../lib/readingAtTail");
    const key = await seedThreeMessages(CHANNEL);

    setReadingAtTailKey(key);
    expect(selection.messagesUnread()[key]).toBeUndefined();

    // `null` is what the pane publishes for every not-reading state: unmount,
    // backgrounded tab, scrolled up, geometry not yet measured.
    setReadingAtTailKey(null);

    expect(selection.messagesUnread()[key]).toBe(3);
  });

  it("suppresses ONLY the reported window — every other badge stands", async () => {
    const selection = await import("../lib/selection");
    const { setReadingAtTailKey } = await import("../lib/readingAtTail");
    const readKey = await seedThreeMessages(CHANNEL);
    const otherKey = await seedThreeMessages("#other");

    setReadingAtTailKey(readKey);

    expect(selection.messagesUnread()[readKey]).toBeUndefined();
    expect(selection.messagesUnread()[otherKey]).toBe(3);
  });

  // #693 — a far-behind window's cursor is FROZEN on purpose and its loaded
  // rows are the tail, deliberately disjoint from the unread region. The
  // server-measured seed is the honest number and the operator being at the
  // bottom of those few rows does not mean they have read the thousands
  // above. Suppressing here would zero the one badge that cannot come back
  // on its own.
  it("keeps a FAR-BEHIND window's badge even while the pane reads its tail", async () => {
    const api = await import("../lib/api");
    vi.mocked(api.countMessagesAfter).mockResolvedValue(3000);
    vi.mocked(api.listMessages).mockResolvedValue([
      {
        id: 3100,
        network: SLUG,
        channel: CHANNEL,
        server_time: 3100,
        kind: "privmsg",
        sender: "bob",
        body: "newest",
        meta: {},
      },
    ]);
    const { applyJoinReply } = await import("../lib/readCursor");
    const { loadInitialScrollback, farBehindByChannel } = await import("../lib/scrollback");
    const selection = await import("../lib/selection");
    const { setReadingAtTailKey } = await import("../lib/readingAtTail");
    const key = channelKey(SLUG, CHANNEL);

    applyJoinReply(SLUG, CHANNEL, 100);
    await loadInitialScrollback(SLUG, CHANNEL);
    expect(farBehindByChannel()[key]).toEqual({ missed: 3000, resumeFrom: 100 });

    selection.setServerSeedCount(key, { messages: 3000, events: 0 });
    expect(selection.messagesUnread()[key]).toBe(3000);

    setReadingAtTailKey(key);

    expect(selection.messagesUnread()[key]).toBe(3000);
  });
});
