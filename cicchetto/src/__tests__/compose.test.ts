import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";
import { LIST_WINDOW_NAME } from "../lib/windowKinds";
import { BLANK_BODY_ERROR, serverAcceptsBody } from "./serverBodyPredicate";

vi.mock("../lib/api", () => {
  class ApiError extends Error {
    readonly status: number;
    readonly code: string;
    // #666 — the resumable fan-out reads `info.retry_after` off a 429 to pace
    // the residue, so the stub MUST mirror the real class's `info` field (see
    // api.ts ApiError) or `e.info` is undefined and the pacing throws.
    readonly info: Record<string, unknown>;
    constructor(status: number, code: string, info: Record<string, unknown> = {}) {
      super(`${status} ${code}`);
      this.name = "ApiError";
      this.status = status;
      this.code = code;
      this.info = info;
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
    // #132 — bare /whois in a channel window resolves the operator's own
    // nick via this helper. Boundary stub; the resolver's own logic is
    // pinned in api.test.ts.
    ownNickForNetwork: vi.fn(),
    // T32 — required by compose.ts for /quit /disconnect /connect
    patchNetwork: vi.fn(),
    // #356 — /notify + /watch presence add hits this REST helper.
    postNotifyAdd: vi.fn().mockResolvedValue(undefined),
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
  // #386 — /kb resolves the offender's userhost on demand (host source).
  resolveUserhost: vi.fn(),
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
  // P-0c — /whowas bridge.
  pushWhowas: vi.fn(),
  // CP22 cluster B (channel-client-polish #14) — /who bridge.
  pushWho: vi.fn(),
  // CP22 cluster B (channel-client-polish #14) — /names bridge.
  pushNames: vi.fn(),
  // #127 — /info, /version, /motd bridges.
  pushInfo: vi.fn(),
  pushVersion: vi.fn(),
  pushMotd: vi.fn(),
  // P-0d / #248 — /lusers bridge.
  pushLusers: vi.fn(),
  // #238 — /links topology bridge.
  pushLinks: vi.fn(),
  // #155 — /stats + /rehash ship the raw frame via pushRaw (the #153-de-gated
  // raw transport). #375 asserts the /rehash option rides this frame.
  pushRaw: vi.fn().mockResolvedValue(undefined),
}));

// #248 — compose marks a /lusers request solicited so the incoming
// bundle surfaces the card (the connect-welcome auto-emit does not).
vi.mock("../lib/lusersBundle", () => ({
  markLusersRequested: vi.fn(),
}));

// #268 — compose.ts clears the mentions bundle on the user's own GOING-away
// (`/away <reason>`), moved off the reorder-prone `away_confirmed:"away"` echo.
vi.mock("../lib/mentionsWindow", () => ({
  clearMentionsBundle: vi.fn(),
  setMentionsBundle: vi.fn(),
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

// #591 — /ping registers a pending correlation entry; spy it so the test can
// assert the (networkId, nick, token, sourceKey, sourceChannel, sentAtMs) tuple
// without exercising the real store.
vi.mock("../lib/pingCorrelation", () => ({
  registerPing: vi.fn(),
  resolvePing: vi.fn(),
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

// #216 — /mode viewer/editor modal store. compose.ts opens it for the
// no-mode-args forms.
vi.mock("../lib/banlistModal", () => ({
  openBanlistModal: vi.fn(),
  closeBanlistModal: vi.fn(),
}));

vi.mock("../lib/modeModal", () => ({
  openModeModal: vi.fn(),
  closeModeModal: vi.fn(),
  modeModalState: vi.fn(() => null),
}));

// #229 — /umode viewer/editor modal store. compose.ts opens it for bare
// /umode and /mode <ownnick>.
vi.mock("../lib/umodeModal", () => ({
  openUmodeModal: vi.fn(),
  closeUmodeModal: vi.fn(),
  umodeModalState: vi.fn(() => null),
}));

// #290 — dedicated services console modal store. compose.ts opens it for a
// bare services command (`/ns`, `/cs`, …) then fires `help`.
vi.mock("../lib/serviceModal", () => ({
  openServiceModal: vi.fn(),
  closeServiceModal: vi.fn(),
  serviceModalState: vi.fn(() => null),
}));

// #229 — nickEquals is used by the /mode <ownnick> self-nick gate. Real
// impl is pinned in nickEquals.test.ts; here a boundary stub (ASCII
// case-insensitive compare is enough for the dispatch tests). #412 — the
// spread of `importOriginal` is now MANDATORY for the whole file, not just
// tab-completion: `channelKey.ts` imports `asciiFold` from this module,
// so every `channelKey(...)` fixture call would hit `undefined(...)` and
// throw without the real export. Tab-completion additionally needs the
// REAL `asciiFold` (A-Z fold, brackets untouched; #525) — a stubbed fold
// would test the stub, not the server-pinned fold. Only `nickEquals`
// stays overridden.
vi.mock("../lib/nickEquals", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/nickEquals")>()),
  nickEquals: (a: string, b: string) => a.toLowerCase() === b.toLowerCase(),
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

  // #666 — a multi-line paste fans out to one PRIVMSG per line, clears the
  // draft on full success, and records the WHOLE original body as ONE history
  // entry (not per-line).
  it("#666 — a multi-line body sends one PRIVMSG per line and clears the draft", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");

    compose.setDraft(k, "one\ntwo\nthree");
    const result = await compose.submit(k, "freenode", "#a");

    expect(vi.mocked(sb.sendMessage).mock.calls.map((c) => c[2])).toEqual(["one", "two", "three"]);
    expect(compose.getDraft(k)).toBe("");
    expect(result).toEqual({ ok: true });

    // History records the WHOLE original paste (one recall entry), not per-line.
    compose.recallPrev(k);
    expect(compose.getDraft(k)).toBe("one\ntwo\nthree");
  });

  // #863 — a whitespace-only line must never abort the REST of a paste.
  //
  // This is the constraint that holds whichever way the fix goes, so it is the
  // one worth pinning before the direction is chosen. If cic starts dropping
  // whitespace-only lines, the line never reaches the door and the others go
  // out. If the server starts accepting them, the line is delivered and the
  // others go out. Only today's disagreement — cic sends it, the server calls
  // it blank — stops the paste dead and mirrors the remainder back into the
  // draft, which is what two users reported as a "scrambled" paste.
  //
  // The door here rejects exactly what the real server rejects
  // (`serverBodyPredicate.ts`, which carries the derivation), with the real
  // 422 envelope: `friendlyApiError` turns it into `Please fix: body: can't be
  // blank.` — the string in the report.
  //
  // Deliberately NOT asserted: whether " " itself is sent. That is the product
  // decision (#863's open question) and this test must survive either answer,
  // so it asserts only that the CONTENT lines all got out and the composer was
  // left empty.
  it("#863 — a whitespace-only line does not abort the rest of the paste", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");

    vi.mocked(sb.sendMessage).mockImplementation(async (_slug, _target, body) => {
      if (!serverAcceptsBody(body)) {
        throw new api.ApiError(
          BLANK_BODY_ERROR.status,
          BLANK_BODY_ERROR.code,
          BLANK_BODY_ERROR.info,
        );
      }
      return undefined as never;
    });

    // A code paste with an indented blank line in the middle — the reported shape.
    compose.setDraft(k, "def f():\n \n    return 1");
    const result = await compose.submit(k, "freenode", "#a");

    const sent = vi.mocked(sb.sendMessage).mock.calls.map((c) => c[2]);
    expect(sent.filter((line) => line.trim() !== "")).toEqual(["def f():", "    return 1"]);
    expect(compose.getDraft(k)).toBe("");
    expect(result).toEqual({ ok: true });
  });

  // #666 — the CORE bug. A fatal mid-paste error must leave ONLY the unsent
  // remainder in the draft (never the whole body), so a resend sends ONLY that
  // remainder — never re-delivering the lines that already went out.
  it("#666 — fatal mid-paste keeps only the residue; resume sends only the remainder (no dup)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");

    // l1..l3 delivered; the 4th send fails FATALLY (400 invalid_line, not a 429).
    let n = 0;
    vi.mocked(sb.sendMessage).mockImplementation(async () => {
      n += 1;
      if (n === 4) throw new api.ApiError(400, "invalid_line");
      return undefined as never;
    });

    compose.setDraft(k, "l1\nl2\nl3\nl4\nl5");
    const first = await compose.submit(k, "freenode", "#a");

    // l1..l4 attempted once each (l4 failed); l5 NEVER attempted (no drop-and-forget).
    expect(vi.mocked(sb.sendMessage).mock.calls.map((c) => c[2])).toEqual(["l1", "l2", "l3", "l4"]);
    // Draft holds ONLY the unsent remainder — the delivered l1..l3 are gone.
    expect(compose.getDraft(k)).toBe("l4\nl5");
    expect(first).toHaveProperty("error");

    // Resume: the door is open now. Resending sends ONLY l4, l5 — never l1..l3 again.
    vi.mocked(sb.sendMessage).mockReset();
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const second = await compose.submit(k, "freenode", "#a");

    expect(vi.mocked(sb.sendMessage).mock.calls.map((c) => c[2])).toEqual(["l4", "l5"]);
    expect(compose.getDraft(k)).toBe(""); // fully drained
    expect(second).toEqual({ ok: true });
  });

  // #666 — a send-door 429 is a PAUSE, not a failure: the fan-out waits the
  // server's retry-after, then retries the SAME (refused, never-delivered) line
  // and drains the rest. No line dropped; the refused line is not skipped; the
  // draft holds the unsent remainder while it paces.
  it("#666 — a send-door 429 auto-paces on retry-after and drains the full paste", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("grappa-token", "tok");
      const sb = await import("../lib/scrollback");
      const api = await import("../lib/api");
      const compose = await import("../lib/compose");
      const k = channelKey("freenode", "#a");

      // a, b deliver; c (call 3) is refused ONCE with a 429 carrying
      // retry_after: 2 (seconds); every later attempt succeeds.
      let n = 0;
      let refused = false;
      vi.mocked(sb.sendMessage).mockImplementation(async () => {
        n += 1;
        if (n === 3 && !refused) {
          refused = true;
          throw new api.ApiError(429, "rate_limited", { retry_after: 2 });
        }
        return undefined as never;
      });

      compose.setDraft(k, "a\nb\nc\nd");
      const done = compose.submit(k, "freenode", "#a");

      // Flush microtasks up to the 429 pause: a, b delivered; c refused once.
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.mocked(sb.sendMessage).mock.calls.map((c) => c[2])).toEqual(["a", "b", "c"]);
      // Residue after the refusal is the UNSENT remainder incl. the refused c.
      expect(compose.getDraft(k)).toBe("c\nd");

      // Honour the interval: advance the full 2s → c retried, then d.
      await vi.advanceTimersByTimeAsync(2_000);

      // Every line delivered in order; c appears twice on the CALL log (refused
      // then delivered) but only ever went out once (the first was a 429).
      expect(vi.mocked(sb.sendMessage).mock.calls.map((c) => c[2])).toEqual([
        "a",
        "b",
        "c",
        "c",
        "d",
      ]);
      expect(compose.getDraft(k)).toBe(""); // fully drained, no residue
      expect(await done).toEqual({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  // #666 — safety valve: a door that keeps 429ing PAST its own retry-after must
  // NOT hang the composer forever. After the per-line retry cap the fan-out
  // gives up and surfaces the throttle, leaving the unsent residue in the draft.
  // `vi.runAllTimersAsync` would itself throw if the loop were unbounded (it
  // aborts after 10k timers) — so this is also the regression guard against
  // ever removing the cap.
  it("#666 — a persistently throttled paste stops after the retry cap (no infinite loop), residue kept", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("grappa-token", "tok");
      const sb = await import("../lib/scrollback");
      const api = await import("../lib/api");
      const compose = await import("../lib/compose");
      const k = channelKey("freenode", "#a");

      // a delivers; b (and every retry of it) is refused with a 429 forever.
      let n = 0;
      vi.mocked(sb.sendMessage).mockImplementation(async () => {
        n += 1;
        if (n >= 2) throw new api.ApiError(429, "rate_limited", { retry_after: 1 });
        return undefined as never;
      });

      compose.setDraft(k, "a\nb\nc");
      const done = compose.submit(k, "freenode", "#a");
      // Drain every scheduled pace-sleep; bounded by the cap → settles.
      await vi.runAllTimersAsync();
      const result = await done;

      expect(result).toHaveProperty("error");
      // a went out and is gone from the draft; the unsent b, c remain.
      expect(compose.getDraft(k)).toBe("b\nc");
    } finally {
      vi.useRealTimers();
    }
  });

  // #737 — a paced drain OWNS the draft it is mirroring the residue into: it
  // rewrites that buffer every acked line, for as long as the drain runs (a
  // 429 ladder can hold it for a minute). The operator cannot share that
  // buffer — anything they type is overwritten on the next tick and wiped by
  // the end-of-submit clear. The store refuses the write instead of losing it,
  // and refuses it at EVERY door, since typing, history recall, swipe recall,
  // tab-complete and both paste routes all land on the same draft.
  it("#737 — typing into a draining window is refused, residue intact, and unlocks after", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("grappa-token", "tok");
      const sb = await import("../lib/scrollback");
      const api = await import("../lib/api");
      const compose = await import("../lib/compose");
      const k = channelKey("freenode", "#a");

      // "a" acks; "b" is refused ONCE with a 2s retry-after, then everything
      // succeeds — a drain that is genuinely paused while the operator types.
      let n = 0;
      let refused = false;
      vi.mocked(sb.sendMessage).mockImplementation(async () => {
        n += 1;
        if (n === 2 && !refused) {
          refused = true;
          throw new api.ApiError(429, "rate_limited", { retry_after: 2 });
        }
        return undefined as never;
      });

      compose.setDraft(k, "a\nb\nc");
      const done = compose.submit(k, "freenode", "#a");
      await vi.advanceTimersByTimeAsync(0);

      expect(compose.isDraining(k)).toBe(true);
      expect(compose.getDraft(k)).toBe("b\nc");

      // The operator types a reply mid-pause. Pre-fix this landed in the
      // draft and the next acked line silently replaced it.
      compose.setDraft(k, "wait what happened");
      expect(compose.getDraft(k)).toBe("b\nc");

      await vi.advanceTimersByTimeAsync(2_000);
      expect(await done).toEqual({ ok: true });

      // Drain over: the window is the operator's again.
      expect(compose.isDraining(k)).toBe(false);
      compose.setDraft(k, "now it takes");
      expect(compose.getDraft(k)).toBe("now it takes");
    } finally {
      vi.useRealTimers();
    }
  });

  it("#737 — history recall and tab-complete are refused mid-drain too", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("grappa-token", "tok");
      const sb = await import("../lib/scrollback");
      const api = await import("../lib/api");
      const compose = await import("../lib/compose");
      const k = channelKey("freenode", "#a");

      // Seed one history entry so recallPrev has somewhere to walk.
      vi.mocked(sb.sendMessage).mockResolvedValue();
      compose.setDraft(k, "earlier line");
      await compose.submit(k, "freenode", "#a");

      let n = 0;
      let refused = false;
      vi.mocked(sb.sendMessage).mockImplementation(async () => {
        n += 1;
        if (n === 2 && !refused) {
          refused = true;
          throw new api.ApiError(429, "rate_limited", { retry_after: 2 });
        }
        return undefined as never;
      });

      compose.setDraft(k, "a\nb\nc");
      const done = compose.submit(k, "freenode", "#a");
      await vi.advanceTimersByTimeAsync(0);
      expect(compose.getDraft(k)).toBe("b\nc");

      compose.recallPrev(k);
      expect(compose.getDraft(k)).toBe("b\nc");
      compose.recallNext(k);
      expect(compose.getDraft(k)).toBe("b\nc");

      // Members MUST be seeded here, or tabComplete returns null on its own
      // empty-members guard and this assertion proves nothing.
      const members = await import("../lib/members");
      vi.mocked(members.membersByChannel).mockReturnValue({
        [k]: [{ nick: "bruno", modes: [] }],
      });
      expect(compose.tabComplete(k, "b", 1, true)).toBeNull();
      expect(compose.getDraft(k)).toBe("b\nc");
      vi.mocked(members.membersByChannel).mockReturnValue({});

      await vi.advanceTimersByTimeAsync(2_000);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  // #737 — the re-entrancy hole the store lock has to close. ComposeBox
  // unmounts when the operator visits home / mentions / $list and on the
  // desktop↔mobile swap, which resets its local `sending()`. Enter still fires
  // on a readOnly textarea, so a second submit would fan the SAME residue out
  // again — the #666 duplicate — and hand two drains one lock, so the first to
  // finish would unlock a window the other is still rewriting.
  it("#737 — a second submit on a draining window is refused, not fanned out again", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("grappa-token", "tok");
      const sb = await import("../lib/scrollback");
      const api = await import("../lib/api");
      const compose = await import("../lib/compose");
      const k = channelKey("freenode", "#a");

      let n = 0;
      let refused = false;
      vi.mocked(sb.sendMessage).mockImplementation(async () => {
        n += 1;
        if (n === 2 && !refused) {
          refused = true;
          throw new api.ApiError(429, "rate_limited", { retry_after: 2 });
        }
        return undefined as never;
      });

      compose.setDraft(k, "a\nb\nc");
      const done = compose.submit(k, "freenode", "#a");
      await vi.advanceTimersByTimeAsync(0);
      expect(compose.isDraining(k)).toBe(true);

      // The operator comes back to a remounted composer and hits Enter.
      const sentBefore = vi.mocked(sb.sendMessage).mock.calls.length;
      const second = await compose.submit(k, "freenode", "#a");
      expect(second).toHaveProperty("error");
      expect(vi.mocked(sb.sendMessage).mock.calls.length).toBe(sentBefore);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(await done).toEqual({ ok: true });

      // One drain, one delivery of each line — "b" twice on the CALL log is
      // the 429 refusal plus its retry, never two fan-outs.
      expect(vi.mocked(sb.sendMessage).mock.calls.map((c) => c[2])).toEqual(["a", "b", "b", "c"]);
      expect(compose.isDraining(k)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // #737 — the lock is per WINDOW, not per component. A ComposeBox-local
  // `sending()` flag would freeze whatever window the operator switched to
  // while leaving the actually-draining one writable.
  it("#737 — the lock is per key: a sibling window stays writable during a drain", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("grappa-token", "tok");
      const sb = await import("../lib/scrollback");
      const api = await import("../lib/api");
      const compose = await import("../lib/compose");
      const draining = channelKey("freenode", "#a");
      const other = channelKey("freenode", "#b");

      let n = 0;
      let refused = false;
      vi.mocked(sb.sendMessage).mockImplementation(async () => {
        n += 1;
        if (n === 2 && !refused) {
          refused = true;
          throw new api.ApiError(429, "rate_limited", { retry_after: 2 });
        }
        return undefined as never;
      });

      compose.setDraft(draining, "a\nb\nc");
      const done = compose.submit(draining, "freenode", "#a");
      await vi.advanceTimersByTimeAsync(0);

      expect(compose.isDraining(draining)).toBe(true);
      expect(compose.isDraining(other)).toBe(false);
      compose.setDraft(other, "typed elsewhere");
      expect(compose.getDraft(other)).toBe("typed elsewhere");

      await vi.advanceTimersByTimeAsync(2_000);
      await done;
    } finally {
      vi.useRealTimers();
    }
  });

  // #737 — a lock that outlives its drain is worse than no lock: the window
  // would be dead until reload. The fatal path must release it too.
  it("#737 — a fatally failed drain releases the lock it was holding", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("grappa-token", "tok");
      const sb = await import("../lib/scrollback");
      const api = await import("../lib/api");
      const compose = await import("../lib/compose");
      const k = channelKey("freenode", "#a");

      // "a" acks, "b" is paced once (so the lock is observably HELD), and the
      // retry of "b" dies fatally — the path that must still unlock.
      let n = 0;
      vi.mocked(sb.sendMessage).mockImplementation(async () => {
        n += 1;
        if (n === 2) throw new api.ApiError(429, "rate_limited", { retry_after: 2 });
        if (n === 3) throw new api.ApiError(400, "invalid_line");
        return undefined as never;
      });

      compose.setDraft(k, "a\nb\nc");
      const done = compose.submit(k, "freenode", "#a");
      await vi.advanceTimersByTimeAsync(0);

      // Held during the pace…
      expect(compose.isDraining(k)).toBe(true);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(await done).toHaveProperty("error");

      // …and released by the fatal exit, not just by the happy one.
      expect(compose.isDraining(k)).toBe(false);
      compose.setDraft(k, "b\nc fixed");
      expect(compose.getDraft(k)).toBe("b\nc fixed");
    } finally {
      vi.useRealTimers();
    }
  });

  // #737 — the lock follows the RESIDUE, not the window the operator typed in:
  // /msg mirrors the remainder into the query window it just focused, which is
  // the window that must stop accepting input.
  it("#737 — a /msg drain locks the query window that receives the residue", async () => {
    vi.useFakeTimers();
    try {
      localStorage.setItem("grappa-token", "tok");
      const sb = await import("../lib/scrollback");
      const api = await import("../lib/api");
      const compose = await import("../lib/compose");
      const source = channelKey("freenode", "#a");
      const query = channelKey("freenode", "bob");

      let n = 0;
      let refused = false;
      vi.mocked(sb.sendMessage).mockImplementation(async () => {
        n += 1;
        if (n === 2 && !refused) {
          refused = true;
          throw new api.ApiError(429, "rate_limited", { retry_after: 2 });
        }
        return undefined as never;
      });

      compose.setDraft(source, "/msg bob a\nb\nc");
      const done = compose.submit(source, "freenode", "#a");
      await vi.advanceTimersByTimeAsync(0);

      expect(compose.isDraining(query)).toBe(true);
      expect(compose.getDraft(query)).toBe("b\nc");
      compose.setDraft(query, "typed at the peer");
      expect(compose.getDraft(query)).toBe("b\nc");

      await vi.advanceTimersByTimeAsync(2_000);
      await done;
      expect(compose.isDraining(query)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
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

  // #591/#640 — /ctcp <target> <verb> builds a single \x01VERB\x01 frame. #640:
  // a CTCP QUERY is a control-surface probe, so the echo is keyed to the SOURCE
  // window (the submit's channelName, "#a") and the wire recipient ("bob")
  // rides the 4th `ctcpTarget` arg — NOT sent to the target as a DM (which
  // spawned the phantom window). No args → no trailing space inside the frame.
  it("/ctcp <target> <verb> echoes in the SOURCE window with ctcpTarget (#591/#640)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/ctcp bob version");
    const result = await compose.submit(k, "freenode", "#a");

    // source window "#a", frame, ctcpTarget "bob" — the recipient is NOT the
    // send channel anymore (that is the whole #640 fix).
    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "#a", "\x01VERSION\x01", "bob");
    expect(result).toEqual({ ok: true });
  });

  // #640 — ACTION is the exception: it IS conversation (/me to an explicit
  // target), so it rides the normal send path INTO the target window (3 args,
  // no ctcpTarget), exactly as before #640. The parser upper-cases the verb.
  it("/ctcp <target> ACTION <args> sends to the TARGET window as conversation (#591/#640)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/ctcp #chan action waves at Everyone");
    const result = await compose.submit(k, "freenode", "#a");

    // Target #chan, no 4th arg — an action belongs in the target's window.
    expect(sb.sendMessage).toHaveBeenCalledWith(
      "freenode",
      "#chan",
      "\x01ACTION waves at Everyone\x01",
    );
    expect(result).toEqual({ ok: true });
  });

  // #591 — /ping <target> sends a CTCP PING carrying a client timestamp token
  // to the target, and registers a pending correlation entry keyed on the
  // source window (where /ping was typed). Date.now is pinned so the token is
  // deterministic; the RTT math itself is unit-tested in pingCorrelation.test.
  it("/ping <target> sends CTCP PING with a timestamp token + registers pending (#591)", async () => {
    localStorage.setItem("grappa-token", "tok");
    vi.spyOn(Date, "now").mockReturnValue(1706743200000);
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const pc = await import("../lib/pingCorrelation");

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/ping bob");
    const result = await compose.submit(k, "freenode", "#a");

    // #640 — CTCP PING frame with the timestamp token, echoed in the SOURCE
    // window ("#a") with the wire recipient ("bob") in the 4th ctcpTarget arg —
    // never a DM to the target (no phantom window).
    expect(sb.sendMessage).toHaveBeenCalledWith(
      "freenode",
      "#a",
      "\x01PING 1706743200000\x01",
      "bob",
    );
    // Pending registered: (networkId, nick, token, sourceKey, sourceChannel, sentAtMs).
    expect(pc.registerPing).toHaveBeenCalledWith(1, "bob", "1706743200000", k, "#a", 1706743200000);
    expect(result).toEqual({ ok: true });

    vi.mocked(Date.now).mockRestore();
  });

  // #600 — the pending correlation MUST be registered BEFORE the send is
  // awaited. `sendPrivmsg` is a REST POST; on a slow/loaded runner its ack can
  // resolve AFTER the peer's CTCP PING reply has already been processed on the
  // (separate, already-open) WS. If registration waited on the send,
  // `maybeConsumePingReply → resolvePing` would find no pending entry and drop
  // the RTT line — the #600 CI timeout (deterministic on the slow CI runner,
  // invisible on a fast local box). Model the slow send with a deferred promise
  // and assert registerPing already fired while the send is still pending.
  it("/ping registers the pending BEFORE the send resolves — a fast reply can't lose it (#600)", async () => {
    localStorage.setItem("grappa-token", "tok");
    vi.spyOn(Date, "now").mockReturnValue(1706743200000);
    const sb = await import("../lib/scrollback");
    const pc = await import("../lib/pingCorrelation");

    // A send that stays pending until we release it — models a slow REST POST
    // while the CTCP reply already flows over the already-open WS.
    let releaseSend!: () => void;
    vi.mocked(sb.sendMessage).mockReturnValue(
      new Promise<void>((resolve) => {
        releaseSend = resolve;
      }),
    );

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/ping bob");
    const submitP = compose.submit(k, "freenode", "#a"); // do NOT await — send is pending

    // Flush microtasks so compose reaches (and blocks on) the send await.
    await Promise.resolve();
    await Promise.resolve();

    // THE RACE: with the send still unresolved, a reply arriving now MUST find a
    // registered pending entry. Pre-fix (register AFTER the await) this is 0 calls.
    // #640 — the send targets the SOURCE window ("#a") with ctcpTarget "bob".
    expect(sb.sendMessage).toHaveBeenCalledWith(
      "freenode",
      "#a",
      "\x01PING 1706743200000\x01",
      "bob",
    );
    expect(pc.registerPing).toHaveBeenCalledWith(1, "bob", "1706743200000", k, "#a", 1706743200000);

    releaseSend();
    await submitP;
    vi.mocked(Date.now).mockRestore();
  });

  // #127 — /info, /version, /motd resolve the network id from the slug and
  // push the bare verb; the reply renders in ServerReplyModal (server side).
  it("/info pushes INFO via pushInfo(networkId)", async () => {
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/info");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushInfo).toHaveBeenCalledWith(1);
    expect(result).toEqual({ ok: true });
  });

  it("/version pushes VERSION via pushVersion(networkId)", async () => {
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/version");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushVersion).toHaveBeenCalledWith(1);
    expect(result).toEqual({ ok: true });
  });

  it("/motd pushes MOTD via pushMotd(networkId, null)", async () => {
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/motd");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushMotd).toHaveBeenCalledWith(1, null);
    expect(result).toEqual({ ok: true });
  });

  // #374 — /motd <server> threads the target through pushMotd so grappa
  // emits `MOTD <target>` upstream instead of dropping the arg and
  // returning the current server's MOTD.
  it("/motd <server> pushes MOTD via pushMotd(networkId, target)", async () => {
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/motd void.azzurra.chat");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushMotd).toHaveBeenCalledWith(1, "void.azzurra.chat");
    expect(result).toEqual({ ok: true });
  });

  // #155 — bare /rehash ships the raw "REHASH" frame (full ircd.conf reload).
  it("/rehash pushes bare REHASH via pushRaw(networkId, 'REHASH')", async () => {
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/rehash");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushRaw).toHaveBeenCalledWith(1, "REHASH");
    expect(result).toEqual({ ok: true });
  });

  // #375 — /rehash <option> must forward the option on the wire (mirror of
  // /stats): pre-fix compose hardcoded a bare "REHASH", dropping the option
  // so bahamut ran the default full-config reload instead of REHASH MOTD.
  it("/rehash MOTD pushes REHASH MOTD via pushRaw", async () => {
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/rehash MOTD");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushRaw).toHaveBeenCalledWith(1, "REHASH MOTD");
    expect(result).toEqual({ ok: true });
  });

  // #557 — /kill <nick> <reason> composes `KILL <nick> :<reason>` and ships it
  // via pushRaw (mirror of /quote/rehash). The trailing colon is added HERE,
  // downstream — so a multi-word reason stays ONE param instead of truncating
  // at the first space (the `/quote KILL nick reason` foot-gun #557 fixes). A
  // regression in the ternary would ship green without this assertion.
  it("/kill <nick> <reason> pushes KILL nick :reason via pushRaw (downstream colon)", async () => {
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/kill spammer flooding the channel");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushRaw).toHaveBeenCalledWith(1, "KILL spammer :flooding the channel");
    expect(result).toEqual({ ok: true });
  });

  // #557 — bare /kill <nick> (no reason) ships EXACTLY `KILL <nick>`: the
  // empty-reason branch of the ternary must NOT leak a trailing `:` or a
  // stringified null into the frame.
  it("/kill <nick> bare pushes KILL nick (no trailing colon) via pushRaw", async () => {
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/kill spammer");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushRaw).toHaveBeenCalledWith(1, "KILL spammer");
    expect(result).toEqual({ ok: true });
  });

  // #290 — a BARE services command opens the dedicated services console
  // modal (pinned to the active window's network) AND fires `help` so the
  // service's multi-NOTICE help wall lands confined in the modal instead of
  // flooding the server window. A full command WITH args stays the inline
  // `msg` path (asserted in the bucket-G tests below) — no unsolicited popup.
  it.each([
    ["/ns", "NickServ"],
    ["/cs", "ChanServ"],
    ["/ms", "MemoServ"],
  ])("%s bare opens the services modal for %s and fires help (#290)", async (verb, service) => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const svc = await import("../lib/serviceModal");

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, verb);
    const result = await compose.submit(k, "freenode", "#a");

    expect(svc.openServiceModal).toHaveBeenCalledWith("freenode", service);
    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", service, "help");
    expect(result).toEqual({ ok: true });
  });

  // P-0d / #248 — /lusers marks the request solicited BEFORE pushing so
  // the incoming bundle surfaces the card. Without the mark, the store's
  // #248 gate drops the bundle (same path the connect-welcome auto-emit
  // takes) and the operator's explicit /lusers would show nothing.
  it("/lusers marks the request solicited then pushes LUSERS via pushLusers(networkId)", async () => {
    const socket = await import("../lib/socket");
    const lusersBundle = await import("../lib/lusersBundle");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/lusers");
    const result = await compose.submit(k, "freenode", "#a");

    expect(lusersBundle.markLusersRequested).toHaveBeenCalledWith("freenode");
    expect(socket.pushLusers).toHaveBeenCalledWith(1);
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

  // #723 — the residue has exactly ONE owner. `/msg` redirects the unsent
  // remainder to the query window it just focused, so the SOURCE window must
  // be emptied on the SAME path — pre-fix the `if ("error" in r) return r`
  // early-return skipped the shared end-of-submit clear and left the WHOLE
  // `/msg bob …` command sitting in the source composer, next to a residue
  // copy in the query window. Hitting Enter there re-delivered every line.
  it("#723 — a partial /msg leaves the residue ONLY in the query window; the source is emptied", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");
    const source = channelKey("freenode", "#a");
    const query = channelKey("freenode", "bob");

    // l1 delivered; l2 fails FATALLY (400 invalid_line) → l3 never attempted.
    let n = 0;
    vi.mocked(sb.sendMessage).mockImplementation(async () => {
      n += 1;
      if (n === 2) throw new api.ApiError(400, "invalid_line");
      return undefined as never;
    });

    compose.setDraft(source, "/msg bob l1\nl2\nl3");
    const result = await compose.submit(source, "freenode", "#a");

    expect(result).toHaveProperty("error");
    // The remainder lives with the operator's new focus…
    expect(compose.getDraft(query)).toBe("l2\nl3");
    // …and NOWHERE else. The full command must not survive for a resend.
    expect(compose.getDraft(source)).toBe("");
  });

  // #723 second leg — the query window's composer belongs to the OPERATOR.
  // `sendPacedBody` wrote the residue unconditionally, and the final residue
  // of a SUCCESSFUL send is "" — so `/msg bob hi` from #a silently erased a
  // half-typed message sitting in bob's box.
  it("#723 — a successful /msg does NOT clobber a half-typed draft in the query window", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    vi.mocked(sb.sendMessage).mockResolvedValue();
    const compose = await import("../lib/compose");
    const source = channelKey("freenode", "#a");
    const query = channelKey("freenode", "bob");

    compose.setDraft(query, "half typed reply");
    compose.setDraft(source, "/msg bob hi");
    const result = await compose.submit(source, "freenode", "#a");

    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "bob", "hi");
    expect(result).toEqual({ ok: true });
    expect(compose.getDraft(query)).toBe("half typed reply");
    expect(compose.getDraft(source)).toBe("");
  });

  // #723 — when the query window is BUSY the redirect is refused outright and
  // the source keeps ownership of the residue: the operator's text is never
  // destroyed, and the remainder still has exactly one home. It comes back
  // RE-ADDRESSED — a bare remainder in a CHANNEL composer would resend the
  // private message to the channel. The error copy must say where it went
  // (log-honesty) — "in the box" is a lie when the operator is now looking at
  // a different composer.
  it("#723 — a partial /msg into a busy query window keeps the residue in the source, re-addressed", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");
    const source = channelKey("freenode", "#a");
    const query = channelKey("freenode", "bob");

    let n = 0;
    vi.mocked(sb.sendMessage).mockImplementation(async () => {
      n += 1;
      if (n === 2) throw new api.ApiError(400, "invalid_line");
      return undefined as never;
    });

    compose.setDraft(query, "half typed reply");
    compose.setDraft(source, "/msg bob l1\nl2\nl3");
    const result = await compose.submit(source, "freenode", "#a");

    expect(compose.getDraft(query)).toBe("half typed reply");
    expect(compose.getDraft(source)).toBe("/msg bob l2\nl3");
    expect(result).toHaveProperty("error");
    expect((result as { error: string }).error).toContain("sent 1 of 3 lines");
    expect((result as { error: string }).error).not.toContain("in the box");

    // The whole point of the prefix: resending from the CHANNEL still reaches
    // bob. Bare "l2\nl3" here would have spilled a private message into #a.
    vi.mocked(sb.sendMessage).mockReset();
    vi.mocked(sb.sendMessage).mockResolvedValue();
    await compose.submit(source, "freenode", "#a");
    expect(vi.mocked(sb.sendMessage).mock.calls.map((c) => [c[1], c[2]])).toEqual([
      ["bob", "l2"],
      ["bob", "l3"],
    ]);
  });

  // #723 — a relocated remainder is announced even for a single-line body.
  // The "sent N of M lines" detail stays multi-line-only (#342's throttle copy
  // for a lone send), but "your text moved to another window" is news at any
  // length.
  it("#723 — a single-line /msg into a busy query window says where the text went", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");
    const source = channelKey("freenode", "#a");
    const query = channelKey("freenode", "bob");

    vi.mocked(sb.sendMessage).mockRejectedValue(new api.ApiError(400, "invalid_line"));

    compose.setDraft(query, "half typed reply");
    compose.setDraft(source, "/msg bob hi");
    const result = await compose.submit(source, "freenode", "#a");

    expect(compose.getDraft(query)).toBe("half typed reply");
    expect(compose.getDraft(source)).toBe("/msg bob hi");
    expect((result as { error: string }).error).toContain("the window you sent from");
    expect((result as { error: string }).error).not.toContain("lines");
  });

  // #723, same class — a services target opens NO query window, so the residue
  // always stays in the channel the operator typed it in. Bare, it resends the
  // credential to that channel. This is the leak that made the re-addressing
  // rule general rather than a patch on the /msg fallback.
  it("#723 — a partial /msg to a service keeps its /msg <service> (no channel spill)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");

    vi.mocked(sb.sendMessage).mockRejectedValue(new api.ApiError(400, "invalid_line"));

    compose.setDraft(k, "/msg nickserv IDENTIFY s3cret");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toHaveProperty("error");
    expect(compose.getDraft(k)).toBe("/msg nickserv IDENTIFY s3cret");

    // Resending goes to the service, never to #a.
    vi.mocked(sb.sendMessage).mockReset();
    vi.mocked(sb.sendMessage).mockResolvedValue();
    await compose.submit(k, "freenode", "#a");
    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "nickserv", "IDENTIFY s3cret");
  });

  // #723, worst of the class — a residue that is plain text INSIDE a paste
  // stops being plain text once it is alone in the box. "notes\n/quit" dying on
  // line 2 used to leave a bare `/quit`, and Enter parked every network and
  // logged the operator out. The `//` literal escape keeps it text.
  it("#723 — a residue starting with / is escaped so resending sends text, not a command", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");

    let n = 0;
    vi.mocked(sb.sendMessage).mockImplementation(async () => {
      n += 1;
      if (n === 2) throw new api.ApiError(400, "invalid_line");
      return undefined as never;
    });

    compose.setDraft(k, "notes\n/quit");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toHaveProperty("error");
    expect(compose.getDraft(k)).toBe("//quit");

    vi.mocked(sb.sendMessage).mockReset();
    vi.mocked(sb.sendMessage).mockResolvedValue();
    vi.mocked(api.patchNetwork).mockClear();
    await compose.submit(k, "freenode", "#a");

    // The line goes out as the literal text it was in the paste…
    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "#a", "/quit");
    // …and emphatically does NOT disconnect the operator: a dispatched /quit
    // parks every network through this endpoint.
    expect(api.patchNetwork).not.toHaveBeenCalled();
  });

  // #723 — the multi-line form of the same escape: only the FIRST character
  // needs it, because parseSlash decides once for the whole draft and the
  // per-line fan-out sends the rest verbatim.
  it("#723 — the / escape covers only the first char; later slash lines stay verbatim", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");

    let n = 0;
    vi.mocked(sb.sendMessage).mockImplementation(async () => {
      n += 1;
      if (n === 2) throw new api.ApiError(400, "invalid_line");
      return undefined as never;
    });

    compose.setDraft(k, "notes\n/part #a\n/nick bob");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toHaveProperty("error");
    expect(compose.getDraft(k)).toBe("//part #a\n/nick bob");

    vi.mocked(sb.sendMessage).mockReset();
    vi.mocked(sb.sendMessage).mockResolvedValue();
    await compose.submit(k, "freenode", "#a");

    expect(vi.mocked(sb.sendMessage).mock.calls.map((c) => c[2])).toEqual([
      "/part #a",
      "/nick bob",
    ]);
  });

  // #723, same class — an ACTION remainder left bare resends as plain text,
  // silently downgrading the message kind.
  it("#723 — a partial /me keeps its /me so the remainder resends as an ACTION", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");

    let n = 0;
    vi.mocked(sb.sendMessage).mockImplementation(async () => {
      n += 1;
      if (n === 2) throw new api.ApiError(400, "invalid_line");
      return undefined as never;
    });

    compose.setDraft(k, "/me waves\nthen bows");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toHaveProperty("error");
    expect(compose.getDraft(k)).toBe("/me then bows");

    vi.mocked(sb.sendMessage).mockReset();
    vi.mocked(sb.sendMessage).mockResolvedValue();
    await compose.submit(k, "freenode", "#a");
    expect(sb.sendMessage).toHaveBeenCalledWith("freenode", "#a", "\x01ACTION then bows\x01");
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

  // #510 — `/join #a,#b` forwards the RFC1459 comma-list unsplit to the
  // server (which splits it and opens a `:pending` window per channel,
  // #382). But focus must land on the FIRST channel, not the raw
  // "#a,#b" list: `setSelectedChannel({channelName: "#a,#b"})` focuses a
  // key no `window_states` entry matches → the empty phantom window the
  // issue reports. The POST body stays the unsplit list (server contract).
  it("/join #a,#b posts the unsplit list but focuses the FIRST channel (#510)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postJoin).mockResolvedValue();
    const sel = await import("../lib/selection");

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/join #a,#b");
    const result = await compose.submit(k, "freenode", "#a");

    // POST body stays the comma-list — the server splits it (#382).
    expect(api.postJoin).toHaveBeenCalledWith("tok", "freenode", "#a,#b", null);
    // Focus lands on the first channel, NEVER the phantom "#a,#b".
    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#a",
      kind: "channel",
    });
    expect(sel.setSelectedChannel).not.toHaveBeenCalledWith(
      expect.objectContaining({ channelName: "#a,#b" }),
    );
    expect(result).toEqual({ ok: true });
  });

  // #510/#525 — the focus key MUST match the server's canonical fold
  // (Identifier.canonical_channel: CASEMAPPING=ascii, A-Z only), else a
  // mixed-case first channel focuses a key that never matches the folded
  // window_state. Mirror it via `canonicalChannel` (cic's twin).
  // `#Foo[1]` → `#foo[1]` (case only; `[` is NOT folded post-#525).
  it("/join folds the FIRST channel's case for focus (ASCII, brackets kept) (#510/#525)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.postJoin).mockResolvedValue();
    const sel = await import("../lib/selection");

    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/join #Foo[1],#bar");
    await compose.submit(k, "freenode", "#a");

    // Server folds each element itself; the POST carries the raw list verbatim.
    expect(api.postJoin).toHaveBeenCalledWith("tok", "freenode", "#Foo[1],#bar", null);
    // Focus is the ASCII fold of the first channel (`F` → `f`; `[` stays),
    // matching the server-stored window key (#525: CASEMAPPING=ascii).
    expect(sel.setSelectedChannel).toHaveBeenCalledWith({
      networkSlug: "freenode",
      channelName: "#foo[1]",
      kind: "channel",
    });
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

// #904 — the composer buffer and the send machinery used to share one slot for
// a SINGLE send too: the draft stayed put for the whole in-flight window and
// the end-of-submit clear wiped whatever the operator had typed meanwhile.
// #737 only closed the multi-line drain half of that class. The fix is a send
// queue exactly ONE message deep, owned by the store and keyed on the WINDOW:
// the submission leaves the composer at DISPATCH, the operator types the next
// one, a second Enter queues it, and the third is refused where they can see
// it. Nothing is ever silently eaten.
describe("#904 — one-deep send queue", () => {
  const k = channelKey("freenode", "#a");

  // A send whose ack the test controls: the resolver is handed back so the
  // in-flight window is a real, observable state rather than a timing guess.
  const deferredSend = async () => {
    const sb = await import("../lib/scrollback");
    const acks: Array<{ body: string; resolve: () => void; reject: (e: unknown) => void }> = [];
    vi.mocked(sb.sendMessage).mockImplementation(
      (_slug: string, _target: string, body: string) =>
        new Promise<void>((resolve, reject) => {
          acks.push({ body, resolve, reject });
        }),
    );
    return acks;
  };

  it("#904 — the message leaves the composer at dispatch, not at the ack", async () => {
    localStorage.setItem("grappa-token", "tok");
    const acks = await deferredSend();
    const compose = await import("../lib/compose");

    compose.setDraft(k, "first");
    const done = compose.submit(k, "freenode", "#a");
    await Promise.resolve();

    // In flight: the composer is EMPTY and belongs to the operator again.
    expect(compose.isSending(k)).toBe(true);
    expect(compose.getDraft(k)).toBe("");
    expect(compose.isQueueFull(k)).toBe(false);

    acks[0]?.resolve();
    expect(await done).toEqual({ ok: true });
    expect(compose.isSending(k)).toBe(false);
  });

  it("#904 — what the operator types during a slow send survives the ack", async () => {
    localStorage.setItem("grappa-token", "tok");
    const acks = await deferredSend();
    const compose = await import("../lib/compose");

    compose.setDraft(k, "first");
    const done = compose.submit(k, "freenode", "#a");
    await Promise.resolve();

    // The defect: this used to be destroyed by the end-of-submit clear.
    compose.setDraft(k, "ok also bring the charger");
    acks[0]?.resolve();
    await done;

    expect(compose.getDraft(k)).toBe("ok also bring the charger");
  });

  it("#904 — a second Enter queues the next message and it goes out on the ack", async () => {
    localStorage.setItem("grappa-token", "tok");
    const acks = await deferredSend();
    const sb = await import("../lib/scrollback");
    const compose = await import("../lib/compose");

    compose.setDraft(k, "first");
    const done = compose.submit(k, "freenode", "#a");
    await Promise.resolve();

    compose.setDraft(k, "second");
    expect(await compose.submit(k, "freenode", "#a")).toEqual({ ok: true });
    // Queued, so it left the composer too — and nothing went out yet.
    expect(compose.getDraft(k)).toBe("");
    expect(compose.isQueueFull(k)).toBe(true);
    expect(vi.mocked(sb.sendMessage).mock.calls.length).toBe(1);

    acks[0]?.resolve();
    // The queued line is dispatched by the pump on the ack — wait for the
    // send it makes, don't guess a microtask count.
    await vi.waitFor(() => expect(acks.length).toBe(2));
    acks[1]?.resolve();
    await done;

    expect(vi.mocked(sb.sendMessage).mock.calls.map((c) => c[2])).toEqual(["first", "second"]);
    expect(compose.isSending(k)).toBe(false);
    expect(compose.isQueueFull(k)).toBe(false);
  });

  it("#904 — a THIRD submission is refused visibly, not eaten", async () => {
    localStorage.setItem("grappa-token", "tok");
    const acks = await deferredSend();
    const sb = await import("../lib/scrollback");
    const compose = await import("../lib/compose");

    compose.setDraft(k, "first");
    const done = compose.submit(k, "freenode", "#a");
    await Promise.resolve();
    compose.setDraft(k, "second");
    await compose.submit(k, "freenode", "#a");

    compose.setDraft(k, "third");
    const refused = await compose.submit(k, "freenode", "#a");

    expect(refused).toHaveProperty("error");
    // Refused means REFUSED: the text stays in the composer, unsent.
    expect(compose.getDraft(k)).toBe("third");
    expect(vi.mocked(sb.sendMessage).mock.calls.length).toBe(1);

    acks[0]?.resolve();
    await vi.waitFor(() => expect(acks.length).toBe(2));
    acks[1]?.resolve();
    await done;
    expect(vi.mocked(sb.sendMessage).mock.calls.map((c) => c[2])).toEqual(["first", "second"]);
  });

  it("#904 — a failed send hands the line back IN FRONT of what was typed meanwhile", async () => {
    localStorage.setItem("grappa-token", "tok");
    const acks = await deferredSend();
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");

    compose.setDraft(k, "first");
    const done = compose.submit(k, "freenode", "#a");
    await Promise.resolve();
    compose.setDraft(k, "typed later");

    acks[0]?.reject(new api.ApiError(400, "invalid_line"));
    expect(await done).toHaveProperty("error");

    // Both survive, in the order they were written.
    expect(compose.getDraft(k)).toBe("first\ntyped later");
  });

  it("#904 — a failed send hands the QUEUED line back too and never fires it", async () => {
    localStorage.setItem("grappa-token", "tok");
    const acks = await deferredSend();
    const sb = await import("../lib/scrollback");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");

    compose.setDraft(k, "first");
    const done = compose.submit(k, "freenode", "#a");
    await Promise.resolve();
    compose.setDraft(k, "second");
    await compose.submit(k, "freenode", "#a");

    acks[0]?.reject(new api.ApiError(400, "invalid_line"));
    expect(await done).toHaveProperty("error");

    // A dead link fires nothing further; both lines come back, in order.
    expect(vi.mocked(sb.sendMessage).mock.calls.length).toBe(1);
    expect(compose.getDraft(k)).toBe("first\nsecond");
    expect(compose.isQueueFull(k)).toBe(false);
    expect(compose.isSending(k)).toBe(false);
  });

  it("#904 — the queue is per WINDOW: a sibling composer is untouched", async () => {
    localStorage.setItem("grappa-token", "tok");
    const acks = await deferredSend();
    const compose = await import("../lib/compose");
    const other = channelKey("freenode", "#b");

    compose.setDraft(k, "first");
    const done = compose.submit(k, "freenode", "#a");
    await Promise.resolve();

    expect(compose.isSending(other)).toBe(false);
    compose.setDraft(other, "elsewhere");
    expect(compose.getDraft(other)).toBe("elsewhere");

    acks[0]?.resolve();
    await done;
    expect(compose.getDraft(other)).toBe("elsewhere");
  });

  // #904 × #666/#737 — the multi-line drain is the ONE submission that keeps
  // the buffer: it claims the window (readOnly) and mirrors its own, finer-
  // grained residue there. The pump must not hand the whole paste back on top
  // of that remainder.
  it("#904 — a failed multi-line drain leaves ONLY its residue, not the whole paste", async () => {
    localStorage.setItem("grappa-token", "tok");
    const sb = await import("../lib/scrollback");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");

    let n = 0;
    vi.mocked(sb.sendMessage).mockImplementation(async () => {
      n += 1;
      if (n === 2) throw new api.ApiError(400, "invalid_line");
      return undefined as never;
    });

    compose.setDraft(k, "a\nb\nc");
    expect(await compose.submit(k, "freenode", "#a")).toHaveProperty("error");
    expect(compose.getDraft(k)).toBe("b\nc");
  });

  // #904 — the pump took the text OUT of the composer, so it owes it back on
  // every exit, including the one nobody plans for. `dispatchDraft` catches
  // around its dispatch switch, but the parse ahead of it is outside that net:
  // a throw there used to leave the draft untouched and now would evaporate it,
  // which is the exact destruction this issue is about. It must come back, and
  // the throw must still surface — swallowing it would hide the next bug.
  it("#904 — a throw out of dispatch hands the text back instead of eating it", async () => {
    localStorage.setItem("grappa-token", "tok");
    vi.doMock("../lib/slashCommands", () => ({
      parseSlash: () => {
        throw new Error("parser exploded");
      },
    }));
    try {
      const compose = await import("../lib/compose");
      compose.setDraft(k, "precious text");
      await expect(compose.submit(k, "freenode", "#a")).rejects.toThrow("parser exploded");
      expect(compose.getDraft(k)).toBe("precious text");
      expect(compose.isSending(k)).toBe(false);
    } finally {
      vi.doUnmock("../lib/slashCommands");
      vi.resetModules();
    }
  });

  it("#904 — a queued line is recallable from history the moment it leaves the composer", async () => {
    localStorage.setItem("grappa-token", "tok");
    const acks = await deferredSend();
    const compose = await import("../lib/compose");

    compose.setDraft(k, "first");
    const done = compose.submit(k, "freenode", "#a");
    await Promise.resolve();

    // The composer is empty (the line left at dispatch) — so a recall that
    // returns the line proves history holds it BEFORE any ack. Pre-fix the
    // push happened on the 201 and this walked into an empty history.
    expect(compose.getDraft(k)).toBe("");
    compose.recallPrev(k);
    expect(compose.getDraft(k)).toBe("first");

    compose.setDraft(k, "");
    acks[0]?.resolve();
    await done;
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

  it("folds case (not the bracket range) on the prefix match (#525)", async () => {
    // #525 CASEMAPPING=ascii: `[` is NOT folded, so a member `Foo[1]` and
    // the typed `foo[` are the SAME nick (case-only) and completion
    // matches on the common `nick[away]` shape; a brace `foo{` would be a
    // DIFFERENT nick.
    await setMembers(["Foo[1]"]);
    const compose = await import("../lib/compose");
    const r = compose.tabComplete(k, "foo[", 4, true);
    expect(r?.newInput).toBe("Foo[1]: ");
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

// #30 — Tab on a token carrying a channel sigil draws from the channels
// JOINED on this window's network instead of the member list. Same cycle,
// same revert slot, same anchor; only the candidate set and the suffix
// differ (a channel is never addressed, so never a `": "`).
describe("compose tabComplete — channel names (#30)", () => {
  const k = channelKey("freenode", "#a");

  const setJoinedWindows = async (states: Record<string, string>) => {
    const ws = await import("../lib/windowState");
    vi.mocked(ws.windowStateByChannel).mockReturnValue(
      states as unknown as ReturnType<typeof ws.windowStateByChannel>,
    );
  };

  const setMembers = async (nicks: string[]) => {
    const members = await import("../lib/members");
    vi.mocked(members.membersByChannel).mockReturnValue({
      [k]: nicks.map((nick) => ({ nick, modes: [] })),
    });
  };

  it("completes a joined channel from its prefix", async () => {
    await setJoinedWindows({
      [channelKey("freenode", "#sniffo")]: "joined",
      [channelKey("freenode", "#other")]: "joined",
    });
    const compose = await import("../lib/compose");
    const r = compose.tabComplete(k, "#sni", 4, true);
    expect(r?.newInput).toBe("#sniffo ");
    expect(r?.newCursor).toBe(8);
  });

  it("never appends ': ' — a channel is not addressed like a nick", async () => {
    await setJoinedWindows({ [channelKey("freenode", "#sniffo")]: "joined" });
    const compose = await import("../lib/compose");
    // Line start: the nick path would produce "…: " here.
    expect(compose.tabComplete(k, "#sni", 4, true)?.newInput).toBe("#sniffo ");
  });

  it("offers only channels on THIS window's network", async () => {
    await setJoinedWindows({
      [channelKey("freenode", "#sniffo")]: "joined",
      [channelKey("azzurra", "#sniffonauti")]: "joined",
    });
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "#sni", 4, true)?.newInput).toBe("#sniffo ");
    const draft = compose.getDraft(k);
    // Only one candidate on freenode → next step is the revert slot, NOT
    // the same-prefix channel that lives on the other network.
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("#sni");
  });

  it("offers only JOINED windows — not pending/parked/failed/kicked", async () => {
    await setJoinedWindows({
      [channelKey("freenode", "#sniffo")]: "pending",
      [channelKey("freenode", "#sniper")]: "parked",
      [channelKey("freenode", "#snitch")]: "failed",
      [channelKey("freenode", "#snoop")]: "kicked",
    });
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "#sni", 4, true)).toBeNull();
  });

  it("folds case on the match and inserts the folded key (the channel display)", async () => {
    await setJoinedWindows({ [channelKey("freenode", "#Sniffo")]: "joined" });
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "#SNI", 4, true)?.newInput).toBe("#sniffo ");
  });

  it("cycles matches then reverts to the typed text, then wraps", async () => {
    await setJoinedWindows({
      [channelKey("freenode", "#sniffo")]: "joined",
      [channelKey("freenode", "#snitch")]: "joined",
    });
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "#sn", 3, true)?.newInput).toBe("#sniffo ");
    let draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("#snitch ");
    draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("#sn");
    draft = compose.getDraft(k);
    expect(compose.tabComplete(k, draft, draft.length, true)?.newInput).toBe("#sniffo ");
  });

  it("completes mid-sentence, leaving the rest of the line alone", async () => {
    await setJoinedWindows({ [channelKey("freenode", "#sniffo")]: "joined" });
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "vieni su #sni", 13, true)?.newInput).toBe("vieni su #sniffo ");
  });

  it("returns null when no joined channel matches the token", async () => {
    await setJoinedWindows({ [channelKey("freenode", "#other")]: "joined" });
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "#sni", 4, true)).toBeNull();
  });

  it("a sigil-less token still completes NICKS, not channels", async () => {
    await setJoinedWindows({ [channelKey("freenode", "#sniffo")]: "joined" });
    await setMembers(["sniper"]);
    const compose = await import("../lib/compose");
    expect(compose.tabComplete(k, "sni", 3, true)?.newInput).toBe("sniper: ");
  });

  it("works from a query window (channel candidates come from the network)", async () => {
    await setJoinedWindows({ [channelKey("freenode", "#sniffo")]: "joined" });
    const compose = await import("../lib/compose");
    const q = channelKey("freenode", "mezmerize");
    expect(compose.tabComplete(q, "#sni", 4, true)?.newInput).toBe("#sniffo ");
  });
});

// #268 — /away lifecycle: GOING-away clears this network's mentions bundle
// (moved off the reorder-prone away_confirmed:"away" echo); bare /away
// (un-away) does NOT clear (the return path re-SETs the bundle).
describe("compose submit — /away mentions-bundle clear (#268)", () => {
  it("/away <reason> pushes away-set AND clears this network's mentions bundle", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const mw = await import("../lib/mentionsWindow");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/away lunch break");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushAwaySet).toHaveBeenCalledWith("freenode", "lunch break");
    expect(mw.clearMentionsBundle).toHaveBeenCalledWith("freenode");
    expect(result).toEqual({ ok: true });
  });

  it("bare /away (un-away) pushes away-unset and does NOT clear the mentions bundle", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const mw = await import("../lib/mentionsWindow");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/away");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushAwayUnset).toHaveBeenCalledWith("freenode");
    expect(mw.clearMentionsBundle).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
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
      ident: null,
      realname: null,
      sasl_user: null,
      auth_method: "sasl",
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
      ident: null,
      realname: null,
      sasl_user: null,
      auth_method: "sasl",
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
        ident: null,
        realname: null,
        sasl_user: null,
        auth_method: "sasl",
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
      ident: null,
      realname: null,
      sasl_user: null,
      auth_method: "sasl",
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
      ident: null,
      realname: null,
      sasl_user: null,
      auth_method: "sasl",
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
      ident: null,
      realname: null,
      sasl_user: null,
      auth_method: "sasl",
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
      ident: null,
      realname: null,
      sasl_user: null,
      auth_method: "sasl",
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

  it("/banlist opens the ban modal and re-queries the ban list", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const banlistModal = await import("../lib/banlistModal");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/banlist");
    const result = await compose.submit(k, "freenode", "#a");

    // #386 — /banlist is now the modal surface (supersedes the inline card):
    // open it AND fire a fresh 367/368 re-query so the list is live on open.
    expect(banlistModal.openBanlistModal).toHaveBeenCalledWith("freenode", "#a");
    expect(socket.pushChannelBanlist).toHaveBeenCalledWith(1, "#a");
    expect(result).toEqual({ ok: true });
  });

  // #386 — /kb <nick> [reason]: ban FIRST (`*!*@host`, host from the on-demand
  // userhost lookup), THEN kick — two frames, attempt both (vjt decisions #1/#4).
  it("/kb <nick> resolves host → bans *!*@host then kicks (ban before kick)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    vi.mocked(socket.resolveUserhost).mockResolvedValue({ user: "ident", host: "evil.host.net" });
    vi.mocked(socket.pushChannelBan).mockResolvedValue(undefined);
    vi.mocked(socket.pushChannelKick).mockResolvedValue(undefined);
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/kb alice begone");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.resolveUserhost).toHaveBeenCalledWith(1, "alice");
    expect(socket.pushChannelBan).toHaveBeenCalledWith(1, "#a", "*!*@evil.host.net");
    expect(socket.pushChannelKick).toHaveBeenCalledWith(1, "#a", "alice", "begone");
    // Ban FIRST (no rejoin window): its call order precedes the kick's.
    const [banOrder] = vi.mocked(socket.pushChannelBan).mock.invocationCallOrder;
    const [kickOrder] = vi.mocked(socket.pushChannelKick).mock.invocationCallOrder;
    if (banOrder === undefined || kickOrder === undefined) {
      throw new Error("expected both ban and kick to have been called");
    }
    expect(banOrder).toBeLessThan(kickOrder);
    expect(result).toEqual({ ok: true });
  });

  it("/kb <nick> with unknown host → NO ban, still kicks, surfaces the ban error", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    // not_cached → resolveUserhost resolves null (fail-closed, no guess).
    vi.mocked(socket.resolveUserhost).mockResolvedValue(null);
    vi.mocked(socket.pushChannelKick).mockResolvedValue(undefined);
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/kb alice");
    const result = await compose.submit(k, "freenode", "#a");

    // Fail-closed: no wider-mask guess → ban NOT sent.
    expect(socket.pushChannelBan).not.toHaveBeenCalled();
    // But the person's still kicked (immediate intent), and the ban error surfaces.
    expect(socket.pushChannelKick).toHaveBeenCalledWith(1, "#a", "alice", "");
    expect(result).not.toEqual({ ok: true });
    if (result && "error" in result) {
      expect(result.error).toMatch(/host/i);
      expect(result.error).toMatch(/whois/i);
    } else {
      throw new Error("expected an error result");
    }
  });

  it("/kb missing nick → error, no ban, no kick", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/kb");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.resolveUserhost).not.toHaveBeenCalled();
    expect(socket.pushChannelBan).not.toHaveBeenCalled();
    expect(socket.pushChannelKick).not.toHaveBeenCalled();
    expect(result).not.toEqual({ ok: true });
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

  // #216 — no-mode-args forms open the modal instead of executing.
  it("/mode #chan (no modes) opens the modal, sends no mode event", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const modeModal = await import("../lib/modeModal");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/mode #sniffo");
    const result = await compose.submit(k, "freenode", "#a");

    expect(modeModal.openModeModal).toHaveBeenCalledWith("freenode", "#sniffo");
    expect(socket.pushChannelMode).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  it("bare /mode opens the modal for the current channel window", async () => {
    localStorage.setItem("grappa-token", "tok");
    const modeModal = await import("../lib/modeModal");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/mode");
    const result = await compose.submit(k, "freenode", "#a");

    // selectedChannel mock resolves to #a — the current channel window.
    expect(modeModal.openModeModal).toHaveBeenCalledWith("freenode", "#a");
    expect(result).toEqual({ ok: true });
  });

  it("/mode +s (bare modes) applies to the current channel, no modal", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const modeModal = await import("../lib/modeModal");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/mode +s");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelMode).toHaveBeenCalledWith(1, "#a", "+s", []);
    expect(modeModal.openModeModal).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  // #229 — bare /umode opens the umode viewer/editor modal for the active
  // window's network. No channel context required (umodes are per-session).
  it("bare /umode opens the umode modal for the network", async () => {
    localStorage.setItem("grappa-token", "tok");
    const umodeModal = await import("../lib/umodeModal");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/umode");
    const result = await compose.submit(k, "freenode", "#a");

    expect(umodeModal.openUmodeModal).toHaveBeenCalledWith("freenode");
    expect(socket.pushChannelUmode).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: true });
  });

  // #229 — /mode <ownnick> (no modes) opens the umode modal when the target
  // resolves to the operator's own nick.
  it("/mode <ownnick> opens the umode modal when target is the own nick", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const networks = await import("../lib/networks");
    const umodeModal = await import("../lib/umodeModal");
    const compose = await import("../lib/compose");
    // user() must resolve non-null and ownNickForNetwork must return the
    // target nick for the self-gate to open the modal. The user() mock is
    // typed `() => null`; the self-gate only needs a truthy value it hands
    // to the (mocked) ownNickForNetwork, so cast a minimal stub.
    vi.mocked(networks.user).mockReturnValue({ kind: "user", name: "vjt" } as never);
    vi.mocked(api.ownNickForNetwork).mockReturnValue("vjt-grappa");

    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/mode vjt-grappa");
    const result = await compose.submit(k, "freenode", "#a");

    expect(umodeModal.openUmodeModal).toHaveBeenCalledWith("freenode");
    expect(result).toEqual({ ok: true });
  });

  // #229 — /mode <othernick> (no modes) is a friendly error, NOT a modal —
  // there's no viewer for another user's umodes.
  it("/mode <othernick> errors (no other-user umode viewer)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const networks = await import("../lib/networks");
    const umodeModal = await import("../lib/umodeModal");
    const compose = await import("../lib/compose");
    vi.mocked(networks.user).mockReturnValue({ kind: "user", name: "vjt" } as never);
    vi.mocked(api.ownNickForNetwork).mockReturnValue("vjt-grappa");

    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/mode someone-else");
    const result = await compose.submit(k, "freenode", "#a");

    expect(umodeModal.openUmodeModal).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: expect.stringContaining("someone-else") });
  });

  // #229 — /mode <nick> <modes> still executes a user-MODE change, no modal.
  it("/mode <nick> <modes> executes directly (no umode modal)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const umodeModal = await import("../lib/umodeModal");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/mode vjt-grappa +i");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushChannelMode).toHaveBeenCalledWith(1, "vjt-grappa", "+i", []);
    expect(umodeModal.openUmodeModal).not.toHaveBeenCalled();
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

  // S21 (codebase review 2026-07-08) — /topic -delete was fire-and-forget:
  // `pushChannelTopicClear` returned void and compose painted { ok: true }
  // synchronously, so a WS-down / server {:error,_} was swallowed and the box
  // showed a false success. It must now `await` the #154 verb-ack Promise and
  // surface the failure inline, exactly like op/deop/kick/ban/mode.
  it("/topic -delete surfaces the error when the channel push fails (no false success)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const socket = await import("../lib/socket");
    const friendly = await import("../lib/friendlyChannelError");
    const compose = await import("../lib/compose");
    const err = new api.ChannelPushError("no_session");
    vi.mocked(socket.pushChannelTopicClear).mockRejectedValueOnce(err);
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/topic -delete");
    const result = await compose.submit(k, "freenode", "#a");

    // Failure surfaces as the friendly inline error — NOT a green ✓.
    expect(result).toEqual({ error: friendly.friendlyChannelError(err) });
    // Draft is preserved so the operator can retry without re-typing.
    expect(compose.getDraft(k)).toBe("/topic -delete");
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

// Codebase review 2026-07-19 S6 (#364) — no-silent-drop for the last
// fire-and-forget WS pushes. `/invite` (a WRITE verb whose server handler
// replies invalid_channel/invalid_nick/no_session/upstream_unavailable) and
// the read-query verbs (whois/whowas/who/names/lusers/info/version/motd)
// pushed `: void` and compose painted { ok: true } synchronously — so a
// server {:error,_} OR a WS-down dropped frame reported a false green ✓.
// The query verbs had the worse UX twist: their server-side validation reject
// (e.g. /whois <malformed> → invalid_nick) fires BEFORE the upstream write, so
// no bundle and no $server numeric ever arrive — the operator gets literally
// nothing. All nine now route through the #154(1) `pushUserChannelVerb`
// Promise and are AWAITED in compose, exactly like op/deop/kick/ban/mode and
// the S21 /topic -delete above. `dispatch_subject_verb/3` always replies
// `{:reply, :ok | {:error, %{error}}}` for every one, so awaiting never hangs.
// (banlist stays fire-and-forget by design — its errors surface via the
// 367/368 numerics; that rationale does not hold for these.)
describe("compose submit — S6 no-silent-drop: invite + query verbs surface rejections", () => {
  // Each case drives one verb through a REJECTED push and asserts the failure
  // surfaces inline as { error } — NOT a green ✓ — and the draft is preserved
  // for retry. `pick` selects the freshly-imported mock (resetModules per test
  // means a captured reference would be stale); `typeof import(...)` keeps it
  // type-safe with no string-indexed cast.
  const cases: Array<{
    verb: string;
    draft: string;
    pick: (s: typeof import("../lib/socket")) => (...args: never[]) => Promise<void>;
  }> = [
    { verb: "/invite", draft: "/invite alice", pick: (s) => s.pushChannelInvite },
    { verb: "/whois", draft: "/whois alice", pick: (s) => s.pushWhois },
    { verb: "/whowas", draft: "/whowas alice", pick: (s) => s.pushWhowas },
    { verb: "/who", draft: "/who #a", pick: (s) => s.pushWho },
    { verb: "/names", draft: "/names #a", pick: (s) => s.pushNames },
    { verb: "/lusers", draft: "/lusers", pick: (s) => s.pushLusers },
    { verb: "/info", draft: "/info", pick: (s) => s.pushInfo },
    { verb: "/version", draft: "/version", pick: (s) => s.pushVersion },
    { verb: "/motd", draft: "/motd", pick: (s) => s.pushMotd },
  ];

  it.each(cases)(
    "$verb surfaces the push rejection as { error } (no false success)",
    async ({ draft, pick }) => {
      localStorage.setItem("grappa-token", "tok");
      const api = await import("../lib/api");
      const socket = await import("../lib/socket");
      const friendly = await import("../lib/friendlyChannelError");
      const compose = await import("../lib/compose");

      const err = new api.ChannelPushError("no_session");
      vi.mocked(pick(socket)).mockRejectedValueOnce(err);

      const k = channelKey("freenode", "#a");
      compose.setDraft(k, draft);
      const result = await compose.submit(k, "freenode", "#a");

      // Failure surfaces as the friendly inline error — NOT { ok: true }.
      expect(result).toEqual({ error: friendly.friendlyChannelError(err) });
      // Draft preserved so the operator can retry without re-typing.
      expect(compose.getDraft(k)).toBe(draft);
    },
  );
});

describe("compose submit — info verbs (TODO stubs)", () => {
  // #169 — /who is no longer a stub. Push goes through to the server;
  // success returns {ok: true}. The 352 fold → 315 → typed who_reply event
  // → WhoModal (nothing to scrollback) is verified end-to-end by the
  // Playwright e2e + the Session.Server / EventRouter tests.
  it("/who #channel pushes to server", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/who #grappa");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toMatchObject({ ok: true });
  });

  // #122 — bare /who in a channel window defaults to the current channel
  // (context-default, shared with /names via requireChannel).
  it("/who bare in a channel window resolves to the current channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/who");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushWho).toHaveBeenCalledWith(1, "#a");
    expect(result).toEqual({ ok: true });
  });

  // #122 — bare /who outside a channel window (query/server/home) still
  // errors: there is no current channel to resolve.
  it("/who bare in a non-channel window returns inline error", async () => {
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
    compose.setDraft(k, "/who");
    const result = await compose.submit(k, "freenode", "bob");

    expect(socket.pushWho).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: expect.stringContaining("channel window") });
  });

  it("/names with target dispatches via pushNames", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/names #grappa");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toMatchObject({ ok: true });
  });

  // #122 — bare /names in a channel window defaults to the current
  // channel (context-default, shared with /who via requireChannel).
  it("/names bare in a channel window resolves to the current channel", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/names");
    const result = await compose.submit(k, "freenode", "#a");

    // #140 — pushNames(networkId, target); bare /names resolves to #a.
    expect(socket.pushNames).toHaveBeenCalledWith(1, "#a");
    expect(result).toEqual({ ok: true });
  });

  // #122 — bare /names outside a channel window still errors.
  it("/names bare in a non-channel window returns inline error", async () => {
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
    compose.setDraft(k, "/names");
    const result = await compose.submit(k, "freenode", "bob");

    expect(socket.pushNames).not.toHaveBeenCalled();
    expect(result).toMatchObject({ error: expect.stringContaining("channel window") });
  });

  // #122 — /whois context-default. /w is the alias (parser-level), the
  // null-nick resolution lives in the consumer via resolveBareWhoisNick.
  it("/whois bare in a query window resolves to the current query nick", async () => {
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
    compose.setDraft(k, "/whois");
    const result = await compose.submit(k, "freenode", "bob");

    expect(socket.pushWhois).toHaveBeenCalledWith(1, "bob", null);
    expect(result).toEqual({ ok: true });
  });

  // #132 — bare /whois (and /w alias) in a CHANNEL window self-whoises the
  // operator's own current nick on this network, resolved via
  // ownNickForNetwork(net, me). The default mock window is a channel.
  it("/whois bare in a channel window self-whoises the own nick (#132)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const nets = await import("../lib/networks");
    vi.mocked(api.ownNickForNetwork).mockReturnValue("mynick");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/whois");
    const result = await compose.submit(k, "freenode", "#a");

    // Resolver wiring: own nick comes from the ACTIVE network + current me
    // (ownNickForNetwork), not a re-implementation in compose.
    expect(api.ownNickForNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "freenode" }),
      nets.user(),
    );
    expect(socket.pushWhois).toHaveBeenCalledWith(1, "mynick", null);
    expect(result).toEqual({ ok: true });
  });

  // #132 — /w shares the whois resolver, so bare /w in a channel window
  // self-whoises identically.
  it("/w bare in a channel window self-whoises the own nick (#132)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    vi.mocked(api.ownNickForNetwork).mockReturnValue("mynick");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/w");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushWhois).toHaveBeenCalledWith(1, "mynick", null);
    expect(result).toEqual({ ok: true });
  });

  // #137 — bare /whois on a SERVER window self-whoises the operator's own
  // current nick on this network (extends #132: the self-whois path now
  // covers every network-scoped window, not just channels). The resolver
  // collapses to query → peer; every other network-scoped window → self.
  it("/whois bare in a server window self-whoises the own nick (#137)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const nets = await import("../lib/networks");
    const sel = await import("../lib/selection");
    vi.mocked(sel.selectedChannel).mockReturnValueOnce({
      networkSlug: "freenode",
      channelName: "$server",
      kind: "server",
    });
    vi.mocked(api.ownNickForNetwork).mockReturnValue("mynick");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "$server");
    compose.setDraft(k, "/whois");
    const result = await compose.submit(k, "freenode", "$server");

    // Own nick resolved from the ACTIVE network + current me, same wiring
    // as the channel case (#132) — not re-implemented in compose.
    expect(api.ownNickForNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "freenode" }),
      nets.user(),
    );
    expect(socket.pushWhois).toHaveBeenCalledWith(1, "mynick", null);
    expect(result).toEqual({ ok: true });
  });

  // #137 — /w shares the whois resolver, so bare /w on a server window
  // self-whoises identically.
  it("/w bare in a server window self-whoises the own nick (#137)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const sel = await import("../lib/selection");
    vi.mocked(sel.selectedChannel).mockReturnValueOnce({
      networkSlug: "freenode",
      channelName: "$server",
      kind: "server",
    });
    vi.mocked(api.ownNickForNetwork).mockReturnValue("mynick");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "$server");
    compose.setDraft(k, "/w");
    const result = await compose.submit(k, "freenode", "$server");

    expect(socket.pushWhois).toHaveBeenCalledWith(1, "mynick", null);
    expect(result).toEqual({ ok: true });
  });

  // #122 — /w <nick> alias dispatches via pushWhois with the explicit nick.
  it("/w <nick> dispatches via pushWhois", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/w alice");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushWhois).toHaveBeenCalledWith(1, "alice", null);
    expect(result).toEqual({ ok: true });
  });

  // #198 — /whois <server> <nick> threads the target server through to
  // pushWhois so the bouncer emits `WHOIS <server> <nick>` upstream.
  it("/whois <server> <nick> forwards the target server (#198)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/whois irc.example.org alice");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushWhois).toHaveBeenCalledWith(1, "alice", "irc.example.org");
    expect(result).toEqual({ ok: true });
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

  // #238 — /links dispatches via pushLinks(networkId, mask). Bare form sends a
  // null mask (grappa emits `LINKS`); a mask threads through (grappa emits
  // `LINKS <mask>`). The 364/365 burst drains into the links_bundle event that
  // opens LinksModal — no scrollback rows, so submit returns { ok: true }.
  it("/links pushes bare LINKS via pushLinks(networkId, null)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/links");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushLinks).toHaveBeenCalledWith(1, null);
    expect(result).toEqual({ ok: true });
  });

  it("/links <mask> threads the mask through pushLinks(networkId, mask)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/links *.irc.net");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushLinks).toHaveBeenCalledWith(1, "*.irc.net");
    expect(result).toEqual({ ok: true });
  });
});

// #356 — watch-family dispatch: keyword highlight (/hilight add, /dehilight
// del, /highlight alias) + presence (/notify, /watch alias) as classic-IRC
// irssi-direct verbs; a bare form opens the watch-lists settings section
// (kind open-settings → silent ok, draft still cleared). The green-notice
// RENDERING of the `ok: string` output is covered by ComposeBox.test.
describe("compose submit — watch-family verbs (#356)", () => {
  it("/hilight <pattern> calls pushWatchlistAdd and returns the highlight list inline", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/hilight myname");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushWatchlistAdd).toHaveBeenCalledWith("myname");
    expect(result).toMatchObject({ ok: expect.stringContaining("highlight") });
    expect(result).toMatchObject({ ok: expect.stringContaining("myname") });
  });

  it("/highlight <pattern> (alias) also calls pushWatchlistAdd", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/highlight myname");
    await compose.submit(k, "freenode", "#a");

    expect(socket.pushWatchlistAdd).toHaveBeenCalledWith("myname");
  });

  it("/hilight keeps a multi-word pattern intact (whole rest is one pattern)", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/hilight foo bar");
    await compose.submit(k, "freenode", "#a");

    expect(socket.pushWatchlistAdd).toHaveBeenCalledWith("foo bar");
  });

  it("/dehilight <pattern> calls pushWatchlistDel and returns the highlight list inline", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/dehilight myname");
    const result = await compose.submit(k, "freenode", "#a");

    expect(socket.pushWatchlistDel).toHaveBeenCalledWith("myname");
    expect(result).toMatchObject({ ok: expect.stringContaining("highlight") });
  });

  it("/notify <nick> calls postNotifyAdd and returns a green confirmation naming the nick", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/notify gigi");
    const result = await compose.submit(k, "freenode", "#a");

    expect(api.postNotifyAdd).toHaveBeenCalledWith("tok", "freenode", ["gigi"]);
    expect(result).toMatchObject({ ok: expect.stringContaining("gigi") });
  });

  it("/watch <nick> (presence alias, #356) also calls postNotifyAdd", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/watch gigi");
    await compose.submit(k, "freenode", "#a");

    expect(api.postNotifyAdd).toHaveBeenCalledWith("tok", "freenode", ["gigi"]);
  });

  it("bare /notify opens settings (silent ok) and does NOT hit the notify API", async () => {
    localStorage.setItem("grappa-token", "tok");
    const api = await import("../lib/api");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/notify");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toEqual({ ok: true });
    expect(api.postNotifyAdd).not.toHaveBeenCalled();
  });

  it("bare /hilight opens settings (silent ok) and does NOT hit the watchlist API", async () => {
    localStorage.setItem("grappa-token", "tok");
    const socket = await import("../lib/socket");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/hilight");
    const result = await compose.submit(k, "freenode", "#a");

    expect(result).toEqual({ ok: true });
    expect(socket.pushWatchlistAdd).not.toHaveBeenCalled();
  });

  // Draft must be cleared after a watch-family submit (add + the bare
  // open-settings path both take the post-try clear path).
  it("/hilight <pattern> clears the draft after submit", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/hilight myname");
    await compose.submit(k, "freenode", "#a");
    expect(compose.getDraft(k)).toBe("");
  });

  it("bare /notify clears the draft after submit", async () => {
    localStorage.setItem("grappa-token", "tok");
    const compose = await import("../lib/compose");
    const k = channelKey("freenode", "#a");
    compose.setDraft(k, "/notify");
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
