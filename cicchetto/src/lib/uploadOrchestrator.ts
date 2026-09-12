import { createSignal } from "solid-js";
import { previewKindOf } from "./attachmentPreview";
import type { ChannelKey } from "./channelKey";
import { type ConfirmAttachment, dismissConfirm, requestConfirm } from "./confirmDialog";
import { formatBytes } from "./formatBytes";
import { sendMessage } from "./scrollback";
import { serverSettings } from "./serverSettings";
import {
  baseMime,
  categoryOf,
  mimeExtLabel,
  normalizeUploadFile,
  type UploadCategory,
} from "./uploadCategory";
import { activeHost, type UploadError, type UploadHost, type UploadProgress } from "./uploadHost";
import {
  getUploadConfirmEnabled,
  getUploadTtlSeconds,
  putUploadConfirmEnabled,
  putUploadTtlSeconds,
} from "./userSettings";
// Policy only — videoTranscode.ts (the sole mediabunny importer) is
// loaded via dynamic import() inside prepareVideo so mediabunny's bulk
// lands in a lazy chunk, off the cold-start main bundle (Task 6
// quality-review follow-up, landed with Task 7, 2026-06-09).
import { MAX_DURATION_SECONDS, probeDuration } from "./videoPolicy";

// Upload orchestration — images cluster I-2 (2026-05-15), generalized
// to video + document categories (uploads cluster Task 5, 2026-06-09;
// formerly `imageUploadOrchestrator.ts`).
//
// Sits between the cic compose surface (ComposeBox.tsx — picker /
// camera / drag-drop / paste triggers) and the host transport layer
// (uploadHost.ts — pluggable UploadHost interface). Holds the
// per-channel upload-in-flight state, the singleton privacy-modal
// gate, the cached upload-TTL preference, and the auto-send wiring.
//
// Single entry point: triggerUpload(key, networkSlug, channelName,
// file). All four trigger surfaces collapse to that one call. The
// rest of the surface — uploadState, cancel, dismiss, retry — is
// consumed by ComposeBox.tsx; the privacy-modal surface is consumed
// by PrivacyModal.tsx mounted at Shell root; the TTL preference is
// consumed by SettingsDrawer.tsx (UX-4 bucket M, 2026-05-19 — TTL
// moved from per-message ComposeBox `<select>` to durable
// per-user setting).
//
// Per-host namespacing: the privacy-ack flag is keyed under
// `:<host.id>` (privacyKey/0) so swapping providers tomorrow doesn't
// inherit the wrong default. The upload-TTL preference is server-side
// + host-agnostic (integer seconds) — the host-specific token is
// resolved per-dispatch via `pickHostTokenFromSeconds/2`. See A6 + A7
// in the brainstorm.
//
// IRC stays text only: on resolve, we build `${CATEGORY_EMOJI} ${url}`
// (📸/🎬/📄 per category) and call scrollback.sendMessage directly —
// bypasses compose.ts submit() so the operator's draft text in the
// textarea stays untouched (per A7). The upload PRIVMSG is its own
// separate message; no draft clobbering.

export type UploadStateEntry = {
  filename: string;
  loaded: number;
  total: number;
  /** "transcoding" while the Task 6 video transcode runs (loaded is a
   *  0..1 fraction, total is 1); "uploading" during the host POST
   *  (loaded/total in bytes). Meaningless when `error` is set — error
   *  entries keep whatever phase the failure happened in. */
  phase: "transcoding" | "uploading";
  error?: string;
};

// Per-category PRIVMSG prefix — IRC stays text only; the emoji is the
// whole "media type" signal on the wire.
const CATEGORY_EMOJI: Record<UploadCategory, string> = {
  image: "📸",
  video: "🎬",
  document: "📄",
  audio: "🎵",
};

type ActiveUpload = {
  controller: AbortController;
  file: File;
  networkSlug: string;
  channelName: string;
};

export type PrivacyModalState =
  | { open: true; host: UploadHost; key: ChannelKey }
  | { open: false; host: null; key: null };

const [uploadStates, setUploadStates] = createSignal<Record<ChannelKey, UploadStateEntry>>({});
const [modalState, setModalState] = createSignal<PrivacyModalState>({
  open: false,
  host: null,
  key: null,
});

// In-flight controllers + last-attempted file (for retry). Not in the
// reactive store — tests + rendering only need the visible-state slice.
const inflight = new Map<ChannelKey, ActiveUpload>();
// Last-attempted upload context per channel. Survives the error
// transition (inflight is cleared on resolve/reject; this isn't) so
// retryUpload has the file + slug + channel to re-dispatch with.
// Carries the batch's `ttlSeconds` too (#2094): a retry re-sends the file the
// operator already answered for, so it must re-send it on the terms they
// chose — re-reading the preference here would silently change them.
const lastAttempt = new Map<
  ChannelKey,
  { file: File; networkSlug: string; channelName: string; ttlSeconds: number | null }
>();
// #1883 (ordering fix) — the batch waiting behind the privacy notice, as a
// CONTINUATION rather than a staged file.
//
// The notice used to be gated in `startUpload`, i.e. after the operator had
// already answered the Send confirm: they were told where the files go only
// once they had committed to sending them. Terms first, decision second — so
// the gate moved to the FRONT of `triggerUploads` and what waits here is "the
// rest of the trigger", which may be a confirm or a straight enqueue depending
// on the opt-in.
//
// One at a time, because the modal is a global singleton — the same reason the
// old map was keyed by channel and held one entry per key.
let pendingTrigger: (() => void) | null = null;

// #118 — sequential per-channel upload queue. Files pasted/dropped/picked
// in one batch wait here behind the active upload; each settle pumps the
// next. Plain Map — not reactive; the queue itself drives no UI. Keeps the
// single-slot dispatchUpload pipeline (one inflight per channel) untouched.
// #2094 — `ttlSeconds` is the BATCH's answer, carried per item because the
// queue is what survives between the dialog and the dispatch. `null` means "no
// per-batch answer was given" — the no-confirm path, which falls back to the
// stored preference at dispatch exactly as it did before this field existed.
// Resolving it here rather than at dispatch would freeze a host token chosen
// against whichever host was active when the operator dropped the file.
type QueuedUpload = {
  file: File;
  networkSlug: string;
  channelName: string;
  ttlSeconds: number | null;
};
const queue = new Map<ChannelKey, QueuedUpload[]>();

// Reactive (index,total) for the "(i/N)" batch counter — the only reactive
// slice of the queue. ComposeBox reads uploadBatch(key) for the label.
const [batchByChannel, setBatchByChannel] = createSignal<
  Record<ChannelKey, { index: number; total: number }>
>({});

function setBatch(key: ChannelKey, info: { index: number; total: number } | null): void {
  setBatchByChannel((prev) => {
    if (info === null) {
      const { [key]: _, ...rest } = prev;
      void _;
      return rest;
    }
    return { ...prev, [key]: info };
  });
}

export function uploadBatch(key: ChannelKey): { index: number; total: number } | null {
  return batchByChannel()[key] ?? null;
}

const PRIVACY_KEY_PREFIX = "image-upload-privacy-acknowledged";

const privacyKey = (host: UploadHost): string => `${PRIVACY_KEY_PREFIX}:${host.id}`;

// UX-4 bucket M (2026-05-19) — upload-TTL is a per-user preference
// persisted on the server (`user_settings.data["upload_ttl_seconds"]`)
// as integer seconds. SettingsDrawer owns the read/write UI; this
// orchestrator translates the stored seconds → host token at dispatch
// time. `null` means "no preference set — use the active host's
// defaultTtl" (host-defined, e.g. litterbox's `"24h"`).
//
// The signal is a cic-side cache mirror of the server value: load on
// app start (`loadUploadTtlSeconds`), write-through on user change
// (`saveUploadTtlSeconds`). Reset to null when the host changes
// ladder semantics — but since `activeHost()` is module-level today
// (litterbox-only) the reset path is unused in production. Tests
// exercise it via `resetUploadTtlSecondsForTests`.
const [uploadTtlSeconds, setUploadTtlSecondsSignal] = createSignal<number | null>(null);

export function uploadTtlSecondsValue(): number | null {
  return uploadTtlSeconds();
}

// #1883 — the pre-upload confirm opt-in, cached the same way the TTL above is:
// a cic-side mirror of the server value, loaded once at app start so the very
// first upload honours it rather than only uploads made after the drawer has
// been opened. Default `false` matches the server's own default, so a failed
// or not-yet-finished load behaves exactly like a subject who never opted in.
const [uploadConfirmEnabled, setUploadConfirmEnabledSignal] = createSignal<boolean>(false);

export function uploadConfirmEnabledValue(): boolean {
  return uploadConfirmEnabled();
}

/** Load the server-persisted confirm opt-in into the cic cache. Called from
 *  `Shell.tsx`'s post-login bootstrap beside `loadUploadTtlSeconds`. Errors are
 *  swallowed: the cache stays `false`, which is the server default too. */
export async function loadUploadConfirmEnabled(token: string): Promise<void> {
  try {
    setUploadConfirmEnabledSignal(await getUploadConfirmEnabled(token));
  } catch {
    /* swallowed — stays at the server's own default (false) */
  }
}

/** Persist a new confirm opt-in. Mirrors into the cic cache on success so the
 *  NEXT upload honours it with no reload. Throws ApiError on 4xx/5xx. */
export async function saveUploadConfirmEnabled(token: string, enabled: boolean): Promise<void> {
  setUploadConfirmEnabledSignal(await putUploadConfirmEnabled(token, enabled));
}

/** Test seam — mirrors `resetUploadTtlSecondsForTests`. */
export function resetUploadConfirmEnabledForTests(): void {
  setUploadConfirmEnabledSignal(false);
}

/** Load the server-persisted upload-TTL into the cic cache. Called
 *  once per app start from `Shell.tsx`'s post-login bootstrap effect
 *  (gated on token + /me both resolving) so the operator's saved
 *  preference applies to the first upload, not only after the
 *  SettingsDrawer is opened. Errors are swallowed (cache stays at
 *  null = "use host default"). */
export async function loadUploadTtlSeconds(token: string): Promise<void> {
  try {
    const seconds = await getUploadTtlSeconds(token);
    setUploadTtlSecondsSignal(seconds);
  } catch {
    /* swallowed — fall back to host default */
  }
}

/** Persist a new upload-TTL preference. On success, mirror into the
 *  cic cache. Throws ApiError on 4xx/5xx. */
export async function saveUploadTtlSeconds(token: string, seconds: number | null): Promise<void> {
  const persisted = await putUploadTtlSeconds(token, seconds);
  setUploadTtlSecondsSignal(persisted);
}

/** Test-only: reset the cic cache. Production code never calls this —
 *  the cache survives drawer open/close and is only refreshed by
 *  `loadUploadTtlSeconds`. */
export function resetUploadTtlSecondsForTests(): void {
  setUploadTtlSecondsSignal(null);
}

/** Test-only: clear ALL per-channel upload state (queue, inflight, retry
 *  buffer, privacy stage, visible entries, batch counters, modal).
 *  Production never calls this — the module state is process-lived. */
export function resetUploadsForTests(): void {
  // #1883 — a pending Send/Cancel confirm is upload state too: leaving one
  // armed would let the next test's acceptConfirm fire the previous batch.
  dismissConfirm();
  for (const { controller } of inflight.values()) controller.abort();
  inflight.clear();
  queue.clear();
  lastAttempt.clear();
  pendingTrigger = null;
  setUploadStates({});
  setBatchByChannel({});
  setModalState({ open: false, host: null, key: null });
}

/** Translate a stored-seconds preference into a host-specific token
 *  from the active host's ladder. Returns `null` when no match exists
 *  (caller falls back to `host.defaultTtl`). */
function pickHostTokenFromSeconds(host: UploadHost, seconds: number | null): string | null {
  if (seconds === null) return null;
  const match = host.ttlOptions.find((opt) => opt.seconds === seconds);
  return match?.value ?? null;
}

// #2094 — what the next upload WOULD expire after with nobody choosing
// anything: the stored preference when this host offers it, the host's own
// default otherwise. `null` only when the host has no TTL ladder at all, and
// that is the case where there is nothing to ask.
//
// The preference is checked against THIS host's ladder rather than taken at
// face value: `upload_ttl_seconds` is a plain integer with no host attached,
// and a value the active host cannot serve would seed the dropdown with an
// option that is not in it — a control showing a selection it does not have.
function effectiveTtlSeconds(host: UploadHost): number | null {
  const preferred = uploadTtlSeconds();
  if (preferred !== null && host.ttlOptions.some((opt) => opt.seconds === preferred)) {
    return preferred;
  }
  return host.ttlOptions.find((opt) => opt.value === host.defaultTtl)?.seconds ?? null;
}

function setEntry(key: ChannelKey, entry: UploadStateEntry | null): void {
  setUploadStates((prev) => {
    if (entry === null) {
      const { [key]: _, ...rest } = prev;
      void _;
      return rest;
    }
    return { ...prev, [key]: entry };
  });
}

export function uploadState(key: ChannelKey): UploadStateEntry | null {
  return uploadStates()[key] ?? null;
}

export function privacyModalState(): PrivacyModalState {
  return modalState();
}

// Fixed MB spelling for the "X of Y MB sent" upload-PROGRESS line only. A
// progress counter that flips KB→MB→GB as it climbs reads worse than a stable
// unit, so this stays deliberately MB-only ("N MB", "<0.1" floor so a nonzero
// count never reads as zero). The one-shot CAP/size surfaces (file_too_large +
// the pre-check and transcode caps) now spell their limit via the adaptive
// `formatBytes` (#411), so a sub-MB cap reads "512 KB" not "0.5 MB" and agrees
// with `friendlyApiError` — this is NOT that formatter.
function mbLabel(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return "<0.1";
  if (mb >= 10 || Number.isInteger(mb)) return Math.round(mb).toString();
  return mb.toFixed(1);
}

// #364 bucket H (cross-surface S4) — the embedded upload host
// (/api/uploads) rejects with a JSON body `{error: "<token>", ...}` whose
// FallbackController comments each promise cic renders per-token copy. The
// litterbox host emits plain-text error bodies (no token), so a non-JSON /
// token-less body falls through to the status-based generic below. Parsing
// the token lets us give the RIGHT recourse: 507 is admin action (retrying
// can't fix a full disk), metadata_strip_failed fails identically for any
// file of the same kind (so "try a different file" misleads), file_too_large
// carries the actionable max_bytes threshold. Per
// `feedback_no_localized_strings_server_side`.
function parseUploadErrorToken(body: string): { error?: string; max_bytes?: number } | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null) {
      return parsed as { error?: string; max_bytes?: number };
    }
  } catch {
    /* plain-text host body (litterbox) or empty — no token */
  }
  return null;
}

function httpUploadMessage(status: number, body: string): string {
  const token = parseUploadErrorToken(body);
  switch (token?.error) {
    case "insufficient_storage": {
      // 507 — the store is at capacity. Mirrors network_busy's admin
      // affordance (friendlyApiError): the recourse is the operator, NOT a
      // retry that can't free disk.
      return "The upload store is full. Ask your server admin to free space, then try again.";
    }
    case "file_too_large": {
      // 413 — server per-file cap. Render the max_bytes the server threads
      // "so cic can render the actionable threshold" (same `formatBytes`
      // spelling as the client-side pre-check and friendlyApiError, #411);
      // fall back to a capless message if the field is absent.
      const cap =
        typeof token?.max_bytes === "number" ? ` (max ${formatBytes(token.max_bytes)})` : "";
      return `File is too large${cap}.`;
    }
    case "metadata_strip_failed": {
      // 422 — EXIF/QuickTime strip failed and the boundary fails CLOSED. A
      // different file of the SAME kind fails identically, so the generic
      // "try a different file" is wrong advice.
      return "Couldn't remove metadata from that file, so it wasn't uploaded.";
    }
    case "unsupported_media_type": {
      // 415 — belt-and-braces vs dispatchUpload's client-side accept gate;
      // a cap/host drift or proxy path can still surface it.
      return "That file type isn't supported.";
    }
    default: {
      // Token-less body (litterbox plain text, empty, or an unknown token)
      // → status-based generic. Loud, never silent.
      if (status >= 400 && status < 500) {
        return `Upload rejected (${status}) — try a different file.`;
      }
      return `Upload service unavailable (${status}). Retry?`;
    }
  }
}

function friendlyErrorMessage(err: UploadError, lastProgress: UploadProgress | null): string {
  switch (err.kind) {
    case "network": {
      // XHR error events carry no status; the last progress event is
      // the only forensic signal. Three honest cases: progress never
      // OBSERVED (null — hosts with supportsProgress: false never fire
      // one, so claiming "no bytes" would be a lie), observed zero
      // (server never took a byte), observed nonzero (the stream was
      // cut — e.g. the 2026-06-10 host-nginx 4m body cap).
      if (lastProgress === null) {
        return "Upload failed — network error. Retry?";
      }
      if (lastProgress.loaded === 0) {
        return "Upload failed — no bytes were sent (network or server unreachable). Retry?";
      }
      const sent = mbLabel(lastProgress.loaded);
      const of = lastProgress.total > 0 ? ` of ${mbLabel(lastProgress.total)}` : "";
      return `Upload failed — connection dropped (${sent}${of} MB sent). Retry?`;
    }
    case "abort":
      // Caller short-circuits this path (silent state clear) — included
      // for exhaustiveness only.
      return "Upload cancelled.";
    case "http":
      return httpUploadMessage(err.status, err.body);
    case "invalid_response":
      return "Upload completed but the server returned an invalid response.";
    case "provider":
      return err.message;
  }
}

function unsupportedTypeMessage(host: UploadHost): string {
  // Category list derived from the emoji map — one source of truth for
  // "which categories exist" inside this module.
  const exts = [
    ...new Set(
      (Object.keys(CATEGORY_EMOJI) as UploadCategory[])
        .flatMap((category) => host.acceptedMimeTypes[category])
        .map(mimeExtLabel),
    ),
  ];
  return `Unsupported file type — supported: ${exts.join(", ")}.`;
}

// Single category-dispatched pipeline (uploads cluster Task 5):
// categoryOf → host accept gate → transform hook → per-category cap →
// upload → emoji-prefixed PRIVMSG. async so the Task 6 video transcode
// can await inside the transform hook; callers fire-and-forget with
// `void` — all observable state flows through uploadStates.
async function dispatchUpload(
  key: ChannelKey,
  networkSlug: string,
  channelName: string,
  file: File,
  ttlSeconds: number | null,
): Promise<void> {
  const host = activeHost();

  // #49 root fix: lastAttempt is the user's LATEST selection, recorded
  // before any gate can reject — retry always retries what the error
  // box shows, and a new selection always replaces a rejected one.
  lastAttempt.set(key, { file, networkSlug, channelName, ttlSeconds });

  // #1256: gate on the TYPE. `file.type` may carry a charset the paste
  // path declares truthfully, and the host accept-lists are bare types.
  const mime = baseMime(file.type);
  const category = categoryOf(mime);
  if (category === null || !host.acceptedMimeTypes[category].includes(mime)) {
    setEntry(key, {
      filename: file.name,
      loaded: 0,
      total: 0,
      phase: "uploading",
      error: unsupportedTypeMessage(host),
    });
    return;
  }

  // Re-trigger while a previous upload/transcode for this channel is
  // still in flight: abort it before overwriting, or an orphaned
  // transcode keeps burning CPU with no controller left to reach it.
  // The stale-controller guards downstream make the old promise chain
  // settle silently (Task 6 quality-review follow-up, landed with
  // Task 7, 2026-06-09).
  inflight.get(key)?.controller.abort();

  // Controller + inflight registration happen BEFORE the transform so
  // cancelUpload can abort an in-flight video transcode, not just the
  // host POST (Task 6, 2026-06-09).
  const controller = new AbortController();
  inflight.set(key, { controller, file, networkSlug, channelName });

  // Transform hook — video → transcode (or fallback-to-original under
  // the same policy gates); image/document pass through.
  let uploadFile = file;
  if (category === "video") {
    const prepared = await prepareVideo(key, host, file, controller);
    if (prepared === null) return; // error entry already set, or cancelled
    uploadFile = prepared;
    inflight.set(key, { controller, file: uploadFile, networkSlug, channelName });
  }

  // Cap check runs on the file that will ACTUALLY upload — after the
  // transform, since the transcode changes the size.
  const cap = host.maxFileSizeBytes(category);
  if (cap !== null && uploadFile.size > cap) {
    inflight.delete(key);
    setEntry(key, {
      filename: uploadFile.name,
      loaded: 0,
      total: 0,
      phase: "uploading",
      error: `File is too large (max ${formatBytes(cap)}).`,
    });
    return;
  }

  setEntry(key, {
    filename: uploadFile.name,
    loaded: 0,
    total: uploadFile.size,
    phase: "uploading",
  });

  // #2094 — the batch's own answer first, the stored preference behind it, the
  // host default last. Three layers and not two: an operator who never opens
  // the confirm still gets their preference, and one who opens it and leaves
  // the dropdown alone gets the same value the dropdown was showing them.
  const ttl =
    pickHostTokenFromSeconds(host, ttlSeconds ?? uploadTtlSeconds()) ??
    host.defaultTtl ??
    undefined;

  // Per-attempt closure — a retry gets a fresh null, so a stale
  // bytes-sent figure can never leak into the next attempt's error.
  let lastProgress: UploadProgress | null = null;

  host
    .upload(
      uploadFile,
      ttl !== undefined ? { ttl } : {},
      (p) => {
        // Ignore stale progress events from a cancelled-then-retried
        // upload — only the current inflight entry matters.
        if (inflight.get(key)?.controller !== controller) return;
        lastProgress = { loaded: p.loaded, total: p.total };
        setEntry(key, {
          filename: uploadFile.name,
          loaded: p.loaded,
          total: p.total,
          phase: "uploading",
        });
      },
      controller.signal,
    )
    .then((url) => {
      if (inflight.get(key)?.controller !== controller) return;
      inflight.delete(key);
      setEntry(key, null);
      // Auto-send PRIVMSG with the per-category emoji prefix — A7.
      void sendMessage(networkSlug, channelName, `${CATEGORY_EMOJI[category]} ${url}`);
      pumpQueue(key); // #118: start the next queued file
    })
    .catch((err: UploadError) => {
      if (inflight.get(key)?.controller !== controller) return;
      inflight.delete(key);
      if (err.kind === "abort") {
        setEntry(key, null);
        return;
      }
      setEntry(key, {
        filename: uploadFile.name,
        loaded: 0,
        total: 0,
        phase: "uploading",
        error: friendlyErrorMessage(err, lastProgress),
      });
    });
}

// #201 — the ceiling is a server setting now; MAX_DURATION_SECONDS is
// only the fallback for the window before the first settings snapshot
// (and for a pre-#201 server). Read at each gate, never captured in a
// module const: an admin can move it mid-session and the WS push
// updates the signal without a reload.
function videoMaxDurationSeconds(): number {
  return serverSettings()?.uploadVideoMaxDurationSeconds ?? MAX_DURATION_SECONDS;
}

// Deliberately NOT `formatDuration` from duration.ts: that one floors
// (90s → "1m"), which would UNDERSTATE a ceiling and tell the operator
// a 75s clip was over a "1m" limit. A cap has to name itself exactly.
function durationLabel(seconds: number): string {
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

function videoTooLongMessage(maxSeconds: number): string {
  return `Video too long (max ${durationLabel(maxSeconds)}).`;
}

// Video transform — Task 6 (2026-06-09). Returns the file to upload
// (transcoded mp4, or the ORIGINAL on a capability fallback), or null
// when an error entry was set / the upload was cancelled mid-transcode.
//
// Policy vs capability: `too_long` hard-rejects with no fallback (the
// 2-minute ceiling is policy); `unsupported`/`failed` fall back to the
// original under the SAME policy gates — duration re-checked here via
// the <video>-element probe (which works without WebCodecs); the cap
// check for the fallback original happens HERE with the transcode-
// failure reason in the error copy (iOS Safari has no console — a
// console-only reason is no reason). In-cap fallbacks still pass
// through dispatchUpload's downstream cap check as a no-op.
//
// Stale-controller guard after every await: cancelUpload may have
// aborted + cleared inflight while we were suspended; a cancelled
// transcode settles as `failed` and must NOT resurrect state or fall
// back to uploading the original.
async function prepareVideo(
  key: ChannelKey,
  host: UploadHost,
  file: File,
  controller: AbortController,
): Promise<File | null> {
  setEntry(key, { filename: file.name, loaded: 0, total: 1, phase: "transcoding" });

  // Lazy chunk: mediabunny only loads the first time someone actually
  // uploads a video. vi.mock intercepts dynamic import() too, so the
  // test seam is unchanged.
  const { transcodeVideo } = await import("./videoTranscode");

  // Hosts that report no video cap (null) still need a bitrate budget —
  // size the transcode for the embedded default (50MiB) and let the
  // host's actual limit reject the upload if it disagrees.
  const capBytes = host.maxFileSizeBytes("video") ?? 50 * 1024 * 1024;
  // Read ONCE per attempt so the gate inside transcodeVideo and the
  // fallback gate below cannot straddle an admin change mid-upload and
  // reject against a value the message never named.
  const maxDurationSeconds = videoMaxDurationSeconds();
  const result = await transcodeVideo(
    file,
    capBytes,
    maxDurationSeconds,
    (fraction) => {
      if (inflight.get(key)?.controller !== controller) return;
      setEntry(key, { filename: file.name, loaded: fraction, total: 1, phase: "transcoding" });
    },
    controller.signal,
  );
  if (inflight.get(key)?.controller !== controller) return null; // cancelled

  if ("ok" in result) return result.ok;

  if (result.error.kind === "too_long") {
    inflight.delete(key);
    setEntry(key, {
      filename: file.name,
      loaded: 0,
      total: 0,
      phase: "transcoding",
      error: videoTooLongMessage(maxDurationSeconds),
    });
    return null;
  }

  // Capability failure → fall back to the original, reason logged.
  console.warn("video transcode unavailable, uploading original:", result.error);
  const durationSeconds = await probeDuration(file);
  if (inflight.get(key)?.controller !== controller) return null; // cancelled
  if (durationSeconds !== null && durationSeconds > maxDurationSeconds) {
    inflight.delete(key);
    setEntry(key, {
      filename: file.name,
      loaded: 0,
      total: 0,
      phase: "transcoding",
      error: videoTooLongMessage(maxDurationSeconds),
    });
    return null;
  }

  // Cap-check the fallback original HERE, not downstream: the generic
  // "File is too large" hides WHY a raw original reached the cap check
  // at all, and on iOS Safari — the dogfood platform — the console is
  // invisible, so the transcode-failure reason must ride the error UI
  // (2026-06-10 iPhone dogfood: instant "too large" with zero clues).
  const reason = result.error.kind === "unsupported" ? result.error.detail : result.error.message;
  const cap = host.maxFileSizeBytes("video");
  if (cap !== null && file.size > cap) {
    inflight.delete(key);
    setEntry(key, {
      filename: file.name,
      loaded: 0,
      total: 0,
      phase: "transcoding",
      error: `Video processing failed (${reason}); the original is too large (max ${formatBytes(cap)}).`,
    });
    return null;
  }
  return file;
}

// #1883 — the confirm every upload passes, and the door every surface uses.
//
// Picking a photo from the gallery used to reach the wire with no stop
// anywhere. The only gate was the privacy modal, which is one-shot per host —
// so for every operator who has ticked "remember", the sequence was tap
// paperclip -> tap photo -> it is public, on a dense grid where a mis-tap has
// no undo because the bytes are already on someone else's server and the link
// is already in the channel.
//
// #1884 first put this guard in `pickerUpload.ts`, covering the PICKER only,
// on the argument that a drag onto a visible target is a gesture the operator
// aimed and Ctrl-V is one they typed. That reading was reversed (vjt's ruling,
// 2026-08-31): the gate belongs at the ONE point every surface already passes
// through. #351 collapsed picker, drop and paste onto this function, and the
// OS share-target reaches it through `dropUpload` as well — so a guard here is
// inherited by all four, and by a fifth added later, instead of each having to
// remember it. A per-surface guard is an enumeration, and enumerations drift.
//
// The objection #1884 raised against this position is answered by the split
// below, not waved away: "the orchestrator owns the queue, and a batch the
// operator has not authorised has no business being in it." It never enters
// it. `triggerUploads` only ASKS; nothing is queued, no batch counter moves
// and no upload slot is taken until Send calls `enqueueUploads`.
//
// Normalisation (iOS .m4r -> audio/mp4) happens HERE, before the preview, so
// the type the dialog shows is the type that will be sent. This is also why
// the picker call site must NOT route through `dropUpload`: that helper
// pre-filters on `categoryOf`, and iOS labels a .m4r `application/octet-stream`
// — only `normalizeUploadFile` rescues it, and the filter would drop the file
// before the rescue could run.
//
// #1883 — the confirm is OPT-IN, and this paragraph used to say the opposite
// ("there is no don't ask again ... a gate every returning operator has already
// switched off is not a gate"). That argument was aimed at the flag which
// PRODUCED the defect: `localStorage`, per-browser, invisible, not revocable
// from the UI. `upload_confirm_enabled` is a different object — per-user,
// server-side, and visible beside the upload-retention control — so the
// objection is rhetorical rather than mechanical. The cost is real and is
// stated rather than hidden: OFF by default means all five doors are unguarded
// until someone turns it on. Reversal ruled 2026-09-05; see the server
// accessor `Grappa.UserSettings.get_upload_confirm_enabled/1`.

// Row identity. Filenames are not unique (a gallery multi-select routinely
// yields two `IMG_0001.png`) and neither is the File object across two picks
// of the same photo, so the id is minted here and never derived.
let nextAttachmentId = 0;

// The attachment is minted WITH the staged file and never recomputed. Solid's
// `<For>` diffs by reference, so a row rebuilt on every read would dispose and
// recreate EVERY row on any removal — which since #1964 is visible: a playing
// audio preview stops and resets, a text preview is re-read off disk, and both
// object URLs churn. Deriving once is also the cheaper shape.
type StagedFile = { id: string; file: File; attachment: ConfirmAttachment };

// #1964 — the preview is of the file's ACTUAL type.
//
// This used to answer a thumbnail for images and nothing for anything else, on
// the argument that "a picture is the only preview worth showing: for every
// other category the bytes say nothing a human can check at a glance, and the
// name is what distinguishes `contract-final.pdf` from `contract-draft.pdf`".
// That reasoning assumes a name the OPERATOR chose. The paste path (#816)
// names every file `paste.txt`, in every window, so on the one door where the
// operator cannot possibly know what is inside, the dialog showed a byte count
// and an empty box. `previewKindOf` decides what each staged file can be shown
// as; a file with no renderer (PDF, office documents) still answers null and
// keeps the placeholder. The blob is handed over raw — ConfirmModal mints and
// revokes the object URL, because the row's unmount is the only event that
// knows when it stops being needed.
function toAttachment(id: string, file: File): ConfirmAttachment {
  const kind = previewKindOf(file.type);
  return {
    id,
    label: file.name,
    // Gabriele's ruling (2026-09-08): when there is no preview, SAY so. cic
    // has no PDF or office renderer — the media viewer has four arms and a
    // 📄 link deliberately falls through to the browser (MircText.tsx) — so a
    // preview for those types would mean building a viewer first. The honest
    // row is the name, the size and a plain statement; the old empty-box glyph
    // read as a picture that failed to load, which is a different claim.
    detail:
      kind === null ? `${formatBytes(file.size)} · preview not supported` : formatBytes(file.size),
    preview: kind === null ? null : { kind, blob: file },
  };
}

export function triggerUploads(
  key: ChannelKey,
  networkSlug: string,
  channelName: string,
  rawFiles: File[],
  // #1883 — what to do if this question is replaced before it is answered.
  // Optional, and the asymmetry is the point: every other door is driven by a
  // gesture still on screen, so "ask again" is the operator repeating it. The
  // OS share target arrives at boot with nothing to repeat, so it is the one
  // caller that must be told its files went nowhere.
  onDisplaced?: () => void,
): void {
  if (rawFiles.length === 0) return;
  // Normalised BEFORE staging so the preview, the removal set and the queue
  // all describe the same files.
  const normalised: StagedFile[] = rawFiles.map((raw) => {
    nextAttachmentId += 1;
    const id = `picked-${nextAttachmentId}`;
    const file = normalizeUploadFile(raw);
    return { id, file, attachment: toAttachment(id, file) };
  });

  // Everything past the privacy notice. A closure because the notice may have
  // to run first and resume this afterwards — see `pendingTrigger`.
  const proceed = (): void => {
    // #1883 — the opt-in branch, and it sits HERE on purpose: after
    // normalisation, never before it. `enqueueUploads` does NOT normalise, so
    // the tempting spelling
    //
    //     if (!uploadConfirmEnabled()) return enqueueUploads(key, ..., rawFiles)
    //
    // would send the RAW files and re-break the iOS `.m4r` case this function
    // exists to rescue (iOS labels it `application/octet-stream`; only
    // `normalizeUploadFile` maps it to `audio/mp4`). Branch on policy, never on
    // the un-normalised input.
    if (!uploadConfirmEnabled()) {
      // `null`, not `effectiveTtlSeconds()`: with no dialog there was no
      // answer, and the dispatch-time fallback to the stored preference is the
      // whole of the pre-#2094 behaviour. Resolving it here would be the same
      // value by a longer road, and a wrong one the moment the active host
      // changes between the drop and the POST.
      enqueueUploads(
        key,
        networkSlug,
        channelName,
        normalised.map((s) => s.file),
        null,
      );
      return;
    }

    openSendConfirm();
  };

  // The privacy notice comes FIRST, before either door below. It states the
  // terms — which host the bytes go to, and for how long — and a question about
  // terms is worth nothing after the answer has been given. Per BATCH now,
  // where the old placement in `startUpload` asked per FILE: an operator who
  // declines "don't show this again" is asked once for the drop, not once per
  // file in it, which matches the Send confirm's own granularity.
  const host = activeHost();
  const acked = localStorage.getItem(privacyKey(host));
  if (acked === null || acked === "") {
    pendingTrigger = proceed;
    setModalState({ open: true, host, key });
    return;
  }

  proceed();

  function openSendConfirm(): void {
    const [staged, setStaged] = createSignal<StagedFile[]>(normalised);
    // #2094 — the TTL for THIS batch. Seeded from the effective default (the
    // stored preference, or the active host's own default when there is no
    // preference), so the dropdown opens showing what would have happened
    // anyway and a choice is an override rather than a required answer.
    //
    // Per REQUEST, not module-level: the answer belongs to the batch the
    // dialog is asking about, so a displaced or cancelled request takes it
    // with it and the next drop starts from the preference again. It is
    // deliberately NOT written back to `upload_ttl_seconds` — a one-off stays
    // one-off, and a dialog the operator opened to look at their files is not
    // where a durable preference should be changed by accident.
    const confirmHost = activeHost();
    const [batchTtlSeconds, setBatchTtlSeconds] = createSignal<number | null>(
      effectiveTtlSeconds(confirmHost),
    );

    requestConfirm({
      onDisplaced,
      // The destination goes in the TITLE, which is also the dialog's
      // `aria-label` — the one string a screen reader announces on open, and the
      // one fact a mis-tap most needs to see. Target-neutral "to X" rather than
      // "in the channel": `channelName` is a nick on a query window.
      title: `Send to ${channelName}?`,
      // Count-free on purpose: the rows below ARE the count, and a number baked
      // into this string would start lying the moment a row is removed (the
      // request is not re-issued on removal — see ConfirmAttachments.items).
      body: "Each file below is uploaded and its link is posted there. This cannot be taken back.",
      confirmLabel: "Send",
      onConfirm: () =>
        enqueueUploads(
          key,
          networkSlug,
          channelName,
          staged().map((s) => s.file),
          batchTtlSeconds(),
        ),
      // No third door: there is no other route to "post this file here". Cancel
      // and Send are the whole question.
      alternative: null,
      // #1964 — the one dialog in cic where Enter means yes. The files are
      // already staged by a gesture the operator made, and this confirm is
      // opt-in: it exists to be READ, and the key you press after reading was
      // discarding the batch. See `ConfirmRequest.defaultButton`.
      defaultButton: "confirm",
      // #2094 — the TTL ladder, or nothing when the host has none to offer
      // (`effectiveTtlSeconds` is null exactly then). Seconds are the currency
      // on the wire of this control because seconds are what the preference
      // and the server both speak; the host token is picked at dispatch, from
      // whichever host is active by then.
      choice:
        batchTtlSeconds() === null
          ? null
          : {
              label: "Delete after",
              options: confirmHost.ttlOptions.map((opt) => ({
                value: String(opt.seconds),
                label: opt.label,
              })),
              value: () => String(batchTtlSeconds()),
              onSelect: (value) => setBatchTtlSeconds(Number(value)),
            },
      attachments: {
        items: (): ConfirmAttachment[] => staged().map((s) => s.attachment),
        onRemove: (id: string): void => {
          const rest = staged().filter((s) => s.id !== id);
          setStaged(rest);
          // Removing the last row is the same answer as Cancel — an empty dialog
          // asking "send these?" has nothing to affirm. Dismiss rather than
          // leaving a Send button that would be a no-op.
          if (rest.length === 0) dismissConfirm();
        },
      },
    });
  }
}

// #118 — the post-confirm half: enqueue ALL files, bump the batch total, then
// pump if nothing is active for this channel. Sequential: one file uploads at
// a time; each settle pumps the next. Private — the confirm above is the only
// way in, and `files` are already normalised.
function enqueueUploads(
  key: ChannelKey,
  networkSlug: string,
  channelName: string,
  files: File[],
  ttlSeconds: number | null,
): void {
  if (files.length === 0) return;
  const items: QueuedUpload[] = files.map((file) => ({
    file,
    networkSlug,
    channelName,
    ttlSeconds,
  }));
  const q = queue.get(key) ?? [];
  // A batch is "ongoing" only while something is genuinely processing — an
  // inflight upload, an open privacy modal, or files already queued. An
  // error entry on its own does NOT count: a fresh selection after a failed
  // upload starts a new batch and supersedes the error (the #49 contract).
  const ongoing = isActive(key) || q.length > 0;
  q.push(...items);
  queue.set(key, q);
  if (ongoing) {
    const prev = batchByChannel()[key];
    setBatch(key, { index: prev?.index ?? 0, total: (prev?.total ?? 0) + items.length });
  } else {
    setBatch(key, { index: 0, total: items.length });
  }
  // Already busy? The in-flight settle / dismiss / ack drains the queue.
  if (isActive(key)) return;
  pumpQueue(key);
}

// Back-compat single-file entry — retained so the existing call sites +
// tests keep their signature. Funnels into the queue like everything else.
export function triggerUpload(
  key: ChannelKey,
  networkSlug: string,
  channelName: string,
  rawFile: File,
): void {
  triggerUploads(key, networkSlug, channelName, [rawFile]);
}

// "Busy" = an upload is in flight, the privacy modal is open for this
// channel, or an error entry is awaiting the user's dismiss/retry. In any
// of these the queue must wait — the resolving path will pump it.
function isActive(key: ChannelKey): boolean {
  const modal = modalState();
  return inflight.has(key) || (modal.open && modal.key === key);
}

// Dequeue + start the next file. Empty → clear the batch counter.
function pumpQueue(key: ChannelKey): void {
  const q = queue.get(key);
  if (q === undefined || q.length === 0) {
    queue.delete(key);
    setBatch(key, null);
    return;
  }
  const next = q.shift() as QueuedUpload;
  queue.set(key, q);
  const total = batchByChannel()[key]?.total ?? q.length + 1;
  setBatch(key, { index: total - q.length, total });
  startUpload(key, next);
}

// Dispatch. The privacy gate used to live HERE, per file — it now runs once at
// the front of `triggerUploads`, before the operator is asked to Send, so
// nothing reaches the queue un-acknowledged and asking again here would be a
// second prompt for a question already answered.
function startUpload(key: ChannelKey, item: QueuedUpload): void {
  void dispatchUpload(key, item.networkSlug, item.channelName, item.file, item.ttlSeconds);
}

export function acknowledgePrivacy(rememberChoice: boolean): void {
  const state = modalState();
  if (!state.open) return;
  if (rememberChoice) {
    localStorage.setItem(privacyKey(state.host), "1");
  }
  setModalState({ open: false, host: null, key: null });
  // Resume the batch this notice interrupted: the Send confirm when the opt-in
  // is on, a straight enqueue when it is off. Cleared FIRST so a resume that
  // opens another modal cannot re-enter a stale continuation.
  const resume = pendingTrigger;
  pendingTrigger = null;
  resume?.();
}

export function cancelUpload(key: ChannelKey): void {
  const entry = inflight.get(key);
  if (entry !== undefined) {
    entry.controller.abort();
    inflight.delete(key);
  }
  // #118: cancelling the in-flight upload stops the WHOLE batch.
  queue.delete(key);
  setBatch(key, null);
  setEntry(key, null);
}

export function dismissUpload(key: ChannelKey): void {
  // Two dismiss flavours (#118):
  //  - from the privacy modal → the user declined; cancel the whole batch
  //    (clear the queue) — never silently re-dispatch the queued files.
  //  - from an upload error → skip the failed file, continue the rest.
  const modal = modalState();
  const wasModal = modal.open && modal.key === key;
  if (wasModal) {
    setModalState({ open: false, host: null, key: null });
    // Declining the terms cancels the batch before anything is queued — the
    // continuation is the only thing holding it, so dropping it IS the cancel.
    pendingTrigger = null;
  }
  const entry = inflight.get(key);
  if (entry !== undefined) {
    entry.controller.abort();
    inflight.delete(key);
  }
  setEntry(key, null);
  if (wasModal) {
    queue.delete(key);
    setBatch(key, null);
  } else {
    pumpQueue(key);
  }
}

export function retryUpload(key: ChannelKey): void {
  const ctx = lastAttempt.get(key);
  if (ctx === undefined) return;
  setEntry(key, null);
  // #118: re-run the failed file FIRST, then continue any queued files.
  const q = queue.get(key) ?? [];
  q.unshift({
    file: ctx.file,
    networkSlug: ctx.networkSlug,
    channelName: ctx.channelName,
    ttlSeconds: ctx.ttlSeconds,
  });
  queue.set(key, q);
  pumpQueue(key);
}
