import { afterEach, beforeEach, describe, expect, it } from "vitest";

// C7.3: readCursor — localStorage-backed read-cursor store.
// Tests cover:
//   1. getReadCursor returns null for unknown keys.
//   2. setReadCursor persists to localStorage.
//   3. getReadCursor returns the stored value after setReadCursor.
//   4. clearReadCursors wipes all cursors (called on identity change).
//   5. Key format is `(networkSlug, channel)` — different keys don't collide.

import { clearReadCursors, getReadCursor, setReadCursor } from "../lib/readCursor";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("readCursor (C7.3)", () => {
  it("getReadCursor returns null for an unknown (networkSlug, channel) pair", () => {
    expect(getReadCursor("freenode", "#grappa")).toBeNull();
  });

  it("setReadCursor persists the server_time cursor to localStorage", () => {
    setReadCursor("freenode", "#grappa", 1_700_000_000_000);
    // Raw localStorage entry must exist under a deterministic key.
    const rawKey = "rc:freenode:#grappa";
    expect(localStorage.getItem(rawKey)).toBe("1700000000000");
  });

  it("getReadCursor returns the stored server_time after setReadCursor", () => {
    setReadCursor("freenode", "#grappa", 1_700_000_042_000);
    expect(getReadCursor("freenode", "#grappa")).toBe(1_700_000_042_000);
  });

  it("different (slug, channel) pairs have independent cursors", () => {
    setReadCursor("freenode", "#grappa", 100);
    setReadCursor("freenode", "#cicchetto", 200);
    setReadCursor("libera", "#grappa", 300);
    expect(getReadCursor("freenode", "#grappa")).toBe(100);
    expect(getReadCursor("freenode", "#cicchetto")).toBe(200);
    expect(getReadCursor("libera", "#grappa")).toBe(300);
  });

  it("clearReadCursors removes all read-cursor entries from localStorage", () => {
    setReadCursor("freenode", "#grappa", 100);
    setReadCursor("freenode", "#cicchetto", 200);
    clearReadCursors();
    expect(getReadCursor("freenode", "#grappa")).toBeNull();
    expect(getReadCursor("freenode", "#cicchetto")).toBeNull();
  });

  it("setReadCursor overwrites a previous cursor for the same window", () => {
    setReadCursor("freenode", "#grappa", 100);
    setReadCursor("freenode", "#grappa", 999);
    expect(getReadCursor("freenode", "#grappa")).toBe(999);
  });
});
