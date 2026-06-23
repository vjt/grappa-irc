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
  // Per-test demuxed shape for the skip-gate probe. Default mirrors
  // sampleClip (a .mov): NOT mp4, so the gate stays closed unless a
  // test opens it explicitly — pre-gate tests keep their behavior.
  format: "mov" as "mp4" | "mov",
  codec: "avc" as string | null,
  getFormatThrows: false,
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
  // The skip-gate discriminates the demuxed container via
  // `instanceof Mp4InputFormat` — mirror the real class hierarchy's
  // OBSERVABLE bit: mp4 and mov are distinct classes.
  class Mp4InputFormat {}
  class QuickTimeInputFormat {}
  class Input {
    async getFormat(): Promise<unknown> {
      if (h.getFormatThrows) throw new Error("unreadable container");
      return h.format === "mp4" ? new Mp4InputFormat() : new QuickTimeInputFormat();
    }
    async getPrimaryVideoTrack(): Promise<{
      getDisplayHeight: () => Promise<number>;
      codec: string | null;
    }> {
      return { getDisplayHeight: async () => h.sourceHeight, codec: h.codec };
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
    Mp4InputFormat,
    Mp4OutputFormat,
    Input,
    Output,
    Conversion: { init: h.conversionInit },
    canEncodeVideo: h.canEncodeVideo,
  };
});

import {
  __setProbeDurationForTests,
  MAX_DURATION_SECONDS,
  MIN_VIDEO_BITRATE_BPS,
  pickEncodeBitrate,
  pickTargetHeight,
} from "../videoPolicy";
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
// `discardedTracks` mirrors mediabunny's `DiscardedTrack` shape
// (conversion.d.ts): { track: InputTrack (with .type), reason: <typed
// union>, trackOptions } — the isValid-false diagnostic reads
// `track.type` + `reason`.
type MockDiscardedTrack = {
  track: { type: "video" | "audio" };
  reason: string;
  trackOptions: Record<string, unknown>;
};
type MockConversion = {
  isValid: boolean;
  discardedTracks: MockDiscardedTrack[];
  onProgress?: (progress: number, processedTime: number) => unknown;
  execute: () => Promise<void>;
  cancel: () => Promise<void>;
};

const installHappyConversion = (): void => {
  h.conversionInit.mockImplementation(async (opts: NonNullable<typeof h.lastInitOptions>) => {
    h.lastInitOptions = opts;
    const conv: MockConversion = {
      isValid: true,
      discardedTracks: [],
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
  h.format = "mov";
  h.codec = "avc";
  h.getFormatThrows = false;
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

describe("pickEncodeBitrate", () => {
  it("generous cap (104s, 100MiB, 720p) → clamped to the 4Mbps ceiling, not the ~7.5Mbps budget", () => {
    // The 2026-06-10 dogfood case: the raw budget is ~7.5Mbps — without
    // the ceiling the output FILLS the cap (~95MiB of a 100MiB cap).
    expect(pickEncodeBitrate(720, 104, 100 * MiB)).toBe(4_000_000);
  });

  it("generous cap at 480p → clamped to the 2Mbps ceiling", () => {
    expect(pickEncodeBitrate(480, 104, 100 * MiB)).toBe(2_000_000);
  });

  it("starved cap (119s, 1MiB) → negative budget floored at MIN_VIDEO_BITRATE_BPS", () => {
    expect(pickEncodeBitrate(480, 119, 1 * MiB)).toBe(MIN_VIDEO_BITRATE_BPS);
  });

  it("budget between floor and ceiling passes through un-clamped", () => {
    // 30s @ 10MiB → floor((10MiB × 0.95 × 8) / 30 − 128k) = 2_528_392 —
    // above the 100k floor, below the 4Mbps 720p ceiling.
    expect(pickEncodeBitrate(720, 30, 10 * MiB)).toBe(2_528_392);
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

  it("gate closed (no WebCodecs) with a legal duration → unsupported, encoder detail", async () => {
    const result = await transcodeVideo(
      sampleClip(),
      cap,
      noProgress,
      new AbortController().signal,
    );

    expect(result).toEqual({
      error: { kind: "unsupported", detail: "no H.264 encoder (WebCodecs)" },
    });
    expect(h.conversionInit).not.toHaveBeenCalled();
  });

  it("unreadable metadata (probe null) with the gate open → unsupported, metadata detail (no budget without duration)", async () => {
    stubWebCodecs();
    __setProbeDurationForTests(async () => null);

    const result = await transcodeVideo(
      sampleClip(),
      cap,
      noProgress,
      new AbortController().signal,
    );

    expect(result).toEqual({
      error: { kind: "unsupported", detail: "unreadable video metadata" },
    });
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
    // The encoder gets the CLAMPED policy bitrate, not the raw budget —
    // 30s @ 50MiB budgets ~13Mbps, ceilinged at 4Mbps for 720p. Wiring
    // is asserted via the production policy fn; the clamp values
    // themselves are pinned in the pickEncodeBitrate describe.
    expect(opts.video.bitrate).toBe(pickEncodeBitrate(720, 30, cap));
    expect(opts.video.bitrate).toBe(4_000_000);
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
        discardedTracks: [],
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
        discardedTracks: [],
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

  it("invalid conversion (isValid false) → unsupported with discardedTracks detail, execute never runs", async () => {
    stubWebCodecs();
    const execute = vi.fn(async () => {});
    h.conversionInit.mockImplementation(async () => {
      const conv: MockConversion = {
        isValid: false,
        // Mirrors mediabunny's DiscardedTrack shape — the diagnostic
        // joins `track.type:reason` per discarded track.
        discardedTracks: [
          { track: { type: "video" }, reason: "undecodable_source_codec", trackOptions: {} },
        ],
        execute,
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

    expect(result).toEqual({
      error: { kind: "unsupported", detail: "video:undecodable_source_codec" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("invalid conversion with EMPTY discardedTracks → generic 'conversion invalid' detail", async () => {
    stubWebCodecs();
    h.conversionInit.mockImplementation(async () => {
      const conv: MockConversion = {
        isValid: false,
        discardedTracks: [],
        execute: vi.fn(async () => {}),
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

    expect(result).toEqual({ error: { kind: "unsupported", detail: "conversion invalid" } });
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
      const conv: MockConversion = { isValid: true, discardedTracks: [], execute, cancel };
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

// --------------------------------------------------------------------
// Skip-gate — already-target-shape sources upload as-is (metadata-strip
// cluster, 2026-06-10). Privacy is the SERVER's job now; this gate is
// pure performance and consults observable facts only.
// --------------------------------------------------------------------

describe("transcodeVideo skip-gate", () => {
  const cap = 50 * MiB;
  const noProgress = (): void => {};
  // 30s @ 50MiB → policy 720p, encode ceiling 4Mbps; +128k audio
  // reserve → overall-bitrate threshold ≈ 15.5 MB for a 30s clip.

  const mp4Clip = (bytes: number): File =>
    new File([new Uint8Array(bytes)], "clip.mp4", { type: "video/mp4" });

  it("H.264-in-mp4, in-policy, under-bitrate, under-cap → the ORIGINAL File comes back, no encode, no WebCodecs needed", async () => {
    // Deliberately NO stubWebCodecs: a compliant file must skip even
    // on platforms that cannot transcode at all.
    h.format = "mp4";
    const file = mp4Clip(16);

    const result = await transcodeVideo(file, cap, noProgress, new AbortController().signal);

    if (!("ok" in result)) throw new Error(`expected ok, got ${JSON.stringify(result)}`);
    expect(result.ok).toBe(file); // same File identity — untouched
    expect(h.conversionInit).not.toHaveBeenCalled();
  });

  it("mov container does NOT skip — same ISOBMFF family, wrong target shape", async () => {
    stubWebCodecs();
    h.format = "mov";

    const result = await transcodeVideo(mp4Clip(16), cap, noProgress, new AbortController().signal);

    expect("ok" in result).toBe(true);
    expect(h.conversionInit).toHaveBeenCalled();
  });

  it("mp4-branded content DECLARED video/quicktime does NOT skip — stored content-type would mismatch", async () => {
    stubWebCodecs();
    h.format = "mp4";
    // sampleClip declares video/quicktime; the demuxed container says
    // mp4. The upload would ride the declared type, so the gate must
    // refuse and let the transcode rename it .mp4/video/mp4.
    await transcodeVideo(sampleClip(), cap, noProgress, new AbortController().signal);

    expect(h.conversionInit).toHaveBeenCalled();
  });

  it("non-avc codec in mp4 does NOT skip", async () => {
    stubWebCodecs();
    h.format = "mp4";
    h.codec = "vp9";

    await transcodeVideo(mp4Clip(16), cap, noProgress, new AbortController().signal);

    expect(h.conversionInit).toHaveBeenCalled();
  });

  it("overall bitrate above what our encode would produce does NOT skip", async () => {
    stubWebCodecs();
    h.format = "mp4";
    // 16 MiB over 30s ≈ 4.5 Mbps overall — above the 4 Mbps 720p
    // ceiling + 128k audio reserve (≈ 4.128 Mbps ≈ 15.5 MB / 30s).
    const result = await transcodeVideo(
      mp4Clip(16 * MiB),
      cap,
      noProgress,
      new AbortController().signal,
    );

    expect("ok" in result).toBe(true);
    expect(h.conversionInit).toHaveBeenCalled();
  });

  it("over-cap original does NOT skip — shrinking is the point", async () => {
    stubWebCodecs();
    h.format = "mp4";
    // 30s @ 1MiB cap: starved budget → the bitrate threshold
    // (~996 kB) sits at the cap, so the cap check is what rejects a
    // 2MiB file — pins condition 4 independently of condition 3.
    const smallCap = 1 * MiB;

    await transcodeVideo(mp4Clip(2 * MiB), smallCap, noProgress, new AbortController().signal);

    expect(h.conversionInit).toHaveBeenCalled();
  });

  it("unreadable container (getFormat throws) falls through to the transcode path", async () => {
    stubWebCodecs();
    h.format = "mp4";
    h.getFormatThrows = true;

    const result = await transcodeVideo(mp4Clip(16), cap, noProgress, new AbortController().signal);

    expect("ok" in result).toBe(true);
    expect(h.conversionInit).toHaveBeenCalled();
  });
});
