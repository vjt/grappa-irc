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
// Exported for videoTranscode's skip-gate: a source file's OVERALL
// bitrate (video + audio) is compared against what we'd produce —
// pickEncodeBitrate (video only) plus this audio reserve.
export const AUDIO_BUDGET_BPS = 128_000;
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

// Visually-transparent ceilings per target height. Without them the
// budget math FILLS the cap: a 100MiB cap on a 104s clip budgets
// ~7.5Mbps of 720p H.264 where ~4Mbps is already transparent,
// producing a ~95MiB file nobody asked for (2026-06-10 iPhone
// dogfood). The budget stays the lower-bound driver (starved caps
// still degrade gracefully); the ceiling bounds generous ones.
export const MAX_VIDEO_BITRATE_BPS: Record<720 | 480, number> = {
  720: 4_000_000,
  480: 2_000_000,
};

/** Encoder bitrate for a clip: the cap-derived budget, floored at
 *  MIN_VIDEO_BITRATE_BPS, ceilinged at the per-resolution transparent
 *  bitrate. `height` is the POLICY height from pickTargetHeight (the
 *  source clamp doesn't change the ceiling bucket). */
export function pickEncodeBitrate(
  height: 720 | 480,
  durationSeconds: number,
  capBytes: number,
): number {
  const budget = Math.floor(videoBitrateBudget(durationSeconds, capBytes));
  return Math.min(Math.max(budget, MIN_VIDEO_BITRATE_BPS), MAX_VIDEO_BITRATE_BPS[height]);
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
      // MediaError code in the log: code 4 (SRC_NOT_SUPPORTED) is what
      // a CSP-blocked blob: load reports — the 2026-06-10 dogfood
      // incident would have been a one-look diagnosis with this line.
      // Supplements (not replaces) the visible "unreadable video
      // metadata" error copy on platforms that have a console.
      console.warn(
        "video metadata probe failed:",
        video.error?.code ?? "no MediaError",
        video.error?.message ?? "",
      );
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
