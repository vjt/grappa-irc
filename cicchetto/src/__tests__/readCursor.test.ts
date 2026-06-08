import { createEffect, createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Server-owned read cursor — module is a Solid signal map of
// `last_read_message_id` per (networkSlug, channel), hydrated from
// /me + per-channel WS join replies + cross-device read_cursor_set
// events. Writes go to the server via fire-and-forget POST.
//
// Tests cover:
//   1. getReadCursor returns null for unknown keys.
//   2. applyMeEnvelope hydrates the bulk envelope from /me.
//   3. applyJoinReply is a no-op on null but writes on a real cursor.
//   4. applyReadCursorSet is last-write-wins (any direction).
//   5. setReadCursor POSTs the right URL + body shape.
//   6. clearReadCursors wipes all entries.
//   7. on(token) cleanup arm wipes on logout/rotation.
//   8. getReadCursor is reactive — Solid effects re-run on set.
//   9. Module-load purges legacy `rc:`-prefixed localStorage keys
//      one-shot (idempotent on subsequent loads).
//
// auth module is mocked so we can drive the token signal deterministically
// without touching localStorage. The mock is registered BEFORE the
// readCursor module is imported in tests so the createRoot effect at
// module load wires to the mock signal.

vi.mock("../lib/auth", async () => {
  const { createSignal } = await import("solid-js");
  const [tok, setTok] = createSignal<string | null>(null);
  return { token: tok, setToken: setTok };
});

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  localStorage.clear();
});

describe("readCursor", () => {
  it("getReadCursor returns null for an unknown (networkSlug, channel) pair", async () => {
    const { getReadCursor, clearReadCursors } = await import("../lib/readCursor");
    clearReadCursors();
    expect(getReadCursor("freenode", "#grappa")).toBeNull();
  });

  it("applyMeEnvelope hydrates nested {slug => {chan => id}} into the signal map", async () => {
    const { applyMeEnvelope, getReadCursor } = await import("../lib/readCursor");
    applyMeEnvelope({
      freenode: { "#grappa": 100, "#cicchetto": 200 },
      libera: { "#grappa": 300 },
    });
    expect(getReadCursor("freenode", "#grappa")).toBe(100);
    expect(getReadCursor("freenode", "#cicchetto")).toBe(200);
    expect(getReadCursor("libera", "#grappa")).toBe(300);
    expect(getReadCursor("freenode", "#unknown")).toBeNull();
  });

  it("applyMeEnvelope replaces the whole map (cold-load source of truth)", async () => {
    const { applyMeEnvelope, getReadCursor } = await import("../lib/readCursor");
    applyMeEnvelope({ freenode: { "#stale": 999 } });
    expect(getReadCursor("freenode", "#stale")).toBe(999);
    // Second envelope from a fresh login overwrites entirely.
    applyMeEnvelope({ libera: { "#fresh": 1 } });
    expect(getReadCursor("freenode", "#stale")).toBeNull();
    expect(getReadCursor("libera", "#fresh")).toBe(1);
  });

  it("applyJoinReply is a no-op when the join reply carries null cursor", async () => {
    const { applyJoinReply, applyMeEnvelope, getReadCursor } = await import("../lib/readCursor");
    applyMeEnvelope({ freenode: { "#grappa": 50 } });
    applyJoinReply("freenode", "#grappa", null);
    // Existing value preserved — null never overwrites.
    expect(getReadCursor("freenode", "#grappa")).toBe(50);
  });

  it("applyJoinReply writes the cursor for the given (slug, channel)", async () => {
    const { applyJoinReply, getReadCursor, clearReadCursors } = await import("../lib/readCursor");
    clearReadCursors();
    applyJoinReply("freenode", "#grappa", 42);
    expect(getReadCursor("freenode", "#grappa")).toBe(42);
  });

  it("applyReadCursorSet is last-write-wins (cursor moves freely in either direction)", async () => {
    const { applyReadCursorSet, getReadCursor, clearReadCursors } = await import(
      "../lib/readCursor"
    );
    clearReadCursors();
    applyReadCursorSet("freenode", "#grappa", 100);
    expect(getReadCursor("freenode", "#grappa")).toBe(100);
    applyReadCursorSet("freenode", "#grappa", 50); // backwards — operator scrolled up + settled
    expect(getReadCursor("freenode", "#grappa")).toBe(50);
    applyReadCursorSet("freenode", "#grappa", 200); // forwards
    expect(getReadCursor("freenode", "#grappa")).toBe(200);
  });

  it("setReadCursor POSTs to the cursor endpoint with the right body shape", async () => {
    const { setReadCursor } = await import("../lib/readCursor");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ last_read_message_id: 42 }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    await setReadCursor("tokABC", "freenode", "#grappa", 42);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/networks/freenode/channels/%23grappa/read-cursor");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify({ message_id: 42 }));
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers.authorization).toBe("Bearer tokABC");
  });

  it("setReadCursor swallows non-OK responses (fire-and-forget contract)", async () => {
    const { setReadCursor } = await import("../lib/readCursor");
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 422 }));
    vi.stubGlobal("fetch", fetchMock);
    // Must not throw — production code never awaits the result.
    await expect(setReadCursor("t", "n", "c", 1)).resolves.toBeUndefined();
  });

  describe("optimistic local advance (flicker + own-msg-unread fix)", () => {
    // Root cause of two bugs: the local cursor signal was round-trip-only
    // (advanced ONLY when the server's read_cursor_set WS event echoed
    // back via applyReadCursorSet). Reactivity firing in the POST→echo
    // gap read the STALE cursor:
    //   * sidebar badge flicker when leaving a channel — the focused-
    //     window badge suppression drops synchronously on focus-leave,
    //     but the leave-arm's cursor advance had not round-tripped, so
    //     perChannelUnread briefly recomputed a non-zero count.
    //   * own-sent message rendered above the unread divider after
    //     switching away and back — the marker re-latch read the stale
    //     pre-send cursor.
    // Fix: setReadCursor advances the local signal optimistically,
    // forward-only, BEFORE the POST. The WS echo re-affirms the same id.

    it("optimistically advances the local cursor before the WS echo lands", async () => {
      const { setReadCursor, getReadCursor, applyJoinReply, clearReadCursors } = await import(
        "../lib/readCursor"
      );
      clearReadCursors();
      applyJoinReply("freenode", "#grappa", 100);
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      // Do NOT await — the local cursor must reflect the advance
      // synchronously, with no dependence on the server round-trip
      // (applyReadCursorSet) that would otherwise land the value.
      const p = setReadCursor("tok", "freenode", "#grappa", 150);
      expect(getReadCursor("freenode", "#grappa")).toBe(150);
      await p;
    });

    it("optimistic advance is forward-only — never moves the local cursor backward", async () => {
      const { setReadCursor, getReadCursor, applyJoinReply, clearReadCursors } = await import(
        "../lib/readCursor"
      );
      clearReadCursors();
      applyJoinReply("freenode", "#grappa", 100);
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      // A backward candidate must not move the local cursor — only the
      // authoritative applyReadCursorSet WS echo may move it backward
      // (cross-device last-write-wins). Guards against an in-flight
      // stale POST clobbering a peer's more-recent advance.
      await setReadCursor("tok", "freenode", "#grappa", 50);
      expect(getReadCursor("freenode", "#grappa")).toBe(100);
    });

    it("optimistically sets the cursor on cold start (no prior value)", async () => {
      const { setReadCursor, getReadCursor, clearReadCursors } = await import("../lib/readCursor");
      clearReadCursors();
      const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const p = setReadCursor("tok", "freenode", "#grappa", 42);
      expect(getReadCursor("freenode", "#grappa")).toBe(42);
      await p;
    });
  });

  it("clearReadCursors removes every entry from the signal map", async () => {
    const { clearReadCursors, applyMeEnvelope, getReadCursor } = await import("../lib/readCursor");
    applyMeEnvelope({ freenode: { "#grappa": 100, "#cicchetto": 200 } });
    clearReadCursors();
    expect(getReadCursor("freenode", "#grappa")).toBeNull();
    expect(getReadCursor("freenode", "#cicchetto")).toBeNull();
  });

  describe("Solid reactivity (unread-marker bug fix)", () => {
    it("getReadCursor is tracked: applyReadCursorSet invalidates a Solid effect", async () => {
      // Repro for the unread-marker pinning bug. ScrollbackPane's `rows`
      // createMemo reads getReadCursor inside its body. When a
      // `read_cursor_set` WS event lands the memo MUST re-run with the
      // new cursor so the marker disappears.
      const { applyReadCursorSet, getReadCursor, clearReadCursors } = await import(
        "../lib/readCursor"
      );
      clearReadCursors();
      let observed: number | null = -1;
      let runs = 0;
      const dispose = createRoot((dispose) => {
        createEffect(() => {
          observed = getReadCursor("freenode", "#grappa");
          runs += 1;
        });
        return dispose;
      });
      // Initial run: cursor unset, observed=null.
      expect(observed).toBeNull();
      const initialRuns = runs;

      applyReadCursorSet("freenode", "#grappa", 100);
      // Solid effects flush synchronously when a tracked source changes.
      expect(observed).toBe(100);
      expect(runs).toBe(initialRuns + 1);

      applyReadCursorSet("freenode", "#grappa", 200);
      expect(observed).toBe(200);
      expect(runs).toBe(initialRuns + 2);

      dispose();
    });

    it("clearReadCursors invalidates effects tracking previously-set cursors", async () => {
      const { applyReadCursorSet, getReadCursor, clearReadCursors } = await import(
        "../lib/readCursor"
      );
      clearReadCursors();
      applyReadCursorSet("freenode", "#grappa", 100);
      let observed: number | null = -1;
      const dispose = createRoot((dispose) => {
        createEffect(() => {
          observed = getReadCursor("freenode", "#grappa");
        });
        return dispose;
      });
      expect(observed).toBe(100);

      clearReadCursors();
      expect(observed).toBeNull();

      dispose();
    });
  });

  describe("legacy localStorage purge", () => {
    it("purges any pre-CP29-R4 `rc:`-prefixed localStorage keys at module load", async () => {
      // Stage legacy bytes BEFORE importing the module so the module's
      // load-time `purgeLegacyKeys()` runs against this fixture. Use
      // `vi.resetModules` first so a prior test's module load doesn't
      // poison the fresh import.
      vi.resetModules();
      localStorage.setItem("rc:freenode:#grappa", "1700000000000");
      localStorage.setItem("rc:libera:#test", "1700000001000");
      // A non-`rc:`-prefixed key must NOT be touched.
      localStorage.setItem("grappa-token", "tokABC");
      await import("../lib/readCursor");
      expect(localStorage.getItem("rc:freenode:#grappa")).toBeNull();
      expect(localStorage.getItem("rc:libera:#test")).toBeNull();
      expect(localStorage.getItem("grappa-token")).toBe("tokABC");
    });
  });
});
