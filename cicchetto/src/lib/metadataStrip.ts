// #2517b — the metadata strip an end-to-end encrypted attachment passes
// before cic encrypts it.
//
// #39 made metadata stripping a SERVER guarantee and kept clients out of it
// (`Grappa.Uploads.MetadataStrip`). An encrypted attachment reaches grappa as
// ciphertext, which the server physically cannot strip, so vjt's F2 ruling
// (2026-11-06) moves the strip into cic for that window ONLY: strip before
// encrypting, and a file that cannot be stripped is not sent. Plain uploads
// keep the server strip and never come here.
//
// Scope and kept tags mirror #39. An image's container is walked, animation
// frames included, and every segment, chunk or extension off its container's
// allowlist is dropped (a JPEG marker no decoder reads is refused); the EXIF
// Orientation (#39 round 2: without it a portrait photo renders sideways) and
// the ICC profile (#416: without it a Display-P3 photo renders washed out)
// stay. A video is the transcode's tag-free output or nothing
// (`encryptedVideoOutcome`). Documents and audio pass through, as in #39, and
// are never sent here.
//
// What it removes is metadata as tools write it. A kept block is copied whole,
// not checked against its expected shape, so a payload someone deliberately
// hid inside one (an oversized gAMA, an extra sub-block in a loop extension)
// goes through, as one hidden in the pixels would. The kept ICC profile
// carries text of its own, its description and copyright, and a display's
// profile names the display it describes.
//
// The allowlists hold what a decoder draws by and nothing else, so a block
// they do not name is dropped, wherever it sits: an allowlist cannot leak
// what it has never heard of. PNG gAMA and sRGB stay beside the ICC profile:
// colour description with no provenance, the class #416 keeps the profile
// for. Orientation comes back as ONE IFD entry.
//
// The container comes from the magic bytes, and the declared type must agree
// (`file.type` lies). The bytes after a container's end are dropped: a phone
// appends an MPF secondary image after a JPEG's EOI. A container that does
// not parse — truncated, a length past the end, junk where a block belongs —
// is REFUSED, never stripped from a guess.

import { atKey, keysOf } from "./byKey";
import { baseMime, type IMAGE_MIMES } from "./uploadCategory";
import type { TranscodeError } from "./videoTranscode";

export type ImageContainer = "jpeg" | "png" | "webp" | "gif";

/** Why an image is not sent. Typed, so the compose box can say it. */
export type ImageRefusal =
  // Not one of the five image types the upload allowlist accepts.
  | { reason: "unsupported_type"; declared: string }
  // The bytes are none of the four image containers.
  | { reason: "unknown_container"; declared: string }
  // The bytes are a container the declared type is not.
  | { reason: "type_mismatch"; declared: string; detected: ImageContainer }
  // The container does not parse, or holds a block no decoder reads.
  | { reason: "malformed"; container: ImageContainer; detail: string };

/** Why a video is not sent. */
export type VideoRefusal =
  // Over the duration ceiling: the same policy a plain upload meets.
  | { reason: "video_too_long"; durationSeconds: number }
  // The transcode did not run, or could not drop all the video's metadata.
  | { reason: "video_unprocessed"; detail: string };

export type Stripped<T, R> = { ok: T } | { refused: R };

// A new image type in the upload allowlist without a container here fails tsc.
const CONTAINER_OF = keysOf<ImageContainer>({
  "image/png": "png",
  "image/jpeg": "jpeg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/apng": "png",
} satisfies Record<(typeof IMAGE_MIMES)[number], ImageContainer>);

/**
 * `bytes` without their metadata, by the rules in the moduledoc, or why not.
 * Pure and synchronous; `declaredMime` is the type the file's source gave.
 */
export function stripImageMetadata(
  bytes: Uint8Array,
  declaredMime: string,
): Stripped<Uint8Array, ImageRefusal> {
  const expected = atKey(CONTAINER_OF, baseMime(declaredMime));
  if (expected === undefined) {
    return { refused: { reason: "unsupported_type", declared: declaredMime } };
  }
  const detected = containerOf(bytes);
  if (detected === null)
    return { refused: { reason: "unknown_container", declared: declaredMime } };
  if (detected !== expected) {
    return { refused: { reason: "type_mismatch", declared: declaredMime, detected } };
  }
  try {
    return { ok: STRIP[detected](bytes) };
  } catch (err) {
    if (!(err instanceof Malformed)) throw err;
    return { refused: { reason: "malformed", container: detected, detail: err.message } };
  }
}

/**
 * What an encrypted window may send of a video once `transcodeVideo` (called
 * with `"transcode"`) has answered: its fresh output, never the original. A
 * plain upload falls back to the original when the transcode cannot run and
 * lets the server strip it; here nothing would, so that is a refusal, and so
 * is the original coming back at all.
 */
export function encryptedVideoOutcome(
  original: File,
  result: { ok: File } | { error: TranscodeError },
): Stripped<File, VideoRefusal> {
  if ("ok" in result) {
    if (result.ok !== original) return { ok: result.ok };
    return { refused: { reason: "video_unprocessed", detail: "the original came back as it was" } };
  }
  const { error } = result;
  switch (error.kind) {
    case "too_long":
      return { refused: { reason: "video_too_long", durationSeconds: error.durationSeconds } };
    case "unsupported":
      return { refused: { reason: "video_unprocessed", detail: error.detail } };
    case "failed":
      return { refused: { reason: "video_unprocessed", detail: error.message } };
  }
}

// --------------------------------------------------------------------------
// Bytes
// --------------------------------------------------------------------------

// Thrown by the walkers and caught only by `stripImageMetadata`.
class Malformed extends Error {}

// Every read is bounds-checked: past the end is a truncated file.
function byte(b: Uint8Array, at: number): number {
  const value = b[at];
  if (value === undefined) throw new Malformed(`truncated at byte ${at}`);
  return value;
}
const be16 = (b: Uint8Array, at: number): number => (byte(b, at) << 8) | byte(b, at + 1);
const le16 = (b: Uint8Array, at: number): number => byte(b, at) | (byte(b, at + 1) << 8);
const be32 = (b: Uint8Array, at: number): number => be16(b, at) * 0x10000 + be16(b, at + 2);
const le32 = (b: Uint8Array, at: number): number => le16(b, at) + le16(b, at + 2) * 0x10000;

function slice(b: Uint8Array, from: number, to: number): Uint8Array {
  if (to > b.length) throw new Malformed(`a block runs to byte ${to}, past the end at ${b.length}`);
  return b.subarray(from, to);
}

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const latin1 = (b: Uint8Array): string => String.fromCharCode(...b);
const startsWith = (b: Uint8Array, at: number, prefix: Uint8Array): boolean =>
  prefix.every((x, i) => b[at + i] === x);
const be32Bytes = (n: number): Uint8Array =>
  Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
const le32Bytes = (n: number): Uint8Array =>
  Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, n >>> 24);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

const JPEG_MAGIC = Uint8Array.of(0xff, 0xd8, 0xff);
const PNG_MAGIC = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);

function containerOf(b: Uint8Array): ImageContainer | null {
  if (startsWith(b, 0, JPEG_MAGIC)) return "jpeg";
  if (startsWith(b, 0, PNG_MAGIC)) return "png";
  if (startsWith(b, 0, ascii("GIF87a")) || startsWith(b, 0, ascii("GIF89a"))) return "gif";
  if (startsWith(b, 0, ascii("RIFF")) && startsWith(b, 8, ascii("WEBP"))) return "webp";
  return null;
}

const STRIP: Record<ImageContainer, (b: Uint8Array) => Uint8Array> = {
  jpeg: stripJpeg,
  png: stripPng,
  webp: stripWebp,
  gif: stripGif,
};

// --------------------------------------------------------------------------
// EXIF Orientation: read from any EXIF TIFF, written back as one IFD entry
// --------------------------------------------------------------------------

// IFD0's Orientation when it is a rotation (1-8), else null. A TIFF that does
// not parse has none to keep and goes with the rest of the EXIF: losing the
// tag costs a sideways photo, never a leak, so it is no refusal.
function orientationOf(tiff: Uint8Array): number | null {
  try {
    const order = be16(tiff, 0);
    if (order !== 0x4949 && order !== 0x4d4d) return null;
    const u16 = order === 0x4949 ? le16 : be16;
    const u32 = order === 0x4949 ? le32 : be32;
    if (u16(tiff, 2) !== 42) return null;
    const ifd = u32(tiff, 4);
    for (let i = 0, count = u16(tiff, ifd); i < count; i++) {
      const entry = ifd + 2 + i * 12;
      if (u16(tiff, entry) !== 0x0112) continue;
      const value = u16(tiff, entry + 8);
      return value >= 1 && value <= 8 ? value : null;
    }
    return null;
  } catch (err) {
    if (!(err instanceof Malformed)) throw err;
    return null;
  }
}

// The one IFD entry cic writes back.
const orientationTiff = (orientation: number): Uint8Array =>
  concat([
    ascii("MM\0*"), // a big-endian TIFF
    be32Bytes(8), // IFD0 right after the header
    Uint8Array.of(0, 1), // one entry:
    Uint8Array.of(0x01, 0x12, 0, 3), // Orientation, SHORT
    be32Bytes(1), // count 1
    Uint8Array.of(0, orientation, 0, 0), // the value, left-justified
    be32Bytes(0), // no next IFD
  ]);

// --------------------------------------------------------------------------
// JPEG: segments. Kept: the markers a decoder reads, the scans, the
// ICC_PROFILE APP2 chunks, the Adobe APP14 (the colour transform a CMYK, YCCK
// or RGB-coded JPEG decodes by), and Orientation in a minimal EXIF APP1.
// Dropped: every other APPn (JFIF, XMP, MPF, IPTC…) and COM, before the scan
// or after it. Any other marker is refused.
// --------------------------------------------------------------------------

const EXIF_ID = ascii("Exif\0\0");
const ICC_ID = ascii("ICC_PROFILE\0");
const ADOBE_ID = ascii("Adobe");

// ITU T.81 Table B.1: SOF0-15 bar the reserved JPG (C8), counting DHT (C4)
// and DAC (CC) among them; then SOS, DQT, DNL, DRI, DHP and EXP.
const isDecodingMarker = (marker: number): boolean =>
  (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc8) || (marker >= 0xda && marker <= 0xdf);

function stripJpeg(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, 2)];
  let at = 2;
  for (;;) {
    if (byte(b, at) !== 0xff) throw new Malformed(`no JPEG marker at byte ${at}`);
    while (byte(b, at) === 0xff) at++; // fill bytes
    const marker = byte(b, at);
    if (marker === 0xd9) {
      out.push(b.subarray(at - 1, at + 1));
      return concat(out);
    }
    const isAppOrCom = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!isAppOrCom && !isDecodingMarker(marker)) {
      throw new Malformed(`unknown JPEG marker 0x${marker.toString(16)} at byte ${at}`);
    }
    const length = be16(b, at + 1);
    if (length < 2) throw new Malformed(`JPEG segment length ${length} at byte ${at + 1}`);
    const end = at + 1 + length;
    const segment = slice(b, at - 1, end);
    const payload = segment.subarray(4);
    if (marker === 0xe1 && startsWith(payload, 0, EXIF_ID)) {
      const orientation = orientationOf(payload.subarray(EXIF_ID.length));
      if (orientation !== null) {
        out.push(Uint8Array.of(0xff, 0xe1, 0, 34), EXIF_ID, orientationTiff(orientation));
      }
    } else if (
      !isAppOrCom ||
      (marker === 0xe2 && startsWith(payload, 0, ICC_ID)) ||
      (marker === 0xee && startsWith(payload, 0, ADOBE_ID))
    ) {
      out.push(segment);
    }
    at = end;
    if (marker === 0xda) {
      const scanEnd = endOfScan(b, at);
      out.push(b.subarray(at, scanEnd));
      at = scanEnd;
    }
  }
}

// The entropy-coded data after an SOS runs to the first marker that is not a
// stuffed 0xFF00 or a restart marker (RST0-7).
function endOfScan(b: Uint8Array, from: number): number {
  for (let at = from; ; at++) {
    if (byte(b, at) !== 0xff) continue;
    const next = byte(b, at + 1);
    if (next !== 0x00 && (next < 0xd0 || next > 0xd7)) return at;
    at++;
  }
}

// --------------------------------------------------------------------------
// PNG and APNG: chunks. Kept: the critical chunks, transparency, the colour
// description and the APNG animation chunks, and Orientation in a minimal
// eXIf. Dropped: text, time, the miscellaneous group (pHYs, bKGD, hIST,
// sPLT), and every chunk outside the PNG core. CRCs are never read: a kept
// chunk is copied whole.
// --------------------------------------------------------------------------

const PNG_KEPT = new Set([
  "IHDR",
  "PLTE",
  "IDAT",
  "IEND",
  "tRNS",
  "iCCP",
  "gAMA",
  "sRGB",
  "cHRM",
  "sBIT",
  "cICP",
  "mDCv",
  "cLLI",
  "acTL",
  "fcTL",
  "fdAT",
]);

function stripPng(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [b.subarray(0, PNG_MAGIC.length)];
  for (let at = PNG_MAGIC.length; ; ) {
    const length = be32(b, at);
    const type = latin1(slice(b, at + 4, at + 8));
    const end = at + 12 + length;
    const chunk = slice(b, at, end);
    if (type === "eXIf") {
      const orientation = orientationOf(chunk.subarray(8, 8 + length));
      if (orientation !== null) out.push(pngChunk("eXIf", orientationTiff(orientation)));
    } else if (PNG_KEPT.has(type)) {
      out.push(chunk);
    }
    if (type === "IEND") return concat(out);
    at = end;
  }
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typed = concat([ascii(type), data]);
  return concat([be32Bytes(data.length), typed, be32Bytes(crc32(typed))]);
}

// CRC-32 (ISO-HDLC), bitwise: it only ever covers one 30-byte chunk.
function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const x of bytes) {
    crc ^= x;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

// --------------------------------------------------------------------------
// WebP: RIFF chunks. Kept: VP8X (its XMP flag cleared, its EXIF flag set only
// when Orientation comes back), the bitstreams, alpha, animation and ICCP.
// An animation frame (ANMF) is walked too: RFC 9649 lets unknown chunks follow
// its bitstream. Dropped: XMP, the rest of EXIF, every unknown chunk. The RIFF
// and frame sizes are written afresh.
// --------------------------------------------------------------------------

const WEBP_KEPT = new Set(["VP8 ", "VP8L", "ALPH", "ANIM", "ICCP"]);
const FRAME_KEPT = new Set(["VP8 ", "VP8L", "ALPH"]);
const VP8X_EXIF = 0x08;
const VP8X_XMP = 0x04;

type RiffChunk = { fourcc: string; size: number; bytes: Uint8Array };

// The chunks in b[from, end), each with its payload size and its bytes,
// padding included. A chunk past `end` is a refusal; one past the file is too,
// since every chunk is read through `slice`.
function riffChunks(b: Uint8Array, from: number, end: number): RiffChunk[] {
  const chunks: RiffChunk[] = [];
  for (let at = from; at < end; ) {
    const fourcc = latin1(slice(b, at, at + 4));
    const size = le32(b, at + 4);
    const next = at + 8 + size + (size % 2);
    if (next > end) throw new Malformed(`${fourcc} chunk at byte ${at} runs past its container`);
    chunks.push({ fourcc, size, bytes: slice(b, at, next) });
    at = next;
  }
  return chunks;
}

function stripWebp(b: Uint8Array): Uint8Array {
  const out: Uint8Array[] = [];
  let vp8x: Uint8Array | null = null;
  let exif = false;
  for (const { fourcc, size, bytes } of riffChunks(b, 12, 8 + le32(b, 4))) {
    if (fourcc === "VP8X") {
      vp8x = bytes.slice();
      out.push(vp8x);
    } else if (fourcc === "EXIF") {
      const orientation = orientationOf(bytes.subarray(8, 8 + size));
      if (orientation !== null) {
        out.push(ascii("EXIF"), le32Bytes(26), orientationTiff(orientation));
        exif = true;
      }
    } else if (fourcc === "ANMF") {
      out.push(stripFrame(bytes, size));
    } else if (WEBP_KEPT.has(fourcc)) {
      out.push(bytes);
    }
  }
  if (vp8x !== null) vp8x[8] = (byte(vp8x, 8) & ~(VP8X_EXIF | VP8X_XMP)) | (exif ? VP8X_EXIF : 0);
  const body = concat([ascii("WEBP"), ...out]);
  return concat([ascii("RIFF"), le32Bytes(body.length), body]);
}

// An ANMF: its 16-byte frame header, then the frame's alpha and bitstream.
function stripFrame(frame: Uint8Array, size: number): Uint8Array {
  if (size < 16) throw new Malformed(`an ANMF of ${size} bytes, short of its 16-byte header`);
  const kept = riffChunks(frame, 24, 8 + size).filter(({ fourcc }) => FRAME_KEPT.has(fourcc));
  const body = concat([frame.subarray(8, 24), ...kept.map(({ bytes }) => bytes)]);
  return concat([ascii("ANMF"), le32Bytes(body.length), body]);
}

// --------------------------------------------------------------------------
// GIF: blocks. Kept: the header and colour tables, every frame, Graphic
// Control and Plain Text extensions, and the application extensions for the
// loop (NETSCAPE2.0, ANIMEXTS1.0) and the ICC profile. Dropped: Comment, XMP
// and every other extension.
// --------------------------------------------------------------------------

const GIF_KEPT_APPS = new Set(["NETSCAPE2.0", "ANIMEXTS1.0", "ICCRGBG1012"]);

const colourTableSize = (flags: number): number => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);

function stripGif(b: Uint8Array): Uint8Array {
  let at = 13 + colourTableSize(byte(b, 10));
  const out: Uint8Array[] = [slice(b, 0, at)];
  for (;;) {
    const start = at;
    const introducer = byte(b, at);
    if (introducer === 0x3b) {
      out.push(b.subarray(at, at + 1));
      return concat(out);
    }
    if (introducer === 0x2c) {
      at = endOfSubBlocks(b, at + 10 + colourTableSize(byte(b, at + 9)) + 1);
      out.push(b.subarray(start, at));
    } else if (introducer === 0x21) {
      const label = byte(b, at + 1);
      at = endOfSubBlocks(b, at + 2);
      const isKeptApp =
        label === 0xff &&
        byte(b, start + 2) === 11 &&
        GIF_KEPT_APPS.has(latin1(slice(b, start + 3, start + 14)));
      if (label === 0xf9 || label === 0x01 || isKeptApp) out.push(b.subarray(start, at));
    } else {
      throw new Malformed(`unknown GIF block 0x${introducer.toString(16)} at byte ${at}`);
    }
  }
}

// Where a run of data sub-blocks ends: just past its zero-length terminator.
function endOfSubBlocks(b: Uint8Array, from: number): number {
  let at = from;
  for (let size = byte(b, at); size !== 0; size = byte(b, at)) at += size + 1;
  return at + 1;
}
