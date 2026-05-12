import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// Boundary: mock REST (`lib/api`) and the scrollback append verb
// (`lib/scrollback`). The reconnect-backfill module is pure logic over
// (token-gated REST fetch → append-via-verb), so we stub both.

vi.mock("../lib/api", () => ({
  listMessagesAfter: vi.fn(),
  listMessages: vi.fn(),
  listNetworks: vi.fn(),
  listChannels: vi.fn(),
  sendMessage: vi.fn(),
  me: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setOn401Handler: vi.fn(),
}));

vi.mock("../lib/scrollback", () => ({
  appendToScrollback: vi.fn(),
  scrollbackByChannel: vi.fn(() => ({})),
  loadInitialScrollback: vi.fn(),
  loadMore: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
});

const sampleMsg = (id: number, body = "x"): ScrollbackMessage => ({
  id,
  network: "azzurra",
  channel: "#sniffo",
  server_time: id * 1000,
  kind: "privmsg",
  sender: "vjt",
  body,
  meta: {},
});

describe("recordSeen", () => {
  it("tracks the high-water mark per topic", async () => {
    localStorage.setItem("grappa-token", "tok");
    const { recordSeen, runBackfill } = await import("../lib/reconnectBackfill");
    const { listMessagesAfter } = await import("../lib/api");
    vi.mocked(listMessagesAfter).mockResolvedValue([]);

    const key = channelKey("azzurra", "#sniffo");
    recordSeen(key, sampleMsg(5));
    recordSeen(key, sampleMsg(10));

    await runBackfill("azzurra", "#sniffo");
    // Two recordSeen calls: high-water mark should be 10 (max), so
    // backfill REST is called with after=10.
    expect(listMessagesAfter).toHaveBeenCalledWith("tok", "azzurra", "#sniffo", 10);
  });

  it("does not rewind on out-of-order arrivals", async () => {
    localStorage.setItem("grappa-token", "tok");
    const { recordSeen, runBackfill } = await import("../lib/reconnectBackfill");
    const { listMessagesAfter } = await import("../lib/api");
    vi.mocked(listMessagesAfter).mockResolvedValue([]);

    const key = channelKey("azzurra", "#sniffo");
    recordSeen(key, sampleMsg(20));
    recordSeen(key, sampleMsg(10)); // older — must not rewind

    await runBackfill("azzurra", "#sniffo");
    expect(listMessagesAfter).toHaveBeenCalledWith("tok", "azzurra", "#sniffo", 20);
  });
});

describe("noteJoinOk", () => {
  it("returns false on first call (initial join), true on subsequent (rejoin)", async () => {
    const { noteJoinOk } = await import("../lib/reconnectBackfill");
    expect(noteJoinOk("azzurra", "#sniffo")).toBe(false);
    expect(noteJoinOk("azzurra", "#sniffo")).toBe(true);
    expect(noteJoinOk("azzurra", "#sniffo")).toBe(true);
  });

  it("tracks join counts independently per (slug, channel)", async () => {
    const { noteJoinOk } = await import("../lib/reconnectBackfill");
    expect(noteJoinOk("azzurra", "#a")).toBe(false);
    expect(noteJoinOk("azzurra", "#b")).toBe(false);
    expect(noteJoinOk("freenode", "#a")).toBe(false);

    expect(noteJoinOk("azzurra", "#a")).toBe(true);
    expect(noteJoinOk("azzurra", "#b")).toBe(true);
    expect(noteJoinOk("freenode", "#a")).toBe(true);
  });
});

describe("runBackfill", () => {
  it("is a no-op if no high-water mark recorded for the topic", async () => {
    localStorage.setItem("grappa-token", "tok");
    const { runBackfill } = await import("../lib/reconnectBackfill");
    const { listMessagesAfter } = await import("../lib/api");

    await runBackfill("azzurra", "#never-seen");
    expect(listMessagesAfter).not.toHaveBeenCalled();
  });

  it("is a no-op if no token", async () => {
    const { recordSeen, runBackfill } = await import("../lib/reconnectBackfill");
    const { listMessagesAfter } = await import("../lib/api");

    const key = channelKey("azzurra", "#sniffo");
    recordSeen(key, sampleMsg(5));
    // No token set → backfill must skip the REST call.
    await runBackfill("azzurra", "#sniffo");
    expect(listMessagesAfter).not.toHaveBeenCalled();
  });

  it("dispatches each backfilled row through appendToScrollback", async () => {
    localStorage.setItem("grappa-token", "tok");
    const { recordSeen, runBackfill } = await import("../lib/reconnectBackfill");
    const { listMessagesAfter } = await import("../lib/api");
    const { appendToScrollback } = await import("../lib/scrollback");

    const key = channelKey("azzurra", "#sniffo");
    recordSeen(key, sampleMsg(5));

    const backfilled = [sampleMsg(6, "missed-1"), sampleMsg(7, "missed-2")];
    vi.mocked(listMessagesAfter).mockResolvedValue(backfilled);

    await runBackfill("azzurra", "#sniffo");

    expect(appendToScrollback).toHaveBeenCalledTimes(2);
    expect(appendToScrollback).toHaveBeenNthCalledWith(1, key, backfilled[0]);
    expect(appendToScrollback).toHaveBeenNthCalledWith(2, key, backfilled[1]);
  });

  it("rolls high-water mark forward as it ingests so a second reconnect resumes from the new tail",
    async () => {
      localStorage.setItem("grappa-token", "tok");
      const { recordSeen, runBackfill } = await import("../lib/reconnectBackfill");
      const { listMessagesAfter } = await import("../lib/api");

      const key = channelKey("azzurra", "#sniffo");
      recordSeen(key, sampleMsg(5));

      vi.mocked(listMessagesAfter).mockResolvedValueOnce([sampleMsg(6), sampleMsg(7)]);
      await runBackfill("azzurra", "#sniffo");

      // Second backfill cycle (simulated reconnect after another gap)
      // — must use the NEW high-water mark (7), not the original (5).
      vi.mocked(listMessagesAfter).mockResolvedValueOnce([]);
      await runBackfill("azzurra", "#sniffo");

      const calls = vi.mocked(listMessagesAfter).mock.calls;
      expect(calls[0]).toEqual(["tok", "azzurra", "#sniffo", 5]);
      expect(calls[1]).toEqual(["tok", "azzurra", "#sniffo", 7]);
    });

  it("logs and recovers on REST error without rewinding cursor", async () => {
    localStorage.setItem("grappa-token", "tok");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { recordSeen, runBackfill } = await import("../lib/reconnectBackfill");
    const { listMessagesAfter } = await import("../lib/api");
    const { appendToScrollback } = await import("../lib/scrollback");

    const key = channelKey("azzurra", "#sniffo");
    recordSeen(key, sampleMsg(5));

    vi.mocked(listMessagesAfter).mockRejectedValueOnce(new Error("network down"));
    await runBackfill("azzurra", "#sniffo");

    expect(appendToScrollback).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalled();

    // Next reconnect: the cursor stayed at 5 (no rewind), so a retry
    // gets to fire and ingest correctly.
    vi.mocked(listMessagesAfter).mockResolvedValueOnce([sampleMsg(6)]);
    await runBackfill("azzurra", "#sniffo");
    expect(appendToScrollback).toHaveBeenCalledWith(key, sampleMsg(6));

    consoleSpy.mockRestore();
  });

  it("guards against overlapping in-flight backfills on the same topic",
    async () => {
      localStorage.setItem("grappa-token", "tok");
      const { recordSeen, runBackfill } = await import("../lib/reconnectBackfill");
      const { listMessagesAfter } = await import("../lib/api");

      const key = channelKey("azzurra", "#sniffo");
      recordSeen(key, sampleMsg(5));

      let resolveFirst: (v: ScrollbackMessage[]) => void = () => {};
      const firstPromise = new Promise<ScrollbackMessage[]>((res) => {
        resolveFirst = res;
      });
      vi.mocked(listMessagesAfter).mockReturnValueOnce(firstPromise);

      const a = runBackfill("azzurra", "#sniffo");
      // Second call while first is still pending — must be skipped.
      const b = runBackfill("azzurra", "#sniffo");

      expect(listMessagesAfter).toHaveBeenCalledTimes(1);

      resolveFirst([]);
      await Promise.all([a, b]);
    });
});
