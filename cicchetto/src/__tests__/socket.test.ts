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
  const mockChannel = {
    join: vi.fn(),
    on: vi.fn(),
    leave: vi.fn(),
  };
  const mockSocketInstance = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn().mockReturnValue(false),
    channel: vi.fn().mockReturnValue(mockChannel),
  };
  const socketCtor = vi.fn();
  return { mockChannel, mockSocketInstance, socketCtor };
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

  it("joinChannel builds the topic-vocabulary string and calls channel.join()", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinChannel("alice", "freenode", "#grappa");
    expect(h.mockSocketInstance.channel).toHaveBeenCalledWith(
      "grappa:user:alice/network:freenode/channel:#grappa",
    );
    expect(h.mockChannel.join).toHaveBeenCalledTimes(1);
  });

  it("joinNetwork builds the per-(user, network) topic", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinNetwork("alice", "freenode");
    expect(h.mockSocketInstance.channel).toHaveBeenCalledWith("grappa:user:alice/network:freenode");
  });

  it("joinUser builds the per-user topic", async () => {
    localStorage.setItem("grappa-token", "tok-1");
    const socket = await import("../lib/socket");
    socket.joinUser("alice");
    expect(h.mockSocketInstance.channel).toHaveBeenCalledWith("grappa:user:alice");
  });
});
