// issue 2611 — the level meter's one hard case: a stop that lands while
// `getUserMedia` is still pending. The stream does not exist yet, so a stop
// that only looks at `stream` releases nothing, and the awaited stream then
// lands and runs the meter with the microphone open — tracks never stopped,
// recording indicator lit until the page reloads. The window is the permission
// prompt, which the FIRST dictation always shows.
//
// 🔴 THE AUDIOCONTEXT FAKE IS THE POINT. jsdom has none, so without one a late
// stream falls into the `Ctor === undefined` arm and is released there: the
// test passed with AND without the generation guard, and the guard — the only
// thing standing between a stale stream and a running meter — was unpinned
// (delta-2 review, measured with the guard removed: 0 reds).
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

type Stream = { getTracks: () => { stop: () => void }[] };

const withMicrophone = (stream: Stream): void => {
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => stream) },
  });
};

/** A browser that can actually run the meter, so its start is observable. */
const withAudio = () => {
  const analyser = { fftSize: 0, getFloatTimeDomainData: vi.fn() };
  const createAnalyser = vi.fn(() => analyser);
  const connect = vi.fn();
  const close = vi.fn(async () => undefined);
  // A CLASS, not an arrow: the module does `new Ctor()`, and an arrow cannot
  // be constructed — the shape the delta-2 review found in the recognition
  // stub, where `new` threw and the test measured the stub instead.
  class FakeAudioContext {
    createAnalyser = createAnalyser;
    createMediaStreamSource = () => ({ connect });
    close = close;
  }
  vi.stubGlobal("AudioContext", FakeAudioContext);
  const raf = vi.fn(() => 1);
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return { createAnalyser, close, raf };
};

describe("micLevel (issue 2611)", () => {
  afterEach(() => {
    stopMicMeter();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("releases a stream that arrives after the stop, and never starts the meter on it", async () => {
    const audio = withAudio();
    const pending = deferred<Stream>();
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
    // The guard, not a missing AudioContext: with one present, the meter still
    // never runs on a stream nobody is waiting for any more.
    expect(audio.createAnalyser).not.toHaveBeenCalled();
    expect(audio.raf).not.toHaveBeenCalled();
    expect(micLevel()).toBe(0);
  });

  // Control: the same fake, a stop AFTER the stream landed — the meter runs,
  // and the stop releases it.
  it("runs the meter when the stream lands under no stop, and releases it", async () => {
    const audio = withAudio();
    const stopped = track();
    withMicrophone({ getTracks: () => [stopped] });

    await startMicMeter();

    expect(audio.createAnalyser).toHaveBeenCalledTimes(1);
    expect(audio.raf).toHaveBeenCalledTimes(1);

    stopMicMeter();

    expect(stopped.stop).toHaveBeenCalledTimes(1);
    expect(audio.close).toHaveBeenCalledTimes(1);
    expect(micLevel()).toBe(0);
  });
});
