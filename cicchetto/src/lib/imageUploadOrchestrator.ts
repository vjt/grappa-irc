import { createSignal } from "solid-js";
import type { ChannelKey } from "./channelKey";
import { activeHost, type ImageHost, type UploadError } from "./image-upload";
import { sendMessage } from "./scrollback";

// Image-upload orchestration — images cluster I-2 (2026-05-15).
//
// Sits between the cic compose surface (ComposeBox.tsx — picker /
// camera / drag-drop / paste triggers) and the host transport layer
// (image-upload.ts — pluggable ImageHost interface). Holds the
// per-channel upload-in-flight state, the singleton privacy-modal
// gate, the per-host TTL preference, and the auto-send wiring.
//
// Single entry point: triggerUpload(key, networkSlug, channelName,
// file). All four trigger surfaces collapse to that one call. The
// rest of the surface — uploadState, cancel, dismiss, retry, TTL
// dropdown wiring — is consumed by ComposeBox.tsx; the privacy-modal
// surface is consumed by PrivacyModal.tsx mounted at Shell root.
//
// Per-host namespacing: privacy-ack flag + chosen-TTL preference both
// keyed under `:<host.id>` so swapping providers tomorrow doesn't
// inherit the wrong defaults silently. See A6 + A7 in the brainstorm.
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
const TTL_KEY_PREFIX = "image-upload-ttl";

const privacyKey = (host: ImageHost): string => `${PRIVACY_KEY_PREFIX}:${host.id}`;
const ttlKey = (host: ImageHost): string => `${TTL_KEY_PREFIX}:${host.id}`;

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

export function getChosenTtl(): string | null {
  const host = activeHost();
  return localStorage.getItem(ttlKey(host));
}

export function setChosenTtl(value: string): void {
  const host = activeHost();
  localStorage.setItem(ttlKey(host), value);
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

  const ttl = getChosenTtl() ?? host.defaultTtl ?? undefined;

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
