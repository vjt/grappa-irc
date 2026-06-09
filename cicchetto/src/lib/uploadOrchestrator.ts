import { createSignal } from "solid-js";
import type { ChannelKey } from "./channelKey";
import { sendMessage } from "./scrollback";
import { categoryOf, type UploadCategory } from "./uploadCategory";
import { activeHost, type UploadError, type UploadHost } from "./uploadHost";
import { getUploadTtlSeconds, putUploadTtlSeconds } from "./userSettings";

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
  /** Task 5 (2026-06-09): "transcoding" is driven by the Task 6 video
   *  transcode; every entry this task emits is "uploading". The type
   *  lands now so ComposeBox (Task 7) builds against it. */
  phase: "transcoding" | "uploading";
  error?: string;
};

// Per-category PRIVMSG prefix — IRC stays text only; the emoji is the
// whole "media type" signal on the wire.
const CATEGORY_EMOJI: Record<UploadCategory, string> = {
  image: "📸",
  video: "🎬",
  document: "📄",
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
const lastAttempt = new Map<ChannelKey, { file: File; networkSlug: string; channelName: string }>();
// File staged behind the privacy modal (one at a time — modal is a
// global singleton). Keyed by channel so dismiss/continue knows what
// to retry.
const pendingPrivacyGated = new Map<
  ChannelKey,
  { file: File; networkSlug: string; channelName: string }
>();

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

/** Translate a stored-seconds preference into a host-specific token
 *  from the active host's ladder. Returns `null` when no match exists
 *  (caller falls back to `host.defaultTtl`). */
function pickHostTokenFromSeconds(host: UploadHost, seconds: number | null): string | null {
  if (seconds === null) return null;
  const match = host.ttlOptions.find((opt) => opt.seconds === seconds);
  return match?.value ?? null;
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

function friendlyErrorMessage(err: UploadError): string {
  switch (err.kind) {
    case "network":
      return "Upload failed — network error. Retry?";
    case "abort":
      // Caller short-circuits this path (silent state clear) — included
      // for exhaustiveness only.
      return "Upload cancelled.";
    case "http":
      if (err.status >= 400 && err.status < 500) {
        return `Upload rejected (${err.status}) — try a different file.`;
      }
      return `Upload service unavailable (${err.status}). Retry?`;
    case "invalid_response":
      return "Upload completed but the server returned an invalid response.";
    case "provider":
      return err.message;
  }
}

// MIME → extension label for the unsupported-type error copy. Mirrors
// the uploadCategory.ts MIME lists — adding a MIME there means adding
// its label here in the same commit.
const MIME_EXT_LABEL: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/apng": "apng",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

function unsupportedTypeMessage(host: UploadHost): string {
  const exts = (["image", "video", "document"] satisfies UploadCategory[])
    .flatMap((category) => host.acceptedMimeTypes[category])
    .map((mime) => MIME_EXT_LABEL[mime] ?? mime);
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
): Promise<void> {
  const host = activeHost();

  // #49 root fix: lastAttempt is the user's LATEST selection, recorded
  // before any gate can reject — retry always retries what the error
  // box shows, and a new selection always replaces a rejected one.
  lastAttempt.set(key, { file, networkSlug, channelName });

  const category = categoryOf(file.type);
  if (category === null || !host.acceptedMimeTypes[category].includes(file.type)) {
    setEntry(key, {
      filename: file.name,
      loaded: 0,
      total: 0,
      phase: "uploading",
      error: unsupportedTypeMessage(host),
    });
    return;
  }

  // Transform hook — video transcode lands in Task 6; image/document
  // pass through.
  const uploadFile = file;

  // Cap check runs on the file that will ACTUALLY upload — after the
  // transform, since the transcode changes the size.
  const cap = host.maxFileSizeBytes(category);
  if (cap !== null && uploadFile.size > cap) {
    const mb = Math.round(cap / (1024 * 1024));
    setEntry(key, {
      filename: uploadFile.name,
      loaded: 0,
      total: 0,
      phase: "uploading",
      error: `File is too large (max ${mb}MB).`,
    });
    return;
  }

  const controller = new AbortController();
  inflight.set(key, { controller, file: uploadFile, networkSlug, channelName });

  setEntry(key, {
    filename: uploadFile.name,
    loaded: 0,
    total: uploadFile.size,
    phase: "uploading",
  });

  const ttl = pickHostTokenFromSeconds(host, uploadTtlSeconds()) ?? host.defaultTtl ?? undefined;

  host
    .upload(
      uploadFile,
      ttl !== undefined ? { ttl } : {},
      (p) => {
        // Ignore stale progress events from a cancelled-then-retried
        // upload — only the current inflight entry matters.
        if (inflight.get(key)?.controller !== controller) return;
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
        error: friendlyErrorMessage(err),
      });
    });
}

export function triggerUpload(
  key: ChannelKey,
  networkSlug: string,
  channelName: string,
  file: File,
): void {
  const host = activeHost();
  const ackd = localStorage.getItem(privacyKey(host));
  if (ackd === null || ackd === "") {
    pendingPrivacyGated.set(key, { file, networkSlug, channelName });
    setModalState({ open: true, host, key });
    return;
  }
  void dispatchUpload(key, networkSlug, channelName, file);
}

export function acknowledgePrivacy(rememberChoice: boolean): void {
  const state = modalState();
  if (!state.open) return;
  const host = state.host;
  const pendingKey = state.key;
  if (rememberChoice) {
    localStorage.setItem(privacyKey(host), "1");
  }
  setModalState({ open: false, host: null, key: null });
  const pending = pendingPrivacyGated.get(pendingKey);
  if (pending === undefined) return;
  pendingPrivacyGated.delete(pendingKey);
  void dispatchUpload(pendingKey, pending.networkSlug, pending.channelName, pending.file);
}

export function cancelUpload(key: ChannelKey): void {
  const entry = inflight.get(key);
  if (entry !== undefined) {
    entry.controller.abort();
    inflight.delete(key);
  }
  setEntry(key, null);
}

export function dismissUpload(key: ChannelKey): void {
  // Symmetrical handler for: error UI dismiss, cancel-from-modal,
  // retry preface. Closes any open privacy modal targeting this key
  // AND clears any in-flight controller AND clears the visible state
  // entry. Safe to call from any state.
  const modal = modalState();
  if (modal.open && modal.key === key) {
    setModalState({ open: false, host: null, key: null });
    pendingPrivacyGated.delete(key);
  }
  const entry = inflight.get(key);
  if (entry !== undefined) {
    entry.controller.abort();
    inflight.delete(key);
  }
  setEntry(key, null);
}

export function retryUpload(key: ChannelKey): void {
  const ctx = lastAttempt.get(key);
  if (ctx === undefined) return;
  setEntry(key, null);
  triggerUpload(key, ctx.networkSlug, ctx.channelName, ctx.file);
}
