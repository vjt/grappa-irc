// Video upload policy — split out of videoTranscode.ts (Task 6
// quality-review follow-up, landed with Task 7, 2026-06-09).
//
// Everything the upload orchestrator needs SYNCHRONOUSLY about video
// uploads lives here: the duration ceiling, the adaptive-resolution
// budget math, and the <video>-element duration probe. Crucially this
// module has NO mediabunny import — videoTranscode.ts (which does) is
// loaded by the orchestrator via dynamic import(), so mediabunny's
// bulk lands in a ~495kB lazy chunk fetched on first video upload,
// instead of the cold-start main bundle (~305kB after the split).
// Adding a mediabunny (or any other heavyweight) import here would
// silently drag it back into the main chunk — don't.
//
// Policy vs capability split (the orchestrator's fallback contract):
// - `too_long` is POLICY — duration is read via a <video> element's
//   loadedmetadata, which works WITHOUT WebCodecs, so the 2-minute
//   ceiling binds on the no-transcode fallback path too.
// - capability (WebCodecs presence, codec support) is videoTranscode's
//   business; see that module.
//
// Spec: docs/superpowers/specs/2026-06-09-video-doc-uploads-design.md

export const MAX_DURATION_SECONDS = 120;
const RESOLUTION_THRESHOLD_BPS = 2_000_000;
const AUDIO_BUDGET_BPS = 128_000;
const CAP_SAFETY = 0.95; // VBR overshoot margin
// Degenerate cap/duration combos (tiny cap × near-ceiling duration)
// drive the budget to ≤ 0 — clamp so the encoder never sees a nonsense
// bitrate; the over-cap output is rejected by the downstream cap check.
export const MIN_VIDEO_BITRATE_BPS = 100_000;

// --------------------------------------------------------------------
// Adaptive resolution policy — pure budget math, exported for tests
// and for videoTranscode's encoder configuration.
// --------------------------------------------------------------------

export function videoBitrateBudget(durationSeconds: number, capBytes: number): number {
  return (capBytes * CAP_SAFETY * 8) / durationSeconds - AUDIO_BUDGET_BPS;
}

export function pickTargetHeight(durationSeconds: number, capBytes: number): 720 | 480 {
  return videoBitrateBudget(durationSeconds, capBytes) >= RESOLUTION_THRESHOLD_BPS ? 720 : 480;
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
