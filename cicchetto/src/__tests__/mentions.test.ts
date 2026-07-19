import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

// #267 — server-authoritative per-window MENTION count.
//
// `mentions.ts` owns the store the sidebar reads for the red mention
// badge. The count is NOT a client-side PRIVMSG-body bump anymore; it is
// fed by the server via three doors, all funnelling into `setServerMention`
// (the per-window setter) or `applyServerMentionsEnvelope` (the /me
// cold-load bulk hydrate driven by the `user()` effect):
//   * `/me` `unread_counts` envelope (cold load),
//   * the per-channel join reply's `window_counts` seed,
//   * the live `window_counts` push (new message + cursor advance).
//
// This file tests the STORE in isolation: the setter semantics (set,
// zero-drops, idempotent short-circuit), the focus-zero overlay
// (`mentionCounts` renders 0 for the selected+visible window), and the
// identity-rotation reset. subscribe.test.ts covers that subscribe.ts
// actually calls `setServerMention` on those events — here we own the
// projection.
//
// Boundary + setup mirror selection.test.ts (its sibling store):
//   * `lib/api` mocked so networks' `user` resource resolves silently;
//     the /me hydrate test overrides `me()` with an unread_counts payload.
//   * `lib/readCursor` mocked so selection's cursor writes don't hit a
//     relative-URL `fetch` (jsdom `ERR_INVALID_URL`).
//   * documentVisibility is REAL, driven through jsdom's
//     `document.visibilityState` + `visibilitychange`, so the focus-zero
//     overlay exercises the actual predicate (mocking would require
//     disposing prior Solid roots between tests).

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

vi.mock("../lib/readCursor", () => ({
  setReadCursor: vi.fn().mockResolvedValue(undefined),
  applyMeEnvelope: vi.fn(),
  applyJoinReply: vi.fn(),
  applyReadCursorSet: vi.fn(),
  getReadCursor: vi.fn(() => null),
  readCursors: vi.fn(() => ({})),
  decodeCursorKey: vi.fn(() => null),
  clearReadCursors: vi.fn(),
}));

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
  // Real documentVisibility reads document.hasFocus() AND
  // document.visibilityState. Default each test to visible+focused; blur is
  // opt-in via setVisibilityForTest(false).
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "visible",
  });
});

describe("mentions store — setServerMention", () => {
  it("sets the mention count for a key", async () => {
    localStorage.setItem("grappa-token", "tok");
    const mentions = await import("../lib/mentions");
    const key = channelKey("freenode", "#grappa");
    mentions.setServerMention(key, 3);
    expect(mentions.mentionCounts()[key]).toBe(3);
  });

  it("a count of 0 drops the key (absence is zero)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const mentions = await import("../lib/mentions");
    const key = channelKey("freenode", "#grappa");
    mentions.setServerMention(key, 4);
    expect(mentions.mentionCounts()[key]).toBe(4);
    mentions.setServerMention(key, 0);
    expect(key in mentions.mentionCounts()).toBe(false);
  });

  it("is idempotent on an equal-value update (same map reference, no re-fire)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const mentions = await import("../lib/mentions");
    const key = channelKey("freenode", "#grappa");
    mentions.setServerMention(key, 2);
    const first = mentions.mentionCounts();
    mentions.setServerMention(key, 2);
    // Same object identity — the short-circuit returned `prev` unchanged.
    expect(mentions.mentionCounts()).toBe(first);
  });

  it("independent keys accumulate independently", async () => {
    localStorage.setItem("grappa-token", "tok");
    const mentions = await import("../lib/mentions");
    const a = channelKey("freenode", "#grappa");
    const b = channelKey("freenode", "#cicchetto");
    mentions.setServerMention(a, 1);
    mentions.setServerMention(b, 5);
    expect(mentions.mentionCounts()[a]).toBe(1);
    expect(mentions.mentionCounts()[b]).toBe(5);
  });
});

describe("mentions store — focus-zero overlay", () => {
  it("the selected + visible window renders 0 (operator is reading it)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const mentions = await import("../lib/mentions");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#grappa");
    mentions.setServerMention(key, 3);
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    // Selected + visible → overlaid to absence.
    expect(key in mentions.mentionCounts()).toBe(false);
  });

  it("a NON-selected window keeps its count while another is selected", async () => {
    localStorage.setItem("grappa-token", "tok");
    const mentions = await import("../lib/mentions");
    const selection = await import("../lib/selection");
    const selected = channelKey("freenode", "#grappa");
    const other = channelKey("freenode", "#cicchetto");
    mentions.setServerMention(selected, 3);
    mentions.setServerMention(other, 2);
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    const counts = mentions.mentionCounts();
    expect(selected in counts).toBe(false);
    // The background window's count is untouched by the focus overlay.
    expect(counts[other]).toBe(2);
  });

  it("selected but browser-HIDDEN keeps the count (a returning operator sees the activity)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const mentions = await import("../lib/mentions");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#grappa");
    mentions.setServerMention(key, 3);
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    // Tab backgrounded — the operator is not actually reading, so the
    // focus-zero overlay must NOT suppress the count.
    setVisibilityForTest(false);
    expect(mentions.mentionCounts()[key]).toBe(3);
  });

  it("the raw count is unchanged by the overlay — the read cursor is not advanced", async () => {
    // The overlay is a pure projection: re-selecting away from the window
    // restores the count (the raw server value was never mutated).
    localStorage.setItem("grappa-token", "tok");
    const mentions = await import("../lib/mentions");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#grappa");
    mentions.setServerMention(key, 3);
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    expect(key in mentions.mentionCounts()).toBe(false);
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#cicchetto",
      kind: "channel",
    });
    expect(mentions.mentionCounts()[key]).toBe(3);
  });
});

describe("mentions store — /me unread_counts hydrate", () => {
  it("bulk-hydrates the mention counts from the /me envelope on login", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.me).mockResolvedValue({
      kind: "user",
      id: "u-test",
      name: "alice",
      is_admin: false,
      inserted_at: "2026-01-01T00:00:00Z",
      read_cursors: {},
      unread_counts: {
        freenode: {
          // 2 mentions on #grappa; #cicchetto has unread messages but no
          // mention → absent from the mention map.
          "#grappa": { messages: 5, events: 1, mentions: 2, severity: "mention" },
          "#cicchetto": { messages: 3, events: 0, mentions: 0, severity: "message" },
        },
      },
    });
    const mentions = await import("../lib/mentions");
    // Importing mentions pulls in networks → the `user` resource fetches
    // /me; the on(user) effect hydrates once it resolves.
    await import("../lib/networks");
    const grappa = channelKey("freenode", "#grappa");
    const cicchetto = channelKey("freenode", "#cicchetto");
    await vi.waitFor(() => {
      expect(mentions.mentionCounts()[grappa]).toBe(2);
    });
    // A zero-mention window with unread messages must not leak into the
    // mention map.
    expect(cicchetto in mentions.mentionCounts()).toBe(false);
  });
});

describe("mentions store — identity rotation", () => {
  it("clears all counts on token rotation A→B", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const mentions = await import("../lib/mentions");
    const auth = await import("../lib/auth");
    const key = channelKey("freenode", "#grappa");
    mentions.setServerMention(key, 3);
    expect(mentions.mentionCounts()[key]).toBe(3);
    auth.setToken("tokB");
    await vi.waitFor(() => {
      expect(key in mentions.mentionCounts()).toBe(false);
    });
  });

  it("clears all counts on logout (token → null)", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const mentions = await import("../lib/mentions");
    const auth = await import("../lib/auth");
    const key = channelKey("freenode", "#grappa");
    mentions.setServerMention(key, 2);
    expect(mentions.mentionCounts()[key]).toBe(2);
    auth.setToken(null);
    await vi.waitFor(() => {
      expect(key in mentions.mentionCounts()).toBe(false);
    });
  });
});
