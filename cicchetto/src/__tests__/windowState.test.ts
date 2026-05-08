import { beforeEach, describe, expect, it, vi } from "vitest";
import { channelKey } from "../lib/channelKey";

// CP15 B5: cic mirror of the server-side window state machine. The
// server splits state across three maps (window_states,
// window_failure_{reasons,numerics}, window_kicked_meta) so each
// concern is reactive on its own; cic's signal store mirrors that
// split. `:parted` is intentionally absent from the broadcast — its
// projection is "key removed from windowStateByChannel" (the archive
// section in Sidebar derives from `scrollback present + state absent`).
//
// Identity-rotation cleanup mirrors `members.ts` / `scrollback.ts`:
// on token rotation/logout, all three maps are emptied so a new
// bearer doesn't see the prior tenant's window states.

vi.mock("../lib/api", () => ({
  setOn401Handler: vi.fn(),
  // Pulled in transitively by selection.ts → scrollback.ts.
  listMessages: vi.fn().mockResolvedValue([]),
  displayNick: (u: { nick: string }) => u.nick,
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

describe("windowState.setJoined", () => {
  it("populates windowStateByChannel[key] = 'joined'", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    ws.setJoined(key);

    expect(ws.windowStateByChannel()[key]).toBe("joined");
  });

  it("clears any prior failure metadata for the same key", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    ws.setFailed(key, "Cannot join channel (+i)", 473);
    ws.setJoined(key);

    expect(ws.windowFailureByChannel()[key]).toBeUndefined();
  });

  it("clears any prior kicked metadata for the same key", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    ws.setKicked(key, "op", "behave");
    ws.setJoined(key);

    expect(ws.windowKickedMetaByChannel()[key]).toBeUndefined();
  });
});

describe("windowState.setFailed", () => {
  it("populates windowStateByChannel[key] = 'failed'", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#cic-test-pending");

    ws.setFailed(key, "Cannot join channel (+i)", 473);

    expect(ws.windowStateByChannel()[key]).toBe("failed");
  });

  it("populates windowFailureByChannel[key] with reason + numeric", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#cic-test-pending");

    ws.setFailed(key, "Cannot join channel (+i)", 473);

    expect(ws.windowFailureByChannel()[key]).toEqual({
      reason: "Cannot join channel (+i)",
      numeric: 473,
    });
  });

  it("accepts a null reason (upstream omitted the trailing param)", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#cic-test-pending");

    ws.setFailed(key, null, 471);

    expect(ws.windowFailureByChannel()[key]).toEqual({ reason: null, numeric: 471 });
  });
});

describe("windowState.setKicked", () => {
  it("populates windowStateByChannel[key] = 'kicked'", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    ws.setKicked(key, "op", "behave");

    expect(ws.windowStateByChannel()[key]).toBe("kicked");
  });

  it("populates windowKickedMetaByChannel[key] with by + reason", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    ws.setKicked(key, "op", "behave");

    expect(ws.windowKickedMetaByChannel()[key]).toEqual({ by: "op", reason: "behave" });
  });

  it("accepts null by + reason (upstream omitted both)", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    ws.setKicked(key, null, null);

    expect(ws.windowKickedMetaByChannel()[key]).toEqual({ by: null, reason: null });
  });
});

describe("windowState.setParted (absence is the projection)", () => {
  it("removes the entry from windowStateByChannel", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    ws.setJoined(key);
    ws.setParted(key);

    expect(ws.windowStateByChannel()[key]).toBeUndefined();
  });

  it("clears failure metadata too (re-join + re-fail gets a fresh reason)", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    ws.setFailed(key, "Cannot join channel (+i)", 473);
    ws.setParted(key);

    expect(ws.windowFailureByChannel()[key]).toBeUndefined();
  });

  it("clears kicked metadata too", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    ws.setKicked(key, "op", "behave");
    ws.setParted(key);

    expect(ws.windowKickedMetaByChannel()[key]).toBeUndefined();
  });

  it("is idempotent — parting an unknown key is a no-op", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#never-joined");

    ws.setParted(key);

    expect(ws.windowStateByChannel()[key]).toBeUndefined();
  });
});

describe("windowState.setPending (operator clicked JOIN — optimistic visual feedback)", () => {
  it("populates windowStateByChannel[key] = 'pending'", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#new-channel");

    ws.setPending(key);

    expect(ws.windowStateByChannel()[key]).toBe("pending");
  });
});

describe("windowState.windowIsJoined (primitive predicate)", () => {
  it("returns true for a key in joined state", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    ws.setJoined(key);

    expect(ws.windowIsJoined(key)).toBe(true);
  });

  it("returns false for a key in pending state", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#cic-test-pending");

    ws.setPending(key);

    expect(ws.windowIsJoined(key)).toBe(false);
  });

  it("returns false for a key in failed state", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#cic-test-failed");

    ws.setFailed(key, "Cannot join channel (+i)", 473);

    expect(ws.windowIsJoined(key)).toBe(false);
  });

  it("returns false for a key in kicked state", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#cic-test-kicked");

    ws.setKicked(key, "op", "behave");

    expect(ws.windowIsJoined(key)).toBe(false);
  });

  it("returns false for a key absent from windowStateByChannel (parted/never-joined/server/DM)", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#never-joined");

    expect(ws.windowIsJoined(key)).toBe(false);
  });
});

describe("windowState.isActiveChannelJoined (composed: kind=channel AND joined)", () => {
  it("returns true when active selection is a joined channel", async () => {
    const ws = await import("../lib/windowState");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#grappa");

    ws.setJoined(key);
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#grappa",
      kind: "channel",
    });

    expect(ws.isActiveChannelJoined()).toBe(true);
  });

  it("returns false when active selection is a channel in pending state", async () => {
    const ws = await import("../lib/windowState");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#cic-test-pending");

    ws.setPending(key);
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#cic-test-pending",
      kind: "channel",
    });

    expect(ws.isActiveChannelJoined()).toBe(false);
  });

  it("returns false when active selection is a channel in failed state", async () => {
    const ws = await import("../lib/windowState");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#cic-test-failed");

    ws.setFailed(key, "Cannot join channel (+i)", 473);
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#cic-test-failed",
      kind: "channel",
    });

    expect(ws.isActiveChannelJoined()).toBe(false);
  });

  it("returns false when active selection is a channel in kicked state", async () => {
    const ws = await import("../lib/windowState");
    const selection = await import("../lib/selection");
    const key = channelKey("freenode", "#cic-test-kicked");

    ws.setKicked(key, "op", "behave");
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "#cic-test-kicked",
      kind: "channel",
    });

    expect(ws.isActiveChannelJoined()).toBe(false);
  });

  it("returns false when active selection is a query (DM) — no member list possible", async () => {
    const ws = await import("../lib/windowState");
    const selection = await import("../lib/selection");
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: "alice",
      kind: "query",
    });

    expect(ws.isActiveChannelJoined()).toBe(false);
  });

  it("returns false when active selection is the server window", async () => {
    const ws = await import("../lib/windowState");
    const selection = await import("../lib/selection");
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: ":server",
      kind: "server",
    });

    expect(ws.isActiveChannelJoined()).toBe(false);
  });

  it("returns false when active selection is the mentions window", async () => {
    const ws = await import("../lib/windowState");
    const selection = await import("../lib/selection");
    selection.setSelectedChannel({
      networkSlug: "freenode",
      channelName: ":mentions",
      kind: "mentions",
    });

    expect(ws.isActiveChannelJoined()).toBe(false);
  });

  it("returns false when no channel is selected", async () => {
    const ws = await import("../lib/windowState");
    const selection = await import("../lib/selection");
    selection.setSelectedChannel(null);

    expect(ws.isActiveChannelJoined()).toBe(false);
  });
});

describe("windowState identity rotation (token change)", () => {
  it("clears all three maps when the bearer rotates", async () => {
    localStorage.setItem("grappa-token", "tokA");
    const auth = await import("../lib/auth");
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    ws.setFailed(key, "Cannot join channel (+i)", 473);
    ws.setKicked(channelKey("freenode", "#other"), "op", "bye");
    ws.setJoined(channelKey("freenode", "#third"));

    auth.setToken("tokB");
    // Solid runs the on(token) cleanup in the next microtask flush.
    await Promise.resolve();

    expect(ws.windowStateByChannel()).toEqual({});
    expect(ws.windowFailureByChannel()).toEqual({});
    expect(ws.windowKickedMetaByChannel()).toEqual({});
  });

  it("does NOT clear on initial bearer set (cold-start login)", async () => {
    const auth = await import("../lib/auth");
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    auth.setToken("tokA");
    await Promise.resolve();
    ws.setJoined(key);

    // No prior bearer existed — no clear should fire.
    expect(ws.windowStateByChannel()[key]).toBe("joined");
  });
});
