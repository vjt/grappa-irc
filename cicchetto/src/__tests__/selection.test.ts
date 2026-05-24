import { beforeEach, describe, expect, it, vi } from "vitest";
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

    it("selecting a query window clears messagesUnread + eventsUnread + unreadCounts", async () => {
      // Symmetric counterpart of C7.5 "setSelectedChannel clears both
      // messagesUnread and eventsUnread" — kind: "query".
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "vjt");
      selection.bumpUnread(key);
      selection.bumpMessageUnread(key);
      selection.bumpEventUnread(key);
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "vjt",
        kind: "query",
      });
      expect(selection.unreadCounts()[key]).toBeUndefined();
      expect(selection.messagesUnread()[key]).toBeUndefined();
      expect(selection.eventsUnread()[key]).toBeUndefined();
    });

    it("browser-focus-regain clears mentionCounts for the selected query window", async () => {
      // Symmetric counterpart of UX-5 BU bug-1 fix — kind: "query".
      // Pre-regression (channel path) cleared mentions on focus-regain;
      // K asserts the PM path does too.
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

    it("browser-focus-regain clears messagesUnread + eventsUnread + unreadCounts for the selected query window", async () => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      vi.mocked(api.listMessages).mockResolvedValue([]);
      const selection = await import("../lib/selection");
      const key = channelKey("freenode", "vjt");
      selection.setSelectedChannel({
        networkSlug: "freenode",
        channelName: "vjt",
        kind: "query",
      });
      setVisibilityForTest(false);
      await Promise.resolve();
      selection.bumpUnread(key);
      selection.bumpMessageUnread(key);
      selection.bumpEventUnread(key);

      setVisibilityForTest(true);
      await Promise.resolve();

      expect(selection.unreadCounts()[key]).toBeUndefined();
      expect(selection.messagesUnread()[key]).toBeUndefined();
      expect(selection.eventsUnread()[key]).toBeUndefined();
    });

    it("focus-regain on selected query window does NOT clear OTHER PM windows' badges", async () => {
      // Anti-spec guard: focus-regain only clears the SELECTED window's
      // badges. Mention sitting on a different DM peer must remain visibly
      // unread until the operator navigates there.
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
});
