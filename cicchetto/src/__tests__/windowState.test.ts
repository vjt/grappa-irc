import { beforeEach, describe, expect, it, vi } from "vitest";
import { type ChannelKey, channelKey } from "../lib/channelKey";

// `vi.resetModules()` per test means every `await import` yields a FRESH
// module instance, so the transition table below has to receive the same
// instance the assertion reads — hence passing `ws` in rather than closing
// over one.
type WindowStateModule = typeof import("../lib/windowState");

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

vi.mock(import("../lib/api"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    setOn401Handler: vi.fn(),
    // Pulled in transitively by selection.ts → scrollback.ts.
    listMessages: vi.fn().mockResolvedValue([]),
    // UX-4 bucket D — selection.ts also imports `networks` from
    // `lib/networks` to drive the parked-network → home redirect.
    // networks.ts's createResource chain fires `me()` + `listNetworks()`
    // when the token changes (this suite sets tokA/tokB). Mock the
    // minimum-but-valid envelope so the resource resolves silently;
    // pass-through `tagNetwork` and other helpers via `actual`.
    me: vi.fn().mockResolvedValue({
      kind: "user",
      id: "u-test",
      name: "alice",
      is_admin: false,
      inserted_at: "2026-01-01T00:00:00Z",
      read_cursors: {},
    }),
    listNetworks: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([]),
  };
});

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

describe("windowState.setInvited", () => {
  it("populates windowStateByChannel[key] = 'invited' (#78)", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#invited-room");

    ws.setInvited(key, "alice");

    expect(ws.windowStateByChannel()[key]).toBe("invited");
  });

  it("does not touch failure / kicked metadata (an invite carries neither)", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#invited-room");

    ws.setInvited(key, "alice");

    expect(ws.windowFailureByChannel()[key]).toBeUndefined();
    expect(ws.windowKickedMetaByChannel()[key]).toBeUndefined();
  });

  // #902 — the inviter is window metadata now. The banner that replaced the
  // greyed tab renders it, and it arrives on the `window_invited` event
  // rather than being read out of the channel's scrollback (which the banner
  // never waits for).
  it("records the inviter (#902)", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#invited-room");

    ws.setInvited(key, "alice");

    expect(ws.invitedByChannel()[key]).toBe("alice");
  });

  // Mirrors the server-side invariant asserted in `WindowStateTest`: the key
  // exists IF AND ONLY IF the state is "invited". Without the drops, a stale
  // nick outlives the invite it belonged to and the map becomes a parallel
  // structure that has to be reconciled by hand.
  it.each([
    ["setPending", (ws: WindowStateModule, key: ChannelKey) => ws.setPending(key)],
    ["setJoined", (ws: WindowStateModule, key: ChannelKey) => ws.setJoined(key)],
    ["setFailed", (ws: WindowStateModule, key: ChannelKey) => ws.setFailed(key, "nope", 473)],
    ["setKicked", (ws: WindowStateModule, key: ChannelKey) => ws.setKicked(key, "op", "bye")],
    ["forceParted", (ws: WindowStateModule, key: ChannelKey) => ws.forceParted(key)],
  ])("%s clears the recorded inviter (#902)", async (_name, transition) => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#invited-room");

    ws.setInvited(key, "alice");
    transition(ws, key);

    expect(ws.invitedByChannel()[key]).toBeUndefined();
  });
});

describe("windowState.invitedWindows (#902)", () => {
  it("projects every invited key as (network, channel, inviter)", async () => {
    const ws = await import("../lib/windowState");

    ws.setInvited(channelKey("freenode", "#one"), "alice");
    ws.setInvited(channelKey("azzurra", "#two"), "bob");
    ws.setJoined(channelKey("freenode", "#joined"));

    expect(ws.invitedWindows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ networkSlug: "freenode", channelName: "#one", inviter: "alice" }),
        expect.objectContaining({ networkSlug: "azzurra", channelName: "#two", inviter: "bob" }),
      ]),
    );
    expect(ws.invitedWindows()).toHaveLength(2);
  });

  // The whole point of the projection: it reads the STATE map, so an invite
  // that resolves stops being projected without anyone clearing a second
  // store. This is what makes the banner derived rather than owned.
  it("stops projecting a channel once it leaves the invited state", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#one");

    ws.setInvited(key, "alice");
    ws.setJoined(key);

    expect(ws.invitedWindows()).toHaveLength(0);
  });

  // A newer cic meeting an older BEAM: the narrower substitutes the "*"
  // sentinel rather than dropping the invite, so the projection must render
  // a nameless banner, never `undefined` in the copy.
  it("falls back to the anonymous-sender sentinel when no inviter was recorded", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#one");

    ws.setInvited(key, "*");

    expect(ws.invitedWindows()[0]?.inviter).toBe("*");
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

  it("does NOT clear a 'pending' key — a stale part echo after a re-join is dropped (#495)", async () => {
    // #495 ordering guard. When the user PARTs then re-joins fast, the
    // re-join's optimistic window_pending sets "pending" BEFORE the
    // earlier part's `:parted` echo (an ircd round-trip) arrives. That
    // stale echo must NOT clear the fresh pending — otherwise the
    // selection close-watcher misreads the live→dead flip and evicts
    // focus to $server (asserted end-to-end in selection.test.ts). The
    // genuine-PART case leaves the key "joined" (see "removes the entry"
    // above), where the guard is inert.
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#bofh");

    ws.setPending(key);
    ws.setParted(key);

    expect(ws.windowStateByChannel()[key]).toBe("pending");
  });
});

describe("windowState.forceParted (unconditional user-close drop)", () => {
  it("drops a joined key like setParted", async () => {
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#grappa");

    ws.setJoined(key);
    ws.forceParted(key);

    expect(ws.windowStateByChannel()[key]).toBeUndefined();
  });

  it("clears a 'pending' key too — a USER × bypasses the #495 stale-echo guard", async () => {
    // Counterpart to setParted's #495 no-op: a DELIBERATE close
    // (windowClose.ts closeChannelWindow / dismissPseudoWindow) must drop
    // the key even mid-re-join, so a pending pseudo-row's × is never a
    // silent no-op. If this regressed, setParted's guard would swallow the
    // dismissal and strand an un-dismissable greyed row.
    const ws = await import("../lib/windowState");
    const key = channelKey("freenode", "#bofh");

    ws.setPending(key);
    ws.forceParted(key);

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
