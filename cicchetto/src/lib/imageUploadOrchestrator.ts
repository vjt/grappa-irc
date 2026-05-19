import { createSignal } from "solid-js";
import type { ChannelKey } from "./channelKey";
import { activeHost, type ImageHost, type UploadError } from "./image-upload";
import { sendMessage } from "./scrollback";
import { getUploadTtlSeconds, putUploadTtlSeconds } from "./userSettings";

// Image-upload orchestration — images cluster I-2 (2026-05-15).
//
// Sits between the cic compose surface (ComposeBox.tsx — picker /
// camera / drag-drop / paste triggers) and the host transport layer
// (image-upload.ts — pluggable ImageHost interface). Holds the
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
// IRC stays text only: on resolve, we build `📸 ${url}` and call
// scrollback.sendMessage directly — bypasses compose.ts submit() so
// the operator's draft text in the textarea stays untouched (per A7).
// The image PRIVMSG is its own separate message; no draft clobbering.

export type UploadStateEntry = {
  filename: string;
  loaded: number;
  total: number;
  error?: string;
};

type ActiveUpload = {
  controller: AbortController;
  file: File;
  networkSlug: string;
  channelName: string;
};

export type PrivacyModalState =
  | { open: true; host: ImageHost; key: ChannelKey }
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

const privacyKey = (host: ImageHost): string => `${PRIVACY_KEY_PREFIX}:${host.id}`;

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
function pickHostTokenFromSeconds(host: ImageHost, seconds: number | null): string | null {
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

function preCheck(host: ImageHost, file: File): string | null {
  if (!host.acceptedMimeTypes.includes(file.type)) {
    return `Only image files are supported (${host.acceptedMimeTypes
      .map((m) => m.replace("image/", "."))
      .join(", ")}).`;
  }
  if (host.maxFileSizeBytes !== null && file.size > host.maxFileSizeBytes) {
    const mb = Math.round(host.maxFileSizeBytes / (1024 * 1024));
    return `File is too large (max ${mb}MB).`;
  }
  return null;
}

function dispatchUpload(
  key: ChannelKey,
  networkSlug: string,
  channelName: string,
  file: File,
): void {
  const host = activeHost();

  const preErr = preCheck(host, file);
  if (preErr !== null) {
    setEntry(key, { filename: file.name, loaded: 0, total: 0, error: preErr });
    return;
  }

  const controller = new AbortController();
  inflight.set(key, { controller, file, networkSlug, channelName });
  lastAttempt.set(key, { file, networkSlug, channelName });

  setEntry(key, { filename: file.name, loaded: 0, total: file.size });

  const ttl = pickHostTokenFromSeconds(host, uploadTtlSeconds()) ?? host.defaultTtl ?? undefined;

  host
    .upload(
      file,
      ttl !== undefined ? { ttl } : {},
      (p) => {
        // Ignore stale progress events from a cancelled-then-retried
        // upload — only the current inflight entry matters.
        if (inflight.get(key)?.controller !== controller) return;
        setEntry(key, { filename: file.name, loaded: p.loaded, total: p.total });
      },
      controller.signal,
    )
    .then((url) => {
      if (inflight.get(key)?.controller !== controller) return;
      inflight.delete(key);
      setEntry(key, null);
      // Auto-send PRIVMSG with photocamera prefix — A7.
      void sendMessage(networkSlug, channelName, `📸 ${url}`);
    })
    .catch((err: UploadError) => {
      if (inflight.get(key)?.controller !== controller) return;
      inflight.delete(key);
      if (err.kind === "abort") {
        setEntry(key, null);
        return;
      }
      setEntry(key, {
        filename: file.name,
        loaded: 0,
        total: 0,
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
  dispatchUpload(key, networkSlug, channelName, file);
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
  dispatchUpload(pendingKey, pending.networkSlug, pending.channelName, pending.file);
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
