// Client-side video downscale — video+document uploads cluster Task 6
// (2026-06-09).
//
// mediabunny (WebCodecs under the hood): demux mp4/mov/webm → H.264
// mp4 out, audio passthrough when the source track fits the container
// (the iPhone AAC case — Chrome has no AAC encoder; an unmanageable
// track is discarded with a mediabunny console warning and the output
// proceeds video-only, non-blocking). Transcode-always when supported:
// output is uniformly mp4 and metadata-free. NOTE the metadata death
// is NOT mediabunny's default — `Conversion.init` COPIES input tags
// unless told otherwise; the explicit `tags: {}` below is what makes
// GPS/creation-time die by construction.
//
// Policy vs capability split (the orchestrator's fallback contract):
// - `too_long` is POLICY — duration is read via a <video> element's
//   loadedmetadata, which works WITHOUT WebCodecs, so the 2-minute
//   ceiling binds on the fallback path too. Hard reject, no fallback.
// - `unsupported` / `failed` are CAPABILITY — the orchestrator falls
//   back to uploading the original under the same policy gates.
//
// Adaptive resolution: bitrate budget = (95% × cap × 8) / duration −
// 128kbps audio reserve; a comfortable budget (≥ 2 Mbps) gets 720p,
// a starved one 480p. Never upscale — mediabunny scales to the
// requested box unconditionally, so the target is clamped to the
// source track's display height.
//
// Spec: docs/superpowers/specs/2026-06-09-video-doc-uploads-design.md

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  canEncodeVideo,
  Input,
  Mp4OutputFormat,
  Output,
} from "mediabunny";

export type TranscodeError =
  | { kind: "too_long"; durationSeconds: number } // policy — hard reject, no fallback
  | { kind: "unsupported" } // capability — fallback eligible
  | { kind: "failed"; message: string }; // capability — fallback eligible

export const MAX_DURATION_SECONDS = 120;
export const RESOLUTION_THRESHOLD_BPS = 2_000_000;
const AUDIO_BUDGET_BPS = 128_000;
const CAP_SAFETY = 0.95; // VBR overshoot margin
// Degenerate cap/duration combos (tiny cap × near-ceiling duration)
// drive the budget to ≤ 0 — clamp so the encoder never sees a nonsense
// bitrate; the over-cap output is rejected by the downstream cap check.
const MIN_VIDEO_BITRATE_BPS = 100_000;

// --------------------------------------------------------------------
// Support gate — WebCodecs presence + avc encodability, session-cached.
// --------------------------------------------------------------------

let supportProbe: Promise<boolean> | null = null;

export function videoTranscodeSupported(): Promise<boolean> {
  supportProbe ??= (async () => {
    // `in` check rather than `typeof VideoEncoder` so the gate doesn't
    // depend on lib.dom carrying WebCodecs declarations.
    if (!("VideoEncoder" in globalThis)) return false;
    return canEncodeVideo("avc");
  })();
  return supportProbe;
}

/** Test-only: drop the cached probe result. Production never calls
 *  this — the gate cannot change mid-session. */
export function __resetVideoTranscodeSupportForTests(): void {
  supportProbe = null;
}

// --------------------------------------------------------------------
// Duration probe — <video> loadedmetadata. Deliberately NOT mediabunny:
// it must work without WebCodecs so the 2-minute policy ceiling binds
// on the fallback path. jsdom never fires loadedmetadata, so tests
// swap the implementation via the seam below (same pattern as
// uploadHost.ts `__setUploadTokenReader`).
// --------------------------------------------------------------------

function probeDurationViaVideoElement(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(video.duration) ? video.duration : null);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    video.src = url;
  });
}

let probeDurationImpl: (file: File) => Promise<number | null> = probeDurationViaVideoElement;

/** Duration in seconds via <video> metadata; null when the browser
 *  cannot read the file's metadata. */
export function probeDuration(file: File): Promise<number | null> {
  return probeDurationImpl(file);
}

/** Test-only seam — null restores the real <video>-element probe. */
export function __setProbeDurationForTests(
  fn: ((file: File) => Promise<number | null>) | null,
): void {
  probeDurationImpl = fn ?? probeDurationViaVideoElement;
}

// --------------------------------------------------------------------
// Adaptive resolution policy — pure budget math, exported for tests.
// --------------------------------------------------------------------

function videoBitrateBudget(durationSeconds: number, capBytes: number): number {
  return (capBytes * CAP_SAFETY * 8) / durationSeconds - AUDIO_BUDGET_BPS;
}

export function pickTargetHeight(durationSeconds: number, capBytes: number): 720 | 480 {
  return videoBitrateBudget(durationSeconds, capBytes) >= RESOLUTION_THRESHOLD_BPS ? 720 : 480;
}

// --------------------------------------------------------------------
// Transcode
// --------------------------------------------------------------------

/** Transcode `file` to an adaptive-resolution H.264 mp4 sized for
 *  `capBytes`. Resolves `{ok}` with a fresh `<basename>.mp4` File, or
 *  `{error}` per the policy/capability split in the moduledoc. Honors
 *  `signal`: pre-aborted → immediate failed; mid-flight abort cancels
 *  the conversion. */
export async function transcodeVideo(
  file: File,
  capBytes: number,
  onProgress: (fraction: number) => void,
  signal: AbortSignal,
): Promise<{ ok: File } | { error: TranscodeError }> {
  if (signal.aborted) return { error: { kind: "failed", message: "aborted" } };

  // Policy gate FIRST — binds even when the capability gate is closed.
  const durationSeconds = await probeDuration(file);
  if (durationSeconds !== null && durationSeconds > MAX_DURATION_SECONDS) {
    return { error: { kind: "too_long", durationSeconds } };
  }

  if (!(await videoTranscodeSupported())) return { error: { kind: "unsupported" } };
  if (durationSeconds === null) {
    // No duration → no bitrate budget. Capability failure: the
    // orchestrator falls back to the original under the same gates.
    return { error: { kind: "unsupported" } };
  }

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track === null) return { error: { kind: "unsupported" } };
    const sourceHeight = await track.getDisplayHeight();
    const height = Math.min(pickTargetHeight(durationSeconds, capBytes), sourceHeight);
    const bitrate = Math.max(
      Math.floor(videoBitrateBudget(durationSeconds, capBytes)),
      MIN_VIDEO_BITRATE_BPS,
    );

    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const conversion = await Conversion.init({
      input,
      output,
      // Only `height` is set — mediabunny deduces width from the
      // aspect ratio, so no `fit` mode is needed. Audio options are
      // omitted on purpose: the default is passthrough-when-compatible.
      video: { codec: "avc", height, bitrate },
      // Load-bearing: without this, mediabunny COPIES the input's
      // metadata tags (GPS, creation time) into the fresh container.
      tags: {},
    });
    if (!conversion.isValid) return { error: { kind: "unsupported" } };

    conversion.onProgress = (fraction) => onProgress(fraction);
    const onAbort = (): void => void conversion.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    // Abort raced between the entry check and the listener attach —
    // cancel directly; execute() below throws ConversionCanceledError.
    if (signal.aborted) void conversion.cancel();
    try {
      await conversion.execute();
    } finally {
      signal.removeEventListener("abort", onAbort);
    }

    const buffer = output.target.buffer;
    if (buffer === null) return { error: { kind: "failed", message: "no output buffer" } };
    const basename = file.name.replace(/\.[^.]*$/, "");
    return { ok: new File([buffer], `${basename}.mp4`, { type: "video/mp4" }) };
  } catch (err) {
    // ConversionCanceledError and genuine mid-conversion crashes both
    // land here — the orchestrator's stale-controller guard separates
    // "user cancelled" from "fall back to the original".
    return {
      error: { kind: "failed", message: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    input.dispose();
  }
}
