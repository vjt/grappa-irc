import { createRoot, createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STALE_RESUME_HOURS,
  installStaleResumeReload,
  isStaleResume,
  markActive,
  readLastActive,
  STALE_RESUME_HOURS_KEY,
  STALE_RESUME_STAMP_KEY,
  staleResumeThresholdMs,
} from "../lib/staleResume";

// #695 — reload the whole client on resume after a prolonged absence.
//
// The interval is measured from a PERSISTED stamp, never from a timer: the
// whole point is a document iOS suspended for two days, with no JS running
// for the entire window. Every test here therefore drives `now` as a plain
// value and never advances a fake clock — if a test needed a timer to trip
// the threshold, the implementation would be measuring the wrong thing.

const HOUR = 3_600_000;

// setupTests.ts installs a fresh localStorage per test but leaves jsdom's
// sessionStorage — where the stamp lives — untouched, so it would bleed the
// stamp between cases.
beforeEach(() => {
  sessionStorage.clear();
});

// Solid's effect queue is flushed on a macrotask (same idiom as
// badge.test.ts's mountBadgeSync case).
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

interface Harness {
  visible: (v: boolean) => void;
  pageshow: () => void;
  // The verb `installStaleResumeReload` hands back — what main.tsx wires into
  // the #318 foreground heartbeat.
  heartbeatTick: () => void;
  setNow: (t: number) => void;
  reload: ReturnType<typeof vi.fn>;
  dispose: () => void;
}

function install(startNow: number): Harness {
  let now = startNow;
  const reload = vi.fn();
  const [isVisible, setVisible] = createSignal(true);
  const handlers: Array<() => void> = [];
  let dispose = (): void => {};
  let check = (): void => {};
  createRoot((d) => {
    dispose = d;
    check = installStaleResumeReload({
      isVisible,
      now: () => now,
      reload,
      win: {
        addEventListener: (_event: "pageshow", handler: () => void) => {
          handlers.push(handler);
        },
      },
    });
  });
  return {
    visible: setVisible,
    pageshow: () => {
      for (const h of handlers) h();
    },
    heartbeatTick: () => check(),
    setNow: (t: number) => {
      now = t;
    },
    reload,
    dispose,
  };
}

describe("staleResume — threshold resolution", () => {
  it("defaults to 48h when no override is stored", () => {
    expect(DEFAULT_STALE_RESUME_HOURS).toBe(48);
    expect(staleResumeThresholdMs()).toBe(48 * HOUR);
  });

  it("honours a stored override, so the threshold moves without a deploy", () => {
    localStorage.setItem(STALE_RESUME_HOURS_KEY, "6");
    expect(staleResumeThresholdMs()).toBe(6 * HOUR);
  });

  it("falls back to the default on a non-numeric override", () => {
    localStorage.setItem(STALE_RESUME_HOURS_KEY, "soon");
    expect(staleResumeThresholdMs()).toBe(DEFAULT_STALE_RESUME_HOURS * HOUR);
  });

  it("falls back to the default on a non-positive override — a typo must not reload on every resume", () => {
    localStorage.setItem(STALE_RESUME_HOURS_KEY, "0");
    expect(staleResumeThresholdMs()).toBe(DEFAULT_STALE_RESUME_HOURS * HOUR);
    localStorage.setItem(STALE_RESUME_HOURS_KEY, "-3");
    expect(staleResumeThresholdMs()).toBe(DEFAULT_STALE_RESUME_HOURS * HOUR);
  });
});

describe("staleResume — the persisted stamp", () => {
  it("markActive writes the stamp and readLastActive reads it back", () => {
    markActive(1_700_000_000_000);
    expect(readLastActive()).toBe(1_700_000_000_000);
  });

  it("lives in sessionStorage, so a foreground tab in another window cannot refresh it", () => {
    markActive(1_700_000_000_000);
    expect(sessionStorage.getItem(STALE_RESUME_STAMP_KEY)).toBe("1700000000000");
    expect(localStorage.getItem(STALE_RESUME_STAMP_KEY)).toBeNull();
  });

  it("readLastActive is null when nothing was ever stamped", () => {
    expect(readLastActive()).toBeNull();
  });

  it("readLastActive is null on a corrupt stamp", () => {
    sessionStorage.setItem(STALE_RESUME_STAMP_KEY, "yesterday");
    expect(readLastActive()).toBeNull();
  });
});

describe("isStaleResume — the decision", () => {
  const t0 = 1_700_000_000_000;

  it("is false under the threshold", () => {
    expect(isStaleResume(t0 + 47 * HOUR, t0, 48 * HOUR)).toBe(false);
  });

  it("is false exactly at the threshold", () => {
    expect(isStaleResume(t0 + 48 * HOUR, t0, 48 * HOUR)).toBe(false);
  });

  it("is true over the threshold", () => {
    expect(isStaleResume(t0 + 48 * HOUR + 1, t0, 48 * HOUR)).toBe(true);
  });

  it("is false with no stamp — a first-ever boot has nothing to be stale against", () => {
    expect(isStaleResume(t0 + 1000 * HOUR, null, 48 * HOUR)).toBe(false);
  });

  it("is false on a future-dated stamp — a backwards clock step must not reload", () => {
    expect(isStaleResume(t0, t0 + 10 * HOUR, 48 * HOUR)).toBe(false);
  });
});

describe("installStaleResumeReload", () => {
  const t0 = 1_700_000_000_000;

  it("stamps this document active at install, so the document that just reloaded does not reload again", async () => {
    // The stale stamp survives the reload (same window, same sessionStorage).
    // Without the pre-arm write the fresh document would read it, trip, and
    // reload again — the loop the issue calls out by name.
    markActive(t0 - 336 * HOUR);
    const h = install(t0);
    await flush();
    expect(h.reload).not.toHaveBeenCalled();
    expect(readLastActive()).toBe(t0);
    h.dispose();
  });

  it("does not reload on a resume under the threshold", async () => {
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 47 * HOUR);
    h.visible(true);
    await flush();
    expect(h.reload).not.toHaveBeenCalled();
    h.dispose();
  });

  it("reloads on a resume over the threshold, driven by the stamp with no timer running", async () => {
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    // The OS suspended the document here: no heartbeat tick, no
    // visibilitychange, no JS at all for 50 hours. Only the stamp survives.
    expect(readLastActive()).toBe(t0);
    h.setNow(t0 + 50 * HOUR);
    h.visible(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("refreshes the stamp as it reloads, so more triggers cannot stack a second reload", async () => {
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 50 * HOUR);
    h.visible(true);
    await flush();
    // More resume triggers arrive before the navigation completes — a
    // pageshow and another visibility round-trip.
    h.pageshow();
    h.visible(false);
    await flush();
    h.visible(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    // And the document is left healthy rather than wedged: a reload that
    // never lands must not disable the feature for this document's whole
    // remaining life.
    expect(readLastActive()).toBe(t0 + 50 * HOUR);
    h.dispose();
  });

  it("re-arms after a reload that never landed — a later genuine absence still trips", async () => {
    const h = install(t0);
    await flush();
    h.setNow(t0 + 50 * HOUR);
    h.pageshow();
    expect(h.reload).toHaveBeenCalledTimes(1);
    // The navigation was blocked; this document lives on and is used again.
    h.setNow(t0 + 200 * HOUR);
    h.pageshow();
    expect(h.reload).toHaveBeenCalledTimes(2);
    h.dispose();
  });

  it("trips on the foreground heartbeat tick — the iOS thaw that fires no visibility transition", async () => {
    const h = install(t0);
    await flush();
    // iOS froze the document without firing visibilitychange, so the signal
    // never changed and pageshow never fired. The interval was frozen too;
    // its first tick after the thaw is the only observer left.
    h.setNow(t0 + 50 * HOUR);
    h.heartbeatTick();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("a heartbeat tick during genuine foreground use only refreshes the stamp", async () => {
    const h = install(t0);
    await flush();
    h.setNow(t0 + 30_000);
    h.heartbeatTick();
    expect(h.reload).not.toHaveBeenCalled();
    expect(readLastActive()).toBe(t0 + 30_000);
    h.dispose();
  });

  it("reloads on a pageshow — the bfcache restore the visibility signal never sees", async () => {
    const h = install(t0);
    await flush();
    h.setNow(t0 + 50 * HOUR);
    h.pageshow();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("refreshes the stamp on every trigger while still fresh", async () => {
    const h = install(t0);
    await flush();
    h.setNow(t0 + 2 * HOUR);
    h.visible(false);
    await flush();
    expect(readLastActive()).toBe(t0 + 2 * HOUR);
    h.setNow(t0 + 3 * HOUR);
    h.pageshow();
    expect(readLastActive()).toBe(t0 + 3 * HOUR);
    h.dispose();
  });

  it("honours the stored override — a 6h threshold trips on a 7h absence", async () => {
    localStorage.setItem(STALE_RESUME_HOURS_KEY, "6");
    const h = install(t0);
    await flush();
    h.visible(false);
    await flush();
    h.setNow(t0 + 7 * HOUR);
    h.visible(true);
    await flush();
    expect(h.reload).toHaveBeenCalledTimes(1);
    h.dispose();
  });
});
