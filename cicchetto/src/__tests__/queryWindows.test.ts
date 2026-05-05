import { beforeEach, describe, expect, it, vi } from "vitest";

// C1.2: query window state + close semantics.
//
// Tests the queryWindows state module — created fresh in each test by
// resetting modules. The module exposes:
//   * queryWindowsByNetwork(): Record<number, QueryWindow[]>
//   * setQueryWindowsByNetwork(record): void
//   * closeQueryWindowState(networkId, targetNick): void
//     (client-side remove + server push)
//
// Server push goes via socket.pushCloseQueryWindow — mocked here.

vi.mock("../lib/socket", () => ({
  joinUser: vi.fn(() => ({ on: vi.fn(), push: vi.fn().mockReturnValue({ receive: vi.fn() }) })),
  joinChannel: vi.fn(() => ({
    join: vi.fn(() => ({ receive: vi.fn().mockReturnValue({ receive: vi.fn() }) })),
    on: vi.fn(),
  })),
  pushCloseQueryWindow: vi.fn(),
  pushOpenQueryWindow: vi.fn(),
  notifyClientClosing: vi.fn(),
  pushAwaySet: vi.fn(),
  pushAwayUnset: vi.fn(),
}));

vi.mock("../lib/auth", () => ({
  token: () => "tok",
  socketUserName: () => "alice",
  setToken: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe("queryWindows state", () => {
  it("initializes with empty record", async () => {
    const { queryWindowsByNetwork } = await import("../lib/queryWindows");
    expect(queryWindowsByNetwork()).toEqual({});
  });

  it("setQueryWindowsByNetwork replaces the full state", async () => {
    const { queryWindowsByNetwork, setQueryWindowsByNetwork } = await import("../lib/queryWindows");
    setQueryWindowsByNetwork({
      1: [{ targetNick: "alice", openedAt: "2026-05-04T10:00:00Z" }],
    });
    expect(queryWindowsByNetwork()[1]).toHaveLength(1);
    expect(queryWindowsByNetwork()[1]?.[0]?.targetNick).toBe("alice");
  });

  it("closeQueryWindowState removes the nick from client state", async () => {
    const { queryWindowsByNetwork, setQueryWindowsByNetwork, closeQueryWindowState } = await import(
      "../lib/queryWindows"
    );
    setQueryWindowsByNetwork({
      1: [
        { targetNick: "alice", openedAt: "2026-05-04T10:00:00Z" },
        { targetNick: "bob", openedAt: "2026-05-04T11:00:00Z" },
      ],
    });
    closeQueryWindowState(1, "alice");
    expect(queryWindowsByNetwork()[1]).toHaveLength(1);
    expect(queryWindowsByNetwork()[1]?.[0]?.targetNick).toBe("bob");
  });

  it("closeQueryWindowState is case-insensitive", async () => {
    const { queryWindowsByNetwork, setQueryWindowsByNetwork, closeQueryWindowState } = await import(
      "../lib/queryWindows"
    );
    setQueryWindowsByNetwork({
      1: [{ targetNick: "Alice", openedAt: "2026-05-04T10:00:00Z" }],
    });
    closeQueryWindowState(1, "alice");
    expect(queryWindowsByNetwork()[1]).toHaveLength(0);
  });

  it("closeQueryWindowState pushes close_query_window to socket", async () => {
    const socket = await import("../lib/socket");
    const { setQueryWindowsByNetwork, closeQueryWindowState } = await import("../lib/queryWindows");
    setQueryWindowsByNetwork({
      1: [{ targetNick: "bob", openedAt: "2026-05-04T10:00:00Z" }],
    });
    closeQueryWindowState(1, "bob");
    expect(socket.pushCloseQueryWindow).toHaveBeenCalledWith(1, "bob");
  });

  it("closeQueryWindowState on non-existent nick is a no-op (idempotent)", async () => {
    const socket = await import("../lib/socket");
    const { queryWindowsByNetwork, setQueryWindowsByNetwork, closeQueryWindowState } = await import(
      "../lib/queryWindows"
    );
    setQueryWindowsByNetwork({
      1: [{ targetNick: "alice", openedAt: "2026-05-04T10:00:00Z" }],
    });
    closeQueryWindowState(1, "nobody");
    expect(queryWindowsByNetwork()[1]).toHaveLength(1);
    // Socket is still called even for missing nick — server is idempotent
    expect(socket.pushCloseQueryWindow).toHaveBeenCalledWith(1, "nobody");
  });
});
