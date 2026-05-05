import { beforeEach, describe, expect, it } from "vitest";

// C5.2 — numericInline store unit tests.
//
// Per-window ephemeral numeric lines. The store is a module-singleton
// signal map (keyed by a window identity string). Tests exercise:
//   - appendNumericInline adds a line to the correct window key.
//   - Max cap (MAX_INLINE_PER_WINDOW) is enforced: oldest entries drop off.
//   - clearNumericInline resets a window's list.
//   - numericsByWindow accessor returns the correct sub-list.

import {
  appendNumericInline,
  clearNumericInline,
  MAX_INLINE_PER_WINDOW,
  numericsByWindow,
} from "../lib/numericInline";

beforeEach(() => {
  // Reset module state between tests via the clear verb.
  clearNumericInline("test-key");
  clearNumericInline("other-key");
});

describe("numericInline", () => {
  it("appendNumericInline adds an entry to the specified window key", () => {
    appendNumericInline("test-key", { numeric: 401, text: "No such nick", severity: "error" });
    const lines = numericsByWindow()["test-key"] ?? [];
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ numeric: 401, text: "No such nick", severity: "error" });
  });

  it("multiple appends accumulate in order", () => {
    appendNumericInline("test-key", { numeric: 401, text: "first", severity: "error" });
    appendNumericInline("test-key", { numeric: 482, text: "second", severity: "error" });
    appendNumericInline("test-key", { numeric: 302, text: "third", severity: "ok" });
    const lines = numericsByWindow()["test-key"] ?? [];
    expect(lines).toHaveLength(3);
    expect(lines[0]?.text).toBe("first");
    expect(lines[2]?.text).toBe("third");
  });

  it("enforces MAX_INLINE_PER_WINDOW cap by dropping oldest entries", () => {
    for (let i = 0; i < MAX_INLINE_PER_WINDOW + 3; i++) {
      appendNumericInline("test-key", { numeric: 200 + i, text: `msg ${i}`, severity: "ok" });
    }
    const lines = numericsByWindow()["test-key"] ?? [];
    expect(lines).toHaveLength(MAX_INLINE_PER_WINDOW);
    // Oldest entries are dropped — the last entry should be the most recently appended.
    expect(lines[lines.length - 1]?.text).toBe(`msg ${MAX_INLINE_PER_WINDOW + 2}`);
  });

  it("clearNumericInline resets the window key to empty", () => {
    appendNumericInline("test-key", { numeric: 401, text: "stale", severity: "error" });
    clearNumericInline("test-key");
    const lines = numericsByWindow()["test-key"] ?? [];
    expect(lines).toHaveLength(0);
  });

  it("entries for different window keys are isolated", () => {
    appendNumericInline("test-key", { numeric: 401, text: "A", severity: "error" });
    appendNumericInline("other-key", { numeric: 482, text: "B", severity: "error" });
    expect((numericsByWindow()["test-key"] ?? []).length).toBe(1);
    expect((numericsByWindow()["other-key"] ?? []).length).toBe(1);
    clearNumericInline("test-key");
    expect((numericsByWindow()["test-key"] ?? []).length).toBe(0);
    // other-key unaffected.
    expect((numericsByWindow()["other-key"] ?? []).length).toBe(1);
  });
});
