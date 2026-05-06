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

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
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
});
