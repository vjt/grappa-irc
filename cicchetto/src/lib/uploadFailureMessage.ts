// The sentences an upload failure is shown as — ONE home, because two doors
// answer the same failure. The plain composer's upload card and the encrypted
// attachment path had a copy each (`friendlyErrorMessage` here and
// `uploadFailure` in `encryptedAttachments.ts`), and the copies had already
// drifted: the encrypted one had no `lastProgress` reasoning at all. Same
// failure, same words, one implementation (CLAUDE.md: implement once).
import { formatBytes } from "./formatBytes";
import type { UploadError, UploadProgress } from "./uploadHost";

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
  // 401 — the session is gone, and neither door can fix that by picking a
  // different file. The encrypted door said so in its own copy before the two
  // were merged here; the shared sentence now serves both.
  if (status === 401) return "Not signed in, so the upload was refused.";
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

export function friendlyErrorMessage(
  err: UploadError,
  lastProgress: UploadProgress | null,
): string {
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
