import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

// Boundary: mock REST (`lib/api`). Selection effects reach into
// `scrollback.loadInitialScrollback` (the verb that backfills
// history), so listMessages is mocked too. Identity-transition
// cleanup is asserted directly via `auth.setToken(...)`.

vi.mock("../lib/api", () => ({
  listNetworks: vi.fn(),
  listChannels: vi.fn(),
  listMessages: vi.fn(),
  sendMessage: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setOn401Handler: vi.fn(),
}));

// CP29 R-4: selection.ts now POSTs to the server via
// `setReadCursor` on focus-leave / browser-blur. Stub the verb so
// tests stay self-contained — the cursor-write path is exercised by
// `readCursor.test.ts` end-to-end (mocked fetch). Without this mock the
// real `setReadCursor` calls `fetch()` with a relative URL that
// jsdom's WHATWG fetch implementation rejects with `ERR_INVALID_URL`.
vi.mock("../lib/readCursor", () => ({
  setReadCursor: vi.fn().mockResolvedValue(undefined),
  applyMeEnvelope: vi.fn(),
  applyJoinReply: vi.fn(),
  applyReadCursorSet: vi.fn(),
  getReadCursor: vi.fn(() => null),
  clearReadCursors: vi.fn(),
}));

// documentVisibility is NOT mocked — we drive it through the actual jsdom
// document.visibilityState + visibilitychange event so the real module's
// signal updates. Mocking would require disposing prior createRoot scopes
// between tests (vi.resetModules invalidates module cache but keeps Solid
// roots alive), which would cause stale-effect cross-talk.
//
// Each test starts visible+focused; setVisibilityForTest(false) flips to
// hidden and fires visibilitychange. document.hasFocus is spied on once at
// module load (default true).
const setVisibilityForTest = (visible: boolean) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (visible ? "visible" : "hidden"),
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  // Default each test to visible+focused. The real documentVisibility
  // module reads document.hasFocus() AND document.visibilityState. Spy
  // hasFocus to always return true (jsdom returns false by default
  // without focus events) so blur is opt-in via setVisibilityForTest(false).
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

describe("selection store", () => {
  it("bumpUnread increments per-key counter monotonically", async () => {
    localStorage.setItem("grappa-token", "tok");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#grappa");
    selection.bumpUnread(key);
    selection.bumpUnread(key);
    selection.bumpUnread(key);
    expect(selection.unreadCounts()[key]).toBe(3);
  });

  it("selecting a channel clears its accumulated unread count", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([]);
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#grappa");
    selection.bumpUnread(key);
    expect(selection.unreadCounts()[key]).toBe(1);
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    expect(selection.unreadCounts()[key]).toBeUndefined();
  });

  it("selecting a channel fires loadInitialScrollback exactly once across re-selections", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([]);
    const selection = await import("../lib/selection");
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    await vi.waitFor(() => {
      expect(api.listMessages).toHaveBeenCalledWith("tok", "freenode", "#grappa");
    });
    expect(api.listMessages).toHaveBeenCalledTimes(1);
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#cicchetto",
      kind: "channel",
    });
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    await vi.waitFor(() => {
      expect(api.listMessages).toHaveBeenCalledWith("tok", "freenode", "#cicchetto");
    });
    expect(api.listMessages).toHaveBeenCalledTimes(2);
  });

  it("token rotation clears selectedChannel + unreadCounts", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#grappa");
    selection.bumpUnread(key);
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    expect(selection.selectedChannel()).not.toBeNull();
    auth.setToken("tokB");
    await vi.waitFor(() => {
      expect(selection.selectedChannel()).toBeNull();
    });
    expect(selection.unreadCounts()[key]).toBeUndefined();
  });

  it("logout (token → null) clears selectedChannel + unreadCounts", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#grappa");
    selection.bumpUnread(key);
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    auth.setToken(null);
    await vi.waitFor(() => {
      expect(selection.selectedChannel()).toBeNull();
    });
    expect(selection.unreadCounts()[key]).toBeUndefined();
  });

  // C7.5: msg-vs-events badge split.
  describe("msg-vs-events badge split (C7.5)", () => {
    it("bumpMessageUnread increments messagesUnread for the key", async () => {
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");
      selection.bumpMessageUnread(key);
      selection.bumpMessageUnread(key);
      expect(selection.messagesUnread()[key]).toBe(2);
    });

    it("bumpEventUnread increments eventsUnread for the key", async () => {
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");
      selection.bumpEventUnread(key);
      expect(selection.eventsUnread()[key]).toBe(1);
    });

    it("setSelectedChannel clears both messagesUnread and eventsUnread for the key", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");
      selection.bumpMessageUnread(key);
      selection.bumpEventUnread(key);
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      expect(selection.messagesUnread()[key]).toBeUndefined();
      expect(selection.eventsUnread()[key]).toBeUndefined();
    });

    it("token rotation clears messagesUnread + eventsUnread", async () => {
      localStorage.setItem("grappa-token", "tokA");
      const auth = await import("../lib/auth");
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");
      selection.bumpMessageUnread(key);
      selection.bumpEventUnread(key);
      auth.setToken("tokB");
      await vi.waitFor(() => {
        expect(selection.messagesUnread()[key]).toBeUndefined();
      });
      expect(selection.eventsUnread()[key]).toBeUndefined();
    });
  });

  // Read-cursor set on focus-leave.
  //
  // Spec: when the user moves focus AWAY from a window, that window's
  // read-cursor is set to the server_time of the last message visible
  // in its scrollback at the moment of leave. Next visit: no marker
  // (everything seen). New incoming msgs while away → server_time
  // exceeds cursor → marker reappears on next visit.
  //
  // Anti-spec (the bug this guards against): cursor advancing on FOCUS
  // (or on every WS append) hides the marker before the user has had
  // a chance to see it. Cursor advancing only on LEAVE preserves the
  // "unread until you've moved on" semantic.
  //
  // CP29 R-4: cursor backend flipped from localStorage to server-side
  // (POST /networks/:slug/channels/:chan/read-cursor). Tests assert on
  // calls to the mocked `setReadCursor` verb instead of localStorage
  // bytes. The verb is fire-and-forget; the server-side broadcast that
  // would normally land via `applyReadCursorSet` is out of scope here
  // (covered by `readCursor.test.ts`).
  describe("read-cursor set on focus-leave", () => {
    it("switching from A to B sets A's cursor to A's last msg id", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const readCursor = await import("../lib/readCursor");
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const aKey = channelKey("freenode", "#grappa");
      // Seed #grappa scrollback with two messages.
      scrollback.appendToScrollback(aKey, {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 1_700_000_000_000,
        kind: "privmsg",
        sender: "alice",
        body: "hi",
        meta: {},
      });
      scrollback.appendToScrollback(aKey, {
        id: 2,
        network: "freenode",
        channel: "#grappa",
        server_time: 1_700_000_001_000,
        kind: "privmsg",
        sender: "bob",
        body: "hey",
        meta: {},
      });
      // Focus #grappa, then leave to #cicchetto.
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      // Cursor not yet set on focus alone — only on leave.
      expect(readCursor.setReadCursor).not.toHaveBeenCalled();
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#cicchetto",
        kind: "channel",
      });
      // After leave: cursor set to last msg's id.
      expect(readCursor.setReadCursor).toHaveBeenCalledWith("tok", "freenode", "#grappa", 2);
    });

    it("switching from A to null (deselect) also sets A's cursor", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const readCursor = await import("../lib/readCursor");
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const aKey = channelKey("freenode", "#grappa");
      scrollback.appendToScrollback(aKey, {
        id: 7,
        network: "freenode",
        channel: "#grappa",
        server_time: 1_700_000_005_000,
        kind: "privmsg",
        sender: "alice",
        body: "bye",
        meta: {},
      });
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      selection.setSelectedChannel(null);
      expect(readCursor.setReadCursor).toHaveBeenCalledWith("tok", "freenode", "#grappa", 7);
    });

    it("leaving a window with no scrollback yet does NOT set the cursor", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const readCursor = await import("../lib/readCursor");
      const selection = await import("../lib/selection");
      // No seeded scrollback — only the focus + leave dance.
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#empty",
        kind: "channel",
      });
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#other",
        kind: "channel",
      });
      // Nothing to mark as read.
      expect(readCursor.setReadCursor).not.toHaveBeenCalled();
    });

    it("re-selecting the same window does NOT set the cursor (no leave occurred)", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const readCursor = await import("../lib/readCursor");
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const aKey = channelKey("freenode", "#grappa");
      scrollback.appendToScrollback(aKey, {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 1_700_000_000_000,
        kind: "privmsg",
        sender: "alice",
        body: "hi",
        meta: {},
      });
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      expect(readCursor.setReadCursor).not.toHaveBeenCalled();
    });
  });

  // Browser-blur arm: when the focused window's browser tab loses
  // focus (Cmd-Tab away, Page Visibility hidden, etc.), the cursor
  // for the currently-selected window must set — same semantic as
  // a cicchetto-leave but triggered by document-visibility transitions.
  // Without this, returning to the browser would show no marker even
  // for msgs that arrived while the user was demonstrably away.
  describe("read-cursor set on browser-blur (visibility transition)", () => {
    it("focused on #grappa, browser blurs → cursor sets to last visible msg id", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const readCursor = await import("../lib/readCursor");
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const key = channelKey("freenode", "#grappa");
      scrollback.appendToScrollback(key, {
        id: 42,
        network: "freenode",
        channel: "#grappa",
        server_time: 1_700_000_010_000,
        kind: "privmsg",
        sender: "alice",
        body: "msg",
        meta: {},
      });
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      // Pre-blur: cursor not yet set (focus alone doesn't set).
      expect(readCursor.setReadCursor).not.toHaveBeenCalled();

      setVisibilityForTest(false);
      await Promise.resolve(); // let the createEffect flush

      expect(readCursor.setReadCursor).toHaveBeenCalledWith("tok", "freenode", "#grappa", 42);
    });

    it("no selected window: blur does NOT set any cursor", async () => {
      localStorage.setItem("grappa-token", "tok");
      const readCursor = await import("../lib/readCursor");
      const selection = await import("../lib/selection");
      // No setSelectedChannel call — selection is null at module load.
      expect(selection.selectedChannel()).toBeNull();

      setVisibilityForTest(false);
      await Promise.resolve();

      expect(readCursor.setReadCursor).not.toHaveBeenCalled();
    });

    it("focused on empty-scrollback window: blur does NOT set the cursor", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const readCursor = await import("../lib/readCursor");
      const selection = await import("../lib/selection");
      // Select but don't seed any scrollback — there is nothing to mark as read.
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#empty",
        kind: "channel",
      });
      setVisibilityForTest(false);
      await Promise.resolve();

      expect(readCursor.setReadCursor).not.toHaveBeenCalled();
    });

    it("blur followed by focus regain does NOT set the cursor again", async () => {
      // Only the blur transition writes; focus regain is a no-op
      // (the user is now actively reading, no msgs to mark as "seen
      // while away").
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const readCursor = await import("../lib/readCursor");
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const key = channelKey("freenode", "#grappa");
      scrollback.appendToScrollback(key, {
        id: 100,
        network: "freenode",
        channel: "#grappa",
        server_time: 100,
        kind: "privmsg",
        sender: "alice",
        body: "msg",
        meta: {},
      });
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      setVisibilityForTest(false);
      await Promise.resolve();
      expect(readCursor.setReadCursor).toHaveBeenCalledTimes(1);
      expect(readCursor.setReadCursor).toHaveBeenLastCalledWith("tok", "freenode", "#grappa", 100);

      setVisibilityForTest(true);
      await Promise.resolve();
      // Focus regain must NOT trigger another set.
      expect(readCursor.setReadCursor).toHaveBeenCalledTimes(1);
    });

    it("initial visibility=true does NOT spuriously set any cursor", async () => {
      // Module load fires the on(isDocumentVisible) effect with prev===undefined.
      // That initial run must skip cursor set (otherwise every fresh
      // window with msgs would have its cursor pinned to "now" at load).
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const readCursor = await import("../lib/readCursor");
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const key = channelKey("freenode", "#grappa");
      scrollback.appendToScrollback(key, {
        id: 1,
        network: "freenode",
        channel: "#grappa",
        server_time: 100,
        kind: "privmsg",
        sender: "alice",
        body: "msg",
        meta: {},
      });
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      // No setVisibilityForTest call — visibility stays at its initial true.
      // After microtask flush, cursor must NOT be set.
      await Promise.resolve();
      expect(readCursor.setReadCursor).not.toHaveBeenCalled();
    });
  });
  // Badge clear on browser-focus-regain — symmetric counterpart to the
  // browser-blur cursor-set arm. When the focused window's browser tab
  // regains focus, badges (unread / messages / events) for that window
  // must clear — same semantic as cicchetto-select clear, just triggered
  // by visibility transition instead of selection change.
  //
  // Without this, a user who blurs the browser, accumulates unread badge
  // bumps via subscribe.ts (effective-focus = false → bump), and then
  // returns to the browser would still see the badge sitting on the
  // currently-selected window even though they're now actively reading.
  describe("badge clear on browser-focus-regain", () => {
    it("badges for selected window clear when browser regains focus", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      // Simulate the subscribe.ts blurred-arrival path: badges bumped
      // because effective-focus was false at msg arrival.
      setVisibilityForTest(false);
      await Promise.resolve();
      selection.bumpUnread(key);
      selection.bumpMessageUnread(key);
      selection.bumpEventUnread(key);
      expect(selection.unreadCounts()[key]).toBe(1);
      expect(selection.messagesUnread()[key]).toBe(1);
      expect(selection.eventsUnread()[key]).toBe(1);

      // Browser regains focus → user is now reading → badges should clear.
      setVisibilityForTest(true);
      await Promise.resolve();

      expect(selection.unreadCounts()[key]).toBeUndefined();
      expect(selection.messagesUnread()[key]).toBeUndefined();
      expect(selection.eventsUnread()[key]).toBeUndefined();
    });

    it("badges for OTHER (non-selected) windows are NOT touched on focus-regain", async () => {
      // Anti-spec guard: focus-regain only clears the SELECTED window's
      // badges. A msg accumulated on a different window while away must
      // remain visibly unread until the user navigates there.
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const selKey = channelKey("freenode", "#grappa");
      const otherKey = channelKey("freenode", "#cicchetto");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      setVisibilityForTest(false);
      await Promise.resolve();
      selection.bumpMessageUnread(selKey);
      selection.bumpMessageUnread(otherKey);

      setVisibilityForTest(true);
      await Promise.resolve();

      expect(selection.messagesUnread()[selKey]).toBeUndefined();
      // Other window's badge survives — user hasn't read it yet.
      expect(selection.messagesUnread()[otherKey]).toBe(1);
    });

    it("focus-regain with no selected window is a no-op", async () => {
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");
      // No setSelectedChannel — selection is null.
      selection.bumpMessageUnread(key);
      setVisibilityForTest(false);
      await Promise.resolve();
      setVisibilityForTest(true);
      await Promise.resolve();

      // Badge for unselected channel left intact (focus-regain found no
      // selection to clear).
      expect(selection.messagesUnread()[key]).toBe(1);
    });

    it("initial visibility=true does NOT spuriously clear bumped badges", async () => {
      // Mirror of the cursor-set "initial run" guard. Module load fires
      // the visibility effect with prev===undefined; that initial run must
      // not clear pre-existing badges (e.g. from history-restore on cold
      // start or future cross-tab sync).
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      // Bump AFTER selection (the select path itself clears badges; we want
      // to assert the visibility-effect's initial run does not double-clear
      // a fresh bump).
      selection.bumpMessageUnread(key);
      // No setVisibilityForTest — visibility stays true (initial state).
      await Promise.resolve();

      expect(selection.messagesUnread()[key]).toBe(1);
    });
  });
});
