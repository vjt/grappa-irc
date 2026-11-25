import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import { REPLY_DEADLINE_MS } from "../lib/transportFailure";

// `phoenix.Socket` is a class with private fields — vi.fn().mockImplementation
// doesn't expose a constructor that JS engine accepts under `new`, so we mock
// the export with a real class that delegates to a hoisted vi.fn() spy. The
// spy carries the constructor-args assertions; the instance methods are
// hoisted vi.fn()s on a singleton object the class returns from its
// constructor (returning an object from a constructor overrides `this`).
//
// `vi.hoisted` is mandatory: vi.mock is hoisted to the top of the file
// (before non-mock declarations), so anything the factory closes over
// must also be hoisted to be initialized in time.

const h = vi.hoisted(() => {
  // phoenix.js's `Channel.join()` returns a Push; `.receive(...)`
  // returns the same Push for chaining. The mock mirrors this so the
  // production code's `.join().receive("error", ...).receive(...)`
  // chain (S48) doesn't crash inside the test.
  const mockJoinPush = { receive: vi.fn() };
  mockJoinPush.receive.mockReturnValue(mockJoinPush);
  // `push` also returns a Push — mirrored for pushAwaySet/Unset chaining.
  const mockPush = { receive: vi.fn() };
  mockPush.receive.mockReturnValue(mockPush);
  const mockChannel = {
    join: vi.fn(() => mockJoinPush),
    on: vi.fn(),
    leave: vi.fn(),
    push: vi.fn(() => mockPush),
  };
  const mockSocketInstance = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
    channel: vi.fn().mockReturnValue(mockChannel),
    onOpen: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
  };
  const socketCtor = vi.fn();
  return { mockChannel, mockJoinPush, mockPush, mockSocketInstance, socketCtor };
});

vi.mock("phoenix", () => {
  class MockSocket {
    constructor(endpoint: string, opts: object) {
      h.socketCtor(endpoint, opts);
      Object.assign(this, h.mockSocketInstance);
    }
  }
  return { Socket: MockSocket };
});

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  h.mockSocketInstance.isConnected.mockReturnValue(false);
  h.mockSocketInstance.channel.mockReturnValue(h.mockChannel);
  h.mockChannel.push.mockReset();
  h.mockChannel.push.mockReturnValue(h.mockPush);
  h.mockPush.receive.mockReset();
  h.mockPush.receive.mockReturnValue(h.mockPush);
});

// #1061 defect 1, cold-start half — a boot that BEGINS offline gets no
// `offline` event (it already fired, or never fired at all), so
// `haltForOffline` cannot save it and the guard has to live on the connect
// path itself. `vi.resetModules()` in beforeEach re-evaluates connectivity.ts
// too, so stubbing `navigator.onLine` before the dynamic import is a faithful
// cold start rather than a signal poked after the fact.
describe("cold start while the device is offline (#1061)", () => {
  function stubOnLine(value: boolean): void {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => value,
    });
  }

  afterEach(() => {
    stubOnLine(true);
  });

  it("does not connect on module load when the device is already offline", async () => {
    stubOnLine(false);
    localStorage.setItem("grappa-token", "tok-offline-boot");
    await import("../lib/socket");
    // The Socket is still CONSTRUCTED (the token effect builds it so the
    // `online` handler has an instance to kick) — it is just never dialled.
    expect(h.socketCtor).toHaveBeenCalledTimes(1);
    expect(h.mockSocketInstance.connect).not.toHaveBeenCalled();
  });

  // The event-driven half of the scenario (foreground while offline, then
  // `online`) does NOT live here: socket.ts registers its window/document
  // listeners at module scope with anonymous handlers, so every
  // `vi.resetModules()` import in this file leaves a live listener behind that
  // no test can detach. One dispatch then fires N handlers from N module
  // instances and the count means nothing. That scenario needs exactly one
  // module instance per jsdom window, which is a whole FILE —
  // `socketOffline.test.ts`.
});

describe("socket singleton", () => {
  it("connects on module load when token is non-null", async () => {
    localStorage.setItem("grappa-token", "tok-init");
    await import("../lib/socket");
    expect(h.mockSocketInstance.connect).toHaveBeenCalledTimes(1);
  });

  it("does not construct or connect when no token at module load", async () => {
    await import("../lib/socket");
    expect(h.socketCtor).not.toHaveBeenCalled();
    expect(h.mockSocketInstance.connect).not.toHaveBeenCalled();
  });

  it("constructs Socket with an absolute /socket endpoint and the authToken subprotocol (no token in the URL)", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    await import("../lib/socket");
    // jsdom serves the test doc from http://localhost:3000/, so the
    // endpoint is the ws:// absolute form (see socketEndpoint #193 tests).
    // #95: authToken carries the bearer via the Sec-WebSocket-Protocol
    // subprotocol; the token is deliberately NOT passed via `params`
    // (phoenix appends params to the URL query — that would re-leak it).
    // #1379: the endpoint stays a bare origin+path. Anything that belongs in
    // the query rides `params`, because phoenix concatenates `/websocket`
    // onto this string before appending params — see socketEndpointUrl.test.ts.
    expect(h.socketCtor).toHaveBeenCalledWith(
      "ws://localhost:3000/socket",
      expect.objectContaining({ authToken: "tok-1" }),
    );
    const opts = h.socketCtor.mock.calls[0]?.[1] as {
      authToken: string;
      params?: Record<string, unknown>;
    };
    // authToken is the live token captured at construction (#95).
    expect(opts.authToken).toBe("tok-1");
    // The token must not ride the URL query string. `params` is no longer
    // empty (#1379 puts the public protocol version there), so the invariant
    // is about the BEARER specifically, not about params being absent.
    expect(Object.values(opts.params ?? {})).not.toContain("tok-1");
  });

  it("disconnects when the token signal goes null", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const auth = await import("../lib/auth");
    await import("../lib/socket");
    h.mockSocketInstance.isConnected.mockReturnValue(true);
    auth.setToken(null);
    expect(h.mockSocketInstance.disconnect).toHaveBeenCalledTimes(1);
  });

  it("rebuilds the Socket on token rotation so the fresh authToken subprotocol is captured", async () => {
    // #95: the bearer rides `authToken`, which phoenix captures ONCE at
    // construction (unlike the `params` callback). A plain
    // disconnect+reconnect on the same instance would replay the STALE
    // ctor-time token, so a rotation (Phase 5 refresh / admin re-issue)
    // must REBUILD the socket. Assert a second construction whose
    // authToken is the rotated bearer.
    localStorage.setItem("grappa-token", "tok-A");
    const auth = await import("../lib/auth");
    await import("../lib/socket");
    expect(h.socketCtor).toHaveBeenCalledTimes(1);
    expect(h.mockSocketInstance.connect).toHaveBeenCalledTimes(1);
    h.mockSocketInstance.isConnected.mockReturnValue(true);

    auth.setToken("tok-B");

    // Old instance dropped, fresh instance built + connected.
    expect(h.mockSocketInstance.disconnect).toHaveBeenCalledTimes(1);
    expect(h.socketCtor).toHaveBeenCalledTimes(2);
    expect(h.mockSocketInstance.connect).toHaveBeenCalledTimes(2);
    // The rebuilt socket's authToken is the rotated bearer (the whole
    // point — the subprotocol must carry the new token).
    const opts2 = h.socketCtor.mock.calls[1]?.[1] as { authToken: string };
    expect(opts2.authToken).toBe("tok-B");
  });

  it("logout+login constructs a fresh Socket instance (2026-05-27)", async () => {
    // Pre-fix logout only called disconnect() on the existing Socket
    // and left `_socket` non-null. The next login's `getSocket()`
    // returned the disconnected instance and `connect()` on it did
    // NOT re-evaluate the params callback in a way the next handshake
    // observed — the WS never came back up after a visitor
    // logout+relogin. Symptom: BEAM log shows POST /auth/login + the
    // REST burst, but no `CONNECTED TO GrappaWeb.UserSocket` and no
    // `JOINED grappa:user:...` for the new visitor id, so
    // members_seeded / window_state / topic_changed broadcasts have
    // no subscriber and the MembersPane never populates.
    localStorage.setItem("grappa-token", "tok-A");
    const auth = await import("../lib/auth");
    await import("../lib/socket");
    expect(h.socketCtor).toHaveBeenCalledTimes(1);

    h.mockSocketInstance.isConnected.mockReturnValue(true);
    auth.setToken(null);
    h.mockSocketInstance.isConnected.mockReturnValue(false);

    auth.setToken("tok-B");

    // Two Socket instances: one for tok-A, fresh one for tok-B.
    expect(h.socketCtor).toHaveBeenCalledTimes(2);
    // The second construction carries tok-B on the authToken subprotocol
    // (#95) — and no token in the URL (no `params`).
    const opts2 = h.socketCtor.mock.calls[1]?.[1] as {
      authToken: string;
      params?: Record<string, unknown>;
    };
    expect(opts2.authToken).toBe("tok-B");
    expect(Object.values(opts2.params ?? {})).not.toContain("tok-B");
  });

  // #364 bucket B — the phoenix Socket auto-reconnect backoff loop keeps a
  // live `reconnectTimer` firing `connect()` while the WS is DOWN (post-BEAM
  // restart, network blip, or a handshake that never completed). In that
  // window `isConnected()` is FALSE. Pre-fix, both the logout and rotation
  // arms gated `disconnect()` on `isConnected()`, so a mid-backoff socket was
  // never disconnected — the code just nulled `_socket`, ORPHANING an instance
  // whose reconnectTimer kept re-firing `connect()` with the STALE ctor-time
  // `authToken` (a zombie reconnect loop under the old bearer, unstoppable
  // because the reference was dropped). `disconnect()` is the only call that
  // resets phoenix's reconnectTimer (haltForOffline/kickReconnect already rely
  // on this) and it is safe to call on a non-open socket, so it MUST run
  // unconditionally before the reference is dropped.
  it("logout disconnects a mid-backoff (not-connected) socket to kill the zombie reconnect loop (#364)", async () => {
    localStorage.setItem("grappa-token", "tok-A");
    const auth = await import("../lib/auth");
    await import("../lib/socket");
    expect(h.socketCtor).toHaveBeenCalledTimes(1);
    // Socket is mid-backoff: connect() was scheduled but the handshake never
    // completed, so isConnected() stays false (the beforeEach default).
    expect(h.mockSocketInstance.isConnected()).toBe(false);

    auth.setToken(null);

    // Even though the socket is not connected, disconnect() MUST fire so
    // phoenix's reconnectTimer is reset and the stale-bearer instance can't
    // keep reconnecting after the reference is dropped.
    expect(h.mockSocketInstance.disconnect).toHaveBeenCalledTimes(1);
  });

  it("rotation disconnects a mid-backoff (not-connected) socket before rebuilding it (#364)", async () => {
    localStorage.setItem("grappa-token", "tok-A");
    const auth = await import("../lib/auth");
    await import("../lib/socket");
    expect(h.socketCtor).toHaveBeenCalledTimes(1);
    // Mid-backoff: isConnected() is false (beforeEach default) — no completed
    // handshake on the tok-A instance.
    expect(h.mockSocketInstance.isConnected()).toBe(false);

    auth.setToken("tok-B");

    // The old (not-connected) instance MUST be disconnected before the rebuild
    // so its reconnectTimer stops replaying the stale tok-A authToken.
    expect(h.mockSocketInstance.disconnect).toHaveBeenCalledTimes(1);
    expect(h.socketCtor).toHaveBeenCalledTimes(2);
    const opts2 = h.socketCtor.mock.calls[1]?.[1] as { authToken: string };
    expect(opts2.authToken).toBe("tok-B");
  });

  it("joinChannel builds the topic-vocabulary string and calls channel.join()", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinChannel("alice", "freenode", "#grappa", undefined, {});
    expect(h.mockSocketInstance.channel).toHaveBeenCalledWith(
      "grappa:user:alice/network:freenode/channel:#grappa",
      {},
    );
    expect(h.mockChannel.join).toHaveBeenCalledTimes(1);
  });

  // #1769 — the join params reach phoenix.js verbatim. The server reads the
  // param ONCE, in `GrappaChannel.join/3`, so a params object that never made
  // it onto the channel would fail silently: the socket would keep receiving
  // the full presence flood and nothing client-side would notice.
  it("joinChannel passes the presence param through to socket.channel()", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinChannel("alice", "freenode", "#grappa", undefined, { presence: false });
    expect(h.mockSocketInstance.channel).toHaveBeenCalledWith(
      "grappa:user:alice/network:freenode/channel:#grappa",
      { presence: false },
    );
  });

  it("joinChannel registers error + timeout handlers on the join Push (S48)", async () => {
    // The server can return `{:error, %{error: "unknown topic" |
    // "forbidden"}}` from `GrappaChannel.join/3`; without a `.receive`
    // hook these errors used to vanish into the void. Pin that the
    // production call chains both an "error" and a "timeout" hook so a
    // future refactor that drops one fails this test.
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinChannel("alice", "freenode", "#grappa", undefined, {});
    const eventNames = h.mockJoinPush.receive.mock.calls.map((c) => c[0]);
    expect(eventNames).toContain("error");
    expect(eventNames).toContain("timeout");
  });
});

// #193 — the WS reconnect went out over ws:// on an https PWA, hit the
// :80 vhost's `301 https://…`, and the handshake (which doesn't follow
// redirects) failed → client stuck on the splash after a BEAM restart.
// The durable fix: OUR code pins the scheme from the page origin, so the
// endpoint is always an absolute wss:// on https (never phoenix's
// derivation, never a stale-SW-pinned ws://).
describe("socketEndpoint (#193 — force wss on https origin)", () => {
  it("returns a wss:// absolute endpoint on an https origin", async () => {
    const { socketEndpoint } = await import("../lib/socket");
    expect(socketEndpoint({ protocol: "https:", host: "irc.sniffo.org" })).toBe(
      "wss://irc.sniffo.org/socket",
    );
  });

  it("returns wss:// even with a non-default https port (host carries the port)", async () => {
    const { socketEndpoint } = await import("../lib/socket");
    expect(socketEndpoint({ protocol: "https:", host: "irc.sniffo.org:8443" })).toBe(
      "wss://irc.sniffo.org:8443/socket",
    );
  });

  it("returns ws:// only on a genuinely plaintext http origin (dev/LAN)", async () => {
    const { socketEndpoint } = await import("../lib/socket");
    expect(socketEndpoint({ protocol: "http:", host: "localhost:5173" })).toBe(
      "ws://localhost:5173/socket",
    );
  });

  it("reads the ambient location when no arg is given (jsdom → http://localhost:3000)", async () => {
    const { socketEndpoint } = await import("../lib/socket");
    // jsdom serves the doc from http://localhost:3000/ by default.
    expect(socketEndpoint()).toBe("ws://localhost:3000/socket");
  });
});

// #1379 — cic declares the protocol version it speaks so the server's 426
// refusal can fire against it. Before this, a grep for `client_proto` over all
// of `cicchetto/` returned one prose comment: the socket connected with no
// declaration and was treated as CURRENT however stale the bundle was.
//
// These assertions are about the DECLARATION, deliberately separate from the
// #193 scheme tests above: those pin whole URLs, so they redden for either
// reason and cannot say which. Each one below fails for exactly one edit.
//
// The declaration rides the Socket's `params`, NOT the endpoint string, so
// what this file can witness is the constructor ARGUMENT — its phoenix mock
// stops there by construction. That the argument survives phoenix's own
// composition onto a dialable URL is a different claim needing the real
// class, and it lives in `socketEndpointUrl.test.ts`.
describe("cic declares the client protocol version to the socket (#1379)", () => {
  it("hands the version to the Socket as a param, where phoenix appends it post-transport", async () => {
    localStorage.setItem("grappa-token", "tok-proto");
    const { CLIENT_PROTOCOL_VERSION } = await import("../lib/socket");
    const opts = h.socketCtor.mock.calls[0]?.[1] as { params?: Record<string, unknown> };
    expect(opts.params?.client_proto).toBe(CLIENT_PROTOCOL_VERSION);
  });

  it("keeps the endpoint string free of a query, which phoenix would mis-join", async () => {
    // Not a style rule: the constructor concatenates `/websocket` onto this
    // string, so a `?` here silently moves the transport into a param value
    // and the dialled path stops being one the server routes.
    const { socketEndpoint } = await import("../lib/socket");
    expect(socketEndpoint({ protocol: "https:", host: "irc.sniffo.org" })).not.toContain("?");
  });

  it("declares an integer at or above the server floor of 1", async () => {
    // The floor itself is `Grappa.Protocol.min_version/0` and is pinned
    // against this constant server-side (`test/grappa/protocol_test.exs`) —
    // this side only guarantees the value is a usable protocol number, so a
    // typo'd `0`, `NaN` or `1.5` cannot reach the wire.
    const { CLIENT_PROTOCOL_VERSION } = await import("../lib/socket");
    expect(Number.isInteger(CLIENT_PROTOCOL_VERSION)).toBe(true);
    expect(CLIENT_PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
  });

  it("keeps the no-DOM relative endpoint a bare path too (no ambient location)", async () => {
    // The `!l` fallback is a second return and must obey the same no-query
    // rule as the absolute one. Reaching that branch needs `location`
    // genuinely absent, which jsdom never is — hence the stub, taken AFTER
    // the import so module scope still evaluates against the real one.
    const { socketEndpoint } = await import("../lib/socket");
    vi.stubGlobal("location", undefined);
    try {
      expect(socketEndpoint()).toBe("/socket");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// #1379 — the user-topic join reply carries the server's `protocol_version`
// and cic dropped it on the floor. What this suite covers is the HANDOVER:
// joinUser reads the number and hands it to `serverProtocol.ts`, which owns
// the floor and the comparison (`serverProtocol.test.ts`).
//
// This comment used to call the number "a diagnostic, not a gate", because
// "a difference is legal under the additive-only rule". #1393d withdrew that
// on 2026-08-21: a server BEHIND cic's floor now raises a banner, not a
// console line. Only the server-AHEAD direction is still nothing to gate on.
// The `console.warn` covers both because a bundle/BEAM skew on a
// service-worker-cached PWA is invisible from every other signal.
describe("joinUser consumes the join reply's protocol_version (#1379)", () => {
  async function joinAndReply(reply: unknown): Promise<MockInstance> {
    localStorage.setItem("grappa-token", "tok-proto-reply");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");
    const okCb = h.mockJoinPush.receive.mock.calls.find(([ev]) => ev === "ok")?.[1] as (
      r: unknown,
    ) => void;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    okCb(reply);
    return warn;
  }

  it("warns when the server speaks a different protocol than this bundle", async () => {
    const warn = await joinAndReply({ protocol_version: 99 });
    try {
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("99");
    } finally {
      warn.mockRestore();
    }
  });

  // #1393d — the join reply is where the floor gets its evidence, and this
  // is the seam that carries it there. Until this slice `noteServerProtocol`
  // read the number and threw it away after a `console.warn`; the comment
  // above it said a difference was "not actionable", and it was right while
  // cic invented every field it did not receive. It no longer does, so the
  // number has to reach `serverProtocol.ts`.
  it("feeds the reply's protocol_version to the client-side floor", async () => {
    const sp = await import("../lib/serverProtocol");
    sp.__resetServerProtocolForTests();
    const warn = await joinAndReply({ protocol_version: 1 });
    try {
      expect(sp.serverProtocol()).toBe(1);
      expect(sp.shouldShowServerOutdatedBanner()).toBe(true);
    } finally {
      warn.mockRestore();
      sp.__resetServerProtocolForTests();
    }
  });

  // …and a reply with no number leaves the floor UNSET rather than at zero.
  // "Unknown" and "ancient" are different states and only one of them is
  // something cic observed.
  it("leaves the floor unset when the reply carries no protocol_version", async () => {
    const sp = await import("../lib/serverProtocol");
    sp.__resetServerProtocolForTests();
    const warn = await joinAndReply({});
    try {
      expect(sp.serverProtocol()).toBeNull();
      expect(sp.shouldShowServerOutdatedBanner()).toBe(false);
    } finally {
      warn.mockRestore();
      sp.__resetServerProtocolForTests();
    }
  });

  it("stays silent when the server speaks the same protocol — the normal case", async () => {
    const { CLIENT_PROTOCOL_VERSION } = await import("../lib/socket");
    const warn = await joinAndReply({ protocol_version: CLIENT_PROTOCOL_VERSION });
    try {
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("stays silent when the reply omits protocol_version (unknown-is-never-fatal)", async () => {
    // A server too old to publish the field, or any future reply shape that
    // drops it, must not produce a mismatch warning naming `undefined`.
    const warn = await joinAndReply({});
    try {
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("warns once per bundle load, not once per phoenix auto-rejoin", async () => {
    // joinUser's "ok" hook re-fires on every reconnect; a PWA reconnects on
    // every network blip, so an un-latched warn is a console flood.
    const warn = await joinAndReply({ protocol_version: 99 });
    try {
      const okCb = h.mockJoinPush.receive.mock.calls.find(([ev]) => ev === "ok")?.[1] as (
        r: unknown,
      ) => void;
      okCb({ protocol_version: 99 });
      okCb({ protocol_version: 99 });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("still runs the caller's onJoinOk — the check must not swallow the reply", async () => {
    localStorage.setItem("grappa-token", "tok-proto-passthrough");
    const socket = await import("../lib/socket");
    const onJoinOk = vi.fn();
    socket.joinUser("alice", onJoinOk);
    const okCb = h.mockJoinPush.receive.mock.calls.find(([ev]) => ev === "ok")?.[1] as (
      r: unknown,
    ) => void;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      okCb({ protocol_version: 99 });
      expect(onJoinOk).toHaveBeenCalledWith({ protocol_version: 99 });
    } finally {
      warn.mockRestore();
    }
  });
});

describe("notifyClientClosing (S3.3 — pagehide immediate-away hint)", () => {
  it("is a no-op when no user channel has been joined yet", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    // No joinUser call — _userChannel is null
    socket.notifyClientClosing();
    expect(h.mockChannel.push).not.toHaveBeenCalled();
  });

  it("pushes client_closing on the user channel after joinUser", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");
    socket.notifyClientClosing();
    expect(h.mockChannel.push).toHaveBeenCalledWith("client_closing", {});
  });

  it("pagehide event triggers notifyClientClosing via window listener", async () => {
    // Simulate the main.tsx wiring: if pagehide fires after joinUser,
    // the push should reach the channel. This test exercises the event
    // listener integration without importing main.tsx (which has side
    // effects like Router render). We register the listener directly.
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    const { notifyClientClosing } = socket;

    socket.joinUser("alice");
    window.addEventListener("pagehide", notifyClientClosing);
    window.dispatchEvent(new Event("pagehide"));
    window.removeEventListener("pagehide", notifyClientClosing);

    expect(h.mockChannel.push).toHaveBeenCalledWith("client_closing", {});
  });
});

describe("reportVisibility (#182 — foreground push-suppression signal)", () => {
  // #192 — reportVisibility now folds document.hasFocus() into the reported
  // signal (presence = visible AND focused). These #182 cases assert the
  // focused+visible state, so pin hasFocus() true here. Without it the suite
  // is order-dependent: another test file leaving the shared jsdom document
  // blurred flips hasFocus() and breaks the {visible:true} assertions.
  let hasFocusSpy: MockInstance<() => boolean>;
  beforeEach(() => {
    hasFocusSpy = vi.spyOn(document, "hasFocus").mockReturnValue(true);
  });
  afterEach(() => {
    hasFocusSpy.mockRestore();
  });

  it("is a no-op when no user channel has been joined yet", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    // No joinUser call — _userChannel is null
    socket.reportVisibility();
    expect(h.mockChannel.push).not.toHaveBeenCalled();
  });

  it("pushes visibility with the current document.visibilityState after joinUser", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");
    // joinUser fires an initial reportVisibility only when the join "ok"
    // callback runs (server round-trip); the mock does not auto-invoke it,
    // so a direct call is the deterministic unit under test.
    h.mockChannel.push.mockClear();

    socket.reportVisibility();

    // jsdom defaults document.visibilityState to "visible".
    expect(h.mockChannel.push).toHaveBeenCalledWith(
      "visibility",
      { visible: true },
      REPLY_DEADLINE_MS,
    );
  });

  it("reports {visible: false} when the document is hidden", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");
    h.mockChannel.push.mockClear();

    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      socket.reportVisibility();
      expect(h.mockChannel.push).toHaveBeenCalledWith(
        "visibility",
        { visible: false },
        REPLY_DEADLINE_MS,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("joinUser's join-ok callback fires the initial visibility report", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");

    // Find and invoke the "ok" hook the join registered — this is what
    // phoenix calls on (re)join, and it must report the initial visibility.
    const okCb = h.mockJoinPush.receive.mock.calls.find(([ev]) => ev === "ok")?.[1] as (
      reply: unknown,
    ) => void;
    expect(okCb).toBeTypeOf("function");
    okCb({});

    expect(h.mockChannel.push).toHaveBeenCalledWith(
      "visibility",
      { visible: true },
      REPLY_DEADLINE_MS,
    );
  });

  it("visibilitychange event triggers reportVisibility via document listener", async () => {
    // Mirrors the main.tsx wiring without importing main.tsx.
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    const { reportVisibility } = socket;

    socket.joinUser("alice");
    h.mockChannel.push.mockClear();

    document.addEventListener("visibilitychange", reportVisibility);
    document.dispatchEvent(new Event("visibilitychange"));
    document.removeEventListener("visibilitychange", reportVisibility);

    expect(h.mockChannel.push).toHaveBeenCalledWith(
      "visibility",
      { visible: true },
      REPLY_DEADLINE_MS,
    );
  });

  it("reports {visible: false} when on-screen but the window is unfocused (#192)", async () => {
    // #192 regression: a desktop tab left on-screen (visibilityState stays
    // "visible") but no longer holding keyboard focus — user clicked another
    // app without minimizing/switching tabs — must be reported as NOT present.
    // reportVisibility folds document.hasFocus() into the signal (mirroring
    // documentVisibility.ts), so visibility-alone is no longer sufficient.
    // Without this, #182's per-user any_visible? gate keeps suppressing Web
    // Push on EVERY device (a backgrounded phone included).
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");
    h.mockChannel.push.mockClear();

    // visibilityState stays "visible" (jsdom default) — only focus is lost.
    hasFocusSpy.mockReturnValue(false);
    socket.reportVisibility();
    expect(h.mockChannel.push).toHaveBeenCalledWith(
      "visibility",
      { visible: false },
      REPLY_DEADLINE_MS,
    );
  });
});

describe("pushAwaySet / pushAwayUnset (S3.4 — /away channel push)", () => {
  it("pushAwaySet is a no-op (rejected) when no user channel joined", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    // No joinUser — _userChannel is null
    await expect(socket.pushAwaySet("libera", "brb")).rejects.toThrow("not connected");
  });

  it("pushAwaySet pushes away set payload on the user channel", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");

    // Simulate server "ok" reply: find the "ok" receive callback and call it
    const promise = socket.pushAwaySet("libera", "brb coffee");
    const okCb = h.mockPush.receive.mock.calls.find(([ev]) => ev === "ok")?.[1] as () => void;
    okCb();
    await promise;

    expect(h.mockChannel.push).toHaveBeenCalledWith(
      "away",
      {
        action: "set",
        network: "libera",
        reason: "brb coffee",
      },
      REPLY_DEADLINE_MS,
    );
  });

  it("pushAwaySet rejects on server error reply", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");

    const promise = socket.pushAwaySet("libera", "brb");
    const errCb = h.mockPush.receive.mock.calls.find(([ev]) => ev === "error")?.[1] as (
      e: unknown,
    ) => void;
    errCb({ error: "no_session" });
    await expect(promise).rejects.toThrow();
  });

  it("pushAwayUnset pushes away unset payload on the user channel", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");

    const promise = socket.pushAwayUnset("libera");
    const okCb = h.mockPush.receive.mock.calls.find(([ev]) => ev === "ok")?.[1] as () => void;
    okCb();
    await promise;

    expect(h.mockChannel.push).toHaveBeenCalledWith(
      "away",
      {
        action: "unset",
        network: "libera",
      },
      REPLY_DEADLINE_MS,
    );
  });

  it("pushAwayUnset is rejected when no user channel joined", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    await expect(socket.pushAwayUnset("libera")).rejects.toThrow("not connected");
  });
});

// #579 — /lusers [<mask> [<server>]]. The two RFC 2812 §3.4.2 args were
// dropped client-side, so the routed two-token form could not be issued at
// all. These assert the WIRE PAYLOAD, not that a function was called: a null
// arg must OMIT its key (pushMotd/pushLinks' shape — grappa's
// `validate_lusers_args/2` clauses match on absent, and a bare LUSERS is what
// the bare form must still produce), a present one must carry its value.
describe("pushLusers (#579 — mask + target server on the wire)", () => {
  const okReply = (): void => {
    const okCb = h.mockPush.receive.mock.calls.find(([ev]) => ev === "ok")?.[1] as () => void;
    okCb();
  };

  it("bare /lusers sends network_id only — no mask, no server key", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");

    const promise = socket.pushLusers(7, null, null);
    okReply();
    await promise;

    expect(h.mockChannel.push).toHaveBeenCalledWith("lusers", { network_id: 7 }, REPLY_DEADLINE_MS);
  });

  it("/lusers <mask> carries the mask and still omits server", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");

    const promise = socket.pushLusers(7, "*.azzurra.org", null);
    okReply();
    await promise;

    expect(h.mockChannel.push).toHaveBeenCalledWith(
      "lusers",
      {
        network_id: 7,
        mask: "*.azzurra.org",
      },
      REPLY_DEADLINE_MS,
    );
  });

  it("/lusers <mask> <server> carries both", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");

    const promise = socket.pushLusers(7, "*.azzurra.org", "void.azzurra.chat");
    okReply();
    await promise;

    expect(h.mockChannel.push).toHaveBeenCalledWith(
      "lusers",
      {
        network_id: 7,
        mask: "*.azzurra.org",
        server: "void.azzurra.chat",
      },
      REPLY_DEADLINE_MS,
    );
  });
});

// S21 (codebase review 2026-07-08) — /topic -delete was fire-and-forget:
// `pushChannelTopicClear` returned void with no `.receive` chain, so a
// server {:error,_} or a WS-down was swallowed. It now shares the
// `pushWithReply` Promise shape (resolve on "ok", reject with a typed
// ChannelPushError on "error", NotConnected with no user channel, NoReply at
// the deadline — issue 2738) like every other state-changing verb (#154).
describe("pushChannelTopicClear (S21 — /topic -delete verb ack)", () => {
  it("rejects 'not connected' when no user channel joined", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    await expect(socket.pushChannelTopicClear(1, "#a")).rejects.toThrow("not connected");
  });

  it("pushes the topic_clear payload and resolves on the server 'ok' reply", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");

    const promise = socket.pushChannelTopicClear(7, "#a");
    const okCb = h.mockPush.receive.mock.calls.find(([ev]) => ev === "ok")?.[1] as () => void;
    okCb();
    await promise;

    expect(h.mockChannel.push).toHaveBeenCalledWith(
      "topic_clear",
      {
        network_id: 7,
        channel: "#a",
      },
      REPLY_DEADLINE_MS,
    );
  });

  it("rejects on the server 'error' reply (no silent swallow)", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");

    const promise = socket.pushChannelTopicClear(7, "#a");
    const errCb = h.mockPush.receive.mock.calls.find(([ev]) => ev === "error")?.[1] as (
      e: unknown,
    ) => void;
    errCb({ error: "no_session" });
    await expect(promise).rejects.toThrow();
  });
});
