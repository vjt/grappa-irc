import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

vi.mock("../lib/api", () => {
  class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string) {
      super(`${status} ${code}`);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
    }
  }
  return {
    ApiError,
    postTopic: vi.fn(),
    postNick: vi.fn(),
    postJoin: vi.fn(),
    postPart: vi.fn(),
    // T32 — required by compose.ts for /quit /disconnect /connect
    patchNetwork: vi.fn(),
    // Required by networks.ts (transitively imported via compose.ts → networks.ts)
    listNetworks: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([]),
    me: vi.fn().mockResolvedValue(null),
    setOn401Handler: vi.fn(),
  };
});

// Mock socket.ts push helpers — compose.ts calls these for ops verbs.
vi.mock("../lib/socket", () => ({
  pushAwaySet: vi.fn().mockResolvedValue(undefined),
  pushAwayUnset: vi.fn().mockResolvedValue(undefined),
  pushOpenQueryWindow: vi.fn(),
  pushCloseQueryWindow: vi.fn(),
  pushChannelOp: vi.fn(),
  pushChannelDeop: vi.fn(),
  pushChannelVoice: vi.fn(),
  pushChannelDevoice: vi.fn(),
  pushChannelKick: vi.fn(),
  pushChannelBan: vi.fn(),
  pushChannelUnban: vi.fn(),
  pushChannelBanlist: vi.fn(),
  pushChannelInvite: vi.fn(),
  pushChannelUmode: vi.fn(),
  pushChannelMode: vi.fn(),
  pushChannelTopicClear: vi.fn(),
  notifyClientClosing: vi.fn(),
  // C8.3 — watchlist push helpers.
  pushWatchlistAdd: vi.fn().mockResolvedValue({ patterns: ["myname"] }),
  pushWatchlistDel: vi.fn().mockResolvedValue({ patterns: [] }),
  pushWatchlistList: vi.fn().mockResolvedValue({ patterns: ["myname"] }),
}));

// Mock queryWindows.ts — compose.ts calls openQueryWindowState for /msg /query /q.
vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: vi.fn(),
  closeQueryWindowState: vi.fn(),
  queryWindowsByNetwork: vi.fn(() => ({})),
  setQueryWindowsByNetwork: vi.fn(),
}));

// Mock selection.ts — compose.ts reads selectedChannel for channel-context verbs.
vi.mock("../lib/selection", () => ({
  selectedChannel: vi.fn(() => ({ networkSlug: "freenode", channelName: "#a", kind: "channel" })),
  setSelectedChannel: vi.fn(),
  unreadCounts: vi.fn(() => ({})),
  bumpUnread: vi.fn(),
}));

vi.mock("../lib/scrollback", () => ({
  sendMessage: vi.fn(),
}));

vi.mock("../lib/members", () => ({
  membersByChannel: vi.fn(() => ({})),
  applyPresenceEvent: vi.fn(),
  loadMembers: vi.fn(),
}));

// Mock auth to provide logout for /quit flow. `token` must return a value
// so the compose submit's `if (!t) return` guard doesn't short-circuit
// tests that expect the handler to run.
vi.mock("../lib/auth", () => ({
  token: vi.fn(() => "tok"),
  logout: vi.fn().mockResolvedValue(undefined),
}));

// Mock networks so compose.ts can read the network list for /quit without
// depending on the real api.ts listNetworks call chain in tests.
vi.mock("../lib/networks", () => ({
  networks: vi.fn(() => [
    { id: 1, slug: "freenode", inserted_at: "", updated_at: "" },
    { id: 2, slug: "libera", inserted_at: "", updated_at: "" },
  ]),
  user: vi.fn(() => null),
  channelsBySlug: vi.fn(() => ({})),
  refetchChannels: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("compose draft state", () => {
  it("setDraft writes per-channel; getDraft reads", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k1 = channelKey("freenode", "#a");
    const k2 = channelKey("freenode", "#b");
    compose.setDraft(k1, "hello");
    compose.setDraft(k2, "world");
    expect(compose.getDraft(k1)).toBe("hello");
    expect(compose.getDraft(k2)).toBe("world");
  });

  it("getDraft returns empty string for an untouched channel", async () => {
    const compose = await import("../lib/compose");
    expect(compose.getDraft(channelKey("freenode", "#never"))).toBe("");
  });
});

describe("compose history (up/down recall)", () => {
  it("submit pushes the body onto history; recallPrev returns it", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");

    compose.setDraft(k, "first message");
    await compose.submit(k, "freenode", "#a");
    compose.setDraft(k, "");

    compose.recallPrev(k);
    expect(compose.getDraft(k)).toBe("first message");
  });

  it("recallPrev/Next walks the history both directions", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");

    for (const body of ["one", "two", "three"]) {
      compose.setDraft(k, body);
      await compose.submit(k, "freenode", "#a");
    }
    compose.setDraft(k, "");

    compose.recallPrev(k);
    expect(compose.getDraft(k)).toBe("three");
    compose.recallPrev(k);
    expect(compose.getDraft(k)).toBe("two");
    compose.recallPrev(k);
    expect(compose.getDraft(k)).toBe("one");
    compose.recallPrev(k); // already at oldest — clamp
    expect(compose.getDraft(k)).toBe("one");

    compose.recallNext(k);
    expect(compose.getDraft(k)).toBe("two");
    compose.recallNext(k);
    expect(compose.getDraft(k)).toBe("three");
    compose.recallNext(k); // past newest — return to empty draft
    expect(compose.getDraft(k)).toBe("");
  });
});

describe("compose submit — slash command dispatch", () => {
  it(":privmsg sends via scrollback.sendMessage", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "hello");
    const result = await compose.submit(k, "freenode", "#a");

    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "#a", "hello");
    expect(result).toEqual({ ok: true });
  });

  it("/me action sends as ACTION via scrollback.sendMessage with CTCP framing", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/me waves");
    const result = await compose.submit(k, "freenode", "#a");

    // CTCP ACTION wraps body as \x01ACTION <text>\x01
    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "#a", "\x01ACTION waves\x01");
    expect(result).toEqual({ ok: true });
  });

  it("/topic body posts to /topic endpoint", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postTopic).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/topic ciao mondo");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.postTopic).toHaveBeenCalledWith("tok", "freenode", "#a", "ciao mondo");
    expect(result).toEqual({ ok: true });
  });

  it("/nick newnick posts to /nick endpoint", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postNick).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/nick vjt-away");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.postNick).toHaveBeenCalledWith("tok", "freenode", "vjt-away");
    expect(result).toEqual({ ok: true });
  });

  it("/msg target body sends PRIVMSG to target via scrollback.sendMessage", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/msg alice ciao");
    const result = await compose.submit(k, "freenode", "#a");

    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "alice", "ciao");
    expect(result).toEqual({ ok: true });
  });

  it("/join channel posts to channels endpoint", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postJoin).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/join #italia");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.postJoin).toHaveBeenCalledWith("tok", "freenode", "#italia");
    expect(result).toEqual({ ok: true });
  });

  it("/part with no arg parts the current channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postPart).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/part");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.postPart).toHaveBeenCalledWith("tok", "freenode", "#a");
    expect(result).toEqual({ ok: true });
  });

  it("unknown slash returns {error: 'unknown command'}", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/whois alice");
    const result = await compose.submit(k, "freenode", "#a");
    expect(result).toEqual({ error: "unknown command: /whois" });
  });

  it("empty draft returns {error: 'empty'} without dispatching", async () => {
    const sb = await import("../lib/scrollback");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "   ");
    const result = await compose.submit(k, "freenode", "#a");
    expect(result).toEqual({ error: "empty" });
    expect(sb.sendMessage).not.toHaveBeenCalled();
  });

  it("REST failure surfaces ApiError.code as {error}; draft preserved", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postTopic).mockRejectedValue(new api.ApiError(503, "upstream"));

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/topic ciao mondo");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toEqual({ error: "upstream" });
    // Draft preserved so user can retry without re-typing.
    expect(compose.getDraft(k)).toBe("/topic ciao mondo");
  });

  it("non-ApiError rejection surfaces as {error: 'send failed'}", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockRejectedValue(new Error("boom"));

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "hello");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toEqual({ error: "send failed" });
    expect(compose.getDraft(k)).toBe("hello");
  });
});

describe("compose tabComplete (members-only, P4-1 Q6)", () => {
  it("returns null when no members", async () => {
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    expect(compose.tabComplete(k, "hello al", 8, true)).toBeNull();
  });

  it("completes the leading nick prefix at the cursor", async () => {
    const members = await import("../lib/members");
    vi.mocked(members.membersByChannel).mockReturnValue({
      [channelKey("freenode", "#a")]: [
        { nick: "alice", modes: [] },
        { nick: "alex", modes: [] },
        { nick: "bob", modes: [] },
      ],
    });

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    const r = compose.tabComplete(k, "hi al", 5, true);
    expect(r).not.toBeNull();
    // First match alphabetically: alex
    expect(r?.newInput).toBe("hi alex");
    expect(r?.newCursor).toBe(7);
  });

  it("cycles through matches on repeated tab", async () => {
    const members = await import("../lib/members");
    vi.mocked(members.membersByChannel).mockReturnValue({
      [channelKey("freenode", "#a")]: [
        { nick: "alice", modes: [] },
        { nick: "alex", modes: [] },
      ],
    });

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    const r1 = compose.tabComplete(k, "al", 2, true);
    expect(r1?.newInput).toBe("alex");
    const r2 = compose.tabComplete(k, r1?.newInput ?? "", r1?.newCursor ?? 0, true);
    expect(r2?.newInput).toBe("alice");
    const r3 = compose.tabComplete(k, r2?.newInput ?? "", r2?.newCursor ?? 0, true);
    // Wraps back to alex
    expect(r3?.newInput).toBe("alex");
  });
});

// T32 slash verbs: /quit /disconnect /connect
describe("compose submit — T32 verbs", () => {
  it("/quit PATCHes ALL networks to :parked then calls logout", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const auth = await import("../lib/auth");
    vi.mocked(api.patchNetwork).mockResolvedValue({
      network: "freenode",
      nick: "vjt",
      realname: null,
      sasl_user: null,
      auth_method: "sasl_plain",
      auth_command_template: null,
      autojoin_channels: [],
      connection_state: "parked",
      connection_state_reason: "user-quit",
      connection_state_changed_at: null,
      inserted_at: "",
      updated_at: "",
    });

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/quit going offline");
    const result = await compose.submit(k, "freenode", "#a");

    // Both networks from the mock get PATCHed to :parked.
    expect(api.patchNetwork).toHaveBeenCalledTimes(2);
    expect(api.patchNetwork).toHaveBeenCalledWith("tok", "freenode", {
      connection_state: "parked",
      reason: "going offline",
    });
    expect(api.patchNetwork).toHaveBeenCalledWith("tok", "libera", {
      connection_state: "parked",
      reason: "going offline",
    });
    // logout() terminates the session regardless of PATCH results.
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  it("/quit bare (no reason) PATCHes without reason field", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.patchNetwork).mockResolvedValue({
      network: "freenode",
      nick: "vjt",
      realname: null,
      sasl_user: null,
      auth_method: "sasl_plain",
      auth_command_template: null,
      autojoin_channels: [],
      connection_state: "parked",
      connection_state_reason: null,
      connection_state_changed_at: null,
      inserted_at: "",
      updated_at: "",
    });

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/quit");
    await compose.submit(k, "freenode", "#a");

    // No reason key when bare /quit.
    expect(api.patchNetwork).toHaveBeenCalledWith("tok", "freenode", {
      connection_state: "parked",
    });
  });

  it("/quit still calls logout even if a PATCH fails (Promise.allSettled)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const auth = await import("../lib/auth");
    // First PATCH fails, second succeeds.
    vi.mocked(api.patchNetwork)
      .mockRejectedValueOnce(new Error("network unreachable"))
      .mockResolvedValueOnce({
        network: "libera",
        nick: "vjt",
        realname: null,
        sasl_user: null,
        auth_method: "sasl_plain",
        auth_command_template: null,
        autojoin_channels: [],
        connection_state: "parked",
        connection_state_reason: null,
        connection_state_changed_at: null,
        inserted_at: "",
        updated_at: "",
      });

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/quit");
    const result = await compose.submit(k, "freenode", "#a");

    // logout STILL called despite the first PATCH failing.
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });
  });

  it("/disconnect bare uses active-window's network slug", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.patchNetwork).mockResolvedValue({
      network: "freenode",
      nick: "vjt",
      realname: null,
      sasl_user: null,
      auth_method: "sasl_plain",
      auth_command_template: null,
      autojoin_channels: [],
      connection_state: "parked",
      connection_state_reason: null,
      connection_state_changed_at: null,
      inserted_at: "",
      updated_at: "",
    });

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/disconnect");
    const result = await compose.submit(k, "freenode", "#a");

    // Active-window network slug used when no arg given.
    expect(api.patchNetwork).toHaveBeenCalledWith("tok", "freenode", {
      connection_state: "parked",
    });
    expect(result).toEqual({ ok: true });
  });

  it("/disconnect <net> targets the named network slug", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.patchNetwork).mockResolvedValue({
      network: "libera",
      nick: "vjt",
      realname: null,
      sasl_user: null,
      auth_method: "sasl_plain",
      auth_command_template: null,
      autojoin_channels: [],
      connection_state: "parked",
      connection_state_reason: null,
      connection_state_changed_at: null,
      inserted_at: "",
      updated_at: "",
    });

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/disconnect libera");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.patchNetwork).toHaveBeenCalledWith("tok", "libera", {
      connection_state: "parked",
    });
    expect(result).toEqual({ ok: true });
  });

  it("/disconnect <net> <reason> passes reason to PATCH body", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.patchNetwork).mockResolvedValue({
      network: "libera",
      nick: "vjt",
      realname: null,
      sasl_user: null,
      auth_method: "sasl_plain",
      auth_command_template: null,
      autojoin_channels: [],
      connection_state: "parked",
      connection_state_reason: "going offline",
      connection_state_changed_at: null,
      inserted_at: "",
      updated_at: "",
    });

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/disconnect libera going offline");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.patchNetwork).toHaveBeenCalledWith("tok", "libera", {
      connection_state: "parked",
      reason: "going offline",
    });
    expect(result).toEqual({ ok: true });
  });

  it("/connect <net> PATCHes the named network to :connected", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.patchNetwork).mockResolvedValue({
      network: "libera",
      nick: "vjt",
      realname: null,
      sasl_user: null,
      auth_method: "sasl_plain",
      auth_command_template: null,
      autojoin_channels: [],
      connection_state: "connected",
      connection_state_reason: null,
      connection_state_changed_at: null,
      inserted_at: "",
      updated_at: "",
    });

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/connect libera");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.patchNetwork).toHaveBeenCalledWith("tok", "libera", {
      connection_state: "connected",
    });
    expect(result).toEqual({ ok: true });
  });

  it("/connect bare returns inline error without making API call", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/connect");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.patchNetwork).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: expect.stringContaining("requires") });
  });
});

// C2.2 / C4.3 — handler wiring for DM verbs.
// /msg /query /q all open the query window AND switch focus (user-action).
describe("compose submit — /query and /q DM verbs", () => {
  it("/query <nick> opens query window via openQueryWindowState AND switches focus", async () => {
    localStorage.setItem("grappa-token", "tok");
    const qw = await import("../lib/queryWindows");
    const sel = await import("../lib/selection");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/query alice");
    const result = await compose.submit(k, "freenode", "#a");

    expect(qw.openQueryWindowState).toHaveBeenCalledWith(1, "alice", expect.any(String));
    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "alice",
      kind: "query",
    });
    expect(result).toEqual({ ok: true });
  });

  it("/q <nick> opens query window AND switches focus (alias for /query)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const qw = await import("../lib/queryWindows");
    const sel = await import("../lib/selection");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/q bob");
    const result = await compose.submit(k, "freenode", "#a");

    expect(qw.openQueryWindowState).toHaveBeenCalledWith(1, "bob", expect.any(String));
    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "bob",
      kind: "query",
    });
    expect(result).toEqual({ ok: true });
  });

  it("/msg <nick> <text> opens query window, switches focus, AND sends PRIVMSG", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const qw = await import("../lib/queryWindows");
    const sel = await import("../lib/selection");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/msg alice ciao");
    const result = await compose.submit(k, "freenode", "#a");

    expect(qw.openQueryWindowState).toHaveBeenCalledWith(1, "alice", expect.any(String));
    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "alice",
      kind: "query",
    });
    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "alice", "ciao");
    expect(result).toEqual({ ok: true });
  });

  it("/msg without active network returns inline error", async () => {
    localStorage.setItem("grappa-token", "tok");
    const networks = await import("../lib/networks");
    // Override networks to return empty list — no network found.
    // The `networks` export is a Resource at compile-time but a vi.fn at test-
    // time (mocked at module level). Access mock API via unknown cast.
    (
      networks.networks as unknown as { mockReturnValueOnce: (v: unknown) => void }
    ).mockReturnValueOnce([]);
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/msg alice hello");
    const result = await compose.submit(k, "freenode", "#a");

    // networkId not found → inline error.
    expect(result).toMatchObject({ error: expect.stringContaining("network not found") });
  });
});

describe("compose submit — channel ops verbs", () => {
  it("/op <nicks> pushes op channel event", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/op alice bob");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelOp).toHaveBeenCalledWith(1, "#a", ["alice", "bob"]);
    expect(result).toEqual({ ok: true });
  });

  it("/deop <nick> pushes deop channel event", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/deop alice");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelDeop).toHaveBeenCalledWith(1, "#a", ["alice"]);
    expect(result).toEqual({ ok: true });
  });

  it("/voice <nick> pushes voice channel event", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/voice alice");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelVoice).toHaveBeenCalledWith(1, "#a", ["alice"]);
    expect(result).toEqual({ ok: true });
  });

  it("/devoice <nick> pushes devoice channel event", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/devoice alice");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelDevoice).toHaveBeenCalledWith(1, "#a", ["alice"]);
    expect(result).toEqual({ ok: true });
  });

  it("/kick <nick> [reason] pushes kick channel event", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/kick alice bye bye");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelKick).toHaveBeenCalledWith(1, "#a", "alice", "bye bye");
    expect(result).toEqual({ ok: true });
  });

  it("/ban <mask> pushes ban channel event", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/ban *!*@evil.com");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelBan).toHaveBeenCalledWith(1, "#a", "*!*@evil.com");
    expect(result).toEqual({ ok: true });
  });

  it("/unban <mask> pushes unban channel event", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/unban *!*@evil.com");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelUnban).toHaveBeenCalledWith(1, "#a", "*!*@evil.com");
    expect(result).toEqual({ ok: true });
  });

  it("/banlist pushes banlist channel event", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/banlist");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelBanlist).toHaveBeenCalledWith(1, "#a");
    expect(result).toEqual({ ok: true });
  });

  it("/invite <nick> pushes invite channel event with active channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/invite alice");
    const result = await compose.submit(k, "freenode", "#a");

    // channel defaults to active window "#a"
    expect(socket.pushChannelInvite).toHaveBeenCalledWith(1, "#a", "alice");
    expect(result).toEqual({ ok: true });
  });

  it("/invite <nick> <#chan> pushes invite with explicit channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/invite alice #secret");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelInvite).toHaveBeenCalledWith(1, "#secret", "alice");
    expect(result).toEqual({ ok: true });
  });

  it("/op without channel window returns inline error", async () => {
    localStorage.setItem("grappa-token", "tok");
    // Override selection ONCE to simulate a query window (no # prefix = not a channel).
    const sel = await import("../lib/selection");
    vi.mocked(sel.selectedChannel).mockReturnValueOnce({
      networkSlug: "freenode",
      channelName: "alice",
      kind: "query",
    });
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "alice");
    compose.setDraft(k, "/op bob");
    const result = await compose.submit(k, "freenode", "alice");

    expect(socket.pushChannelOp).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: expect.stringContaining("channel window") });
  });
});

describe("compose submit — /umode and /mode (no channel context required)", () => {
  it("/umode <modes> pushes umode event", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/umode +i");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelUmode).toHaveBeenCalledWith(1, "+i");
    expect(result).toEqual({ ok: true });
  });

  it("/mode <target> <modes> <params> pushes mode event verbatim", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/mode #sniffo +o-v alice rofl");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelMode).toHaveBeenCalledWith(1, "#sniffo", "+o-v", ["alice", "rofl"]);
    expect(result).toEqual({ ok: true });
  });
});

describe("compose submit — /topic branches", () => {
  it("/topic <text> posts to topic REST endpoint", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postTopic).mockResolvedValue();
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/topic new topic text");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.postTopic).toHaveBeenCalledWith("tok", "freenode", "#a", "new topic text");
    expect(result).toEqual({ ok: true });
  });

  it("/topic -delete pushes topic_clear channel event", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/topic -delete");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelTopicClear).toHaveBeenCalledWith(1, "#a");
    expect(result).toEqual({ ok: true });
  });

  it("/topic bare returns inline error (C3 wires the inline render)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/topic");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toMatchObject({ error: expect.stringContaining("C3") });
  });
});

describe("compose submit — info verbs (TODO stubs)", () => {
  it("/who returns inline error (server-side not yet implemented)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/who alice");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toMatchObject({ error: expect.stringContaining("not yet implemented") });
  });

  it("/names returns inline error (server-side not yet implemented)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/names #grappa");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toMatchObject({ error: expect.stringContaining("not yet implemented") });
  });

  it("/list returns inline error (server-side not yet implemented)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/list *grappa*");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toMatchObject({ error: expect.stringContaining("not yet implemented") });
  });

  it("/links returns inline error (server-side not yet implemented)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/links *.irc.net");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toMatchObject({ error: expect.stringContaining("not yet implemented") });
  });
});

describe("compose submit — watchlist verbs (C8.3)", () => {
  it("/watch add <pattern> calls pushWatchlistAdd and returns patterns inline", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/watch add myname");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushWatchlistAdd).toHaveBeenCalledWith("myname");
    expect(result).toMatchObject({ ok: expect.stringContaining("myname") });
  });

  it("/highlight list calls pushWatchlistList and returns patterns inline", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/highlight list");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushWatchlistList).toHaveBeenCalled();
    expect(result).toMatchObject({ ok: expect.stringContaining("watchlist") });
  });

  it("/watch del <pattern> calls pushWatchlistDel and returns patterns inline", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/watch del myname");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushWatchlistDel).toHaveBeenCalledWith("myname");
    expect(result).toMatchObject({ ok: expect.stringContaining("watchlist") });
  });
});
