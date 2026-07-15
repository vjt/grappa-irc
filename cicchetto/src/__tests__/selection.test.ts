import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// Boundary: mock REST (`lib/api`). Selection effects reach into
// `scrollback.loadInitialScrollback` (the verb that backfills
// history), so listMessages is mocked too. Identity-transition
// cleanup is asserted directly via `auth.setToken(...)`.

vi.mock(import("../lib/api"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listNetworks: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([]),
    listMessages: vi.fn(),
    sendMessage: vi.fn(),
    // UX-4 bucket D — selection.ts now imports `networks` from
    // `lib/networks` to drive the parked-network → home redirect.
    // networks.ts's `createResource` chain fires `me()` on every token
    // change; without a resolved value the resource handler crashes
    // when reaching `m.read_cursors`. Return a minimal-but-valid
    // MeResponse so the resource resolves silently. Pass-through the
    // real `tagNetwork` so the boundary tagger keeps its contract
    // checks (visitor-vs-user discrimination, nick guard).
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

// BUGHUNT-2: selection.ts no longer writes cursors — moved to
// ScrollbackPane (leave / unmount / blur / scroll-settle). Mock is
// retained because surviving tests assert `setReadCursor` was NOT
// called from selection.ts paths (negative contract). Without the
// mock the underlying `fetch()` with a relative URL would error on
// jsdom's WHATWG fetch with `ERR_INVALID_URL`.
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
  it("setServerSeedCount seeds messagesUnread + eventsUnread memos for the key", async () => {
    localStorage.setItem("grappa-token", "tok");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#grappa");
    selection.setServerSeedCount(key, { messages: 3, events: 1 });
    expect(selection.messagesUnread()[key]).toBe(3);
    expect(selection.eventsUnread()[key]).toBe(1);
    expect(selection.unreadCounts()[key]).toBe(4);
  });

  it("setServerSeedCount is idempotent on equal-value updates (no re-render)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#grappa");
    selection.setServerSeedCount(key, { messages: 2, events: 0 });
    const first = selection.serverSeedCounts();
    selection.setServerSeedCount(key, { messages: 2, events: 0 });
    expect(selection.serverSeedCounts()).toBe(first);
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

  it("does NOT fetch /messages for synthetic windows (home/admin/mentions) — grappa-irc#81", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.listMessages).mockResolvedValue([]);
    const selection = await import("../lib/selection");

    // None of these map to a server-backed scrollback channel: $home is
    // the status buffer, $admin the console, and `mentions` carries an
    // empty channelName. Fetching `/messages` for any of them 404s on
    // the server, which trips the production fail2ban http-404 ban
    // cascade and locks real users out at the network layer.
    selection.setSelectedChannel({ networkSlug: "$home", channelName: "$home", kind: "home" });
    selection.setSelectedChannel({ networkSlug: "$admin", channelName: "$admin", kind: "admin" });
    selection.setSelectedChannel({ networkSlug: "freenode", channelName: "", kind: "mentions" });

    // Select a real channel last. Once ITS fetch lands the selection
    // effect has fully drained for every prior set, so any synthetic
    // fetch would already have fired. The call count pins that only the
    // backed window hit REST.
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    await vi.waitFor(() => {
      expect(api.listMessages).toHaveBeenCalledWith("tok", "freenode", "#grappa");
    });
    expect(api.listMessages).toHaveBeenCalledTimes(1);
  });

  it("token rotation clears selectedChannel + serverSeedCounts", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#grappa");
    selection.setServerSeedCount(key, { messages: 5, events: 0 });
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
    expect(selection.messagesUnread()[key]).toBeUndefined();
    expect(selection.unreadCounts()[key]).toBeUndefined();
  });

  it("logout (token → null) clears selectedChannel + serverSeedCounts", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#grappa");
    selection.setServerSeedCount(key, { messages: 5, events: 0 });
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });
    auth.setToken(null);
    await vi.waitFor(() => {
      expect(selection.selectedChannel()).toBeNull();
    });
    expect(selection.messagesUnread()[key]).toBeUndefined();
    expect(selection.unreadCounts()[key]).toBeUndefined();
  });

  // 2026-06-01 (unread-badges-from-cursor cluster, bucket B2): the
  // unread/messages/events badge counts are DERIVED memos over
  // (scrollbackByChannel, readCursors, serverSeedCounts). Pre-cluster
  // they were independent bump-on-WS-receive signals that drifted from
  // the cursor — see the moduledoc comment in selection.ts. The
  // describe block below replaces the deleted bump-store tests with
  // memo-derivation tests; the cross-cluster invariant tests (parked-
  // network redirect, close-window picker, idempotent setter) remain
  // untouched because they exercise orthogonal selection-effect arms.
  describe("memo derivation from cursor + scrollback + seed (2026-06-01)", () => {
    it("memos return zero (empty maps) when no seed and no scrollback", async () => {
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");
      expect(selection.messagesUnread()[key]).toBeUndefined();
      expect(selection.eventsUnread()[key]).toBeUndefined();
      expect(selection.unreadCounts()[key]).toBeUndefined();
    });

    it("memos prefer local scrollback over seed when scrollback is hydrated", async () => {
      // Server seed says 5 messages — but local scrollback has 2 rows
      // past the (null) cursor (cursor = 0 default). Local wins.
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const key = channelKey("freenode", "#grappa");
      selection.setServerSeedCount(key, { messages: 5, events: 0 });

      scrollback.appendToScrollback(key, {
        id: 10,
        network: "freenode",
        channel: "#grappa",
        server_time: 1,
        kind: "privmsg",
        sender: "alice",
        body: "one",
        meta: {},
      });
      scrollback.appendToScrollback(key, {
        id: 11,
        network: "freenode",
        channel: "#grappa",
        server_time: 2,
        kind: "join",
        sender: "bob",
        body: "",
        meta: {},
      });

      expect(selection.messagesUnread()[key]).toBe(1); // privmsg
      expect(selection.eventsUnread()[key]).toBe(1); // join
      expect(selection.unreadCounts()[key]).toBe(2);
    });

    it("memos fall back to seed when no scrollback rows exist for the key", async () => {
      // Cold-start path: server seeds a count for a channel the user
      // hasn't opened yet (no scrollback hydrated). Seed is the
      // displayed count.
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      const seedKey = channelKey("freenode", "#never-opened");
      selection.setServerSeedCount(seedKey, { messages: 7, events: 2 });

      expect(selection.messagesUnread()[seedKey]).toBe(7);
      expect(selection.eventsUnread()[seedKey]).toBe(2);
      expect(selection.unreadCounts()[seedKey]).toBe(9);
    });

    it("memo splits scrollback rows by content vs presence kind", async () => {
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const key = channelKey("freenode", "#mixed");

      const rows: Array<["privmsg" | "join" | "part" | "notice", number]> = [
        ["privmsg", 1],
        ["notice", 2],
        ["join", 3],
        ["part", 4],
        ["privmsg", 5],
      ];
      for (const [kind, id] of rows) {
        scrollback.appendToScrollback(key, {
          id,
          network: "freenode",
          channel: "#mixed",
          server_time: id,
          kind,
          sender: "u",
          body: "x",
          meta: {},
        });
      }

      expect(selection.messagesUnread()[key]).toBe(3); // privmsg+notice+privmsg
      expect(selection.eventsUnread()[key]).toBe(2); // join+part
      expect(selection.unreadCounts()[key]).toBe(5);
    });

    it("applySeedEnvelope bulk-hydrates the seed map from {slug: {chan: {messages, events}}}", async () => {
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      selection.applySeedEnvelope({
        freenode: {
          "#grappa": { messages: 3, events: 1 },
          "#cic": { messages: 0, events: 2 },
        },
        oftc: {
          "#bnc": { messages: 9, events: 0 },
        },
      });

      expect(selection.messagesUnread()[channelKey("freenode", "#grappa")]).toBe(3);
      expect(selection.eventsUnread()[channelKey("freenode", "#grappa")]).toBe(1);
      expect(selection.messagesUnread()[channelKey("freenode", "#cic")]).toBeUndefined();
      expect(selection.eventsUnread()[channelKey("freenode", "#cic")]).toBe(2);
      expect(selection.messagesUnread()[channelKey("oftc", "#bnc")]).toBe(9);
    });
  });

  // #239 — hidden/control messages must NOT leave the unread counter stuck.
  // Regression from #222: the render-layer presence filter hides
  // join/part/quit/nick_change on large / pref-hidden channels, but the
  // count derivation counted every stored row → hidden control rows inflated
  // the events badge the operator could never clear (they never render, so no
  // settle event advances the cursor over them). The count and the pane MUST
  // reconcile to the ONE shared presence predicate (presenceRowVisible):
  // count over VISIBLE rows only. Explicit "hide" pin stands in for a large
  // channel so we don't seed 50 members (flood/autokill risk in the e2e; the
  // size-default math lives in presenceFilter.test.ts).
  describe("presence-filter-hidden rows excluded from the badge (#239)", () => {
    it("hidden join/part do NOT count toward eventsUnread when the channel hides presence", async () => {
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const presenceFilter = await import("../lib/presenceFilter");
      const key = channelKey("freenode", "#big");
      presenceFilter.setChannelPresencePref(key, "hide");

      const rows: Array<[ScrollbackMessage["kind"], number]> = [
        ["privmsg", 1], // visible content
        ["join", 2], // hidden by the presence filter
        ["part", 3], // hidden by the presence filter
        ["mode", 4], // NOT in the narrow noise set → visible event
      ];
      for (const [kind, id] of rows) {
        scrollback.appendToScrollback(key, {
          id,
          network: "freenode",
          channel: "#big",
          server_time: id,
          kind,
          sender: "u",
          body: kind === "privmsg" ? "x" : "",
          meta: {},
        });
      }

      // Facet A: the hidden join/part are excluded; the visible privmsg
      // (message) and the visible mode (event) still count.
      expect(selection.messagesUnread()[key]).toBe(1); // privmsg
      expect(selection.eventsUnread()[key]).toBe(1); // mode only — join/part hidden
      expect(selection.unreadCounts()[key]).toBe(2);
    });

    it("counts join/part again when presence is explicitly SHOWN (filter, not a blanket drop)", async () => {
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      const scrollback = await import("../lib/scrollback");
      const presenceFilter = await import("../lib/presenceFilter");
      const key = channelKey("freenode", "#big2");
      presenceFilter.setChannelPresencePref(key, "show");

      const rows: Array<[ScrollbackMessage["kind"], number]> = [
        ["join", 1],
        ["part", 2],
        ["mode", 3],
      ];
      for (const [kind, id] of rows) {
        scrollback.appendToScrollback(key, {
          id,
          network: "freenode",
          channel: "#big2",
          server_time: id,
          kind,
          sender: "u",
          body: "",
          meta: {},
        });
      }

      // "show" pin re-exposes the presence rows — proving the exclusion is
      // the shared filter predicate, not a hardcoded drop of presence kinds.
      expect(selection.eventsUnread()[key]).toBe(3);
    });
  });

  // BUGHUNT-2: cursor writes moved to ScrollbackPane. These tests guard
  // the NEGATIVE contract — selection.ts must NOT call setReadCursor on
  // focus-leave. ScrollbackPane's own seams + B-bucket e2e sentinels cover
  // the positive (cursor IS written) contract.
  //
  // Anti-spec (the bug these guard against): cursor advancing on FOCUS
  // (or on every WS append) hides the marker before the user has had
  // a chance to see it. Cursor advancing only on LEAVE preserves the
  // "unread until you've moved on" semantic.
  describe("read-cursor set on focus-leave", () => {
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

  // BUGHUNT-2: browser-blur cursor write moved to ScrollbackPane. This
  // single structural-assertion test guards the NEGATIVE contract —
  // selection.ts's on(isDocumentVisible) effect has only a FALSE→TRUE
  // arm (focus-regain badge-clear); the TRUE→FALSE branch was
  // deleted in A6. Any future addition of a cursor-write to this
  // effect would fail this test. The positive (cursor IS written on
  // blur) contract is owned by ScrollbackPane's visibility arm +
  // B-bucket e2e.
  describe("read-cursor set on browser-blur (visibility transition)", () => {
    it("blur arm never writes cursor (selection.ts has no TRUE→FALSE cursor path)", async () => {
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
      // Drive blur — the only edge that the deleted code reacted to.
      setVisibilityForTest(false);
      await Promise.resolve();
      // And drive a focus-regain — the only edge the surviving code
      // reacts to (badge clear, not cursor write).
      setVisibilityForTest(true);
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
  // Post-2026-06-01 contract: focus-regain does NOT clear badge counts
  // (they're derived from cursor + scrollback and drop automatically
  // as the cursor advances). It DOES clear mention counts which remain
  // bump-based.
  describe("focus-regain: mentions clear, badge memos untouched", () => {
    it("mentionCounts for selected window clear when browser regains focus", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const mentions = await import("../lib/mentions");
      const key = channelKey("freenode", "#grappa");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      setVisibilityForTest(false);
      await Promise.resolve();
      mentions.bumpMention(key);
      expect(mentions.mentionCounts()[key]).toBe(1);

      setVisibilityForTest(true);
      await Promise.resolve();

      expect(mentions.mentionCounts()[key]).toBeUndefined();
    });

    it("badge memos are untouched by focus-regain — they derive from cursor + scrollback", async () => {
      // Pre-cluster, focus-regain CLEARED the bump-store badges. Post-
      // cluster, the memos derive from `(scrollbackByChannel,
      // readCursors, serverSeedCounts)` so the cursor write — owned by
      // ScrollbackPane's visibility/scroll-settle arms, not this file
      // — is what drops the count. This test pins the negative
      // contract: focus-regain on its own MUST NOT touch the badge
      // memos for a channel cic hasn't hydrated scrollback for. Use a
      // key OTHER than the selected window so the selection-arm's
      // loadInitialScrollback doesn't race and hydrate `[]` for the
      // tested key (which would override the seed). Production: when
      // a channel has unread state but isn't focused, the seed is
      // what drives the sidebar badge.
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const seededKey = channelKey("freenode", "#has-unread");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#focused-other",
        kind: "channel",
      });
      selection.setServerSeedCount(seededKey, { messages: 3, events: 0 });
      setVisibilityForTest(false);
      await Promise.resolve();
      setVisibilityForTest(true);
      await Promise.resolve();

      expect(selection.messagesUnread()[seededKey]).toBe(3);
      expect(selection.unreadCounts()[seededKey]).toBe(3);
    });

    it("focus-regain does NOT clear OTHER (non-selected) windows' mentionCounts", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const mentions = await import("../lib/mentions");
      const selKey = channelKey("freenode", "#grappa");
      const otherKey = channelKey("freenode", "#cicchetto");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      setVisibilityForTest(false);
      await Promise.resolve();
      mentions.bumpMention(selKey);
      mentions.bumpMention(otherKey);

      setVisibilityForTest(true);
      await Promise.resolve();

      expect(mentions.mentionCounts()[selKey]).toBeUndefined();
      expect(mentions.mentionCounts()[otherKey]).toBe(1);
    });

    it("focus-regain with no selected window is a no-op for mentions", async () => {
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      const mentions = await import("../lib/mentions");
      const key = channelKey("freenode", "#grappa");
      // No setSelectedChannel — selection is null. Use selection
      // import to ensure the module evaluates and installs its arms.
      void selection;
      mentions.bumpMention(key);
      setVisibilityForTest(false);
      await Promise.resolve();
      setVisibilityForTest(true);
      await Promise.resolve();

      expect(mentions.mentionCounts()[key]).toBe(1);
    });

    it("initial visibility=true does NOT spuriously clear bumped mentions", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const mentions = await import("../lib/mentions");
      const key = channelKey("freenode", "#grappa");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      mentions.bumpMention(key);
      // No setVisibilityForTest — visibility stays true (initial state).
      await Promise.resolve();

      // Initial visibility-effect run with prev===undefined must NOT
      // re-fire mention-clear; the selection-arm DID clear at select
      // time so the assertion is "after selection cleared it, bumping
      // again leaves the count visible." If the visibility effect
      // re-fired on initial mount, the mention added post-selection
      // would also clear.
      expect(mentions.mentionCounts()[key]).toBe(1);
    });
  });

  // UX-4 bucket D — when the user-network the operator is currently
  // looking at transitions INTO :parked (or :failed), selection auto-
  // redirects to home. Subscription is in selection.ts and fires
  // uniformly for /disconnect typed, sidebar × button, circuit-breaker
  // park, and admin verb. Test by simulating userTopic.ts's
  // `connection_state_changed` → refetchNetworks() arm with mocked
  // GET /networks responses that flip the row's connection_state.
  describe("parked-network → home redirect (UX-4 bucket D)", () => {
    type Conn = "connected" | "parked" | "failed";
    const userNet = (overrides: { connection_state: Conn }) => ({
      kind: "user" as const,
      id: 1,
      slug: "freenode",
      nick: "alice",
      connection_state: overrides.connection_state,
      connection_state_reason: null,
      connection_state_changed_at: null,
      inserted_at: "",
      updated_at: "",
    });

    it("redirects selection to home when current network flips connected → parked", async () => {
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks)
        .mockResolvedValueOnce([userNet({ connection_state: "connected" })])
        .mockResolvedValueOnce([userNet({ connection_state: "parked" })])
        .mockResolvedValue([userNet({ connection_state: "parked" })]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokRedir");
      await vi.waitFor(() => {
        const nets = networks.networks();
        expect(nets?.length).toBe(1);
        const n = nets?.[0];
        expect(n?.kind).toBe("user");
        if (n?.kind === "user") expect(n.connection_state).toBe("connected");
      });
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#italia",
        kind: "channel",
      });
      networks.refetchNetworks();
      await vi.waitFor(() => {
        const after = sel.selectedChannel();
        expect(after?.networkSlug).toBe("$home");
      });
    });

    it("does NOT redirect when a different network parks", async () => {
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const otherNet = (state: Conn) => ({
        kind: "user" as const,
        id: 2,
        slug: "azzurra",
        nick: "alice",
        connection_state: state,
        connection_state_reason: null,
        connection_state_changed_at: null,
        inserted_at: "",
        updated_at: "",
      });
      vi.mocked(api.listNetworks)
        .mockResolvedValueOnce([userNet({ connection_state: "connected" }), otherNet("connected")])
        .mockResolvedValueOnce([userNet({ connection_state: "connected" }), otherNet("parked")])
        .mockResolvedValue([userNet({ connection_state: "connected" }), otherNet("parked")]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokRedir2");
      await vi.waitFor(() => {
        const nets = networks.networks();
        expect(nets?.length).toBe(2);
      });
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#italia",
        kind: "channel",
      });
      networks.refetchNetworks();
      await vi.waitFor(() => {
        const nets = networks.networks();
        const azz = nets?.find((n) => n.slug === "azzurra");
        expect(azz?.kind).toBe("user");
        if (azz?.kind === "user") expect(azz.connection_state).toBe("parked");
      });
      // Selection stays put — other network parked, not the selected one.
      const after = sel.selectedChannel();
      expect(after?.networkSlug).toBe("freenode");
      expect(after?.channelName).toBe("#italia");
    });

    it("does NOT redirect on the initial load even if the network starts parked", async () => {
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet({ connection_state: "parked" })]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokRedir3");
      await vi.waitFor(() => {
        expect(networks.networks()?.length).toBe(1);
      });
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#italia",
        kind: "channel",
      });
      // Initial load means no `prev` state — the redirect only triggers
      // on a transition. Operator may have legitimately navigated to a
      // parked-network window to view history.
      await new Promise((r) => setTimeout(r, 20));
      const after = sel.selectedChannel();
      expect(after?.networkSlug).toBe("freenode");
    });

    it("does NOT redirect when operator navigates BACK to an already-parked window", async () => {
      // Post-park, the operator may click a row under a parked network
      // to view scrollback history. The redirect must NOT bounce them
      // back to home — that would lock the operator out of historical
      // context. lastConnectionState already reflects parked → no
      // transition → no redirect.
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks)
        .mockResolvedValueOnce([userNet({ connection_state: "connected" })])
        .mockResolvedValueOnce([userNet({ connection_state: "parked" })])
        .mockResolvedValue([userNet({ connection_state: "parked" })]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokRedir4");
      await vi.waitFor(() => {
        const n = networks.networks()?.[0];
        expect(n?.kind).toBe("user");
        if (n?.kind === "user") expect(n.connection_state).toBe("connected");
      });
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#italia",
        kind: "channel",
      });
      // Trigger the parked transition — selection bounces to home.
      networks.refetchNetworks();
      await vi.waitFor(() => {
        expect(sel.selectedChannel()?.networkSlug).toBe("$home");
      });
      // Operator re-navigates to the parked-network window — must stay
      // put (no infinite bounce).
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#italia",
        kind: "channel",
      });
      await new Promise((r) => setTimeout(r, 20));
      const after = sel.selectedChannel();
      expect(after?.networkSlug).toBe("freenode");
      expect(after?.channelName).toBe("#italia");
    });
  });

  // UX-4 bucket E — close-window auto-focus picker. When the
  // currently-selected window vanishes from its live store
  // (channelsBySlug drops the channel after PART/kick; queryWindowsByNetwork
  // drops the query after close_query_window broadcast), focus shifts
  // to MRU > server > home. Tests drive the close transition by
  // re-mocking listChannels and calling refetchChannels (channel path)
  // OR by mutating queryWindowsByNetwork directly (query path).
  describe("close-window auto-focus picker (UX-4 bucket E)", () => {
    type Conn = "connected" | "parked" | "failed";
    const userNet = (slug: string, id: number, conn: Conn) => ({
      kind: "user" as const,
      id,
      slug,
      nick: "alice",
      connection_state: conn,
      connection_state_reason: null,
      connection_state_changed_at: null,
      inserted_at: "",
      updated_at: "",
    });

    it("picks the MRU candidate when an MRU entry is live", async () => {
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet("freenode", 1, "connected")]);
      vi.mocked(api.listChannels)
        .mockResolvedValueOnce([
          { name: "#grappa", joined: true, source: "autojoin" },
          { name: "#cicchetto", joined: true, source: "autojoin" },
        ])
        .mockResolvedValue([{ name: "#cicchetto", joined: true, source: "autojoin" }]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokE1");
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length).toBe(2);
      });

      // Focus #cicchetto then #grappa — MRU is [#grappa, #cicchetto].
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#cicchetto",
        kind: "channel",
      });
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });

      // Close #grappa — refetch reflects only #cicchetto.
      networks.refetchChannels();
      await vi.waitFor(() => {
        expect(sel.selectedChannel()?.channelName).toBe("#cicchetto");
      });
      expect(sel.selectedChannel()?.kind).toBe("channel");
      expect(sel.selectedChannel()?.networkSlug).toBe("freenode");
    });

    it("falls back to server window when MRU is empty and network is connected", async () => {
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet("freenode", 1, "connected")]);
      vi.mocked(api.listChannels)
        .mockResolvedValueOnce([{ name: "#grappa", joined: true, source: "autojoin" }])
        .mockResolvedValue([]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokE2");
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length).toBe(1);
      });

      // Only focus #grappa — MRU is [#grappa]. After eviction it's
      // empty.
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      networks.refetchChannels();
      await vi.waitFor(() => {
        expect(sel.selectedChannel()?.kind).toBe("server");
      });
      expect(sel.selectedChannel()?.channelName).toBe("$server");
      expect(sel.selectedChannel()?.networkSlug).toBe("freenode");
    });

    it("falls back to home when MRU is empty and network is parked", async () => {
      // /disconnect cascade: server emits PARTs for all channels →
      // channelsBySlug refetches empty → close-picker fires → server
      // fallback gated on connection_state === "connected" → fails
      // (parked) → home. Bucket D's network-state effect would also
      // fire on the parked transition; both converge at home.
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet("freenode", 1, "parked")]);
      vi.mocked(api.listChannels)
        .mockResolvedValueOnce([{ name: "#grappa", joined: true, source: "autojoin" }])
        .mockResolvedValue([]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokE3");
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length).toBe(1);
      });
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      networks.refetchChannels();
      await vi.waitFor(() => {
        expect(sel.selectedChannel()?.networkSlug).toBe("$home");
      });
      expect(sel.selectedChannel()?.kind).toBe("home");
    });

    it("skips MRU entries that are no longer live (stale entry)", async () => {
      // Operator focused #a, #b, #c. Then #c PARTs (left from another
      // tab / kicked). Then #b PARTs. MRU is still [#c, #b, #a] but
      // #c and #b are dead. Picker must skip both and land on #a.
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet("freenode", 1, "connected")]);
      vi.mocked(api.listChannels)
        .mockResolvedValueOnce([
          { name: "#a", joined: true, source: "autojoin" },
          { name: "#b", joined: true, source: "autojoin" },
          { name: "#c", joined: true, source: "autojoin" },
        ])
        // After #c parts.
        .mockResolvedValueOnce([
          { name: "#a", joined: true, source: "autojoin" },
          { name: "#b", joined: true, source: "autojoin" },
        ])
        // After #b parts.
        .mockResolvedValue([{ name: "#a", joined: true, source: "autojoin" }]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokE4");
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length).toBe(3);
      });
      // Build MRU: #a, #b, #c → MRU is [#c, #b, #a].
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#a",
        kind: "channel",
      });
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#b",
        kind: "channel",
      });
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#c",
        kind: "channel",
      });

      // #c PARTs — picker should pick #b (next MRU).
      networks.refetchChannels();
      await vi.waitFor(() => {
        expect(sel.selectedChannel()?.channelName).toBe("#b");
      });

      // #b also PARTs — MRU now has stale #c at head + #a; picker
      // skips #c and lands on #a.
      networks.refetchChannels();
      await vi.waitFor(() => {
        expect(sel.selectedChannel()?.channelName).toBe("#a");
      });
    });

    it("does NOT fire when a non-selected window closes", async () => {
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet("freenode", 1, "connected")]);
      vi.mocked(api.listChannels)
        .mockResolvedValueOnce([
          { name: "#grappa", joined: true, source: "autojoin" },
          { name: "#cicchetto", joined: true, source: "autojoin" },
        ])
        .mockResolvedValue([{ name: "#grappa", joined: true, source: "autojoin" }]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokE5");
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length).toBe(2);
      });
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      // Close #cicchetto (not selected). Selection should stay on #grappa.
      networks.refetchChannels();
      await new Promise((r) => setTimeout(r, 20));
      expect(sel.selectedChannel()?.channelName).toBe("#grappa");
    });

    it("does NOT fire when selection is home/server (those don't vanish via close)", async () => {
      // Home and server are NEVER closed via the channel/query close
      // path — server-window close goes through bucket D's
      // disconnectNetwork (which directly bumps to home). The
      // close-watcher gates on kind ∈ {channel, query}.
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet("freenode", 1, "connected")]);
      vi.mocked(api.listChannels)
        .mockResolvedValueOnce([{ name: "#grappa", joined: true, source: "autojoin" }])
        .mockResolvedValue([]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokE6");
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length).toBe(1);
      });
      sel.setSelectedChannel({
        networkSlug: "$home",
        channelName: "$home",
        kind: "home",
      });
      // Channel vanishes — but selection is home, not the vanished
      // channel. Selection must stay at home.
      networks.refetchChannels();
      await new Promise((r) => setTimeout(r, 20));
      expect(sel.selectedChannel()?.kind).toBe("home");
    });

    it("picks MRU when a query window vanishes", async () => {
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet("freenode", 1, "connected")]);
      vi.mocked(api.listChannels).mockResolvedValue([
        { name: "#grappa", joined: true, source: "autojoin" },
      ]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      const qw = await import("../lib/queryWindows");
      auth.setToken("tokE7");
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length).toBe(1);
      });

      // Seed open query windows.
      qw.setQueryWindowsByNetwork({
        1: [
          { targetNick: "bob", openedAt: "2026-01-01T00:00:00Z" },
          { targetNick: "carol", openedAt: "2026-01-01T00:00:01Z" },
        ],
      });

      // Focus #grappa then bob then carol — MRU is [carol, bob, #grappa].
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "bob",
        kind: "query",
      });
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "carol",
        kind: "query",
      });

      // Close carol (drop from queryWindowsByNetwork).
      qw.setQueryWindowsByNetwork({
        1: [{ targetNick: "bob", openedAt: "2026-01-01T00:00:00Z" }],
      });
      await vi.waitFor(() => {
        expect(sel.selectedChannel()?.channelName).toBe("bob");
      });
      expect(sel.selectedChannel()?.kind).toBe("query");
    });

    it("UX-7-E: stays on kicked channel when windowState=kicked + cbs drops", async () => {
      // Peer KICK semantics on the server (apply_effects {:kicked, ...}):
      // drops channel from state.members → channels_changed broadcast
      // → cbs[slug] drops the channel. AND sets window_states[key] =
      // :kicked. Sidebar.pseudoChannelsForNetwork keeps a greyed row
      // for it (the operator should see the kick reason + greyed
      // compose). Pre-UX-7-E, stillLive checked ONLY cbs, so the
      // close-watcher MRU picker fired and yanked focus away to the
      // seeded autojoin channel — defeating the kicked-channel UX.
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet("freenode", 1, "connected")]);
      vi.mocked(api.listChannels)
        .mockResolvedValueOnce([
          { name: "#bofh", joined: true, source: "autojoin" },
          { name: "#new", joined: true, source: "joined" },
        ])
        .mockResolvedValue([{ name: "#bofh", joined: true, source: "autojoin" }]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      const windowState = await import("../lib/windowState");
      const { channelKey } = await import("../lib/channelKey");
      auth.setToken("tokE-UX-7-E");
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length).toBe(2);
      });

      // Focus the soon-to-be-kicked channel.
      sel.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#new",
        kind: "channel",
      });

      // Peer KICK → server emits channels_changed (refetch drops #new)
      // AND broadcasts the windowState transition (cic mirrors via
      // setKicked). Order matches lib/grappa/session/server.ex
      // apply_effects/2 ordering: state change before broadcast.
      windowState.setKicked(channelKey("freenode", "#new"), "operator", "spam");
      networks.refetchChannels();

      // Selection must NOT redirect. Give the close-watcher effect a
      // tick to run — if it would fire, it'd flip selection to #bofh
      // (MRU) or $server within a microtask.
      await new Promise((r) => setTimeout(r, 20));
      expect(sel.selectedChannel()?.channelName).toBe("#new");
      expect(sel.selectedChannel()?.kind).toBe("channel");
      expect(sel.selectedChannel()?.networkSlug).toBe("freenode");
    });
  });

  // #125 — the $list directory is a transient overlay with a close
  // button. Closing it restores the window that was active when it
  // opened (captured as a back target on the non-list → list
  // transition); when that window is gone, it falls through the same
  // MRU → server → home chain as the close-window picker.
  describe("closeToPreviousWindow — $list overlay back (#125)", () => {
    type Conn = "connected" | "parked" | "failed";
    const userNet = (slug: string, id: number, conn: Conn) => ({
      kind: "user" as const,
      id,
      slug,
      nick: "alice",
      connection_state: conn,
      connection_state_reason: null,
      connection_state_changed_at: null,
      inserted_at: "",
      updated_at: "",
    });

    it("restores the window active when $list opened (back target live)", async () => {
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet("freenode", 1, "connected")]);
      vi.mocked(api.listChannels).mockResolvedValue([
        { name: "#grappa", joined: true, source: "autojoin" },
      ]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokClose1");
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length).toBe(1);
      });

      sel.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa", kind: "channel" });
      // Open the $list overlay — captures #grappa as the back target.
      sel.setSelectedChannel({ networkSlug: "freenode", channelName: "$list", kind: "list" });
      expect(sel.selectedChannel()?.kind).toBe("list");

      sel.closeToPreviousWindow("freenode");
      expect(sel.selectedChannel()).toEqual({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
    });

    it("falls back to the server window when the back target is gone (net connected)", async () => {
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet("freenode", 1, "connected")]);
      vi.mocked(api.listChannels)
        .mockResolvedValueOnce([{ name: "#grappa", joined: true, source: "autojoin" }])
        .mockResolvedValue([]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokClose2");
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length).toBe(1);
      });

      sel.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa", kind: "channel" });
      sel.setSelectedChannel({ networkSlug: "freenode", channelName: "$list", kind: "list" });

      // #grappa parts while browsing — back target is now dead.
      networks.refetchChannels();
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length ?? 0).toBe(0);
      });

      sel.closeToPreviousWindow("freenode");
      expect(sel.selectedChannel()?.kind).toBe("server");
      expect(sel.selectedChannel()?.channelName).toBe("$server");
      expect(sel.selectedChannel()?.networkSlug).toBe("freenode");
    });

    it("falls back to home when back target is gone and net is parked", async () => {
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet("freenode", 1, "parked")]);
      vi.mocked(api.listChannels)
        .mockResolvedValueOnce([{ name: "#grappa", joined: true, source: "autojoin" }])
        .mockResolvedValue([]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokClose3");
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length).toBe(1);
      });

      sel.setSelectedChannel({ networkSlug: "freenode", channelName: "#grappa", kind: "channel" });
      sel.setSelectedChannel({ networkSlug: "freenode", channelName: "$list", kind: "list" });
      networks.refetchChannels();
      await vi.waitFor(() => {
        expect(networks.channelsBySlug()?.freenode?.length ?? 0).toBe(0);
      });

      sel.closeToPreviousWindow("freenode");
      expect(sel.selectedChannel()?.kind).toBe("home");
      expect(sel.selectedChannel()?.networkSlug).toBe("$home");
    });

    it("with no prior window, falls back to the server window", async () => {
      vi.resetModules();
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      vi.mocked(api.listNetworks).mockResolvedValue([userNet("freenode", 1, "connected")]);
      vi.mocked(api.listChannels).mockResolvedValue([]);
      const auth = await import("../lib/auth");
      const sel = await import("../lib/selection");
      const networks = await import("../lib/networks");
      auth.setToken("tokClose4");
      await vi.waitFor(() => {
        expect(networks.networks()?.length).toBe(1);
      });

      // $list opened cold (no prior window) — back target stays null.
      sel.setSelectedChannel({ networkSlug: "freenode", channelName: "$list", kind: "list" });
      sel.closeToPreviousWindow("freenode");
      expect(sel.selectedChannel()?.kind).toBe("server");
      expect(sel.selectedChannel()?.networkSlug).toBe("freenode");
    });
  });

  // UX-5 bucket BU — unread state machine: single "is operator reading?"
  // gate drives all three sinks (messagesUnread / eventsUnread /
  // mentionCounts). Before BU, mentionCounts cleared on selection only —
  // browser-blur arrivals on the selected window were left as a stale red
  // badge after focus regain. setSelectedChannel was also not idempotent
  // on identical (slug, name, kind) — re-clicking the active channel
  // re-fired the selection effect, which cleared mentions (legitimately,
  // but also crossed the marker-injection invariant by triggering
  // sessionTopId recapture in ScrollbackPane). The fix consolidates the
  // mention clear into `clearBadgesForWindow` and adds an idempotency
  // guard at the setter boundary so the active-channel re-click is a
  // pure no-op.
  describe("UX-5 bucket BU — mention badge symmetry + idempotent setter", () => {
    it("setSelectedChannel is idempotent on identical (slug, name, kind)", async () => {
      // BU bug-2 root cause: re-clicking the active sidebar row passed a
      // new object literal, which re-fired the on(selectedChannel) effect
      // because Solid's === default compared by identity. The setter now
      // short-circuits before the signal write so no downstream effect
      // observes a non-transition.
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const readCursor = await import("../lib/readCursor");
      const selection = await import("../lib/selection");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      await Promise.resolve();
      vi.mocked(readCursor.setReadCursor).mockClear();
      // Re-click the SAME channel.
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      // No cursor write — the effect didn't re-fire (no leave occurred).
      await Promise.resolve();
      expect(readCursor.setReadCursor).not.toHaveBeenCalled();
    });

    it("setSelectedChannel(null) on already-null is a no-op (no effect re-fire)", async () => {
      // Mirror of the active-channel re-click guard for the null case.
      // Module-load default is null; calling setSelectedChannel(null) here
      // must not perturb the signal.
      localStorage.setItem("grappa-token", "tok");
      const readCursor = await import("../lib/readCursor");
      const selection = await import("../lib/selection");
      expect(selection.selectedChannel()).toBeNull();
      selection.setSelectedChannel(null);
      await Promise.resolve();
      expect(readCursor.setReadCursor).not.toHaveBeenCalled();
    });

    it("selecting a channel clears its accumulated mentionCounts", async () => {
      // BU bug-1 prerequisite: selection clear must include mentions
      // (was the case in pre-BU mentions.ts; verify still works after
      // moving the clear into selection.ts's clearBadgesForWindow).
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const mentions = await import("../lib/mentions");
      const key = channelKey("freenode", "#grappa");
      mentions.bumpMention(key);
      mentions.bumpMention(key);
      expect(mentions.mentionCounts()[key]).toBe(2);
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      expect(mentions.mentionCounts()[key]).toBeUndefined();
    });

    it("browser-focus-regain clears mentionCounts for the selected window (BU bug-1 fix)", async () => {
      // BU bug-1 root: visibility-regain cleared unread/messages/events
      // but NOT mentions. After fix: the same arm clears all four.
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const mentions = await import("../lib/mentions");
      const key = channelKey("freenode", "#grappa");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      setVisibilityForTest(false);
      await Promise.resolve();
      // Simulate the subscribe.ts blurred-arrival path: mention bumped
      // because effective-focus was false (selected but tab hidden).
      mentions.bumpMention(key);
      expect(mentions.mentionCounts()[key]).toBe(1);

      setVisibilityForTest(true);
      await Promise.resolve();

      // Mention badge clears alongside the other three sinks — single
      // unified "is operator reading?" gate.
      expect(mentions.mentionCounts()[key]).toBeUndefined();
    });

    it("focus-regain does NOT clear mentionCounts for OTHER windows", async () => {
      // Symmetric anti-spec guard: focus-regain only clears the SELECTED
      // window's badges (all four sinks).
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const mentions = await import("../lib/mentions");
      const selKey = channelKey("freenode", "#grappa");
      const otherKey = channelKey("freenode", "#cicchetto");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      setVisibilityForTest(false);
      await Promise.resolve();
      mentions.bumpMention(selKey);
      mentions.bumpMention(otherKey);

      setVisibilityForTest(true);
      await Promise.resolve();

      expect(mentions.mentionCounts()[selKey]).toBeUndefined();
      expect(mentions.mentionCounts()[otherKey]).toBe(1);
    });

    it("focus-regain with no selected window does NOT clear any mentionCounts", async () => {
      localStorage.setItem("grappa-token", "tok");
      // Importing selection registers its on(isDocumentVisible) effect
      // — even though we never call setSelectedChannel here.
      await import("../lib/selection");
      const mentions = await import("../lib/mentions");
      const key = channelKey("freenode", "#grappa");
      // No setSelectedChannel — selection is null.
      mentions.bumpMention(key);
      setVisibilityForTest(false);
      await Promise.resolve();
      setVisibilityForTest(true);
      await Promise.resolve();
      expect(mentions.mentionCounts()[key]).toBe(1);
    });
  });

  // UX-6 bucket K — PM (query) unread-marker symmetry. Bug as filed by
  // vjt 2026-05-20: channels clear their unread/mention badge on focus,
  // PMs DON'T. Channel-side path was settled in UX-5 bucket BU; this
  // bucket asserts the symmetric behaviour for `kind: "query"` so any
  // future kind-discriminator regression that selectively skips PMs
  // fails loudly here instead of needing an e2e.
  //
  // Key invariants under test:
  //   * `setSelectedChannel({kind: "query"})` clears messagesUnread +
  //     eventsUnread + unreadCounts + mentionCounts for the PM key.
  //   * Browser-focus-regain on a selected query window clears the same
  //     four sinks (symmetric with the channel case).
  //   * Focus-regain leaves OTHER PM windows' badges alone.
  describe("UX-6 bucket K — PM (query) unread + mention badge symmetry", () => {
    it("selecting a query window clears its accumulated mentionCounts", async () => {
      // Symmetric counterpart of UX-5 BU's "selecting a channel clears
      // its accumulated mentionCounts" — same shape, kind: "query".
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const mentions = await import("../lib/mentions");
      const key = channelKey("freenode", "vjt");
      mentions.bumpMention(key);
      mentions.bumpMention(key);
      expect(mentions.mentionCounts()[key]).toBe(2);
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "vjt",
        kind: "query",
      });
      expect(mentions.mentionCounts()[key]).toBeUndefined();
    });

    it("selecting a query window does NOT spuriously clear the seed/memo badge counts of OTHER windows", async () => {
      // Post-cluster contract: selection.ts no longer wipes badge counts
      // (they derive from cursor + scrollback). Selecting a window MUST
      // NOT touch the memos of OTHER windows whose scrollback hasn't
      // been hydrated yet. Use a different key from the selected one
      // so loadInitialScrollback doesn't race and override the seed
      // with the mocked-empty list.
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const otherKey = channelKey("freenode", "bob");
      selection.setServerSeedCount(otherKey, { messages: 2, events: 1 });
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "vjt",
        kind: "query",
      });
      expect(selection.messagesUnread()[otherKey]).toBe(2);
      expect(selection.eventsUnread()[otherKey]).toBe(1);
      expect(selection.unreadCounts()[otherKey]).toBe(3);
    });

    it("browser-focus-regain clears mentionCounts for the selected query window", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const mentions = await import("../lib/mentions");
      const key = channelKey("freenode", "vjt");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "vjt",
        kind: "query",
      });
      setVisibilityForTest(false);
      await Promise.resolve();
      mentions.bumpMention(key);
      expect(mentions.mentionCounts()[key]).toBe(1);

      setVisibilityForTest(true);
      await Promise.resolve();

      expect(mentions.mentionCounts()[key]).toBeUndefined();
    });

    it("focus-regain on selected query window does NOT clear OTHER PM windows' mentions", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const mentions = await import("../lib/mentions");
      const selKey = channelKey("freenode", "vjt");
      const otherKey = channelKey("freenode", "bob");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "vjt",
        kind: "query",
      });
      setVisibilityForTest(false);
      await Promise.resolve();
      mentions.bumpMention(selKey);
      mentions.bumpMention(otherKey);

      setVisibilityForTest(true);
      await Promise.resolve();

      expect(mentions.mentionCounts()[selKey]).toBeUndefined();
      expect(mentions.mentionCounts()[otherKey]).toBe(1);
    });
  });

  // 2026-06-02 — decouple the sidebar badge from the read cursor. The
  // badge means "have I opened this window?" and must clear on SELECT,
  // independent of the cursor (which the in-pane marker still rides on,
  // so the marker survives the select). selection.ts suppresses the
  // focused-AND-visible window's message/event counts in perChannelUnread;
  // the cursor is never written here (ScrollbackPane owns cursor writes).
  // Spec: docs/superpowers/specs/2026-06-02-decouple-unread-badge-design.md
  describe("focused-window badge suppression (2026-06-02)", () => {
    const seedRows = async (key: ReturnType<typeof channelKey>, kind: "privmsg" | "join") => {
      const scrollback = await import("../lib/scrollback");
      const [, name] = key.split(" ");
      for (const id of [1, 2, 3]) {
        scrollback.appendToScrollback(key, {
          id,
          network: "freenode",
          channel: name ?? "#grappa",
          server_time: id,
          kind,
          sender: "bob",
          body: kind === "privmsg" ? "x" : "",
          meta: {},
        });
      }
    };

    it("selecting a visible window zeros its own message badge", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");
      await seedRows(key, "privmsg");
      expect(selection.messagesUnread()[key]).toBe(3);

      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });

      expect(selection.messagesUnread()[key]).toBeUndefined();
      expect(selection.unreadCounts()[key]).toBeUndefined();
    });

    it("does NOT suppress when the document is hidden (selected ≠ looking)", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");
      await seedRows(key, "privmsg");
      setVisibilityForTest(false);
      await Promise.resolve();
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });

      expect(selection.messagesUnread()[key]).toBe(3);

      setVisibilityForTest(true);
      await Promise.resolve();
      expect(selection.messagesUnread()[key]).toBeUndefined();
    });

    it("suppresses the event badge too (presence kinds)", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");
      await seedRows(key, "join");
      expect(selection.eventsUnread()[key]).toBe(3);

      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });

      expect(selection.eventsUnread()[key]).toBeUndefined();
    });

    it("re-exposes the count when the operator leaves the window", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "#grappa");
      await seedRows(key, "privmsg");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      expect(selection.messagesUnread()[key]).toBeUndefined();

      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#other",
        kind: "channel",
      });

      expect(selection.messagesUnread()[key]).toBe(3);
    });

    it("does NOT suppress OTHER (non-selected) windows", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const otherKey = channelKey("freenode", "#cicchetto");
      await seedRows(otherKey, "privmsg");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });

      expect(selection.messagesUnread()[otherKey]).toBe(3);
    });
  });

  // #243 — re-tap-to-jump predicate. `isActiveSelection(next)` is true iff
  // `next` is the tuple already selected — the exact negation of the
  // idempotent setter's short-circuit (both route through the same
  // `sameSelection` compare, so they can never diverge). The Sidebar /
  // BottomBar tap handlers use it to tell a re-tap (jump scrollback to
  // bottom) from a switch (existing behaviour). The e2e proves the scroll;
  // this pins the equality semantics.
  describe("isActiveSelection — re-tap predicate (#243)", () => {
    it("returns true when the tuple matches the current selection exactly", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      expect(
        selection.isActiveSelection({
          networkSlug: "freenode",
          channelName: "#grappa",
          kind: "channel",
        }),
      ).toBe(true);
    });

    it("returns false when the channel name differs (a switch, not a re-tap)", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      expect(
        selection.isActiveSelection({
          networkSlug: "freenode",
          channelName: "#cicchetto",
          kind: "channel",
        }),
      ).toBe(false);
    });

    it("returns false when the kind differs even if slug + name match", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "#grappa",
        kind: "channel",
      });
      expect(
        selection.isActiveSelection({
          networkSlug: "freenode",
          channelName: "#grappa",
          kind: "query",
        }),
      ).toBe(false);
    });

    it("returns false for any tuple when nothing is selected yet", async () => {
      localStorage.setItem("grappa-token", "tok");
      const selection = await import("../lib/selection");
      expect(selection.selectedChannel()).toBeNull();
      expect(
        selection.isActiveSelection({
          networkSlug: "freenode",
          channelName: "#grappa",
          kind: "channel",
        }),
      ).toBe(false);
    });
  });
});
