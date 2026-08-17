// #1336 — the gesture is the instrument two scroll specs are judged by, so it
// has to be evidence rather than a hope. Runs under the cic vitest project
// (same reason, same shape as `whoisWait.test.ts`): the wait is deliberately
// free of Playwright, so it is provable without a testnet.
//
// The cases that matter are the ones the OLD idiom
// (`expect.poll(async () => { wheel(); return distance })`) got wrong:
// the wheel had not been applied yet when the predicate was read, and the
// predicate was ALREADY true of the pre-gesture state — measured on
// issue168-scroll-authority, where `scrollTop` was byte-identical (1078)
// before and after the "page up", and the scroll landed ~250 ms later,
// inside the next step.

import { describe, expect, it } from "vitest";
import { type ScrollPane, scrollByGesture, waitForScrollRest } from "./scrollGesture";

type Recorded = { calls: string[]; pane: ScrollPane };

// A pane whose scrollTop walks the given script, one entry per read.
function fakePane(script: readonly number[]): Recorded {
  const calls: string[] = [];
  let reads = 0;
  return {
    calls,
    pane: {
      hover: async () => {
        calls.push("hover");
      },
      wheel: async (deltaY: number) => {
        calls.push(`wheel:${deltaY}`);
      },
      scrollTop: async () => {
        const value = script[Math.min(reads, script.length - 1)] ?? 0;
        reads += 1;
        calls.push(`read:${value}`);
        return value;
      },
    },
  };
}

async function failureOf(gesture: Promise<unknown>): Promise<string> {
  try {
    await gesture;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the gesture to reject, but it resolved");
}

describe("#1336 — scrollByGesture", () => {
  it("hovers BEFORE it wheels", async () => {
    const { calls, pane } = fakePane([1078, 500, 500]);
    await scrollByGesture(pane, { deltaY: -4000, timeoutMs: 1_000, pollMs: 1 });
    expect(calls.indexOf("hover")).toBeLessThan(calls.indexOf("wheel:-4000"));
  });

  it("returns the from/to pair once the scroll has moved and settled", async () => {
    const { pane } = fakePane([1078, 900, 800, 800]);
    const moved = await scrollByGesture(pane, { deltaY: -4000, timeoutMs: 1_000, pollMs: 1 });
    expect(moved).toEqual({ from: 1078, to: 800 });
  });

  it("does not return on a mid-flight sample — it waits for two that AGREE", async () => {
    // 900 and 800 are both mid-flight: the pane is still travelling and each
    // would report a position it is about to leave, which is the whole defect
    // being fixed. Only 700 repeats, so only 700 is a resting place. A
    // "return once it changed twice" implementation answers 800 here.
    const { pane } = fakePane([1078, 900, 800, 700, 700]);
    const moved = await scrollByGesture(pane, { deltaY: -4000, timeoutMs: 1_000, pollMs: 1 });
    expect(moved.to).toBe(700);
  });

  it("REJECTS when the wheel never moved the pane", async () => {
    // Measured: a wheel dispatched with the mouse elsewhere is inert and the
    // old idiom passed anyway, for a whole run.
    const { pane } = fakePane([1078]);
    expect(
      await failureOf(scrollByGesture(pane, { deltaY: -4000, timeoutMs: 20, pollMs: 1 })),
    ).toContain("never moved");
  });

  it("REJECTS when the pane is still moving at the deadline", async () => {
    let value = 1078;
    const pane: ScrollPane = {
      hover: async () => {},
      wheel: async () => {},
      scrollTop: async () => {
        value -= 10;
        return value;
      },
    };
    expect(
      await failureOf(scrollByGesture(pane, { deltaY: -4000, timeoutMs: 20, pollMs: 1 })),
    ).toContain("never settled");
  });
});

// The scrollTop writes a SWITCH into #bofh performs, recorded in-page on the
// dev host (2026-08-17, #1336 S2 probe, four iterations at CPU throttle 1x/6x/
// 12x/20x — the shape was identical in all four, only the timings stretched):
//
//     t=0ms   354   the $server pane we switch away from
//     t=45ms    7   the rows recreation resets scrollTop to the top
//     t=59ms 1055   the marker jump, in flight
//     t=78ms 1078   the marker, at rest
//
// and the pane's own geometry at that moment: scrollHeight 1627, clientHeight
// 212, so maxScroll = 1415. These are DATA, not an example — every assertion
// below is arithmetic on them.
// Only the three POST-CLICK writes: 354 is where the $server pane we switch
// away from was sitting, and the barrier cannot sample it — the spec gates on
// the row count and the marker existing first, which the switch must complete
// to satisfy. Replaying it would overstate the defect.
const MEASURED_SWITCH_WRITES = [7, 1055, 1078] as const;
const MEASURED_MAX_SCROLL = 1415;
const MARKER_SCROLL_TOP = 1078;
const SCROLL_BOTTOM_THRESHOLD_PX = 50;

describe("#1336 S2 — waitForScrollRest, and the barrier it replaces", () => {
  // The defect, executed rather than argued. The pre-send barrier in
  // scroll-on-window-switch.spec.ts is `distance-to-bottom > 50`, and
  // `expect.poll` returns on the FIRST evaluation that satisfies it. Replayed
  // against the writes actually recorded, that first satisfying sample is the
  // RESET (scrollTop 7, distance 1408) — the moment the rows were recreated
  // and the marker jump had not happened yet. The barrier cannot tell "the
  // switch landed on the marker" from "the pane is at the top on its way
  // there", because both are far from the bottom.
  it("the OLD distance-only predicate is satisfied by the reset, not by the marker", () => {
    const distances = MEASURED_SWITCH_WRITES.map((st) => MEASURED_MAX_SCROLL - st);
    const firstAccepted = distances.findIndex((d) => d > SCROLL_BOTTOM_THRESHOLD_PX);

    expect(MEASURED_SWITCH_WRITES[firstAccepted]).toBe(7);
    expect(distances[firstAccepted]).toBe(1408);
    // …and the position it was supposed to be waiting for is 337 away from the
    // bottom — the number #1079 reported, twice, on two trees.
    expect(MEASURED_MAX_SCROLL - MARKER_SCROLL_TOP).toBe(337);
  });

  it("waits past the reset and the in-flight sample, and reports the MARKER", async () => {
    const { pane } = fakePane([...MEASURED_SWITCH_WRITES, MARKER_SCROLL_TOP]);
    expect(await waitForScrollRest(pane, { timeoutMs: 1_000, pollMs: 1 })).toBe(MARKER_SCROLL_TOP);
  });

  it("does not mistake two equal samples STRADDLING a move for rest", async () => {
    // A pane that returns to a value it already held is not the same as a pane
    // that never left it: only ADJACENT agreement is rest. Without that, the
    // 1078 here would be read as rest while the pane is still travelling.
    const { pane } = fakePane([1078, 7, 1078, 400, 400]);
    expect(await waitForScrollRest(pane, { timeoutMs: 1_000, pollMs: 1 })).toBe(400);
  });

  it("REJECTS a pane that never comes to rest, naming the last position", async () => {
    let value = 1078;
    const pane: ScrollPane = {
      hover: async () => {},
      wheel: async () => {},
      scrollTop: async () => {
        value -= 10;
        return value;
      },
    };
    const message = await failureOf(waitForScrollRest(pane, { timeoutMs: 20, pollMs: 1 }));
    expect(message).toContain("never came to rest");
    expect(message).toMatch(/last \d+/);
  });

  it("does not call a pane written every 20ms 'at rest', however fast it is read", async () => {
    // The fakes above answer from a script, so two reads taken in the same
    // millisecond look exactly like two reads a poll apart — a barrier that
    // compares samples with no gap between them passes every one of those
    // tests while being worthless. This pane answers from a CLOCK instead,
    // which is the only way the omission becomes visible.
    //
    // Not hypothetical: the first version of this barrier resolved instantly
    // in situ against a pane an injected `setInterval` was moving 1px every
    // 20ms, and the spec then failed downstream on an anonymous number
    // instead of here, by name.
    const start = Date.now();
    const movingPane: Pick<ScrollPane, "scrollTop"> = {
      scrollTop: async () => 1078 - Math.floor((Date.now() - start) / 20),
    };
    expect(
      await failureOf(waitForScrollRest(movingPane, { timeoutMs: 300, pollMs: 50 })),
    ).toContain("never came to rest");
  });

  it("resolves at the position the pane was ALREADY holding", async () => {
    // A settled pane is settled; the barrier is about rest, not about movement
    // (that is `scrollByGesture`'s job, and it rejects a pane that never moved).
    const { pane } = fakePane([1078, 1078]);
    expect(await waitForScrollRest(pane, { timeoutMs: 1_000, pollMs: 1 })).toBe(1078);
  });
});
