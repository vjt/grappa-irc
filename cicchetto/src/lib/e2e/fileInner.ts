// issue 2517 — the `t: "file"` inner: what an end-to-end encrypted
// attachment's key, URL and metadata cross IRC as (spec: issue 2517 comment
// 6726621841).
//
// grappa stores the ciphertext and nothing else (§4k): the name, the type and
// the size live here, inside the Olm message, and so do the key and the IV.
// Everything in this object is the PEER's word, so every field is checked
// before anything is done with it — above all `url`, which must be this
// grappa's own upload path and nothing else: a peer must not be able to make
// this client fetch an arbitrary address.

import type { UploadCategory } from "../uploadCategory";
import { unbase64 } from "./wire";

/**
 * The attachment an encrypted message carries. `sha256` is over the
 * CIPHERTEXT, which is what a fetch returns; `size` is the plaintext's,
 * and the ciphertext is `size + 16` (the GCM tag).
 */
export type FileInner = {
  t: "file";
  url: string;
  /** 32 bytes, standard base64 (unpadded, as `wire.ts` writes it). */
  key: string;
  /** 12 bytes, standard base64. */
  iv: string;
  /** 32 bytes, standard base64. */
  sha256: string;
  name: string;
  mime: string;
  size: number;
  category: UploadCategory;
  /** grappa's answer to the upload: past it the blob is gone. */
  expires_at: string;
};

/** The four upload categories, in the order `uploadCategory.ts` names them. */
export const FILE_CATEGORIES: readonly UploadCategory[] = ["image", "video", "document", "audio"];

// §4k: the ciphertext is stored with no extension, under the same 26-char
// base32 slug a plain upload gets (Grappa.Uploads @slug_regex).
const UPLOAD_PATH = /^\/uploads\/[a-z2-7]{26}$/;

/** Why a `t: "file"` inner is refused. */
export type FileRefusal =
  | "not-a-file"
  | "bad-url"
  | "bad-key"
  | "bad-iv"
  | "bad-sha256"
  | "bad-name"
  | "bad-mime"
  | "bad-size"
  | "bad-category"
  | "bad-expiry";

/**
 * The `file` inner in `inner` when every field of it is well formed, or why
 * not. Shape only: whether `url` is THIS grappa's is `onGrappaOrigin`, which
 * needs the page's origin and is therefore the caller's.
 */
export function parseFileInner(inner: Record<string, unknown>): FileInner | FileRefusal {
  if (inner.t !== "file") return "not-a-file";
  const { url, key, iv, sha256, name, mime, size, category, expires_at } = inner;
  if (typeof url !== "string") return "bad-url";
  if (typeof key !== "string" || byteLength(key) !== 32) return "bad-key";
  if (typeof iv !== "string" || byteLength(iv) !== 12) return "bad-iv";
  if (typeof sha256 !== "string" || byteLength(sha256) !== 32) return "bad-sha256";
  if (typeof name !== "string" || name === "") return "bad-name";
  if (typeof mime !== "string" || mime === "") return "bad-mime";
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return "bad-size";
  if (!FILE_CATEGORIES.includes(category as UploadCategory)) return "bad-category";
  if (typeof expires_at !== "string" || Number.isNaN(Date.parse(expires_at))) return "bad-expiry";
  return {
    t: "file",
    url,
    key,
    iv,
    sha256,
    name,
    mime,
    size,
    category: category as UploadCategory,
    expires_at,
  };
}

/** The bytes `text` decodes to, or -1 when it is not base64 at all. */
function byteLength(text: string): number {
  try {
    return unbase64(text).length;
  } catch {
    return -1;
  }
}

/**
 * Whether `url` is this grappa's own encrypted upload: `origin` plus
 * `/uploads/<slug>`, nothing else — no other host, no other path, no query
 * and no fragment. A peer that names anywhere else is refused.
 */
export function onGrappaOrigin(url: string, origin: string): boolean {
  if (!url.startsWith(`${origin}/uploads/`)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin !== origin) return false;
  if (parsed.search !== "" || parsed.hash !== "") return false;
  return UPLOAD_PATH.test(parsed.pathname);
}

/**
 * The code points a filename must not keep: separators and control
 * characters, and the bidi overrides that let `invoice<RLO>gpj.exe` read as
 * `invoice.jpg` when the name is shown or saved.
 */
const bannedInName = (cp: number): boolean =>
  cp <= 0x1f ||
  cp === 0x7f ||
  cp === 0x2f ||
  cp === 0x5c ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2066 && cp <= 0x2069);

/** The longest name this client shows or saves. */
export const FILENAME_MAX = 120;

/**
 * `name` as it may be shown and saved: path separators, control characters
 * and bidi overrides taken out, whitespace collapsed, and cut to
 * `FILENAME_MAX`. Empty when nothing printable is left, and the caller says
 * so rather than inventing a name.
 */
export function sanitizeFileName(name: string): string {
  const kept = [...name].filter((char) => {
    const cp = char.codePointAt(0);
    return cp === undefined || !bannedInName(cp);
  });
  const cleaned = kept.join("").replace(/\s+/g, " ").trim();
  return [...cleaned].slice(0, FILENAME_MAX).join("").trim();
}
