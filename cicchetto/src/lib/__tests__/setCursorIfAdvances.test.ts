// UX-8 (b1) — forward-only gate for scroll-settle cursor writes.
//
// Today cic's read-cursor only ever moves forward: focus-leave +
// browser-blur write the scrollback tail id (monotonic). When
// scroll-settle becomes a third trigger (bucket C), the call site
// computes the last fully-visible row id and POSTs it — but that
// candidate can be LESS than the current cursor when the user scrolls
// up. Server's last-write-wins would happily honor a backward POST;
// cic uses this gate to keep the existing invariant intact.
//
// The 5 cases pin the full contract: advance (POST), equal (skip),
// retreat (skip), cold-start no-cursor (POST), missing-token (skip).

import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock socket.ts so importing selection.ts (which transitively pulls
// scrollback → networks → socket) doesn't try to open a real
// WebSocket against jsdom's about:blank base URL (ERR_INVALID_URL).
// Same shape queryWindows.test.ts / subscribe.test.ts use.
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

// Mock auth so writing the token signal doesn't cascade into socket
// connect side-effects via the various module-level on(token)
// subscribers (identityScopedStore, readCursor, etc.). The
// helper-under-test reads `token` via `untrack(token)` — the test
// controls the value directly through `setTokenMock`.
let mockTokenValue: string | null = null;
vi.mock("../auth", () => ({
  token: () => mockTokenValue,
  setToken: vi.fn((v: string | null) => {
    mockTokenValue = v;
  }),
}));

// Spy on readCursor's setReadCursor so we can assert call args without
// hitting the real fetch. `vi.mock` factory must replace the export
// while keeping the rest of the module live (clearReadCursors,
// applyJoinReply, getReadCursor stay real — the helper-under-test
// reads them).
const setReadCursorSpy = vi.fn().mockResolvedValue(undefined);
vi.mock("../readCursor", async () => {
  const actual = await vi.importActual<typeof import("../readCursor")>("../readCursor");
  return {
    ...actual,
    setReadCursor: (...args: Parameters<typeof actual.setReadCursor>) => setReadCursorSpy(...args),
  };
});

describe("setCursorIfAdvances", () => {
  beforeEach(async () => {
    const { clearReadCursors } = await import("../readCursor");
    clearReadCursors();
    setReadCursorSpy.mockClear();
    mockTokenValue = null;
  });

  it("POSTs when candidate is greater than current cursor", async () => {
    const { setCursorIfAdvances } = await import("../selection");
    const { applyJoinReply } = await import("../readCursor");
    mockTokenValue = "test-bearer";
    applyJoinReply("net", "#chan", 100);

    setCursorIfAdvances("net", "#chan", 150);

    expect(setReadCursorSpy).toHaveBeenCalledWith("test-bearer", "net", "#chan", 150);
  });

  it("does NOT POST when candidate equals current cursor", async () => {
    const { setCursorIfAdvances } = await import("../selection");
    const { applyJoinReply } = await import("../readCursor");
    mockTokenValue = "test-bearer";
    applyJoinReply("net", "#chan", 100);

    setCursorIfAdvances("net", "#chan", 100);

    expect(setReadCursorSpy).not.toHaveBeenCalled();
  });

  it("does NOT POST when candidate is less than current cursor", async () => {
    const { setCursorIfAdvances } = await import("../selection");
    const { applyJoinReply } = await import("../readCursor");
    mockTokenValue = "test-bearer";
    applyJoinReply("net", "#chan", 100);

    setCursorIfAdvances("net", "#chan", 50);

    expect(setReadCursorSpy).not.toHaveBeenCalled();
  });

  it("POSTs when no cursor exists yet (cold start)", async () => {
    const { setCursorIfAdvances } = await import("../selection");
    const { getReadCursor } = await import("../readCursor");
    mockTokenValue = "test-bearer";
    // No applyJoinReply — getReadCursor returns null.
    expect(getReadCursor("net", "#chan")).toBeNull();

    setCursorIfAdvances("net", "#chan", 42);

    expect(setReadCursorSpy).toHaveBeenCalledWith("test-bearer", "net", "#chan", 42);
  });

  it("does NOT POST when token is missing", async () => {
    const { setCursorIfAdvances } = await import("../selection");
    const { applyJoinReply } = await import("../readCursor");
    // mockTokenValue = null (beforeEach default).
    applyJoinReply("net", "#chan", 100);

    setCursorIfAdvances("net", "#chan", 150);

    expect(setReadCursorSpy).not.toHaveBeenCalled();
  });
});
