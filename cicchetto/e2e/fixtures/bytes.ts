import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

// Shared tiny-file byte fixtures for upload specs.
//
// 1×1 transparent RGBA PNG — VALID bytes (correct IDAT CRC), verified
// against the server's fail-closed exiftool strip. The previous
// inline copies of this constant (i2b / ux-6-b / rev-g-h22 specs)
// carried a corrupted IDAT chunk — bad CRC — that survived for months
// because nothing validated image bytes server-side; the #39 metadata
// strip (2026-06-10) rejects it with 422 metadata_strip_failed
// ("Bad CRC for IDAT chunk"). Keep ONE copy here so the next
// byte-level gate breaks one constant, not a scavenger hunt.
//
// Node context: Buffer.from(TINY_PNG_HEX, "hex"). In-page context:
// pass the string into page.evaluate and decode there.
export const TINY_PNG_HEX =
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489" +
  "0000000b49444154789c6360000200000500017a5eab3f0000000049454e44ae426082";

// #682 — a minimal, VALID MPEG-1 Layer III frame sequence, built rather than
// pasted: 417 bytes per frame at 128 kbps / 44.1 kHz, so a hex constant for
// even a few frames would be kilobytes of noise in a source file.
//
// Header bytes, for the next reader who has to check them against a spec
// sheet rather than trust a magic number:
//   FF FB — syncword + MPEG-1 + Layer III + no CRC
//   90    — 128 kbps, 44100 Hz, no padding
//   40    — joint stereo, no emphasis
// Frame size = floor(144 * 128000 / 44100) = 417.
//
// The payload is silence (zeroes). Specs use this to satisfy an <audio>
// element from a `page.route` handler, so that a radio station's stream is
// served LOCALLY and the suite never reaches a third-party host.
const MP3_FRAME_HEADER = [0xff, 0xfb, 0x90, 0x40];
const MP3_FRAME_BYTES = 417;

export function silentMp3(frames: number): Buffer {
  const frame = Buffer.alloc(MP3_FRAME_BYTES);
  for (const [i, byte] of MP3_FRAME_HEADER.entries()) frame[i] = byte;
  return Buffer.concat(Array.from({ length: frames }, () => frame));
}

// #1805 — a PNG of a GIVEN SIZE, built rather than pasted, for the same reason
// silentMp3 is built: a hex constant for anything bigger than a dot is
// kilobytes of noise, and the size is the parameter that matters.
//
// Why it had to exist: TINY_PNG_HEX is 1×1, and the media viewer renders an
// image at its intrinsic size capped by max-width/max-height — it never scales
// UP. So on that constant the viewer's image is one pixel, and EVERY geometric
// assertion about it (does zooming create a scrollable area, did the visible
// portion move) is satisfied by a one-pixel answer whether or not the feature
// works. A spec that needs to see the picture move needs a picture.
//
// Solid mid-grey RGB, no alpha, no ancillary chunks: the smallest thing the
// server's fail-closed exiftool strip (#39) will accept, and the CRCs are
// computed rather than transcribed, which is the failure mode that cost the
// inline copies TINY_PNG_HEX replaced.
const CRC_TABLE: number[] = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

// ── the two committed video fixtures, and the rule for choosing ────────────
//
// 🔴 THE RUNNER'S BROWSER IS NOT THE SAME PRODUCT ON EVERY HOST, AND ONLY ONE
// OF THEM DECODES H.264 (issue 2026). Measured 2026-09-15 on both binaries,
// same Playwright revision 1217, all controls green:
//
//                                                canPlayType('video/mp4; codecs="avc1.64000A"')
//   linux-x64    Chrome for Testing, 147.0.7727.15          "probably"
//   linux-arm64  Playwright's own Chromium, 147.0.7727.0    ""        ← and AAC likewise
//
// It is not an architecture compiled twice: `DOWNLOAD_PATHS` in
// playwright-core's registry sends `ubuntu22.04-x64` to a `builds/cft/…`
// archive (Chrome for Testing — a Chrome build, proprietary codecs included)
// and `ubuntu22.04-arm64` to `builds/chromium/…`, with Playwright's own
// `// non-cft build` comment sitting on that line. CI runs `ubuntu-latest`
// (x64); an Apple-silicon worker's Docker resolves the same multi-arch base
// tag to arm64. Nothing in this repo pins `platform:`.
//
// The consequence, and it is the whole reason these constants exist: an H.264
// fixture handed to a REAL decoder is GREEN IN CI AND RED LOCALLY. That split
// cost issue 2026 nine data points and several from-scratch investigations,
// because the knowledge lived in a comment inside one spec instead of beside
// the bytes every spec reaches for.
//
// WHICH ONE:
//
//   DECODABLE_VIDEO  the engine must DECODE the bytes — a <video> that has to
//                    reach metadata, an `error?.code` oracle, `videoWidth`.
//                    VP9-in-WebM, "probably" on BOTH builds (measured).
//   OPAQUE_VIDEO     the bytes are only CARRIED — uploaded, linked, named, or
//                    inspected server-side. Never handed to a decoder.
//
// 🔴 Do NOT re-encode tiny.mp4 in place to "fix" this: two specs depend on it
// being an mp4 — uploads2-video-doc-upload posts it through the picker as
// `video/mp4`, and ux-6-b-admin-settings pins its 1.000 s duration.
//
// Regenerate the webm (the grappa image carries ffmpeg with libvpx-vp9, like
// test/support/fixtures/uploads/generate.sh):
//   ffmpeg -y -f lavfi -i color=c=blue:s=128x72:d=1 \
//     -c:v libvpx-vp9 -pix_fmt yuv420p tiny.webm
const videoFixture = (name: string): Buffer =>
  readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)));

export const DECODABLE_VIDEO = {
  name: "clip.webm",
  mimeType: "video/webm",
  buffer: videoFixture("tiny.webm"),
} as const;

export const OPAQUE_VIDEO = {
  name: "tiny.mp4",
  mimeType: "video/mp4",
  buffer: videoFixture("tiny.mp4"),
} as const;

export function pngOfSize(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  // 10..12 = compression 0, filter 0, interlace 0 — already zeroed.

  // One filter byte (0 = None) per scanline, then width RGB triples.
  const stride = 1 + width * 3;
  const raw = Buffer.alloc(stride * height, 0x80);
  for (let y = 0; y < height; y++) raw[y * stride] = 0;

  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
