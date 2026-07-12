import { beforeEach, describe, expect, it, vi } from "vitest";

// #217 — user-configurable message-timestamp format. Closed-set keys
// (NOT a free-form strftime string — CLAUDE.md "atoms/literals, never
// untyped strings for closed sets"), localStorage-persisted, backed by a
// module-singleton Solid signal so open scrollback panes re-render live on
// change (mirror of theme.ts). Default is WITH seconds per the issue.

describe("timeFormat module", () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
  });

  describe("getTimeFormat()", () => {
    it("returns the stored key when set to a valid value", async () => {
      localStorage.setItem("cicchetto.timeFormat", "hm");
      const { getTimeFormat } = await import("../lib/timeFormat");
      expect(getTimeFormat()).toBe("hm");
    });

    it("defaults to 'hms' (with seconds) when localStorage is empty", async () => {
      const { getTimeFormat } = await import("../lib/timeFormat");
      expect(getTimeFormat()).toBe("hms");
    });

    it("falls back to 'hms' when localStorage holds an invalid value", async () => {
      localStorage.setItem("cicchetto.timeFormat", "iso8601");
      const { getTimeFormat } = await import("../lib/timeFormat");
      expect(getTimeFormat()).toBe("hms");
    });
  });

  describe("setTimeFormat()", () => {
    it("persists the key to localStorage", async () => {
      const { setTimeFormat } = await import("../lib/timeFormat");
      setTimeFormat("hm");
      expect(localStorage.getItem("cicchetto.timeFormat")).toBe("hm");
    });

    it("updates the reactive getter so subsequent reads reflect the change", async () => {
      const { getTimeFormat, setTimeFormat } = await import("../lib/timeFormat");
      expect(getTimeFormat()).toBe("hms");
      setTimeFormat("hm");
      expect(getTimeFormat()).toBe("hm");
    });
  });

  describe("formatTimestamp()", () => {
    // A fixed local wall-clock instant: build from Y/M/D h:m:s so the
    // assertion is TZ-independent (Date(...) with component args is local).
    const instant = new Date(2026, 6, 12, 9, 5, 3).getTime(); // 09:05:03 local

    it("renders HH:MM:SS zero-padded when the format is 'hms'", async () => {
      const { formatTimestamp, setTimeFormat } = await import("../lib/timeFormat");
      setTimeFormat("hms");
      expect(formatTimestamp(instant)).toBe("09:05:03");
    });

    it("renders HH:MM zero-padded (no seconds) when the format is 'hm'", async () => {
      const { formatTimestamp, setTimeFormat } = await import("../lib/timeFormat");
      setTimeFormat("hm");
      expect(formatTimestamp(instant)).toBe("09:05");
    });

    it("tracks the current setting without an explicit key argument", async () => {
      const { formatTimestamp, setTimeFormat } = await import("../lib/timeFormat");
      setTimeFormat("hms");
      expect(formatTimestamp(instant)).toBe("09:05:03");
      setTimeFormat("hm");
      expect(formatTimestamp(instant)).toBe("09:05");
    });
  });
});
