import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";
import { LIST_WINDOW_NAME } from "../lib/windowKinds";

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
  // compose.ts's catch does `e instanceof ChannelPushError` (#62) — the
  // mock MUST export the class or that reference is `undefined` and the
  // instanceof throws for EVERY non-ApiError rejection. Mirror the real
  // shape (code + info) like the ApiError stub above.
  class ChannelPushError extends Error {
    readonly code: string;
    readonly info: Record<string, unknown>;
    constructor(code: string, info: Record<string, unknown> = {}) {
      super(`channel push error: ${code}`);
      this.name = "ChannelPushError";
      this.code = code;
      this.info = info;
    }
  }
  return {
    ApiError,
    ChannelPushError,
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
  // C2 — /whois bridge.
  pushWhois: vi.fn(),
  // CP22 cluster B (channel-client-polish #14) — /who bridge.
  pushWho: vi.fn(),
  // CP22 cluster B (channel-client-polish #14) — /names bridge.
  pushNames: vi.fn(),
}));

// Mock queryWindows.ts — compose.ts calls openQueryWindowState for /msg /query /q.
// canonicalQueryNick is identity by default (no existing window match);
// per-test overrides via vi.mocked(...).mockImplementation cover the
// case-insensitive-existing-window arm.
vi.mock("../lib/queryWindows", () => ({
  openQueryWindowState: vi.fn(),
  closeQueryWindowState: vi.fn(),
  queryWindowsByNetwork: vi.fn(() => ({})),
  setQueryWindowsByNetwork: vi.fn(),
  canonicalQueryNick: vi.fn((_networkId: number, nick: string) => nick),
}));

// Mock selection.ts — compose.ts reads selectedChannel for channel-context verbs.
vi.mock("../lib/selection", () => ({
  selectedChannel: vi.fn(() => ({ networkSlug: "freenode", channelName: "#a", kind: "channel" })),
  setSelectedChannel: vi.fn(),
  unreadCounts: vi.fn(() => ({})),
  bumpUnread: vi.fn(),
  applySeedEnvelope: vi.fn(),
}));

vi.mock("../lib/scrollback", () => ({
  sendMessage: vi.fn(),
}));

vi.mock("../lib/members", () => ({
  membersByChannel: vi.fn(() => ({})),
  applyPresenceEvent: vi.fn(),
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
// bnd-A2: also expose `networkIdBySlug` so the channel-ops + DM verbs
// resolve their networkSlug → id without falling through the
// "network not found" guard. The mock data parallels the real helper's
// behavior (slug→Network Map lookup) for the freenode / libera fixtures.
const mockNetworksData = [
  { kind: "user", id: 1, slug: "freenode", inserted_at: "", updated_at: "" },
  { kind: "user", id: 2, slug: "libera", inserted_at: "", updated_at: "" },
];
vi.mock("../lib/networks", () => ({
  networks: vi.fn(() => mockNetworksData),
  user: vi.fn(() => null),
  channelsBySlug: vi.fn(() => ({})),
  refetchChannels: vi.fn(),
  networkBySlug: vi.fn((slug: string) => mockNetworksData.find((n) => n.slug === slug)),
  networkIdBySlug: vi.fn((slug: string) => mockNetworksData.find((n) => n.slug === slug)?.id),
}));

// CP17: setPending is no longer called from compose.ts (server-driven
// origination via userTopic.ts dispatch). The mock stays so the
// "/join does NOT call setPending" test can assert on the absence.
vi.mock("../lib/windowState", () => ({
  setPending: vi.fn(),
  setJoined: vi.fn(),
  setFailed: vi.fn(),
  setKicked: vi.fn(),
  setParted: vi.fn(),
  windowStateByChannel: vi.fn(() => ({})),
  windowFailureByChannel: vi.fn(() => ({})),
  windowKickedMetaByChannel: vi.fn(() => ({})),
}));

// #84 — channelDirectory store mock. compose.ts calls setQuery when the
// user types `/list <pattern>` to seed the directory search on open.
vi.mock("../lib/channelDirectory", () => ({
  directoryPage: vi.fn(() => undefined),
  loadDirectory: vi.fn().mockResolvedValue(undefined),
  setSort: vi.fn().mockResolvedValue(undefined),
  setQuery: vi.fn().mockResolvedValue(undefined),
  triggerRefresh: vi.fn().mockResolvedValue(undefined),
  onDirectoryProgress: vi.fn().mockResolvedValue(undefined),
  onDirectoryComplete: vi.fn().mockResolvedValue(undefined),
  onDirectoryFailed: vi.fn().mockResolvedValue(undefined),
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

  it("recallPrev stashes the live unsent draft; recallNext restores it", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");

    for (const body of ["one", "two"]) {
      compose.setDraft(k, body);
      await compose.submit(k, "freenode", "#a");
    }

    // Half-typed, unsent line at the bottom.
    compose.setDraft(k, "half-typed");

    compose.recallPrev(k); // up into history — must NOT eat the draft
    expect(compose.getDraft(k)).toBe("two");
    compose.recallNext(k); // back to bottom — restores the parked draft
    expect(compose.getDraft(k)).toBe("half-typed");
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

  // Multiline fan-out: an embedded LF can't ride a single PRIVMSG (the
  // server rejects it as :invalid_line — IRC frames are newline-
  // delimited). A multiline compose (Shift+Enter / pasted block) must
  // become one PRIVMSG per line. Pre-fix the whole body went as one send
  // and bounced with an "invalid" error.
  it("multiline :privmsg sends one PRIVMSG per line, in order", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "line one\nline two\nline three");
    const result = await compose.submit(k, "freenode", "#a");

    expect(sb.sendMessage).toHaveBeenCalledTimes(3);
    expect(sb.sendMessage).toHaveBeenNthCalledWith(1, "freenode", "#a", "line one");
    expect(sb.sendMessage).toHaveBeenNthCalledWith(2, "freenode", "#a", "line two");
    expect(sb.sendMessage).toHaveBeenNthCalledWith(3, "freenode", "#a", "line three");
    expect(result).toEqual({ ok: true });
  });

  it("multiline :privmsg drops blank lines and strips CR (CRLF paste)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "a\r\n\r\nb\r\nc");
    const result = await compose.submit(k, "freenode", "#a");

    expect(sb.sendMessage).toHaveBeenCalledTimes(3);
    expect(sb.sendMessage).toHaveBeenNthCalledWith(1, "freenode", "#a", "a");
    expect(sb.sendMessage).toHaveBeenNthCalledWith(2, "freenode", "#a", "b");
    expect(sb.sendMessage).toHaveBeenNthCalledWith(3, "freenode", "#a", "c");
    expect(result).toEqual({ ok: true });
  });

  it("multiline /me sends one ACTION per line", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/me waves\nthen bows");
    const result = await compose.submit(k, "freenode", "#a");

    expect(sb.sendMessage).toHaveBeenCalledTimes(2);
    expect(sb.sendMessage).toHaveBeenNthCalledWith(1, "freenode", "#a", "\x01ACTION waves\x01");
    expect(sb.sendMessage).toHaveBeenNthCalledWith(2, "freenode", "#a", "\x01ACTION then bows\x01");
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

  // UX-4 bucket G — `/msg <Xserv> <text>` sends the wire frame but
  // does NOT open a query window or shift focus. Services responses
  // route to the `$server` window server-side (Identifier.services_sender?
  // allowlist + EventRouter persist-to-$server); a services query
  // window would just sit empty.
  it("/msg nickserv body sends PRIVMSG but does NOT open query window or shift focus (bucket G)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const qw = await import("../lib/queryWindows");
    const sel = await import("../lib/selection");

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/msg nickserv IDENTIFY s3cret");
    const result = await compose.submit(k, "freenode", "#a");

    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "nickserv", "IDENTIFY s3cret");
    expect(qw.openQueryWindowState).not.toHaveBeenCalled();
    expect(sel.setSelectedChannel).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("/msg ChanServ (mixed case) also bypasses query-window open (bucket G)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const qw = await import("../lib/queryWindows");

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/msg ChanServ REGISTER #x pwd");
    const result = await compose.submit(k, "freenode", "#a");

    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "ChanServ", "REGISTER #x pwd");
    expect(qw.openQueryWindowState).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  // UX-4 bucket G — regression guard: ops nicks ending in -serv
  // (Conserv, Dataserv, Reserv) are NOT in the services allowlist;
  // /msg <ops-nick> behaves like /msg <regular-user> and opens a
  // query window.
  it("/msg Conserv (ops nick, not in allowlist) opens query window + shifts focus (bucket G regression guard)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const qw = await import("../lib/queryWindows");
    const sel = await import("../lib/selection");

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/msg Conserv yo");
    const result = await compose.submit(k, "freenode", "#a");

    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "Conserv", "yo");
    expect(qw.openQueryWindowState).toHaveBeenCalled();
    expect(sel.setSelectedChannel).toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("/query nickserv rejects with error explaining services route to $server (bucket G)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const qw = await import("../lib/queryWindows");

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/query nickserv");
    const result = await compose.submit(k, "freenode", "#a");

    expect(qw.openQueryWindowState).not.toHaveBeenCalled();
    expect(result).toHaveProperty("error");
    if ("error" in result) {
      expect(result.error).toMatch(/services/i);
    }
  });

  it("/join channel posts to channels endpoint with null key", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postJoin).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/join #italia");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.postJoin).toHaveBeenCalledWith("tok", "freenode", "#italia", null);
    expect(result).toEqual({ ok: true });
  });

  // UX-4 bucket F: +k channel-key support — `/join #chan key` threads
  // the key through postJoin to the REST surface.
  it("/join channel key posts to channels endpoint with key (bucket F)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postJoin).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/join #priv s3cret");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.postJoin).toHaveBeenCalledWith("tok", "freenode", "#priv", "s3cret");
    expect(result).toEqual({ ok: true });
  });

  // CP17: /join is no longer responsible for setting windowState
  // pending — the server-side `record_in_flight_join/2` writes
  // `window_states[ch] = :pending` and broadcasts
  // `kind: "window_pending"` on the user-topic. cic's userTopic.ts
  // dispatcher mirrors that into `windowStateByChannel` via
  // `setPending(...)`. Closes the CLAUDE.md "cic NEVER originates
  // state" hard-invariant violation that compose's optimistic
  // setPending used to embody. The pre-CP17 setPending here was the
  // last cic-originated state mutation in the codebase.
  it("/join does NOT call setPending (CP17 — origination moved to server)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postJoin).mockResolvedValue();
    const ws = await import("../lib/windowState");

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/join #italia");
    await compose.submit(k, "freenode", "#a");

    expect(ws.setPending).not.toHaveBeenCalled();
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
    compose.setDraft(k, "/notarealverbatall foo");
    const result = await compose.submit(k, "freenode", "#a");
    expect(result).toEqual({ error: "unknown command: /notarealverbatall" });
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

  it("REST failure surfaces friendlyApiError copy as {error}; draft preserved", async () => {
    // U-3 (UD3): typed ApiErrors route through friendlyApiError so the
    // compose-box alert renders human copy instead of raw wire tokens.
    // Use `network_busy` — a known wire token with mapped copy — so
    // the test pins both the catch-path wiring AND the
    // friendlyApiError integration (vs an unmapped token that would
    // fall through to err.message).
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postTopic).mockRejectedValue(new api.ApiError(503, "network_busy"));

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/topic ciao mondo");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toEqual({ error: "This network is at capacity. Try again in a few minutes." });
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

describe("compose tabComplete (members-only, irssi-exact)", () => {
  const k = channelKey("freenode", "#a");

  const setMembers = async (nicks: string[]) => {
    const members = await import("../lib/members");
    vi.mocked(members.membersByChannel).mockReturnValue({
      [k]: nicks.map((nick) => ({ nick, modes: [] })),
    });
  };

  it("returns null when no members", async () => {
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "hello al", 8, true)).toBeNull();
  });

  it("returns null when the word has no prefix match", async () => {
    await setMembers(["bob"]);
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "al", 2, true)).toBeNull();
  });

  it("appends ': ' at line start", async () => {
    await setMembers(["alice", "alex", "bob"]);
    const compose = await import("../lib/compose");
    const r = compose.tabComplete(k, "al", 2, true);
    expect(r?.newInput).toBe("alex: "); // first alphabetically
    expect(r?.newCursor).toBe(6);
  });

  it("appends ' ' (no colon) mid-sentence", async () => {
    await setMembers(["alice", "alex"]);
    const compose = await import("../lib/compose");
    const r = compose.tabComplete(k, "hi al", 5, true);
    expect(r?.newInput).toBe("hi alex ");
    expect(r?.newCursor).toBe(8);
  });

  it("cycles forward through matches then reverts to typed text, then wraps", async () => {
    await setMembers(["alice", "alex"]);
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "al", 2, true)?.newInput).toBe("alex: ");
    let draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("alice: ");
    draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("al");
    draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("alex: ");
  });

  it("Shift+Tab from the first match steps back into the revert slot", async () => {
    await setMembers(["alice", "alex"]);
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "al", 2, true)?.newInput).toBe("alex: ");
    const draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, false)?.newInput).toBe("al");
  });

  it("single match still offers a revert slot", async () => {
    await setMembers(["alex"]);
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "al", 2, true)?.newInput).toBe("alex: ");
    let draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("al");
    draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("alex: ");
  });

  it("continues the cycle when the caret lands inside the inserted nick (re-tap)", async () => {
    await setMembers(["alice", "alex"]);
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "al", 2, true)?.newInput).toBe("alex: ");
    const draft = compose.getDraft(k); // "alex: "
    expect(compose.tabComplete(k, draft, 2, true)?.newInput).toBe("alice: ");
  });

  it("preserves the originally typed case on revert", async () => {
    await setMembers(["alex"]);
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "AL", 2, true)?.newInput).toBe("alex: ");
    const draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("AL");
  });

  it("writes the completed draft into the store", async () => {
    await setMembers(["alex"]);
    const compose = await import("../lib/compose");
    compose.tabComplete(k, "al", 2, true);
    expect(compose.getDraft(k)).toBe("alex: ");
  });

  it("a real keystroke (setDraft) discards the cycle", async () => {
    await setMembers(["alice", "alex"]);
    const compose = await import("../lib/compose");
    compose.tabComplete(k, "al", 2, true); // draft now "alex: "
    compose.setDraft(k, "alex: x"); // user typed → cycle must reset
    expect(compose.tabComplete(k, "alex: x", 7, true)).toBeNull();
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

  // Codebase audit cic M5 — partial PATCH failures during /quit MUST
  // be surfaced via console.warn (one entry per rejected PATCH) so the
  // operator can investigate why a network may auto-respawn on next
  // boot. Pre-fix the `Promise.allSettled` rejected results were
  // dropped on the floor — the user logged out cleanly but a network
  // ghost-state lurked in the log silence. The warning is best-effort:
  // we still proceed to logout (the user wants OUT regardless), but
  // the diagnostic trail no longer vanishes.
  it("/quit logs console.warn for each rejected PATCH but still logs out", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const auth = await import("../lib/auth");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.mocked(api.patchNetwork)
      .mockRejectedValueOnce(new Error("network unreachable: freenode"))
      .mockRejectedValueOnce(new Error("network unreachable: libera"));

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/quit");
    const result = await compose.submit(k, "freenode", "#a");

    // Warning logged for EACH failed PATCH (two failures = two warnings).
    expect(warnSpy).toHaveBeenCalledTimes(2);
    // Each warning carries the failing slug + the rejection reason so
    // the operator can grep for "[/quit]" in container logs.
    const allCalls = warnSpy.mock.calls.map((c) => c.join(" "));
    expect(allCalls.some((s) => s.includes("[/quit]") && s.includes("freenode"))).toBe(true);
    expect(allCalls.some((s) => s.includes("[/quit]") && s.includes("libera"))).toBe(true);
    // Logout still proceeds — `/quit` is nuclear: the user wants out
    // regardless of partial PATCH success.
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ok: true });

    warnSpy.mockRestore();
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

  // U-3 (UD3): /connect surfacing a typed server-side ApiError MUST
  // route through friendlyApiError so the operator sees human copy
  // ("You're already at the session limit...") instead of the raw
  // wire token "too_many_sessions". Pins the
  // compose.ts catch path → friendlyApiError integration.
  it("/connect on a saturated client-cap surfaces friendly copy not raw wire token", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.patchNetwork).mockRejectedValue(new api.ApiError(503, "too_many_sessions"));

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/connect freenode");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toMatchObject({
      error: expect.stringMatching(
        /already at the session limit for this network from this device/i,
      ),
    });
    // Raw wire token MUST NOT leak.
    expect(result).not.toMatchObject({ error: "too_many_sessions" });
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
    // bnd-A2: compose.ts consults `networkIdBySlug` (helper extracted
    // from the 14× repeated `networks()?.find(...)?.id` literal). Stub
    // it to undefined to reproduce the "no slug match" path.
    (
      networks.networkIdBySlug as unknown as { mockReturnValueOnce: (v: unknown) => void }
    ).mockReturnValueOnce(undefined);
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

  it("/invite <nick> <#chan> from non-channel window submits (skip requireChannel when chan supplied)", async () => {
    // P-0f follow-up bucket 0: pre-fix, /invite alice #secret from a
    // query window silently errored ("requires an active channel
    // window") because requireChannel was unconditionally evaluated
    // before the cmd.channel ?? chanOrErr fallback could apply.
    // Post-fix: explicit channel arg short-circuits requireChannel
    // entirely — the active window's kind is irrelevant. Don't mock
    // selectedChannel here: the skip-path never consults it, and a
    // mockReturnValueOnce that isn't consumed leaks into the next
    // test (observed via /topic -delete picking up the stale mock).
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "bob");
    compose.setDraft(k, "/invite alice #secret");
    const result = await compose.submit(k, "freenode", "bob");

    expect(socket.pushChannelInvite).toHaveBeenCalledWith(1, "#secret", "alice");
    expect(result).toEqual({ ok: true });
  });

  it("/invite <nick> bare from non-channel window returns inline error", async () => {
    // Counterpoint: when the channel arg is omitted AND the active
    // window isn't a channel, requireChannel still fires.
    localStorage.setItem("grappa-token", "tok");
    const sel = await import("../lib/selection");
    vi.mocked(sel.selectedChannel).mockReturnValueOnce({
      networkSlug: "freenode",
      channelName: "bob",
      kind: "query",
    });
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "bob");
    compose.setDraft(k, "/invite alice");
    const result = await compose.submit(k, "freenode", "bob");

    expect(socket.pushChannelInvite).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: expect.stringContaining("channel window") });
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
  // CP22 cluster B (channel-client-polish #14) — /who is no longer a stub.
  // Push goes through to the server; success returns {ok: true}. The 352
  // /315 burst → N+1 :persist :notice rows is verified end-to-end by the
  // Playwright e2e + Session.Server tests.
  it("/who #channel pushes to server", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/who #grappa");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toMatchObject({ ok: true });
  });

  it("/who without target returns inline error", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/who");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toMatchObject({ error: expect.stringContaining("requires a #channel") });
  });

  it("/names with target dispatches via pushNames", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/names #grappa");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toMatchObject({ ok: true });
  });

  it("/names without target returns inline error", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/names");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toMatchObject({ error: expect.stringContaining("requires a #channel") });
  });

  // #84 — /list executor. Opens the $list directory pseudo-window for the
  // current network; a pattern arg seeds setQuery so the pane opens pre-
  // filtered. No raw LIST is sent — the directory's own refresh path owns
  // that. The old "not yet implemented" placeholder is REPLACED here.
  it("/list opens $list window and returns {ok: true}", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sel = await import("../lib/selection");
    const cd = await import("../lib/channelDirectory");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/list");
    const result = await compose.submit(k, "freenode", "#a");

    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: LIST_WINDOW_NAME,
      kind: "list",
    });
    // No pattern → setQuery must NOT be called.
    expect(cd.setQuery).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("/list <pattern> opens $list window AND seeds setQuery with pattern", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sel = await import("../lib/selection");
    const cd = await import("../lib/channelDirectory");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/list *grappa*");
    const result = await compose.submit(k, "freenode", "#a");

    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: LIST_WINDOW_NAME,
      kind: "list",
    });
    expect(cd.setQuery).toHaveBeenCalledWith("freenode", "*grappa*");
    expect(result).toEqual({ ok: true });
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

  // C8.3 fix-up BUG #1: draft must be cleared after watchlist submit.
  it("/watch list clears draft after submit", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/watch list");
    await compose.submit(k, "freenode", "#a");
    // Draft must be empty — the early-return bug skipped the post-try clear path.
    expect(compose.getDraft(k)).toBe("");
  });

  it("/watch add <pattern> clears draft after submit", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/watch add myname");
    await compose.submit(k, "freenode", "#a");
    expect(compose.getDraft(k)).toBe("");
  });

  it("/watch del <pattern> clears draft after submit", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/watch del myname");
    await compose.submit(k, "freenode", "#a");
    expect(compose.getDraft(k)).toBe("");
  });
});

// CP13 S9 — $server window slash-only gate.
describe("compose submit — $server slash-only gate (CP13 S9)", () => {
  it("rejects plain text on $server with a friendly error", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "$server");
    compose.setDraft(k, "hello world");
    const result = await compose.submit(k, "freenode", "$server");
    expect(result).toEqual({
      error: "Server window accepts only slash-commands. Try /raw <line>",
    });
    // Draft preserved on rejection so the user can edit and retry.
    expect(compose.getDraft(k)).toBe("hello world");
  });

  it("accepts /raw on $server (passes through to slash dispatch)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "$server");
    // /raw isn't implemented as a known slash today — it falls through to
    // "unknown command", which is fine: the gate didn't reject it.
    compose.setDraft(k, "/raw PING :test");
    const result = await compose.submit(k, "freenode", "$server");
    expect(result).not.toEqual({
      error: "Server window accepts only slash-commands. Try /raw <line>",
    });
  });

  it("does NOT apply the gate to channels (plain text on #foo dispatches)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "regular message");
    const result = await compose.submit(k, "freenode", "#a");
    // Channel privmsg path returns either {ok: true} on success or some
    // other error — but NOT the $server-specific gate error.
    expect(result).not.toEqual({
      error: "Server window accepts only slash-commands. Try /raw <line>",
    });
  });
});
