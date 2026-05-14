import { beforeEach, describe, expect, it, vi } from "vitest";

// C1.2/C1.4: query window state — close + open semantics.
//
// no-silent-drops B6.10 HIGH-10 — state is server-authoritative. The
// open/close verbs push to the server; the server broadcasts the
// updated `query_windows_list` and userTopic.ts's dispatcher writes
// it via setQueryWindowsByNetwork (full-replace). NO optimistic
// local mutation (cic NEVER originates state — mirrors CP17 :pending
// pattern).
//
// Tests the queryWindows state module — created fresh in each test by
// resetting modules. The module exposes:
//   * queryWindowsByNetwork(): Record<number, QueryWindow[]>
//   * setQueryWindowsByNetwork(record): void
//   * closeQueryWindowState(networkId, targetNick): void
//     (server push only — no local mutation)
//   * openQueryWindowState(networkId, targetNick, openedAt): void
//     (server push only, dedupes case-insensitively against current
//     server-authoritative state — no local mutation)
//
// Server push goes via socket.pushCloseQueryWindow / pushOpenQueryWindow
// — mocked here.

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

  // HIGH-10 — closeQueryWindowState does NOT mutate local state.
  // Server's broadcast is the only path that updates state.
  it("closeQueryWindowState pushes close_query_window without local mutation", async () => {
    const socket = await import("../lib/socket");
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
    // State unchanged — server broadcast hasn't landed yet.
    expect(queryWindowsByNetwork()[1]).toHaveLength(2);
    // Server push was made.
    expect(socket.pushCloseQueryWindow).toHaveBeenCalledWith(1, "alice");
  });

  it("closeQueryWindowState always pushes (server is idempotent)", async () => {
    const socket = await import("../lib/socket");
    const { setQueryWindowsByNetwork, closeQueryWindowState } = await import("../lib/queryWindows");
    setQueryWindowsByNetwork({
      1: [{ targetNick: "alice", openedAt: "2026-05-04T10:00:00Z" }],
    });
    closeQueryWindowState(1, "nobody");
    // Server is called even for a missing nick — server-side close is
    // idempotent and replies with the unchanged list.
    expect(socket.pushCloseQueryWindow).toHaveBeenCalledWith(1, "nobody");
  });

  // HIGH-10 — openQueryWindowState pushes without optimistic local
  // mutation; server broadcast populates state.

  it("openQueryWindowState pushes open_query_window without local mutation", async () => {
    const socket = await import("../lib/socket");
    const { queryWindowsByNetwork, openQueryWindowState } = await import("../lib/queryWindows");
    openQueryWindowState(1, "carol", "2026-05-04T12:00:00Z");
    // State unchanged — server broadcast hasn't landed yet.
    expect(queryWindowsByNetwork()[1]).toBeUndefined();
    // Server push was made.
    expect(socket.pushOpenQueryWindow).toHaveBeenCalledWith(1, "carol");
  });

  it("openQueryWindowState skips push when nick already open (case-insensitive dedup)", async () => {
    const socket = await import("../lib/socket");
    const { setQueryWindowsByNetwork, openQueryWindowState } = await import("../lib/queryWindows");
    setQueryWindowsByNetwork({
      1: [{ targetNick: "Carol", openedAt: "2026-05-04T10:00:00Z" }],
    });
    openQueryWindowState(1, "carol", "2026-05-04T12:00:00Z");
    // No spurious round-trip when state already shows the window open.
    // Server-side upsert would be a no-op anyway; skipping avoids a
    // redundant identical broadcast.
    expect(socket.pushOpenQueryWindow).not.toHaveBeenCalled();
  });

  it("openQueryWindowState pushes when nick not yet in server-authoritative state", async () => {
    const socket = await import("../lib/socket");
    const { openQueryWindowState } = await import("../lib/queryWindows");
    openQueryWindowState(1, "dave", "2026-05-04T13:00:00Z");
    expect(socket.pushOpenQueryWindow).toHaveBeenCalledWith(1, "dave");
  });
});
