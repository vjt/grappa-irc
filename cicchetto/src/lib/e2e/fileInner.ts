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
 * The attachment an encrypted message carries. `size` is the plaintext's,
 * and the ciphertext a fetch returns is `size + 16` (the GCM tag).
 */
export type FileInner = {
  t: "file";
  url: string;
  /** 32 bytes, standard base64 (unpadded, as `wire.ts` writes it). */
  key: string;
  /** 12 bytes, standard base64. */
  iv: string;
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
  | "bad-name"
  | "bad-mime"
  | "bad-size"
  | "bad-category"
  | "bad-expiry";

/**
 * A media type as RFC 6838 writes it: `type/subtype`, both from the token
 * alphabet, neither empty. Deliberately strict — this field is the PEER's
 * word and it is shown on the card, so anything outside the token set (bidi
 * overrides, C0/C1 controls, mIRC formatting bytes) is refused rather than
 * rendered. What a well-formed type READS as is not this check's to judge:
 * the card draws it, like the name, as text and never as a link
 * (`EncryptedChatPane`'s card).
 */
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/i;

/**
 * The `file` inner in `inner` when every field of it is well formed, or why
 * not. Shape only: whether `url` is THIS grappa's is `onGrappaOrigin`, which
 * needs the page's origin and is therefore the caller's.
 *
 * NEVER THROWS on wire input, whatever the caller hands it. A sibling copy
 * can carry `file: null` (a text message serialised by a peer that writes the
 * key anyway), and this runs inside the drain, where nothing may throw on what
 * the wire says. A non-object is a refusal like any other.
 */
export function parseFileInner(inner: Record<string, unknown>): FileInner | FileRefusal {
  if (typeof inner !== "object" || inner === null) return "not-a-file";
  if (inner.t !== "file") return "not-a-file";
  const { url, key, iv, name, mime, size, category, expires_at } = inner;
  if (typeof url !== "string") return "bad-url";
  if (typeof key !== "string" || byteLength(key) !== 32) return "bad-key";
  if (typeof iv !== "string" || byteLength(iv) !== 12) return "bad-iv";
  if (typeof name !== "string" || name === "") return "bad-name";
  if (typeof mime !== "string" || !MIME.test(mime)) return "bad-mime";
  if (typeof size !== "number" || !Number.isInteger(size) || size < 0) return "bad-size";
  if (!FILE_CATEGORIES.includes(category as UploadCategory)) return "bad-category";
  if (typeof expires_at !== "string" || Number.isNaN(Date.parse(expires_at))) return "bad-expiry";
  return {
    t: "file",
    url,
    key,
    iv,
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
 * What a filename must not keep: the path separators, and every code point
 * Unicode draws as nothing or uses to steer the layout rather than to write
 * text, named by property so the set is Unicode's and not a list kept here —
 * the controls (Cc, C0 and C1), the format characters (Cf: the bidi marks,
 * embeddings, overrides and isolates, the zero-width characters, the BOM, the
 * interlinear annotation marks, the TAG block), the rest of
 * Default_Ignorable_Code_Point (the Hangul fillers, the variation selectors),
 * and a lone surrogate (Cs), which is no text at all. A name is then shown
 * and saved as what it visibly says. Letters and combining marks of every
 * script stay: they are how names are written. So do the four code points of
 * `JOINERS` and `VARIATION_SELECTORS`, under their own rule.
 */
const BANNED_IN_NAME = /[\p{Cc}\p{Cf}\p{Cs}\p{Default_Ignorable_Code_Point}/\\]/u;

/**
 * Four code points that `BANNED_IN_NAME` covers and that are part of how some
 * names are written, so they come back, but only where they do that work:
 *
 * - U+200C ZERO WIDTH NON-JOINER and U+200D ZERO WIDTH JOINER stay only
 *   between two visible characters the name keeps (the ZWNJ inside a Persian
 *   word, the ZWJ inside an emoji sequence);
 * - U+FE0E and U+FE0F, the text and emoji variation selectors, stay only
 *   right after a base (the U+FE0F of ❤️);
 * - a run of either kind collapses to one;
 * - at an edge of the name, or anywhere else, they go.
 *
 * A variation selector that stays is part of its base, so the joiner after
 * the ❤️ of ❤️‍🔥 is between two visible characters.
 */
const JOINERS: ReadonlySet<string> = new Set(["\u200C", "\u200D"]);
const VARIATION_SELECTORS: ReadonlySet<string> = new Set(["\uFE0E", "\uFE0F"]);

/**
 * A blank. The Braille blank (U+2800) draws as a space and Unicode files it as
 * a symbol, so `\s` alone would let a run of them push the end of a name out
 * of sight.
 */
const BLANK = /[\s\u2800]/u;

/** A run of blanks, collapsed to one space. */
const BLANKS = new RegExp(`${BLANK.source}+`, "gu");

/** The longest name this client shows or saves, in code points. */
export const FILENAME_MAX = 120;

/**
 * The longest tail after the last dot that a cut keeps as the extension, in
 * code points. Past it the tail is more name, and the name is cut like one
 * with no extension at all.
 */
const EXTENSION_MAX = 16;

/**
 * `name` as it may be shown and saved: `BANNED_IN_NAME` taken out (the four
 * joiners and selectors only where they do no work), blanks collapsed, and
 * cut to `FILENAME_MAX` with its extension kept. Empty when nothing printable
 * is left, and the caller says so rather than inventing a name.
 */
export function sanitizeFileName(name: string): string {
  const kept = [...name].filter(
    (char) => JOINERS.has(char) || VARIATION_SELECTORS.has(char) || !BANNED_IN_NAME.test(char),
  );
  return cutToLength(keepInContext(kept).join("").replace(BLANKS, " ").trim()).trim();
}

/** Whether `char` draws as something: neither a blank nor one of the four. */
function isVisible(char: string): boolean {
  return !JOINERS.has(char) && !VARIATION_SELECTORS.has(char) && !BLANK.test(char);
}

/**
 * `chars` with `JOINERS` and `VARIATION_SELECTORS` kept only in the context
 * their rule names. A run collapses by the same tests: of a run of joiners
 * only the last one touches the character after it, and of a run of
 * selectors only the first one touches its base.
 */
function keepInContext(chars: readonly string[]): string[] {
  const kept: string[] = [];
  chars.forEach((char, at) => {
    const before = kept[kept.length - 1];
    if (VARIATION_SELECTORS.has(char)) {
      if (before !== undefined && isVisible(before)) kept.push(char);
    } else if (JOINERS.has(char)) {
      const after = chars[at + 1];
      const between =
        before !== undefined &&
        (isVisible(before) || VARIATION_SELECTORS.has(before)) &&
        after !== undefined &&
        isVisible(after);
      if (between) kept.push(char);
    } else {
      kept.push(char);
    }
  });
  return kept;
}

/**
 * `name` cut to `FILENAME_MAX`, and when it has an extension, the STEM is what
 * gets shorter. A download is saved under this name as
 * `application/octet-stream`, so an extension cut off is given back by
 * nothing: the file would land with no type at all.
 */
function cutToLength(name: string): string {
  const chars = [...name];
  if (chars.length <= FILENAME_MAX) return name;
  const dot = chars.lastIndexOf(".");
  const extension = dot > 0 ? chars.slice(dot) : [];
  const isExtension =
    extension.length > 1 && extension.length <= EXTENSION_MAX + 1 && !extension.includes(" ");
  // The cut can end a piece on a joiner, which is then at an edge.
  if (!isExtension) return keepInContext(chars.slice(0, FILENAME_MAX)).join("");
  const stem = keepInContext(chars.slice(0, FILENAME_MAX - extension.length))
    .join("")
    .trimEnd();
  return stem + extension.join("");
}
