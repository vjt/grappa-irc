import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScrollbackMessage } from "../lib/api";
import { channelKey } from "../lib/channelKey";

// CP29 R-5: reconnectBackfill collapsed to a cursor-source helper.
// Owns the high-water-mark map (`recordSeen`) + the resume-cursor
// resolution heuristic (`getResumeCursor`). The actual REST fetch +
// noteJoinOk count-gate moved into `lib/scrollback.ts:refreshScrollback`
// (called from every per-channel join callback in subscribe.ts —
// initial + every auto-rejoin, no count-gate). See module headers.
//
// Boundary: mock `lib/readCursor` (the server-side cursor fallback in
// the resume-cursor heuristic).

const mockReadCursor = vi.fn<(slug: string, chan: string) => number | null>(() => null);
vi.mock("../lib/readCursor", () => ({
  getReadCursor: (slug: string, chan: string) => mockReadCursor(slug, chan),
  applyMeEnvelope: vi.fn(),
  applyJoinReply: vi.fn(),
  applyReadCursorSet: vi.fn(),
  advanceReadCursor: vi.fn().mockResolvedValue(undefined),
  clearReadCursors: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  vi.clearAllMocks();
  mockReadCursor.mockReturnValue(null);
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
  it("tracks the high-water mark per topic — getResumeCursor reflects the max", async () => {
    const { recordSeen, getResumeCursor } = await import("../lib/reconnectBackfill");
    const key = channelKey("azzurra", "#sniffo");
    recordSeen(key, sampleMsg(5));
    recordSeen(key, sampleMsg(10));
    expect(getResumeCursor("azzurra", "#sniffo")).toBe(10);
  });

  it("does not rewind on out-of-order arrivals", async () => {
    const { recordSeen, getResumeCursor } = await import("../lib/reconnectBackfill");
    const key = channelKey("azzurra", "#sniffo");
    recordSeen(key, sampleMsg(20));
    recordSeen(key, sampleMsg(10));
    expect(getResumeCursor("azzurra", "#sniffo")).toBe(20);
  });

  it("tracks high-water mark independently per (slug, channel)", async () => {
    const { recordSeen, getResumeCursor } = await import("../lib/reconnectBackfill");
    recordSeen(channelKey("azzurra", "#a"), sampleMsg(5));
    recordSeen(channelKey("azzurra", "#b"), sampleMsg(7));
    recordSeen(channelKey("freenode", "#a"), sampleMsg(9));
    expect(getResumeCursor("azzurra", "#a")).toBe(5);
    expect(getResumeCursor("azzurra", "#b")).toBe(7);
    expect(getResumeCursor("freenode", "#a")).toBe(9);
  });
});

describe("getResumeCursor heuristic", () => {
  it("prefers the live high-water mark over the server read cursor", async () => {
    const { recordSeen, getResumeCursor } = await import("../lib/reconnectBackfill");
    mockReadCursor.mockReturnValue(2); // older server-side cursor
    recordSeen(channelKey("azzurra", "#sniffo"), sampleMsg(50));
    expect(getResumeCursor("azzurra", "#sniffo")).toBe(50);
  });

  it("falls back to the server read cursor when no live high-water mark exists", async () => {
    const { getResumeCursor } = await import("../lib/reconnectBackfill");
    mockReadCursor.mockReturnValue(42);
    expect(getResumeCursor("azzurra", "#sniffo")).toBe(42);
  });

  it("returns null when neither source has a value (cold load, no cursor yet)", async () => {
    const { getResumeCursor } = await import("../lib/reconnectBackfill");
    mockReadCursor.mockReturnValue(null);
    expect(getResumeCursor("azzurra", "#sniffo")).toBeNull();
  });

  it("falls back to the server cursor even when the live mark exists for OTHER topics", async () => {
    const { recordSeen, getResumeCursor } = await import("../lib/reconnectBackfill");
    mockReadCursor.mockReturnValue(7);
    recordSeen(channelKey("azzurra", "#other"), sampleMsg(100));
    expect(getResumeCursor("azzurra", "#sniffo")).toBe(7);
  });
});
