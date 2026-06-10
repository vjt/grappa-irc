// Client-side video downscale — video+document uploads cluster Task 6
// (2026-06-09); skip-gate added with the metadata-strip cluster
// (2026-06-10).
//
// mediabunny (WebCodecs under the hood): demux mp4/mov/webm → H.264
// mp4 out, audio passthrough when the source track fits the container
// (the iPhone AAC case — Chrome has no AAC encoder; an unmanageable
// track is discarded with a mediabunny console warning and the output
// proceeds video-only, non-blocking). NOTE the metadata death is NOT
// mediabunny's default — `Conversion.init` COPIES input tags unless
// told otherwise; the explicit `tags: {}` below keeps the transcoded
// output clean.
//
// Transcode-always is SUPERSEDED (2026-06-10, metadata-strip cluster):
// privacy is a server guarantee now — grappa strips image/video
// metadata fail-closed on every upload, so metadata removal is no
// longer a reason to transcode. The transcode decision is pure
// performance, on observable facts only (vjt rejected time/uplink
// estimators): skip when the source is ALREADY the target shape —
// H.264 in mp4, within the duration policy, overall bitrate at or
// under what we'd produce, within the cap. Transcoding such a file
// can't meaningfully shrink it; it only burns wall-clock and battery.
// GPS/metadata presence is deliberately NOT consulted. iOS picker
// caveat: iPhone Photos exports are typically 1080p+ at 8–16 Mbps, so
// the gate rarely fires there — the win is desktop/already-modest
// files. (The picker's own "preparing" pie is iOS's pre-File export,
// unsuppressable from the web.)
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
  Mp4InputFormat,
  Mp4OutputFormat,
  Output,
} from "mediabunny";
import {
  AUDIO_BUDGET_BPS,
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
// Skip-gate — observable facts only (metadata-strip cluster,
// 2026-06-10). All four must hold:
//   1. container is mp4 (demuxed format, not the declared MIME — a
//      .mov is NOT a match even though it's the same ISOBMFF family:
//      the playability target is strictly H.264-in-mp4);
//   2. primary video track codec is avc;
//   3. overall bitrate (size×8/duration — video AND audio together)
//      is at or under what our own encode would produce:
//      pickEncodeBitrate for the policy height + the audio reserve.
//      If the original is already under that, a transcode cannot
//      meaningfully shrink it;
//   4. size within the cap (an over-cap original MUST transcode —
//      shrinking is the point).
// Duration policy (≤ MAX_DURATION_SECONDS) is enforced by the caller
// before this probe runs. Probe failures return false: an unreadable
// container falls through to the normal transcode/capability path,
// which owns the diagnostics.
// --------------------------------------------------------------------

async function alreadyTargetShape(
  file: File,
  durationSeconds: number,
  capBytes: number,
): Promise<boolean> {
  // The DECLARED type must be mp4 too, not just the demuxed
  // container: the upload rides file.type as the stored content-type,
  // and an mp4-branded file named .mov would be served as
  // video/quicktime — Chrome refuses to play that content-type even
  // over H.264 bytes. Such a file transcodes (gets renamed .mp4).
  if (file.type !== "video/mp4") return false;
  if (file.size > capBytes) return false;

  const policyHeight = pickTargetHeight(durationSeconds, capBytes);
  const producedBps = pickEncodeBitrate(policyHeight, durationSeconds, capBytes) + AUDIO_BUDGET_BPS;
  if ((file.size * 8) / durationSeconds > producedBps) return false;

  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(file) });
  try {
    const format = await input.getFormat();
    if (!(format instanceof Mp4InputFormat)) return false;
    const track = await input.getPrimaryVideoTrack();
    return track !== null && track.codec === "avc";
  } catch {
    return false;
  } finally {
    input.dispose();
  }
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

  // Skip-gate (2026-06-10): a source already in target shape uploads
  // as-is. Checked BEFORE the capability gate on purpose — a
  // compliant file on a no-WebCodecs platform skips the
  // unsupported-fallback dance entirely.
  if (durationSeconds !== null && (await alreadyTargetShape(file, durationSeconds, capBytes))) {
    console.info("video already H.264/mp4 within policy — skipping transcode");
    return { ok: file };
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
