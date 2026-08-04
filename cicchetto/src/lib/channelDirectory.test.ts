import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import * as api from "./api";
import { setToken } from "./auth";
import {
  directoryError,
  directoryPage,
  directoryQuery,
  directorySort,
  isLoadingMore,
  loadDirectory,
  loadMore,
  onDirectoryComplete,
  onDirectoryFailed,
  onDirectoryProgress,
  resetDirectory,
  setQuery,
  setSort,
  triggerRefresh,
} from "./channelDirectory";

// channelDirectory store — per-slug DirectoryPage + view (sort/q) signal
// store, identity-scoped. Tests assert outcome invariants, not call order.
//
// Token priming: token() is read at call time (reactive signal). beforeEach
// sets a test bearer via setToken so fetch verbs don't short-circuit on a
// null token. afterEach clears it back to null; the identity-change effect
// fires (prev != null && t !== prev) and resets pages + views so state
// doesn't leak across tests. Tests using slug "freenode" are isolated from
// the provided "libera" tests for the same reason.

const TOKEN = "test-bearer";

// Externally-settled promise, so a test can choose the ORDER two in-flight
// GETs resolve in — the whole point of the #732 request-ordering guard.
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// Let Solid's on(token) identity-change effect flush (it runs off the
// microtask queue, not synchronously inside setToken).
const flushEffects = () => new Promise((r) => setTimeout(r, 0));

const makePage = (overrides: Partial<api.DirectoryPage> = {}): api.DirectoryPage => ({
  entries: [],
  next_cursor: null,
  total: 0,
  captured_at: null,
  status: "fresh" as api.DirectoryStatus,
  ...overrides,
});

describe("channelDirectory store", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    setToken(TOKEN);
  });
  afterEach(() => setToken(null));

  // --- provided test bodies (unchanged) ---

  test("loadDirectory populates the page for the network", async () => {
    vi.spyOn(api, "listDirectory").mockResolvedValue({
      entries: [{ name: "#a", topic: "t", user_count: 3, featured: false }],
      next_cursor: null,
      total: 1,
      captured_at: "2026-06-26T10:00:00Z",
      status: "fresh",
    });
    await loadDirectory("libera");
    expect(directoryPage("libera")?.total).toBe(1);
    expect(directoryPage("libera")?.entries[0]?.name).toBe("#a");
  });

  test("a progress ping re-GETs the current view", async () => {
    const spy = vi.spyOn(api, "listDirectory").mockResolvedValue({
      entries: [],
      next_cursor: null,
      total: 7,
      captured_at: null,
      status: "refreshing",
    });
    await loadDirectory("libera");
    spy.mockClear();
    await onDirectoryProgress("libera");
    expect(spy).toHaveBeenCalledOnce();
    expect(directoryPage("libera")?.total).toBe(7);
  });

  // --- additional coverage ---

  test("onDirectoryComplete re-GETs the current view", async () => {
    const spy = vi
      .spyOn(api, "listDirectory")
      .mockResolvedValue(makePage({ total: 3, status: "fresh" }));
    await loadDirectory("freenode");
    spy.mockClear();
    await onDirectoryComplete("freenode");
    expect(spy).toHaveBeenCalledOnce();
    expect(directoryPage("freenode")?.total).toBe(3);
  });

  test("onDirectoryFailed re-GETs the current view", async () => {
    const spy = vi
      .spyOn(api, "listDirectory")
      .mockResolvedValue(makePage({ total: 0, status: "empty" }));
    await loadDirectory("freenode");
    spy.mockClear();
    await onDirectoryFailed("freenode");
    expect(spy).toHaveBeenCalledOnce();
    expect(directoryPage("freenode")?.status).toBe("empty");
  });

  test("setQuery threads q into the api call", async () => {
    const spy = vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 5 }));
    await setQuery("freenode", "cool");
    expect(spy).toHaveBeenCalledWith(TOKEN, "freenode", expect.objectContaining({ q: "cool" }));
    expect(directoryPage("freenode")?.total).toBe(5);
  });

  test("setSort threads sort into the api call", async () => {
    const spy = vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 12 }));
    await setSort("freenode", "name");
    expect(spy).toHaveBeenCalledWith(TOKEN, "freenode", expect.objectContaining({ sort: "name" }));
    expect(directoryPage("freenode")?.total).toBe(12);
  });

  // #738 — the pane's search box renders this, so it must report the filter
  // the store is actually applying, whoever set it (the box, or compose.ts's
  // `/list <pattern>`).
  test("directoryQuery reports the applied filter and defaults to empty", async () => {
    expect(directoryQuery("dq1")).toBe("");
    vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 1 }));
    await setQuery("dq1", "rust");
    expect(directoryQuery("dq1")).toBe("rust");
    resetDirectory("dq1");
    expect(directoryQuery("dq1")).toBe("");
  });

  test("setQuery + subsequent loadDirectory uses the stored q", async () => {
    vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 2 }));
    await setQuery("freenode", "rust");
    const spy = vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 2 }));
    await loadDirectory("freenode");
    expect(spy).toHaveBeenCalledWith(TOKEN, "freenode", expect.objectContaining({ q: "rust" }));
  });

  test("triggerRefresh calls refreshDirectory with the current bearer", async () => {
    const spy = vi.spyOn(api, "refreshDirectory").mockResolvedValue(undefined);
    await triggerRefresh("freenode");
    expect(spy).toHaveBeenCalledWith(TOKEN, "freenode");
  });

  test("no-token short-circuits — loadDirectory makes no api call when token is null", async () => {
    setToken(null);
    const spy = vi.spyOn(api, "listDirectory");
    await loadDirectory("freenode");
    expect(spy).not.toHaveBeenCalled();
  });

  test("no-token short-circuits — triggerRefresh makes no api call when token is null", async () => {
    setToken(null);
    const spy = vi.spyOn(api, "refreshDirectory");
    await triggerRefresh("freenode");
    expect(spy).not.toHaveBeenCalled();
  });

  // --- #677 pagination: loadMore appends the next keyset page ---

  describe("loadMore (#677 pagination)", () => {
    const ROW = (name: string, users: number): api.DirectoryEntry => ({
      name,
      topic: null,
      user_count: users,
      featured: false,
    });

    test("appends the next page and threads the stored cursor back", async () => {
      const spy = vi.spyOn(api, "listDirectory");
      spy.mockResolvedValueOnce(
        makePage({ entries: [ROW("#a", 9)], next_cursor: "CUR2", total: 3 }),
      );
      await loadDirectory("lm1");
      spy.mockResolvedValueOnce(makePage({ entries: [ROW("#b", 8)], next_cursor: null, total: 3 }));
      await loadMore("lm1");

      // The page-1 cursor was fed back to the server verbatim (opaque).
      expect(spy).toHaveBeenLastCalledWith(
        TOKEN,
        "lm1",
        expect.objectContaining({ cursor: "CUR2" }),
      );
      // Rows ACCUMULATED (not replaced), cursor advanced to the new page's.
      const p = directoryPage("lm1");
      expect(p?.entries.map((e) => e.name)).toEqual(["#a", "#b"]);
      expect(p?.next_cursor).toBeNull();
    });

    test("no-op when next_cursor is null (already at the end)", async () => {
      const spy = vi
        .spyOn(api, "listDirectory")
        .mockResolvedValueOnce(makePage({ total: 1, next_cursor: null }));
      await loadDirectory("lm2");
      spy.mockClear();
      await loadMore("lm2");
      expect(spy).not.toHaveBeenCalled();
    });

    test("no-op when no page has been loaded yet", async () => {
      const spy = vi.spyOn(api, "listDirectory");
      spy.mockClear();
      await loadMore("lm3");
      expect(spy).not.toHaveBeenCalled();
    });

    test("no-op when token is null", async () => {
      const spy = vi
        .spyOn(api, "listDirectory")
        .mockResolvedValueOnce(makePage({ total: 5, next_cursor: "CUR2" }));
      await loadDirectory("lm4");
      setToken(null);
      spy.mockClear();
      await loadMore("lm4");
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // --- #677 clear-on-close: resetDirectory ---

  describe("resetDirectory (#677 clear-on-close)", () => {
    test("clears the search key and drops the cached page", async () => {
      vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 4, next_cursor: "X" }));
      await setQuery("rd1", "rust");
      expect(directoryPage("rd1")).toBeDefined();

      resetDirectory("rd1");
      // Page dropped → a reopen re-fetches from the top.
      expect(directoryPage("rd1")).toBeUndefined();

      // q cleared → the reopen GET carries q: "" (unfiltered), NOT "rust".
      const spy = vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 4 }));
      await loadDirectory("rd1");
      expect(spy).toHaveBeenCalledWith(TOKEN, "rd1", expect.objectContaining({ q: "" }));
    });

    test("preserves sort as a sticky preference across a reset", async () => {
      vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 2 }));
      await setSort("rd2", "name");
      resetDirectory("rd2");
      expect(directorySort("rd2")).toBe("name");
    });
  });

  // --- #732: every async verb surfaces its failure ---

  describe("error surfacing (#732)", () => {
    test("a failed page GET surfaces friendly copy instead of rejecting", async () => {
      vi.spyOn(api, "listDirectory").mockRejectedValue(new api.ApiError(503, "db_unavailable"));
      await expect(loadDirectory("err1")).resolves.toBeUndefined();
      expect(directoryError("err1")).toBe("The service is momentarily busy. Please try again.");
      expect(directoryPage("err1")).toBeUndefined();
    });

    test("a non-ApiError failure surfaces generic copy, not a raw throw", async () => {
      vi.spyOn(api, "listDirectory").mockRejectedValue(new TypeError("Failed to fetch"));
      await loadDirectory("err2");
      expect(directoryError("err2")).toBe("Couldn't reach the server.");
    });

    test("a failed re-GET keeps the page it already had", async () => {
      const spy = vi.spyOn(api, "listDirectory");
      spy.mockResolvedValueOnce(makePage({ total: 4 }));
      await loadDirectory("err3");
      spy.mockRejectedValueOnce(new api.ApiError(504, "session_timeout"));
      await onDirectoryProgress("err3");
      expect(directoryPage("err3")?.total).toBe(4);
      expect(directoryError("err3")).not.toBeNull();
    });

    test("a successful GET clears a prior error", async () => {
      const spy = vi.spyOn(api, "listDirectory");
      spy.mockRejectedValueOnce(new api.ApiError(503, "db_unavailable"));
      await loadDirectory("err4");
      expect(directoryError("err4")).not.toBeNull();
      spy.mockResolvedValueOnce(makePage({ total: 1 }));
      await loadDirectory("err4");
      expect(directoryError("err4")).toBeNull();
    });

    test("resetDirectory clears the error so a reopen starts clean", async () => {
      vi.spyOn(api, "listDirectory").mockRejectedValue(new api.ApiError(503, "db_unavailable"));
      await loadDirectory("err5");
      expect(directoryError("err5")).not.toBeNull();
      resetDirectory("err5");
      expect(directoryError("err5")).toBeNull();
    });

    test("a failed loadMore surfaces the error and clears the spinner", async () => {
      const spy = vi.spyOn(api, "listDirectory");
      spy.mockResolvedValueOnce(makePage({ total: 9, next_cursor: "CUR2" }));
      await loadDirectory("err6");
      spy.mockRejectedValueOnce(new api.ApiError(503, "db_unavailable"));
      await expect(loadMore("err6")).resolves.toBeUndefined();
      expect(directoryError("err6")).not.toBeNull();
      expect(isLoadingMore("err6")).toBe(false);
    });

    test("a successful triggerRefresh does NOT clear a page error", async () => {
      // The Refresh button is live while the pane is blank (status() is
      // undefined → not disabled), so clearing on the 202 would leave the
      // operator with no message and no retry — #732 all over again.
      vi.spyOn(api, "listDirectory").mockRejectedValue(new api.ApiError(503, "db_unavailable"));
      await loadDirectory("err8");
      const before = directoryError("err8");
      vi.spyOn(api, "refreshDirectory").mockResolvedValue(undefined);
      await triggerRefresh("err8");
      expect(directoryError("err8")).toBe(before);
    });

    test("a successful loadMore clears a prior error", async () => {
      const spy = vi.spyOn(api, "listDirectory");
      spy.mockResolvedValueOnce(makePage({ total: 9, next_cursor: "CUR2" }));
      await loadDirectory("err9");
      spy.mockRejectedValueOnce(new api.ApiError(503, "db_unavailable"));
      await loadMore("err9");
      expect(directoryError("err9")).not.toBeNull();
      spy.mockResolvedValueOnce(makePage({ total: 9, next_cursor: null }));
      await loadMore("err9");
      expect(directoryError("err9")).toBeNull();
    });

    test("an identity rotation clears the error with the rest of the state", async () => {
      vi.spyOn(api, "listDirectory").mockRejectedValue(new api.ApiError(503, "db_unavailable"));
      await loadDirectory("err10");
      expect(directoryError("err10")).not.toBeNull();
      setToken("other-bearer");
      await flushEffects();
      expect(directoryError("err10")).toBeNull();
    });

    test("a failed triggerRefresh surfaces the error", async () => {
      vi.spyOn(api, "refreshDirectory").mockRejectedValue(new api.ApiError(504, "session_timeout"));
      await expect(triggerRefresh("err7")).resolves.toBeUndefined();
      expect(directoryError("err7")).toBe(
        "The network is taking too long to respond. Try again in a few seconds.",
      );
    });
  });

  // --- #732: request ordering — only the NEWEST request may write ---

  describe("request ordering (#732)", () => {
    test("a superseded GET does not clobber the newest results", async () => {
      const slow = deferred<api.DirectoryPage>();
      const fast = deferred<api.DirectoryPage>();
      vi.spyOn(api, "listDirectory")
        .mockReturnValueOnce(slow.promise)
        .mockReturnValueOnce(fast.promise);

      const stale = setQuery("ord1", "ru");
      const newest = setQuery("ord1", "rust");
      fast.resolve(makePage({ total: 2 }));
      await newest;
      slow.resolve(makePage({ total: 99 }));
      await stale;

      expect(directoryPage("ord1")?.total).toBe(2);
    });

    test("a superseded GET's failure does not surface over the newest success", async () => {
      const slow = deferred<api.DirectoryPage>();
      const fast = deferred<api.DirectoryPage>();
      vi.spyOn(api, "listDirectory")
        .mockReturnValueOnce(slow.promise)
        .mockReturnValueOnce(fast.promise);

      const stale = setQuery("ord2", "ru");
      const newest = setQuery("ord2", "rust");
      fast.resolve(makePage({ total: 2 }));
      await newest;
      slow.reject(new api.ApiError(503, "db_unavailable"));
      await stale;

      expect(directoryError("ord2")).toBeNull();
      expect(directoryPage("ord2")?.total).toBe(2);
    });

    test("a GET in flight at close does not resurrect the page after resetDirectory", async () => {
      const inflight = deferred<api.DirectoryPage>();
      vi.spyOn(api, "listDirectory").mockReturnValueOnce(inflight.promise);

      const pending = loadDirectory("ord3");
      resetDirectory("ord3");
      inflight.resolve(makePage({ total: 7 }));
      await pending;

      expect(directoryPage("ord3")).toBeUndefined();
    });

    test("a GET in flight across an identity rotation never writes", async () => {
      const inflight = deferred<api.DirectoryPage>();
      vi.spyOn(api, "listDirectory").mockReturnValueOnce(inflight.promise);

      const pending = loadDirectory("ord4");
      setToken("other-bearer");
      await flushEffects();
      inflight.resolve(makePage({ total: 7 }));
      await pending;

      expect(directoryPage("ord4")).toBeUndefined();
    });

    test("a superseded append's failure does not surface", async () => {
      const spy = vi.spyOn(api, "listDirectory");
      spy.mockResolvedValueOnce(makePage({ total: 9, next_cursor: "CUR2" }));
      await loadDirectory("ord6");

      const append = deferred<api.DirectoryPage>();
      spy.mockReturnValueOnce(append.promise);
      const more = loadMore("ord6");
      spy.mockResolvedValueOnce(makePage({ total: 1, next_cursor: null }));
      await onDirectoryProgress("ord6");
      append.reject(new api.ApiError(503, "db_unavailable"));
      await more;

      // The append belonged to a page that is no longer on screen; banner-ing
      // its failure would blame the fresh, healthy page.
      expect(directoryError("ord6")).toBeNull();
    });

    test("a refresh rejection arriving after the close does not park copy", async () => {
      const spy = vi.spyOn(api, "listDirectory").mockResolvedValue(makePage({ total: 1 }));
      await loadDirectory("ord7");
      spy.mockClear();

      const refresh = deferred<void>();
      vi.spyOn(api, "refreshDirectory").mockReturnValueOnce(refresh.promise);
      const pending = triggerRefresh("ord7");
      resetDirectory("ord7");
      refresh.reject(new api.ApiError(504, "session_timeout"));
      await pending;

      expect(directoryError("ord7")).toBeNull();
    });

    test("a refresh rejection after the close is dropped even with no prior load", async () => {
      // The slug holds no id at all (nothing was ever loaded), so the refresh
      // captures `undefined`. Closing must still supersede it — otherwise
      // "never touched" and "invalidated" read the same and the rejection
      // parks copy on a pane that is gone.
      const refresh = deferred<void>();
      vi.spyOn(api, "refreshDirectory").mockReturnValueOnce(refresh.promise);
      const pending = triggerRefresh("ord9");
      resetDirectory("ord9");
      refresh.reject(new api.ApiError(504, "session_timeout"));
      await pending;

      expect(directoryError("ord9")).toBeNull();
    });

    test("a refresh rejection with no prior load surfaces while the pane is live", async () => {
      vi.spyOn(api, "refreshDirectory").mockRejectedValue(new api.ApiError(504, "session_timeout"));
      await triggerRefresh("ord10");
      expect(directoryError("ord10")).not.toBeNull();
    });

    test("an append issued while a top-of-view GET is in flight is not sent", async () => {
      const spy = vi.spyOn(api, "listDirectory");
      spy.mockResolvedValueOnce(makePage({ total: 9, next_cursor: "CUR2" }));
      await loadDirectory("ord8");

      // A filter change is in flight: the page loadMore would extend is
      // already superseded, and its cursor belongs to the OLD view.
      const replacement = deferred<api.DirectoryPage>();
      spy.mockReturnValueOnce(replacement.promise);
      const requery = setQuery("ord8", "rust");
      spy.mockClear();
      await loadMore("ord8");
      expect(spy).not.toHaveBeenCalled();

      replacement.resolve(makePage({ total: 1, next_cursor: null }));
      await requery;
    });

    test("a fetchInto that lands mid-loadMore drops the stale append", async () => {
      const spy = vi.spyOn(api, "listDirectory");
      const ROW = (name: string): api.DirectoryEntry => ({
        name,
        topic: null,
        user_count: 1,
        featured: false,
      });
      spy.mockResolvedValueOnce(makePage({ entries: [ROW("#a")], next_cursor: "CUR2", total: 3 }));
      await loadDirectory("ord5");

      const append = deferred<api.DirectoryPage>();
      spy.mockReturnValueOnce(append.promise);
      const more = loadMore("ord5");

      // A progress ping REPLACES page 1 while the append GET is in flight.
      // The replacement happens to carry the same cursor (same view, fresh
      // capture) — so a cursor-equality guard would wave the append through
      // and splice page 2 of the OLD capture onto the new page 1.
      spy.mockResolvedValueOnce(makePage({ entries: [ROW("#z")], next_cursor: "CUR2", total: 1 }));
      await onDirectoryProgress("ord5");

      append.resolve(makePage({ entries: [ROW("#b")], next_cursor: null }));
      await more;

      expect(directoryPage("ord5")?.entries.map((e) => e.name)).toEqual(["#z"]);
    });
  });
});
