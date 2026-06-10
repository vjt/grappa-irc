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
// source track's display height. The budget math + duration ceiling +
// probe live in videoPolicy.ts (mediabunny-free) so the orchestrator
// can import them statically while THIS module — the only mediabunny
// importer — stays behind a dynamic import() in a lazy chunk (Task 6
// quality-review follow-up, landed with Task 7, 2026-06-09).
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
import {
  MAX_DURATION_SECONDS,
  pickEncodeBitrate,
  pickTargetHeight,
  probeDuration,
} from "./videoPolicy";

export type TranscodeError =
  | { kind: "too_long"; durationSeconds: number } // policy — hard reject, no fallback
  // capability — fallback eligible. `detail` is the diagnostic the
  // error UI surfaces: on iOS Safari (the dogfood platform) there is
  // no console, so a console-only reason is no reason at all.
  | { kind: "unsupported"; detail: string }
  | { kind: "failed"; message: string }; // capability — fallback eligible

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

  if (!(await videoTranscodeSupported())) {
    return { error: { kind: "unsupported", detail: "no H.264 encoder (WebCodecs)" } };
  }
  if (durationSeconds === null) {
    // No duration → no bitrate budget. Capability failure: the
    // orchestrator falls back to the original under the same gates.
    return { error: { kind: "unsupported", detail: "unreadable video metadata" } };
  }

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (track === null) {
      return { error: { kind: "unsupported", detail: "no video track in file" } };
    }
    const sourceHeight = await track.getDisplayHeight();
    const policyHeight = pickTargetHeight(durationSeconds, capBytes);
    const height = Math.min(policyHeight, sourceHeight);
    const bitrate = pickEncodeBitrate(policyHeight, durationSeconds, capBytes);

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
    if (!conversion.isValid) {
      // discardedTracks carries mediabunny's typed reason per track
      // (e.g. no_encodable_target_codec, undecodable_source_codec) —
      // the ONLY diagnostic we get on iOS Safari, where the console
      // is invisible. Surface it.
      const reasons = conversion.discardedTracks
        .map((t) => `${t.track.type}:${t.reason}`)
        .join(", ");
      return {
        error: { kind: "unsupported", detail: reasons === "" ? "conversion invalid" : reasons },
      };
    }

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
