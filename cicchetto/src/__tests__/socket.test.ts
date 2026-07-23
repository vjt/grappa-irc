import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

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
    expect(h.socketCtor).toHaveBeenCalledWith(
      "ws://localhost:3000/socket",
      expect.objectContaining({ authToken: "tok-1" }),
    );
    const opts = h.socketCtor.mock.calls[0]?.[1] as {
      authToken: string;
      params?: unknown;
    };
    // authToken is the live token captured at construction (#95).
    expect(opts.authToken).toBe("tok-1");
    // No `params` — the token must not ride the URL query string.
    expect(opts.params).toBeUndefined();
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
      params?: unknown;
    };
    expect(opts2.authToken).toBe("tok-B");
    expect(opts2.params).toBeUndefined();
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
    socket.joinChannel("alice", "freenode", "#grappa");
    expect(h.mockSocketInstance.channel).toHaveBeenCalledWith(
      "grappa:user:alice/network:freenode/channel:#grappa",
    );
    expect(h.mockChannel.join).toHaveBeenCalledTimes(1);
  });

  it("joinChannel registers error + timeout handlers on the join Push (S48)", async () => {
    // The server can return `{:error, %{error: "unknown topic" |
    // "forbidden"}}` from `GrappaChannel.join/3`; without a `.receive`
    // hook these errors used to vanish into the void. Pin that the
    // production call chains both an "error" and a "timeout" hook so a
    // future refactor that drops one fails this test.
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinChannel("alice", "freenode", "#grappa");
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
    expect(h.mockChannel.push).toHaveBeenCalledWith("visibility", { visible: true });
  });

  it("reports {visible: false} when the document is hidden", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");
    h.mockChannel.push.mockClear();

    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    try {
      socket.reportVisibility();
      expect(h.mockChannel.push).toHaveBeenCalledWith("visibility", { visible: false });
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

    expect(h.mockChannel.push).toHaveBeenCalledWith("visibility", { visible: true });
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

    expect(h.mockChannel.push).toHaveBeenCalledWith("visibility", { visible: true });
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
    expect(h.mockChannel.push).toHaveBeenCalledWith("visibility", { visible: false });
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

    expect(h.mockChannel.push).toHaveBeenCalledWith("away", {
      action: "set",
      network: "libera",
      reason: "brb coffee",
    });
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

    expect(h.mockChannel.push).toHaveBeenCalledWith("away", {
      action: "unset",
      network: "libera",
    });
  });

  it("pushAwayUnset is rejected when no user channel joined", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    await expect(socket.pushAwayUnset("libera")).rejects.toThrow("not connected");
  });
});

// S21 (codebase review 2026-07-08) — /topic -delete was fire-and-forget:
// `pushChannelTopicClear` returned void with no `.receive` chain, so a
// server {:error,_} or a WS-down was swallowed. It now shares the
// `pushUserChannelVerb` Promise shape (resolve on "ok", reject with a typed
// ChannelPushError on "error", reject "not connected" when the socket is
// down) like every other state-changing verb (#154).
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

    expect(h.mockChannel.push).toHaveBeenCalledWith("topic_clear", {
      network_id: 7,
      channel: "#a",
    });
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
