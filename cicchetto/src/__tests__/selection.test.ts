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

  // Read-cursor advance on focus-leave.
  //
  // Spec: when the user moves focus AWAY from a window, that window's
  // read-cursor advances to the server_time of the last message visible
  // in its scrollback at the moment of leave. Next visit: no marker
  // (everything seen). New incoming msgs while away → server_time
  // exceeds cursor → marker reappears on next visit.
  //
  // Anti-spec (the bug this guards against): cursor advancing on FOCUS
  // (or on every WS append) hides the marker before the user has had
  // a chance to see it. Cursor advancing only on LEAVE preserves the
  // "unread until you've moved on" semantic.
  describe("read-cursor advance on focus-leave", () => {
    it("switching from A to B advances rc:A to A's last msg server_time", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
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
      expect(localStorage.getItem("rc:freenode:#grappa")).toBeNull();
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#cicchetto",
        kind: "channel",
      });
      // After leave: cursor advanced to last msg's server_time.
      expect(localStorage.getItem("rc:freenode:#grappa")).toBe(String(1_700_000_001_000));
    });

    it("switching from A to null (deselect) also advances rc:A", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const aKey = channelKey("freenode", "#grappa");
      scrollback.appendToScrollback(aKey, {
        id: 1,
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
      expect(localStorage.getItem("rc:freenode:#grappa")).toBe(String(1_700_000_005_000));
    });

    it("leaving a window with no scrollback yet does NOT write a cursor", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
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
      // No cursor written for #empty: nothing to mark as read.
      expect(localStorage.getItem("rc:freenode:#empty")).toBeNull();
    });

    it("re-selecting the same window does NOT advance the cursor (no leave occurred)", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
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
      // Seed a sentinel cursor — re-select must NOT touch it.
      localStorage.setItem("rc:freenode:#grappa", "999");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      expect(localStorage.getItem("rc:freenode:#grappa")).toBe("999");
    });
  });

  // Browser-blur arm: when the focused window's browser tab loses
  // focus (Cmd-Tab away, Page Visibility hidden, etc.), the cursor
  // for the currently-selected window must advance — same semantic as
  // a cicchetto-leave but triggered by document-visibility transitions.
  // Without this, returning to the browser would show no marker even
  // for msgs that arrived while the user was demonstrably away.
  describe("read-cursor advance on browser-blur (visibility transition)", () => {
    it("focused on #grappa, browser blurs → cursor advances to last visible msg server_time", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const key = channelKey("freenode", "#grappa");
      scrollback.appendToScrollback(key, {
        id: 1,
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
      // Pre-blur: cursor not yet set (focus alone doesn't advance).
      expect(localStorage.getItem("rc:freenode:#grappa")).toBeNull();

      setVisibilityForTest(false);
      await Promise.resolve(); // let the createEffect flush

      expect(localStorage.getItem("rc:freenode:#grappa")).toBe(String(1_700_000_010_000));
    });

    it("no selected window: blur does NOT write any cursor", async () => {
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      // No setSelectedChannel call — selection is null at module load.
      expect(selection.selectedChannel()).toBeNull();

      setVisibilityForTest(false);
      await Promise.resolve();

      // No rc:* keys should exist for any channel.
      let count = 0;
      for (let i = 0; i < localStorage.length; i++) {
        if (localStorage.key(i)?.startsWith("rc:")) count++;
      }
      expect(count).toBe(0);
    });

    it("focused on empty-scrollback window: blur does NOT write a cursor", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      // Select but don't seed any scrollback — there is nothing to mark as read.
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#empty",
        kind: "channel",
      });
      setVisibilityForTest(false);
      await Promise.resolve();

      expect(localStorage.getItem("rc:freenode:#empty")).toBeNull();
    });

    it("blur followed by focus regain does NOT advance the cursor again", async () => {
      // Only the blur transition writes; focus regain is a no-op
      // (the user is now actively reading, no msgs to mark as "seen
      // while away").
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
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
      setVisibilityForTest(false);
      await Promise.resolve();
      // Sentinel: cursor at 100. A focus regain must NOT clobber it
      // (e.g. with a stale value or null).
      expect(localStorage.getItem("rc:freenode:#grappa")).toBe("100");

      setVisibilityForTest(true);
      await Promise.resolve();
      expect(localStorage.getItem("rc:freenode:#grappa")).toBe("100");
    });

    it("initial visibility=true does NOT spuriously advance any cursor", async () => {
      // Module load fires the on(isDocumentVisible) effect with prev===undefined.
      // That initial run must skip cursor advance (otherwise every fresh
      // window with msgs would have its cursor pinned to "now" at load).
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
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
      expect(localStorage.getItem("rc:freenode:#grappa")).toBeNull();
    });
  });
});
