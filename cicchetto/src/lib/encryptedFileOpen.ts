// issue 2517 — fetching, checking and opening an encrypted attachment, on
// the click and never before: a fetch tells grappa this address and the time
// the file was opened, so the card sits there until the user asks for it.
//
// The order is the point. The ciphertext's SHA-256 is checked BEFORE it is
// decrypted (a tampered blob is refused, not decrypted into something), and
// what may be rendered inline is an ALLOWLIST, not the peer's `mime`: a peer
// who says `image/svg+xml` or `text/html` gets a download, never a document
// in this origin. Everything else is offered as `application/octet-stream`.

import { openBytes, sha256Base64 } from "./e2e/fileCrypto";
import type { FileInner } from "./e2e/fileInner";

/** What the click produced: bytes to render, bytes to save, or why neither. */
export type OpenOutcome =
  | { ok: true; kind: "inline"; url: string; media: "image" | "video" | "audio" }
  | { ok: true; kind: "download" }
  | { ok: false; error: string };

/** The types that may be rendered in the page, and the media kind each one opens as. */
const INLINE: Readonly<Record<string, "image" | "video" | "audio">> = {
  "image/jpeg": "image",
  "image/png": "image",
  "image/gif": "image",
  "image/webp": "image",
  "video/mp4": "video",
  "video/webm": "video",
};

/** The media kind `mime` may be shown as, or null when it may only be saved. */
export function inlineKindOf(mime: string): "image" | "video" | "audio" | null {
  const found = INLINE[mime];
  if (found !== undefined) return found;
  return mime.startsWith("audio/") ? "audio" : null;
}

/**
 * Fetches `file`'s ciphertext, checks its digest, opens it with the key the
 * message carried, and answers the blob to render or to save. Never throws:
 * every failure is a sentence for the card.
 *
 * `signal` is the CALLER's lifetime (the card that started the open). An
 * aborted signal takes the fetch down with it, and — the half that matters —
 * stops a blob URL from being minted for a component that is already gone:
 * nobody would be left holding it, so nobody would revoke it, and the
 * plaintext would sit in memory until the page unloaded.
 */
export async function openEncryptedFile(
  file: FileInner,
  signal?: AbortSignal,
): Promise<OpenOutcome> {
  // Read through a function on purpose: TypeScript narrows a `signal?.aborted`
  // comparison to `false` for the rest of the function, but an abort can
  // arrive during any of the awaits below — the narrowing would be a lie.
  const isAborted = (): boolean => signal?.aborted === true;
  let ciphertext: Uint8Array<ArrayBuffer>;
  try {
    const res = await fetch(file.url, { credentials: "same-origin", signal });
    if (res.status === 404) {
      return {
        ok: false,
        error: Date.now() >= Date.parse(file.expires_at) ? "expired" : "gone",
      };
    }
    if (!res.ok) return { ok: false, error: `the server answered ${res.status}` };
    ciphertext = new Uint8Array(await res.arrayBuffer());
  } catch {
    return { ok: false, error: isAborted() ? "cancelled" : "the download failed" };
  }
  if (isAborted()) return { ok: false, error: "cancelled" };

  if ((await sha256Base64(ciphertext)) !== file.sha256) {
    return { ok: false, error: "the file does not match the digest in the message" };
  }
  const plaintext = await openBytes(ciphertext, file.key, file.iv);
  if (plaintext === null) return { ok: false, error: "the file could not be decrypted" };
  if (isAborted()) return { ok: false, error: "cancelled" };

  const media = inlineKindOf(file.mime);
  if (media !== null) {
    const url = URL.createObjectURL(new Blob([plaintext], { type: file.mime }));
    return { ok: true, kind: "inline", url, media };
  }
  saveBlob(new Blob([plaintext], { type: "application/octet-stream" }), file.name);
  return { ok: true, kind: "download" };
}

/** Saves `blob` under `name`: an anchor with `download`, clicked and dropped. */
function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // The navigation has taken the bytes: the URL may go.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
