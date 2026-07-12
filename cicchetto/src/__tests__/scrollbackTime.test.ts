import { afterEach, describe, expect, it } from "vitest";
import { setTimeFormat } from "../lib/timeFormat";
import { formatTime } from "../ScrollbackPane";

// #217 — message-row timestamps are user-configurable (Settings → timestamp
// format), defaulting to WITH seconds (HH:MM:SS). This supersedes #208's
// fixed HH:MM: `formatTime` is now a thin wrapper over the shared
// lib/timeFormat formatter, so it reflects whatever key the operator picked.
describe("ScrollbackPane formatTime", () => {
  // The format is a module-singleton signal; reset to the default after each
  // case so an "hm" case can't leak into a sibling (or another spec file
  // sharing the module in the same worker).
  afterEach(() => setTimeFormat("hms"));

  it("defaults to HH:MM:SS (with seconds) — the #217 default", () => {
    // Build the epoch from local components so the assertion is
    // timezone-independent (the formatter uses getHours/getMinutes/getSeconds,
    // all local).
    const epoch = new Date(2026, 6, 10, 9, 5, 37, 500).getTime();
    setTimeFormat("hms");
    expect(formatTime(epoch)).toBe("09:05:37");
  });

  it("zero-pads hours, minutes, and seconds", () => {
    const epoch = new Date(2026, 0, 1, 3, 7, 4, 0).getTime();
    setTimeFormat("hms");
    expect(formatTime(epoch)).toBe("03:07:04");
  });

  it("drops the seconds component when the operator picks HH:MM", () => {
    const epoch = new Date(2026, 6, 10, 23, 59, 59, 0).getTime();
    setTimeFormat("hm");
    const out = formatTime(epoch);
    expect(out).toBe("23:59");
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });
});
