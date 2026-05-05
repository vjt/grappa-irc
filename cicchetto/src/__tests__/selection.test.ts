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
});
