import { describe, expect, it } from "vitest";
import { formatTime } from "../ScrollbackPane";

// #208 — message-row timestamps render HH:MM (no seconds).
describe("ScrollbackPane formatTime", () => {
  it("formats a local epoch-ms as HH:MM with no seconds", () => {
    // Build the epoch from local components so the assertion is
    // timezone-independent (formatTime uses getHours/getMinutes, local).
    const epoch = new Date(2026, 6, 10, 9, 5, 37, 500).getTime();
    expect(formatTime(epoch)).toBe("09:05");
  });

  it("zero-pads single-digit hours and minutes", () => {
    const epoch = new Date(2026, 0, 1, 3, 7, 0, 0).getTime();
    expect(formatTime(epoch)).toBe("03:07");
  });

  it("never emits a seconds component (HH:MM only)", () => {
    const epoch = new Date(2026, 6, 10, 23, 59, 59, 0).getTime();
    const out = formatTime(epoch);
    expect(out).toBe("23:59");
    expect(out).toMatch(/^\d{2}:\d{2}$/);
  });
});
