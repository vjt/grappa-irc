// RC2 (decouple-unread-badge) — opening a fresh channel marks its
// existing backlog as the read baseline.
//
// Root cause this pins: `loadInitialScrollback` fires on focus and
// pulls the REST backlog, but never recorded a read position. A
// channel visited then defocused BEFORE the backlog hydrated left the
// cursor nil, so the server's nil-cursor `unread_count` counted the
// whole backlog (200) plus the next inbound msg (→ badge "201" instead
// of "1"; the m2-irssi-to-chan-defocused e2e).
//
// The fix advances the cursor to the loaded page's tail (max id) ONLY
// when no cursor exists yet — a freshly-opened channel auto-scrolls to
// the newest row, so "cursor = tail" is the honest "you've seen the
// newest." Gating on null preserves an existing read position (and its
// in-pane unread marker), so a channel you already have a cursor for is
// never re-baselined.
//
// Three cases pin the contract: advance-on-cold-open, preserve-existing,
// skip-empty-page.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../api";

// Mock socket so importing scrollback's transitive graph doesn't open a
// real WebSocket against jsdom's about:blank base URL. Mirrors
// setCursorIfAdvances.test.ts / queryWindows.test.ts.
vi.mock("../socket", () => ({
  joinUser: vi.fn(() => ({ on: vi.fn(), push: vi.fn().mockReturnValue({ receive: vi.fn() }) })),
  joinChannel: vi.fn(() => ({
    join: vi.fn(() => ({ receive: vi.fn().mockReturnValue({ receive: vi.fn() }) })),
    on: vi.fn(),
  })),
  pushCloseQueryWindow: vi.fn(),
  pushOpenQueryWindow: vi.fn(),
  notifyClientClosing: vi.fn(),
  pushAwaySet: vi.fn(),
  pushAwayUnset: vi.fn(),
}));

// Mock auth so the token is test-controlled and writing it doesn't
// cascade into socket connect via the various on(token) subscribers.
let mockTokenValue: string | null = null;
vi.mock("../auth", () => ({
  token: () => mockTokenValue,
  setToken: vi.fn((v: string | null) => {
    mockTokenValue = v;
  }),
}));

// Stub the one REST verb loadInitialScrollback calls; keep the rest of
// api live (the module just declares fetch wrappers — nothing runs at
// import). The spy returns a server-shaped DESC page per test.
const listMessagesSpy = vi.fn<(...a: unknown[]) => Promise<ScrollbackMessage[]>>();
vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    listMessages: (...args: unknown[]) => listMessagesSpy(...args),
  };
});

// Spy setReadCursor without hitting fetch; keep the rest of readCursor
// live so getReadCursor / applyJoinReply / clearReadCursors are real.
const setReadCursorSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../readCursor", async () => {
  const actual = await vi.importActual<typeof import("../readCursor")>("../readCursor");
  return {
    ...actual,
    setReadCursor: (...args: Parameters<typeof actual.setReadCursor>) => setReadCursorSpy(...args),
  };
});

// Build a realistic server-shaped row. The server returns DESC, so the
// page's max id is the tail regardless of position — the impl must not
// assume page[0].
const row = (id: number): ScrollbackMessage => ({
  id,
  network: "net",
  channel: "#bofh",
  server_time: 1_700_000_000 + id,
  kind: "privmsg",
  sender: "peer",
  body: `line ${id}`,
  meta: {},
});

describe("loadInitialScrollback cursor baseline", () => {
  beforeEach(async () => {
    const { clearReadCursors } = await import("../readCursor");
    clearReadCursors();
    setReadCursorSpy.mockClear();
    listMessagesSpy.mockReset();
    mockTokenValue = "test-bearer";
  });

  it("advances the cursor to the loaded page tail when no cursor exists", async () => {
    const { loadInitialScrollback } = await import("../scrollback");
    // Server-shaped DESC page; tail (max id) is 203, not page[0].id.
    listMessagesSpy.mockResolvedValue([row(203), row(202), row(201)]);

    await loadInitialScrollback("net", "#cold");

    expect(setReadCursorSpy).toHaveBeenCalledWith("test-bearer", "net", "#cold", 203);
  });

  it("does NOT touch the cursor when one already exists (preserves marker)", async () => {
    const { loadInitialScrollback } = await import("../scrollback");
    const { applyJoinReply } = await import("../readCursor");
    applyJoinReply("net", "#warm", 100);
    listMessagesSpy.mockResolvedValue([row(203), row(202), row(201)]);

    await loadInitialScrollback("net", "#warm");

    expect(setReadCursorSpy).not.toHaveBeenCalled();
  });

  it("does NOT write a cursor for an empty backlog page", async () => {
    const { loadInitialScrollback } = await import("../scrollback");
    listMessagesSpy.mockResolvedValue([]);

    await loadInitialScrollback("net", "#empty");

    expect(setReadCursorSpy).not.toHaveBeenCalled();
  });
});
