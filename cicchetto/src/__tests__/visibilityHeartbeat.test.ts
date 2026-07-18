import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVisibilityHeartbeat, VISIBILITY_HEARTBEAT_MS } from "../lib/visibilityHeartbeat";

describe("visibilityHeartbeat (#318)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("re-reports on the interval while foreground/visible", () => {
    const report = vi.fn();
    const hb = createVisibilityHeartbeat(report, 1000);

    hb.setVisible(true);
    vi.advanceTimersByTime(3000);

    expect(report).toHaveBeenCalledTimes(3);
    hb.stop();
  });

  it("stops re-reporting once hidden (the server then goes stale)", () => {
    const report = vi.fn();
    const hb = createVisibilityHeartbeat(report, 1000);

    hb.setVisible(true);
    vi.advanceTimersByTime(2000);
    expect(report).toHaveBeenCalledTimes(2);

    hb.setVisible(false);
    vi.advanceTimersByTime(5000);
    expect(report).toHaveBeenCalledTimes(2); // no further reports while hidden

    hb.stop();
  });

  it("does not stack intervals when setVisible(true) is called repeatedly", () => {
    const report = vi.fn();
    const hb = createVisibilityHeartbeat(report, 1000);

    hb.setVisible(true);
    hb.setVisible(true);
    hb.setVisible(true);
    vi.advanceTimersByTime(2000);

    expect(report).toHaveBeenCalledTimes(2); // one interval, not three
    hb.stop();
  });

  it("stop() cancels the interval", () => {
    const report = vi.fn();
    const hb = createVisibilityHeartbeat(report, 1000);

    hb.setVisible(true);
    hb.stop();
    vi.advanceTimersByTime(5000);

    expect(report).toHaveBeenCalledTimes(0);
  });

  it("exposes a positive default heartbeat interval", () => {
    expect(VISIBILITY_HEARTBEAT_MS).toBeGreaterThan(0);
  });
});
