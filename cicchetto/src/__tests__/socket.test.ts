import { beforeEach, describe, expect, it, vi } from "vitest";

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
  const mockChannel = {
    join: vi.fn(() => mockJoinPush),
    on: vi.fn(),
    leave: vi.fn(),
    push: vi.fn(),
  };
  const mockSocketInstance = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
    channel: vi.fn().mockReturnValue(mockChannel),
  };
  const socketCtor = vi.fn();
  return { mockChannel, mockJoinPush, mockSocketInstance, socketCtor };
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

  it("constructs Socket with /socket and a params callback returning the live token", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    await import("../lib/socket");
    expect(h.socketCtor).toHaveBeenCalledWith(
      "/socket",
      expect.objectContaining({ params: expect.any(Function) }),
    );
    const opts = h.socketCtor.mock.calls[0]?.[1] as { params: () => { token: string } };
    expect(opts.params()).toEqual({ token: "tok-1" });
  });

  it("disconnects when the token signal goes null", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const auth = await import("../lib/auth");
    await import("../lib/socket");
    h.mockSocketInstance.isConnected.mockReturnValue(true);
    auth.setToken(null);
    expect(h.mockSocketInstance.disconnect).toHaveBeenCalledTimes(1);
  });

  it("force-reconnects on token rotation between two non-null values", async () => {
    // phoenix.js evaluates the `params` callback only at handshake time,
    // so a live socket stays pinned to the original bearer. A rotation
    // (Phase 5 token-refresh, admin-driven re-issue) must drop and
    // reconnect to surface the new bearer on the next handshake.
    localStorage.setItem("grappa-token", "tok-A");
    const auth = await import("../lib/auth");
    await import("../lib/socket");
    expect(h.mockSocketInstance.connect).toHaveBeenCalledTimes(1);
    h.mockSocketInstance.isConnected.mockReturnValue(true);

    auth.setToken("tok-B");

    expect(h.mockSocketInstance.disconnect).toHaveBeenCalledTimes(1);
    expect(h.mockSocketInstance.connect).toHaveBeenCalledTimes(2);
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
    // The server can return `{:error, %{reason: "unknown topic" |
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

  it("constructs Socket with /socket and a params callback returning the live token", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    await import("../lib/socket");
    expect(h.socketCtor).toHaveBeenCalledWith(
      "/socket",
      expect.objectContaining({ params: expect.any(Function) }),
    );
    const opts = h.socketCtor.mock.calls[0]?.[1] as { params: () => { token: string } };
    expect(opts.params()).toEqual({ token: "tok-1" });
  });

  it("disconnects when the token signal goes null", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const auth = await import("../lib/auth");
    await import("../lib/socket");
    h.mockSocketInstance.isConnected.mockReturnValue(true);
    auth.setToken(null);
    expect(h.mockSocketInstance.disconnect).toHaveBeenCalledTimes(1);
  });

  it("force-reconnects on token rotation between two non-null values", async () => {
    // phoenix.js evaluates the `params` callback only at handshake time,
    // so a live socket stays pinned to the original bearer. A rotation
    // (Phase 5 token-refresh, admin-driven re-issue) must drop and
    // reconnect to surface the new bearer on the next handshake.
    localStorage.setItem("grappa-token", "tok-A");
    const auth = await import("../lib/auth");
    await import("../lib/socket");
    expect(h.mockSocketInstance.connect).toHaveBeenCalledTimes(1);
    h.mockSocketInstance.isConnected.mockReturnValue(true);

    auth.setToken("tok-B");

    expect(h.mockSocketInstance.disconnect).toHaveBeenCalledTimes(1);
    expect(h.mockSocketInstance.connect).toHaveBeenCalledTimes(2);
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
    // The server can return `{:error, %{reason: "unknown topic" |
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
