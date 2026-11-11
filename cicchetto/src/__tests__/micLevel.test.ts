// issue 2611 — the level meter's one hard case: a stop that lands while
// `getUserMedia` is still pending. The stream does not exist yet, so a stop
// that only looks at `stream` releases nothing, and the awaited stream then
// lands and runs the meter with the microphone open — tracks never stopped,
// recording indicator lit until the page reloads. The window is the permission
// prompt, which the FIRST dictation always shows.
import { afterEach, describe, expect, it, vi } from "vitest";
import { micLevel, startMicMeter, stopMicMeter } from "../lib/micLevel";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

const track = () => ({ stop: vi.fn() });

const withMicrophone = (stream: { getTracks: () => { stop: () => void }[] }): void => {
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
};

describe("micLevel (issue 2611)", () => {
  afterEach(() => {
    stopMicMeter();
    vi.unstubAllGlobals();
    // jsdom has no AudioContext: the meter stops right after the stream
    // lands, which is what the release paths below assert.
    vi.restoreAllMocks();
  });

  it("releases a stream that arrives after the stop", async () => {
    const pending = deferred<{ getTracks: () => { stop: () => void }[] }>();
    const stopped = track();
    Object.defineProperty(globalThis.navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(() => pending.promise) },
    });

    const starting = startMicMeter();
    // The operator taps stop while the permission prompt is still up.
    stopMicMeter();
    pending.resolve({ getTracks: () => [stopped] });
    await starting;

    expect(stopped.stop).toHaveBeenCalledTimes(1);
    expect(micLevel()).toBe(0);
  });

  // Control: the same meter, a stop AFTER the stream landed.
  it("releases the stream when the stop comes after it is open", async () => {
    const stopped = track();
    withMicrophone({ getTracks: () => [stopped] });

    await startMicMeter();
    stopMicMeter();

    expect(stopped.stop).toHaveBeenCalledTimes(1);
    expect(micLevel()).toBe(0);
  });
});
