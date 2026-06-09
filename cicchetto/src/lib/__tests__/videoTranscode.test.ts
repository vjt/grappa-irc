import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock mediabunny at the module boundary — jsdom has no WebCodecs, and
// these tests pin OUR policy (duration ceiling, adaptive height, budget
// math, fallback eligibility), not mediabunny's codec plumbing. The
// mock mirrors the real v1.46 API surface videoTranscode.ts consumes:
// Input/Output/Conversion.init/BlobSource/BufferTarget/Mp4OutputFormat/
// ALL_FORMATS/canEncodeVideo, conversion.onProgress (a property, set
// before execute), conversion.cancel().
const h = vi.hoisted(() => ({
  canEncodeVideo: vi.fn(async (_codec: string) => true),
  conversionInit: vi.fn(),
  // Per-test source track height — the never-upscale clamp reads this.
  sourceHeight: 1080,
  // Captured Conversion.init options for assertion.
  lastInitOptions: null as null | {
    input: unknown;
    output: { target: { buffer: ArrayBuffer | null } };
    video: { codec: string; height: number; bitrate: number };
    tags: Record<string, unknown>;
  },
}));

vi.mock("mediabunny", () => {
  class BlobSource {
    constructor(public blob: Blob) {}
  }
  class BufferTarget {
    buffer: ArrayBuffer | null = null;
  }
  class Mp4OutputFormat {}
  class Input {
    async getPrimaryVideoTrack(): Promise<{ getDisplayHeight: () => Promise<number> }> {
      return { getDisplayHeight: async () => h.sourceHeight };
    }
    dispose(): void {}
  }
  class Output {
    target: BufferTarget;
    constructor(opts: { target: BufferTarget }) {
      this.target = opts.target;
    }
  }
  return {
    ALL_FORMATS: [],
    BlobSource,
    BufferTarget,
    Mp4OutputFormat,
    Input,
    Output,
    Conversion: { init: h.conversionInit },
    canEncodeVideo: h.canEncodeVideo,
  };
});

import { __setProbeDurationForTests, MAX_DURATION_SECONDS, pickTargetHeight } from "../videoPolicy";
import {
  __resetVideoTranscodeSupportForTests,
  transcodeVideo,
  videoTranscodeSupported,
} from "../videoTranscode";

const MiB = 1024 * 1024;

const sampleClip = (): File =>
  new File([new Uint8Array(16)], "clip.mov", { type: "video/quicktime" });

// Conversion mock whose execute() fills the output buffer — the happy
// path. Tests that need failure/cancel override conversionInit inline.
type MockConversion = {
  isValid: boolean;
  onProgress?: (progress: number, processedTime: number) => unknown;
  execute: () => Promise<void>;
  cancel: () => Promise<void>;
};

const installHappyConversion = (): void => {
  h.conversionInit.mockImplementation(async (opts: NonNullable<typeof h.lastInitOptions>) => {
    h.lastInitOptions = opts;
    const conv: MockConversion = {
      isValid: true,
      execute: vi.fn(async () => {
        opts.output.target.buffer = new ArrayBuffer(16);
      }),
      cancel: vi.fn(async () => {}),
    };
    return conv;
  });
};

const stubWebCodecs = (): void => {
  vi.stubGlobal("VideoEncoder", class {});
};

beforeEach(() => {
  h.sourceHeight = 1080;
  h.lastInitOptions = null;
  h.canEncodeVideo.mockClear();
  h.canEncodeVideo.mockResolvedValue(true);
  h.conversionInit.mockClear();
  installHappyConversion();
  __resetVideoTranscodeSupportForTests();
  // jsdom never fires <video> loadedmetadata — every test drives the
  // probe through the seam.
  __setProbeDurationForTests(async () => 30);
});

// cp60 gotcha: restore global stubs in afterEach, never in a
// describe-level beforeEach.
afterEach(() => {
  vi.unstubAllGlobals();
  __setProbeDurationForTests(null);
});

// --------------------------------------------------------------------
// Support gate
// --------------------------------------------------------------------

describe("videoTranscodeSupported", () => {
  it("is false when VideoEncoder is absent (jsdom default) — avc probe never runs", async () => {
    expect(await videoTranscodeSupported()).toBe(false);
    expect(h.canEncodeVideo).not.toHaveBeenCalled();
  });

  it("is true when VideoEncoder exists and the avc probe says yes", async () => {
    stubWebCodecs();
    expect(await videoTranscodeSupported()).toBe(true);
    expect(h.canEncodeVideo).toHaveBeenCalledWith("avc");
  });

  it("is false when VideoEncoder exists but the avc probe says no", async () => {
    stubWebCodecs();
    h.canEncodeVideo.mockResolvedValue(false);
    expect(await videoTranscodeSupported()).toBe(false);
  });

  it("caches the result — probe runs once across two calls", async () => {
    stubWebCodecs();
    expect(await videoTranscodeSupported()).toBe(true);
    expect(await videoTranscodeSupported()).toBe(true);
    expect(h.canEncodeVideo).toHaveBeenCalledTimes(1);
  });
});

// --------------------------------------------------------------------
// Adaptive resolution policy — pure budget math
// --------------------------------------------------------------------

describe("pickTargetHeight", () => {
  it("30s under a 50MB cap → comfortable budget → 720p", () => {
    expect(pickTargetHeight(30, 50 * MiB)).toBe(720);
  });

  it("110s under a 50MB cap → still above the 2Mbps threshold → 720p", () => {
    expect(pickTargetHeight(110, 50 * MiB)).toBe(720);
  });

  it("110s under a 4MB cap → starved budget → 480p", () => {
    expect(pickTargetHeight(110, 4 * MiB)).toBe(480);
  });
});

// --------------------------------------------------------------------
// transcodeVideo
// --------------------------------------------------------------------

describe("transcodeVideo", () => {
  const cap = 50 * MiB;
  const noProgress = (): void => {};

  it("rejects a pre-aborted signal immediately — Conversion.init never runs", async () => {
    stubWebCodecs();
    const controller = new AbortController();
    controller.abort();

    const result = await transcodeVideo(sampleClip(), cap, noProgress, controller.signal);

    expect(result).toEqual({ error: { kind: "failed", message: "aborted" } });
    expect(h.conversionInit).not.toHaveBeenCalled();
  });

  it("duration over the 2-minute ceiling → too_long, even WITHOUT WebCodecs (policy precedes capability)", async () => {
    // No VideoEncoder stub on purpose — the policy gate must bind on
    // the fallback path too.
    __setProbeDurationForTests(async () => 300);

    const result = await transcodeVideo(
      sampleClip(),
      cap,
      noProgress,
      new AbortController().signal,
    );

    expect(result).toEqual({ error: { kind: "too_long", durationSeconds: 300 } });
    expect(h.conversionInit).not.toHaveBeenCalled();
  });

  it("gate closed (no WebCodecs) with a legal duration → unsupported", async () => {
    const result = await transcodeVideo(
      sampleClip(),
      cap,
      noProgress,
      new AbortController().signal,
    );

    expect(result).toEqual({ error: { kind: "unsupported" } });
    expect(h.conversionInit).not.toHaveBeenCalled();
  });

  it("unreadable metadata (probe null) with the gate open → unsupported (no budget without duration)", async () => {
    stubWebCodecs();
    __setProbeDurationForTests(async () => null);

    const result = await transcodeVideo(
      sampleClip(),
      cap,
      noProgress,
      new AbortController().signal,
    );

    expect(result).toEqual({ error: { kind: "unsupported" } });
  });

  it("happy path: avc/mp4 out, adaptive height, budget bitrate, EMPTY tags, .mp4 filename", async () => {
    stubWebCodecs();

    const result = await transcodeVideo(
      sampleClip(),
      cap,
      noProgress,
      new AbortController().signal,
    );

    if (!("ok" in result)) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.ok.name).toBe("clip.mp4");
    expect(result.ok.type).toBe("video/mp4");

    const opts = h.lastInitOptions;
    if (opts === null) throw new Error("Conversion.init not called");
    expect(opts.video.codec).toBe("avc");
    // 30s @ 50MB → budget well above 2Mbps → 720p (source is 1080).
    expect(opts.video.height).toBe(720);
    // floor((cap × 0.95 × 8) / duration − 128k audio budget).
    expect(opts.video.bitrate).toBe(Math.floor((cap * 0.95 * 8) / 30 - 128_000));
    // Load-bearing: mediabunny COPIES input metadata tags by default.
    // Empty tags is what makes "metadata dies with the container" true.
    expect(opts.tags).toEqual({});
  });

  it("never upscales — target clamped to the source height", async () => {
    stubWebCodecs();
    h.sourceHeight = 480;

    const result = await transcodeVideo(
      sampleClip(),
      cap,
      noProgress,
      new AbortController().signal,
    );

    expect("ok" in result).toBe(true);
    expect(h.lastInitOptions?.video.height).toBe(480);
  });

  it("forwards conversion progress fractions to onProgress", async () => {
    stubWebCodecs();
    h.conversionInit.mockImplementation(async (opts: NonNullable<typeof h.lastInitOptions>) => {
      const conv: MockConversion = {
        isValid: true,
        execute: vi.fn(async function (this: void) {
          conv.onProgress?.(0.5, 15);
          opts.output.target.buffer = new ArrayBuffer(16);
        }),
        cancel: vi.fn(async () => {}),
      };
      return conv;
    });
    const seen: number[] = [];

    await transcodeVideo(sampleClip(), cap, (f) => seen.push(f), new AbortController().signal);

    expect(seen).toEqual([0.5]);
  });

  it("mid-conversion crash → failed with the thrown message", async () => {
    stubWebCodecs();
    h.conversionInit.mockImplementation(async () => {
      const conv: MockConversion = {
        isValid: true,
        execute: vi.fn(async () => {
          throw new Error("encoder blew up");
        }),
        cancel: vi.fn(async () => {}),
      };
      return conv;
    });

    const result = await transcodeVideo(
      sampleClip(),
      cap,
      noProgress,
      new AbortController().signal,
    );

    expect(result).toEqual({ error: { kind: "failed", message: "encoder blew up" } });
  });

  it("invalid conversion (isValid false) → unsupported, execute never runs", async () => {
    stubWebCodecs();
    const execute = vi.fn(async () => {});
    h.conversionInit.mockImplementation(async () => {
      const conv: MockConversion = { isValid: false, execute, cancel: vi.fn(async () => {}) };
      return conv;
    });

    const result = await transcodeVideo(
      sampleClip(),
      cap,
      noProgress,
      new AbortController().signal,
    );

    expect(result).toEqual({ error: { kind: "unsupported" } });
    expect(execute).not.toHaveBeenCalled();
  });

  it("abort during conversion → conversion.cancel() called, result is failed", async () => {
    stubWebCodecs();
    let rejectExecute: ((err: unknown) => void) | null = null;
    const cancel = vi.fn(async () => {
      rejectExecute?.(new Error("conversion canceled"));
    });
    const execute = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectExecute = reject;
        }),
    );
    h.conversionInit.mockImplementation(async () => {
      const conv: MockConversion = { isValid: true, execute, cancel };
      return conv;
    });

    const controller = new AbortController();
    const pending = transcodeVideo(sampleClip(), cap, noProgress, controller.signal);
    await vi.waitFor(() => expect(execute).toHaveBeenCalled());
    controller.abort();

    const result = await pending;
    expect(cancel).toHaveBeenCalled();
    expect(result).toEqual({ error: { kind: "failed", message: "conversion canceled" } });
  });

  it("MAX_DURATION_SECONDS is the spec'd 120s policy ceiling", () => {
    expect(MAX_DURATION_SECONDS).toBe(120);
  });
});
