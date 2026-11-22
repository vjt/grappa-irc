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
vi.mock("../lib/socket", () => ({
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
vi.mock("../lib/auth", () => ({
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
vi.mock("../lib/readCursor", async () => {
  const actual = await vi.importActual<typeof import("../lib/readCursor")>("../lib/readCursor");
  return {
    ...actual,
    setReadCursor: (...args: Parameters<typeof actual.setReadCursor>) => setReadCursorSpy(...args),
  };
});

// issue 2201 — the query-window guard resolves the slug to a network id. No
// network is known by default (the real store is empty here too), which keeps
// every case above the 2201 block on the plain path.
let networkBySlugMock: (slug: string) => { id: number; slug: string } | undefined = () => undefined;
vi.mock("../lib/networks", async () => {
  const actual = await vi.importActual<typeof import("../lib/networks")>("../lib/networks");
  return { ...actual, networkBySlug: (slug: string) => networkBySlugMock(slug) as never };
});

// #693 — the far-behind freeze reads this map through selection.ts. Keep the
// rest of scrollback live; the spec drives the one signal it needs.
let farBehindMap: Record<string, { missed: number; resumeFrom: number }> = {};
vi.mock("../lib/scrollback", async () => {
  const actual = await vi.importActual<typeof import("../lib/scrollback")>("../lib/scrollback");
  return { ...actual, farBehindByChannel: () => farBehindMap };
});

describe("setCursorIfAdvances", () => {
  beforeEach(async () => {
    const { clearReadCursors } = await import("../lib/readCursor");
    clearReadCursors();
    setReadCursorSpy.mockClear();
    mockTokenValue = null;
    farBehindMap = {};
    networkBySlugMock = () => undefined;
    const { setQueryWindowsByNetwork } = await import("../lib/queryWindows");
    setQueryWindowsByNetwork({});
  });

  it("does NOT POST while the window is far behind (#693)", async () => {
    // A tail-anchored pane renders rows thousands of ids past the operator's
    // real read position. Taking one would mark the whole abandoned region
    // read — server-side, on every device — destroying the position the jump
    // affordance exists to return to. Only `dismissFarBehind` may do that.
    const { setCursorIfAdvances } = await import("../lib/selection");
    const { applyJoinReply } = await import("../lib/readCursor");
    mockTokenValue = "test-bearer";
    applyJoinReply("net", "#chan", 100);
    farBehindMap = { "net #chan": { missed: 3000, resumeFrom: 100 } };

    setCursorIfAdvances("net", "#chan", 3100);

    expect(setReadCursorSpy).not.toHaveBeenCalled();
  });

  it("resumes POSTing for other windows while one is far behind", async () => {
    const { setCursorIfAdvances } = await import("../lib/selection");
    const { applyJoinReply } = await import("../lib/readCursor");
    mockTokenValue = "test-bearer";
    applyJoinReply("net", "#other", 100);
    farBehindMap = { "net #chan": { missed: 3000, resumeFrom: 100 } };

    setCursorIfAdvances("net", "#other", 150);

    expect(setReadCursorSpy).toHaveBeenCalledWith("test-bearer", "net", "#other", 150);
  });

  it("POSTs when candidate is greater than current cursor", async () => {
    const { setCursorIfAdvances } = await import("../lib/selection");
    const { applyJoinReply } = await import("../lib/readCursor");
    mockTokenValue = "test-bearer";
    applyJoinReply("net", "#chan", 100);

    setCursorIfAdvances("net", "#chan", 150);

    expect(setReadCursorSpy).toHaveBeenCalledWith("test-bearer", "net", "#chan", 150);
  });

  it("does NOT POST when candidate equals current cursor", async () => {
    const { setCursorIfAdvances } = await import("../lib/selection");
    const { applyJoinReply } = await import("../lib/readCursor");
    mockTokenValue = "test-bearer";
    applyJoinReply("net", "#chan", 100);

    setCursorIfAdvances("net", "#chan", 100);

    expect(setReadCursorSpy).not.toHaveBeenCalled();
  });

  it("does NOT POST when candidate is less than current cursor", async () => {
    const { setCursorIfAdvances } = await import("../lib/selection");
    const { applyJoinReply } = await import("../lib/readCursor");
    mockTokenValue = "test-bearer";
    applyJoinReply("net", "#chan", 100);

    setCursorIfAdvances("net", "#chan", 50);

    expect(setReadCursorSpy).not.toHaveBeenCalled();
  });

  it("POSTs when no cursor exists yet (cold start)", async () => {
    const { setCursorIfAdvances } = await import("../lib/selection");
    const { getReadCursor } = await import("../lib/readCursor");
    mockTokenValue = "test-bearer";
    // No applyJoinReply — getReadCursor returns null.
    expect(getReadCursor("net", "#chan")).toBeNull();

    setCursorIfAdvances("net", "#chan", 42);

    expect(setReadCursorSpy).toHaveBeenCalledWith("test-bearer", "net", "#chan", 42);
  });

  it("does NOT POST when token is missing", async () => {
    const { setCursorIfAdvances } = await import("../lib/selection");
    const { applyJoinReply } = await import("../lib/readCursor");
    // mockTokenValue = null (beforeEach default).
    applyJoinReply("net", "#chan", 100);

    setCursorIfAdvances("net", "#chan", 150);

    expect(setReadCursorSpy).not.toHaveBeenCalled();
  });

  // issue 2201 — closing a query deletes its read cursor on the server, and
  // the pane leaving the closed window offers its tail to this door. The
  // server refuses that write (`422 no_query_window`); cic must not send it.
  describe("a query the server no longer holds (issue 2201)", () => {
    const openedAt = "2026-11-22T00:00:00Z";

    beforeEach(() => {
      networkBySlugMock = (slug) => (slug === "freenode" ? { id: 42, slug } : undefined);
    });

    it("does NOT POST for a DM with no query window", async () => {
      const { setCursorIfAdvances } = await import("../lib/selection");
      const { setQueryWindowsByNetwork } = await import("../lib/queryWindows");
      mockTokenValue = "test-bearer";
      setQueryWindowsByNetwork({ 42: [] });

      setCursorIfAdvances("freenode", "bob", 3);

      expect(setReadCursorSpy).not.toHaveBeenCalled();
    });

    it("POSTs for a DM whose window is open, matched case-insensitively", async () => {
      const { setCursorIfAdvances } = await import("../lib/selection");
      const { setQueryWindowsByNetwork } = await import("../lib/queryWindows");
      mockTokenValue = "test-bearer";
      setQueryWindowsByNetwork({ 42: [{ targetNick: "Bob", openedAt }] });

      setCursorIfAdvances("freenode", "bob", 3);

      expect(setReadCursorSpy).toHaveBeenCalledWith("test-bearer", "freenode", "bob", 3);
    });

    it("a channel and $server need no query window", async () => {
      const { setCursorIfAdvances } = await import("../lib/selection");
      const { setQueryWindowsByNetwork } = await import("../lib/queryWindows");
      mockTokenValue = "test-bearer";
      setQueryWindowsByNetwork({ 42: [] });

      setCursorIfAdvances("freenode", "#chan", 3);
      setCursorIfAdvances("freenode", "$server", 4);

      expect(setReadCursorSpy).toHaveBeenCalledWith("test-bearer", "freenode", "#chan", 3);
      expect(setReadCursorSpy).toHaveBeenCalledWith("test-bearer", "freenode", "$server", 4);
    });
  });
});
