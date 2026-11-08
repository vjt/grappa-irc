// issue 2517 — sending a file in an end-to-end encrypted query: strip its
// metadata, seal it, upload the ciphertext to grappa's encrypted door, and
// send the key inside the Olm message. Nothing here touches a plain upload:
// the plain door keeps the server's own strip (#39) and never comes here.
//
// The order is the spec's (issue 2517 comment 6726621841): the strip first,
// because grappa cannot do it on ciphertext and a file that cannot be
// stripped is not sent at all; then the cap, on the PLAINTEXT, with the
// category's own cap — the server has one cap for every category, the
// largest plus the tag, and cannot tell which category a blob was; then the
// seal; then the upload; then the message that carries the key.
//
// A video is the transcode's tag-free output or nothing (`transcodeVideo`
// with the "transcode" stripper and `encryptedVideoOutcome`): the plain path
// may fall back to the original and let the server strip it, and this one
// has nobody to fall back to.

import { sealBytes } from "./e2e/fileCrypto";
import type { FileInner } from "./e2e/fileInner";
import { sendEncryptedFile } from "./encryptedChats";
import { formatBytes } from "./formatBytes";
import { encryptedVideoOutcome, stripImageMetadata } from "./metadataStrip";
import { baseMime, categoryOf, type UploadCategory } from "./uploadCategory";
import {
  type EncryptedUploadAnswer,
  embeddedHost,
  type UploadError,
  type UploadProgress,
  uploadEncryptedCiphertext,
} from "./uploadHost";

/** What became of an encrypted attachment: sent, or why not (the sentence the compose box shows). */
export type AttachmentOutcome = { ok: true } | { ok: false; error: string };

export type AttachmentRequest = {
  networkSlug: string;
  /** The peer whose encrypted chat this went to. */
  peer: string;
  file: File;
  /** The embedded host's TTL token: seconds as a string, as the plain door takes it. */
  ttl: string | undefined;
  /** The server's video ceiling, read by the caller at dispatch (`uploadVideoMaxDurationSeconds`). */
  maxDurationSeconds: number;
  signal: AbortSignal;
  onPhase: (phase: "transcoding" | "uploading", loaded: number, total: number) => void;
};

/**
 * Sends `file` to `peer` in an encrypted query, or says why it cannot be
 * sent. Never throws on a refusal: every way out is an answer.
 */
export async function sendEncryptedAttachment(req: AttachmentRequest): Promise<AttachmentOutcome> {
  const mime = baseMime(req.file.type);
  const category = categoryOf(mime);
  // The same accept gate as the plain path, against the same store: the
  // bytes always land on grappa, whatever host the admin picked.
  if (category === null || !embeddedHost.acceptedMimeTypes[category].includes(mime)) {
    return { ok: false, error: `Unsupported file type — ${mime || "unknown"}.` };
  }
  const cap = embeddedHost.maxFileSizeBytes(category);
  if (cap !== null && req.file.size > cap) {
    return { ok: false, error: `File is too large (max ${formatBytes(cap)}).` };
  }

  const stripped = await stripForEncrypted(req, category, cap);
  if ("error" in stripped) return { ok: false, error: stripped.error };
  if (req.signal.aborted) return { ok: false, error: "Upload cancelled." };

  const bytes = new Uint8Array(await stripped.file.arrayBuffer());
  // The strip can shrink a video; the cap is on what actually goes.
  if (cap !== null && bytes.length > cap) {
    return { ok: false, error: `File is too large (max ${formatBytes(cap)}).` };
  }

  const sealed = await sealBytes(bytes);
  if (req.signal.aborted) return { ok: false, error: "Upload cancelled." };

  req.onPhase("uploading", 0, sealed.ciphertext.length);
  let answer: EncryptedUploadAnswer;
  try {
    answer = await uploadEncryptedCiphertext(
      new Blob([sealed.ciphertext.buffer as ArrayBuffer], { type: "application/octet-stream" }),
      req.ttl,
      (p: UploadProgress) => req.onPhase("uploading", p.loaded, p.total),
      req.signal,
    );
  } catch (err) {
    return { ok: false, error: uploadFailure(err as UploadError) };
  }

  const inner: FileInner = {
    t: "file",
    url: answer.url,
    key: sealed.key,
    iv: sealed.iv,
    sha256: sealed.sha256,
    name: stripped.file.name,
    mime,
    size: bytes.length,
    category,
    expires_at: answer.expiresAt,
  };
  await sendEncryptedFile(req.networkSlug, req.peer, inner);
  return { ok: true };
}

/**
 * `req.file` without the metadata it may not carry, or why it cannot be
 * sent. An image is walked and refused rather than sent as it is; a video is
 * the transcode's output or a refusal; a document or an audio file passes,
 * as it does on the plain door, where nothing strips it either.
 */
async function stripForEncrypted(
  req: AttachmentRequest,
  category: UploadCategory,
  cap: number | null,
): Promise<{ file: File } | { error: string }> {
  if (category === "image") {
    const bytes = new Uint8Array(await req.file.arrayBuffer());
    const stripped = stripImageMetadata(bytes, req.file.type);
    if ("refused" in stripped) return { error: imageRefusal(stripped.refused.reason) };
    // `stripImageMetadata` answers a view of the bytes it walked, so the
    // buffer is the file's own: the assertion is the view's declaration,
    // not a promise about anything else.
    const kept = stripped.ok as Uint8Array<ArrayBuffer>;
    return { file: new File([kept], req.file.name, { type: baseMime(req.file.type) }) };
  }
  if (category === "video") {
    req.onPhase("transcoding", 0, 1);
    // Lazy chunk, as in `prepareVideo`: mediabunny only loads for a video.
    const { transcodeVideo } = await import("./videoTranscode");
    const result = await transcodeVideo(
      req.file,
      cap ?? 50 * 1024 * 1024,
      req.maxDurationSeconds,
      "transcode",
      (fraction) => req.onPhase("transcoding", fraction, 1),
      req.signal,
    );
    if (req.signal.aborted) return { error: "Upload cancelled." };
    const outcome = encryptedVideoOutcome(req.file, result);
    if ("refused" in outcome) {
      return {
        error:
          outcome.refused.reason === "video_too_long"
            ? "Video too long."
            : `Couldn't remove the metadata from that video, so it wasn't sent (${outcome.refused.detail}).`,
      };
    }
    return { file: outcome.ok };
  }
  return { file: req.file };
}

function imageRefusal(
  reason: "unsupported_type" | "unknown_container" | "type_mismatch" | "malformed",
): string {
  switch (reason) {
    case "unsupported_type":
      return "That image type cannot be sent encrypted.";
    case "unknown_container":
      return "That file is not an image its type claims.";
    case "type_mismatch":
      return "That file's bytes are not the image type it declares.";
    case "malformed":
      return "That image is damaged, so its metadata could not be removed.";
  }
}

/** The sentence for an upload that failed: the same shapes the plain door answers. */
function uploadFailure(err: UploadError): string {
  if (err.kind === "abort") return "Upload cancelled.";
  if (err.kind === "network") return "Upload failed — network error. Retry?";
  if (err.kind === "http") {
    if (err.status === 413) return "File is too large for the server.";
    if (err.status === 401) return "Not signed in, so the upload was refused.";
    return `Upload rejected (${err.status}) — try a different file.`;
  }
  return "Upload failed. Retry?";
}
