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
