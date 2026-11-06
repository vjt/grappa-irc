// #2517b — cic's metadata strip, the one an end-to-end encrypted attachment
// passes before it is encrypted (vjt's F2 ruling: strip client-side, and a
// file that cannot be stripped is not sent).
//
// Two kinds of test. The FIXTURE tests run the real leak shapes (an iPhone's
// GPS EXIF, a Display-P3 profile, APNG/WebP/GIF made by ffmpeg + exiftool,
// see fixtures/metadataStrip/generate.sh) and compare cic's output with a
// second implementation's on the same bytes: exiftool run with the server
// strip's argv, committed next to each fixture as its `.exiftool.` twin. The
// SYNTHETIC tests build a container from parts and pin one rule each — a
// segment or chunk class kept or dropped, the refusals — with the exact
// expected bytes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { encryptedVideoOutcome, type ImageRefusal, stripImageMetadata } from "../lib/metadataStrip";
import { IMAGE_MIMES } from "../lib/uploadCategory";

const FIXTURES = resolve(process.cwd(), "src/__tests__/fixtures/metadataStrip");
const fixture = (name: string): Uint8Array =>
  Uint8Array.from(readFileSync(resolve(FIXTURES, name)));

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const hex = (h: string): Uint8Array =>
  Uint8Array.from(h.replace(/ /g, "").match(/../g) ?? [], (b) => Number.parseInt(b, 16));
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const indexOf = (hay: Uint8Array, needle: Uint8Array, from: number): number => {
  for (let i = from; i + needle.length <= hay.length; i++) {
    if (needle.every((b, j) => hay[i + j] === b)) return i;
  }
  return -1;
};
const contains = (hay: Uint8Array, marker: string): boolean =>
  indexOf(hay, ascii(marker), 0) !== -1;
const be16 = (n: number): Uint8Array => Uint8Array.of(n >> 8, n & 0xff);
const be32 = (n: number): Uint8Array =>
  Uint8Array.of(n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff);
const le16 = (n: number): Uint8Array => Uint8Array.of(n & 0xff, n >> 8);
const le32 = (n: number): Uint8Array =>
  Uint8Array.of(n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, n >>> 24);

const stripped = (bytes: Uint8Array, mime: string): Uint8Array => {
  const result = stripImageMetadata(bytes, mime);
  if ("refused" in result) throw new Error(`refused: ${JSON.stringify(result.refused)}`);
  return result.ok;
};
const refusal = (bytes: Uint8Array, mime: string): ImageRefusal => {
  const result = stripImageMetadata(bytes, mime);
  if ("ok" in result) throw new Error("expected a refusal, got bytes");
  return result.refused;
};

// --------------------------------------------------------------------------
// The Orientation blocks. cic writes back ONE IFD entry: Orientation (0x0112,
// SHORT x1), big-endian, no next IFD. exiftool writes the same tag plus its
// fixed YCbCrPositioning=1 companion — the only byte difference between the
// two strips on the fixtures.
// --------------------------------------------------------------------------

const TIFF_6 = hex("4d4d002a 00000008 0001 0112 0003 00000001 0006 0000 00000000");
const JPEG_ORIENTATION_6 = cat(hex("ffe1 0022"), ascii("Exif\0\0"), TIFF_6);
const PNG_ORIENTATION_6 = cat(be32(26), ascii("eXIf"), TIFF_6, hex("d6674b69"));
const WEBP_ORIENTATION_6 = cat(ascii("EXIF"), le32(26), TIFF_6);

const EXIFTOOL_TIFF_6 = hex(
  "4d4d002a 00000008 0002 0112 0003 00000001 0006 0000 0213 0003 00000001 0001 0000 00000000",
);
const EXIFTOOL_JPEG_ORIENTATION_6 = cat(hex("ffe1 002e"), ascii("Exif\0\0"), EXIFTOOL_TIFF_6);
const EXIFTOOL_PNG_ORIENTATION_6 = cat(be32(38), ascii("eXIf"), EXIFTOOL_TIFF_6, hex("1410e1e7"));
const EXIFTOOL_WEBP_ORIENTATION_6 = cat(
  ascii("EXIF"),
  le32(46),
  hex("4d4d002a 00000010"),
  ascii("ExifMeta"),
  EXIFTOOL_TIFF_6.subarray(8),
);

// --------------------------------------------------------------------------
// Fixtures: cic's output is the twin's
// --------------------------------------------------------------------------

type FixtureCase = {
  file: string;
  mime: string;
  // The privacy payload: each marker is asserted IN the fixture first (a
  // regenerated fixture that lost its metadata would otherwise pass while
  // validating nothing), then NOT in the output.
  markers: string[];
  // [exiftool's Orientation block, cic's] — swapped into the twin.
  orientation?: [Uint8Array, Uint8Array];
};

const FIXTURE_CASES: FixtureCase[] = [
  { file: "gps.jpg", mime: "image/jpeg", markers: ["Exif", "Apple", "iPhone 15 Pro"] },
  { file: "p3.jpg", mime: "image/jpeg", markers: ["Exif", "Apple", "iPhone 15 Pro"] },
  {
    file: "oriented.jpg",
    mime: "image/jpeg",
    markers: ["Apple", "iPhone 15 Pro"],
    orientation: [EXIFTOOL_JPEG_ORIENTATION_6, JPEG_ORIENTATION_6],
  },
  { file: "gps.png", mime: "image/png", markers: ["eXIf", "Apple"] },
  {
    file: "tagged.apng",
    mime: "image/apng",
    markers: ["Apple", "iPhone 15 Pro", "Secret Author", "secret comment", "tEXt", "iTXt"],
    orientation: [EXIFTOOL_PNG_ORIENTATION_6, PNG_ORIENTATION_6],
  },
  {
    file: "tagged.webp",
    mime: "image/webp",
    markers: ["Apple", "iPhone 15 Pro", "Secret Author", "XMP "],
    orientation: [EXIFTOOL_WEBP_ORIENTATION_6, WEBP_ORIENTATION_6],
  },
  {
    file: "tagged.gif",
    mime: "image/gif",
    markers: ["secret comment", "Secret Author", "XMP DataXMP"],
  },
];

// The twin, with exiftool's Orientation block swapped for cic's.
// A WebP also carries its own length in the RIFF header, so that is rewritten.
const expectedFromTwin = ({ file, mime, orientation }: FixtureCase): Uint8Array => {
  const twin = fixture(file.replace(/\.(\w+)$/, ".exiftool.$1"));
  if (orientation === undefined) return twin;
  const [theirs, ours] = orientation;
  const at = indexOf(twin, theirs, 0);
  expect(at, "the twin carries exiftool's Orientation block").not.toBe(-1);
  expect(indexOf(twin, theirs, at + 1), "exactly once").toBe(-1);
  const swapped = cat(twin.subarray(0, at), ours, twin.subarray(at + theirs.length));
  if (mime === "image/webp") swapped.set(le32(swapped.length - 8), 4);
  return swapped;
};

describe("stripImageMetadata on real files: the twin's bytes, and no privacy marker", () => {
  it.each(FIXTURE_CASES)(
    "$file: no privacy marker survives, and Orientation, the ICC profile and the animation survive byte for byte",
    (c) => {
      const input = fixture(c.file);
      for (const marker of c.markers)
        expect(contains(input, marker), `fixture has ${marker}`).toBe(true);

      const out = stripped(input, c.mime);

      for (const marker of c.markers)
        expect(contains(out, marker), `${marker} survived`).toBe(false);
      expect(out).toEqual(expectedFromTwin(c));
    },
  );
});

// --------------------------------------------------------------------------
// JPEG
// --------------------------------------------------------------------------

const SOI = hex("ffd8");
const EOI = hex("ffd9");
const seg = (marker: number, payload: Uint8Array): Uint8Array =>
  cat(Uint8Array.of(0xff, marker), be16(payload.length + 2), payload);
const jpeg = (...segments: Uint8Array[]): Uint8Array => cat(SOI, ...segments, EOI);

// Structure only: the strip never decodes, so stub tables are enough. The
// scan carries a stuffed 0xFF00, which does not end it.
const DQT = seg(0xdb, new Uint8Array(65));
const SOF0 = seg(0xc0, hex("08 0010 0010 01 01 11 00"));
const DHT = seg(0xc4, new Uint8Array(17));
const SOS = seg(0xda, hex("01 01 00 00 3f 00"));
const SCAN = hex("12 ff00 34 56");
const IMAGE = cat(DQT, SOF0, DHT, SOS, SCAN);

// An EXIF TIFF in either byte order: Make (inline "SEC"), then Orientation
// when given, then a trailing GPS-shaped payload the IFD does not point at.
const exifTiff = (order: "II" | "MM", orientation: number | null): Uint8Array => {
  const u16 = order === "II" ? le16 : be16;
  const u32 = order === "II" ? le32 : be32;
  const entries = [cat(u16(0x010f), u16(2), u32(4), ascii("SEC\0"))];
  if (orientation !== null) {
    entries.push(cat(u16(0x0112), u16(3), u32(1), u16(orientation), u16(0)));
  }
  return cat(
    ascii(order),
    u16(42),
    u32(8),
    u16(entries.length),
    ...entries,
    u32(0),
    ascii("GPS-SECRET"),
  );
};
const exifApp1 = (tiff: Uint8Array): Uint8Array => seg(0xe1, cat(ascii("Exif\0\0"), tiff));
const ICC_APP2 = (n: number): Uint8Array =>
  seg(0xe2, cat(ascii("ICC_PROFILE\0"), Uint8Array.of(n, 2), ascii(`profile-part-${n}`)));
const ADOBE_APP14 = seg(0xee, cat(ascii("Adobe"), hex("0064 0000 0000 01")));
const XMP_APP1 = seg(
  0xe1,
  cat(ascii("http://ns.adobe.com/xap/1.0/\0"), ascii("<x>XMP-SECRET</x>")),
);
const COM = seg(0xfe, ascii("COM-SECRET"));

describe("stripImageMetadata: JPEG", () => {
  it("drops an EXIF APP1 that carries no Orientation", () => {
    expect(stripped(jpeg(exifApp1(exifTiff("MM", null)), IMAGE), "image/jpeg")).toEqual(
      jpeg(IMAGE),
    );
  });

  it.each(["II", "MM"] as const)(
    "keeps Orientation as a minimal EXIF APP1 in the original's place (%s byte order)",
    (order) => {
      const input = jpeg(DQT, exifApp1(exifTiff(order, 6)), IMAGE);

      expect(stripped(input, "image/jpeg")).toEqual(jpeg(DQT, JPEG_ORIENTATION_6, IMAGE));
    },
  );

  it("drops an Orientation outside 1-8: there is no rotation to keep", () => {
    expect(stripped(jpeg(exifApp1(exifTiff("MM", 9)), IMAGE), "image/jpeg")).toEqual(jpeg(IMAGE));
  });

  it("drops an EXIF APP1 whose TIFF does not parse instead of refusing the photo", () => {
    const broken = exifApp1(cat(ascii("MM"), be16(42), be32(0xff)));

    expect(stripped(jpeg(broken, IMAGE), "image/jpeg")).toEqual(jpeg(IMAGE));
  });

  it("drops an XMP APP1", () => {
    expect(stripped(jpeg(XMP_APP1, IMAGE), "image/jpeg")).toEqual(jpeg(IMAGE));
  });

  it("drops COM", () => {
    expect(stripped(jpeg(COM, IMAGE), "image/jpeg")).toEqual(jpeg(IMAGE));
  });

  it.each([
    ["APP0 JFIF", seg(0xe0, cat(ascii("JFIF\0"), hex("0102 00 0001 0001 00 00")))],
    ["APP0 JFXX thumbnail", seg(0xe0, cat(ascii("JFXX\0"), ascii("THUMB-SECRET")))],
    ["APP2 MPF", seg(0xe2, cat(ascii("MPF\0"), ascii("MPF-SECRET")))],
    ["APP2 FPXR", seg(0xe2, cat(ascii("FPXR\0"), ascii("FPXR-SECRET")))],
    ["APP3", seg(0xe3, ascii("APP3-SECRET"))],
    ["APP12 Ducky", seg(0xec, cat(ascii("Ducky\0"), ascii("DUCKY-SECRET")))],
    ["APP13 Photoshop/IPTC", seg(0xed, cat(ascii("Photoshop 3.0\0"), ascii("IPTC-SECRET")))],
    ["APP15", seg(0xef, ascii("APP15-SECRET"))],
  ])("drops %s, like every APPn outside the kept three", (_name, segment) => {
    expect(stripped(jpeg(segment, IMAGE), "image/jpeg")).toEqual(jpeg(IMAGE));
  });

  it("keeps the Adobe APP14: decoding a CMYK/YCCK or RGB-coded JPEG needs its transform flag", () => {
    expect(stripped(jpeg(ADOBE_APP14, IMAGE), "image/jpeg")).toEqual(jpeg(ADOBE_APP14, IMAGE));
  });

  it("keeps every ICC_PROFILE APP2 chunk, in order", () => {
    const input = jpeg(ICC_APP2(1), ICC_APP2(2), IMAGE);

    expect(stripped(input, "image/jpeg")).toEqual(input);
  });

  it("drops APPn and COM that sit after the scan", () => {
    const input = cat(SOI, IMAGE, COM, XMP_APP1, EOI);

    expect(stripped(input, "image/jpeg")).toEqual(jpeg(IMAGE));
  });

  it("keeps a multi-scan (progressive) stream byte for byte: tables between scans, restart markers", () => {
    const secondScan = cat(DHT, SOS, hex("9a ffd1 bc ff00 de"));
    const input = jpeg(IMAGE, secondScan);

    expect(stripped(input, "image/jpeg")).toEqual(input);
  });

  it("drops the fill bytes before a marker and keeps its segment", () => {
    expect(stripped(cat(SOI, hex("ffff"), IMAGE, EOI), "image/jpeg")).toEqual(jpeg(IMAGE));
  });

  // SOFn bar the reserved C8, DHT and DAC among them; then DQT, DNL, DRI, DHP, EXP.
  it.each("c0 c1 c2 c3 c5 c6 c7 c9 ca cb cd ce cf c4 cc db dc dd de df".split(" "))(
    "keeps the decoding marker FF%s",
    (marker) => {
      const input = jpeg(seg(Number.parseInt(marker, 16), ascii("table")), IMAGE);

      expect(stripped(input, "image/jpeg")).toEqual(input);
    },
  );

  it.each([
    ["FF00, which a decoder skips as extraneous data", seg(0x00, ascii("LAT-SECRET"))],
    ["a reserved JPGn extension (FFF0)", seg(0xf0, ascii("JPG0-SECRET"))],
    ["the reserved JPG marker (FFC8)", seg(0xc8, ascii("JPG-SECRET"))],
    ["TEM, which has no length", hex("ff01")],
  ])("refuses a marker that is neither a decoding marker nor APPn/COM: %s", (_name, segment) => {
    expect(refusal(jpeg(DQT, segment, IMAGE), "image/jpeg")).toEqual({
      reason: "malformed",
      container: "jpeg",
      detail: expect.stringContaining("marker"),
    });
  });

  it("drops the bytes after EOI, where a phone appends an MPF secondary image", () => {
    const input = cat(jpeg(IMAGE), jpeg(exifApp1(exifTiff("MM", null)), IMAGE));

    expect(stripped(input, "image/jpeg")).toEqual(jpeg(IMAGE));
  });

  it.each([
    ["no EOI (truncated)", cat(SOI, IMAGE)],
    ["a segment longer than the file", cat(SOI, DQT.subarray(0, 20))],
    ["an SOS whose length is below 2", cat(SOI, DQT, hex("ffda 0001"), SCAN, EOI)],
    // After a whole segment: right after SOI it would break the FF D8 FF magic.
    ["junk where a marker belongs", cat(SOI, DQT, hex("00 11 22"), IMAGE, EOI)],
  ])("refuses %s", (_name, input) => {
    expect(refusal(input, "image/jpeg")).toEqual({
      reason: "malformed",
      container: "jpeg",
      detail: expect.any(String),
    });
  });
});

// --------------------------------------------------------------------------
// PNG / APNG
// --------------------------------------------------------------------------

const PNG_SIG = hex("89504e47 0d0a1a0a");
// The strip never reads a CRC (it copies kept chunks whole), so the synthetic
// chunks carry zeros there; the one CRC it WRITES is pinned in PNG_ORIENTATION_6.
const chunk = (type: string, payload: Uint8Array): Uint8Array =>
  cat(be32(payload.length), ascii(type), payload, hex("00000000"));
const IHDR = chunk("IHDR", hex("00000010 00000010 08 02 00 00 00"));
const IDAT = chunk("IDAT", ascii("deflated-pixels"));
const IEND = chunk("IEND", new Uint8Array(0));
const png = (...chunks: Uint8Array[]): Uint8Array => cat(PNG_SIG, IHDR, ...chunks, IDAT, IEND);

describe("stripImageMetadata: PNG and APNG", () => {
  it("drops tEXt, zTXt and iTXt", () => {
    const input = png(
      chunk("tEXt", ascii("Comment\0TEXT-SECRET")),
      chunk("zTXt", ascii("Comment\0\0ZTXT-SECRET")),
      chunk("iTXt", ascii("XML:com.adobe.xmp\0\0\0\0\0XMP-SECRET")),
    );

    expect(stripped(input, "image/png")).toEqual(png());
  });

  it("drops an eXIf chunk that carries no Orientation", () => {
    expect(stripped(png(chunk("eXIf", exifTiff("MM", null))), "image/png")).toEqual(png());
  });

  it("keeps Orientation as a minimal eXIf in the original's place", () => {
    const iccp = chunk("iCCP", ascii("icc\0\0deflated-profile"));
    const input = png(chunk("eXIf", exifTiff("II", 6)), iccp);

    expect(stripped(input, "image/png")).toEqual(png(PNG_ORIENTATION_6, iccp));
  });

  it("drops tIME and the miscellaneous group: pHYs, bKGD, hIST, sPLT", () => {
    const input = png(
      chunk("tIME", hex("07ea 06 0a 0c 00 00")),
      chunk("pHYs", hex("00000b13 00000b13 01")),
      chunk("bKGD", hex("0010 0020 0030")),
      chunk("hIST", hex("0001")),
      chunk("sPLT", cat(ascii("SPLT-SECRET\0"), hex("08 01020304 0005"))),
    );

    expect(stripped(input, "image/png")).toEqual(png());
  });

  it("drops chunks outside the PNG core: oFFs, sTER, caBX, iDOT, private ones", () => {
    const input = png(
      chunk("oFFs", hex("00000001 00000001 00")),
      chunk("sTER", hex("00")),
      chunk("caBX", ascii("C2PA-SECRET")),
      chunk("iDOT", new Uint8Array(28)),
      chunk("prVt", ascii("PRIVATE-SECRET")),
    );

    expect(stripped(input, "image/png")).toEqual(png());
  });

  it("keeps the colour description: iCCP, gAMA, sRGB, cHRM, sBIT, cICP, mDCv, cLLI", () => {
    const input = png(
      chunk("iCCP", ascii("icc\0\0deflated-profile")),
      chunk("gAMA", be32(45455)),
      chunk("sRGB", hex("00")),
      chunk("cHRM", new Uint8Array(32)),
      chunk("sBIT", hex("080808")),
      chunk("cICP", hex("01 0d 00 01")),
      chunk("mDCv", new Uint8Array(24)),
      chunk("cLLI", new Uint8Array(8)),
    );

    expect(stripped(input, "image/png")).toEqual(input);
  });

  it("keeps PLTE and tRNS", () => {
    const input = png(chunk("PLTE", hex("ff0000 00ff00")), chunk("tRNS", hex("00 ff")));

    expect(stripped(input, "image/png")).toEqual(input);
  });

  it("keeps the APNG animation: acTL, fcTL, fdAT", () => {
    const fcTL = (seq: number): Uint8Array => chunk("fcTL", cat(be32(seq), new Uint8Array(22)));
    const input = cat(
      PNG_SIG,
      IHDR,
      chunk("acTL", hex("00000002 00000000")),
      fcTL(0),
      IDAT,
      fcTL(1),
      chunk("fdAT", cat(be32(2), ascii("frame-2"))),
      IEND,
    );

    expect(stripped(input, "image/apng")).toEqual(input);
  });

  it("drops the bytes after IEND", () => {
    expect(stripped(cat(png(), ascii("TRAILER-SECRET")), "image/png")).toEqual(png());
  });

  it.each([
    ["no IEND (truncated)", cat(PNG_SIG, IHDR, IDAT)],
    ["an IEND cut short", cat(PNG_SIG, IHDR, IDAT, IEND.subarray(0, 8))],
  ])("refuses %s", (_name, input) => {
    expect(refusal(input, "image/png")).toEqual({
      reason: "malformed",
      container: "png",
      detail: expect.any(String),
    });
  });
});

// --------------------------------------------------------------------------
// WebP
// --------------------------------------------------------------------------

const riffChunk = (fourcc: string, payload: Uint8Array): Uint8Array =>
  cat(ascii(fourcc), le32(payload.length), payload, new Uint8Array(payload.length % 2));
const webp = (...chunks: Uint8Array[]): Uint8Array => {
  const body = cat(ascii("WEBP"), ...chunks);
  return cat(ascii("RIFF"), le32(body.length), body);
};
// VP8X flags: 0x20 ICC, 0x10 alpha, 0x08 EXIF, 0x04 XMP, 0x02 animation.
const vp8x = (flags: number): Uint8Array =>
  riffChunk("VP8X", cat(Uint8Array.of(flags, 0, 0, 0), hex("0f0000 0f0000")));
const VP8 = riffChunk("VP8 ", ascii("vp8-bitstream")); // odd length: padded
const ICCP = riffChunk("ICCP", ascii("icc-profile"));

describe("stripImageMetadata: WebP", () => {
  it("drops XMP and clears its VP8X flag", () => {
    const input = webp(vp8x(0x04), VP8, riffChunk("XMP ", ascii("<x>XMP-SECRET</x>")));

    expect(stripped(input, "image/webp")).toEqual(webp(vp8x(0x00), VP8));
  });

  it("drops an EXIF chunk that carries no Orientation and clears its flag", () => {
    const input = webp(vp8x(0x08), VP8, riffChunk("EXIF", exifTiff("MM", null)));

    expect(stripped(input, "image/webp")).toEqual(webp(vp8x(0x00), VP8));
  });

  it("keeps Orientation as a minimal EXIF chunk in the original's place, flag kept", () => {
    const input = webp(vp8x(0x08), VP8, riffChunk("EXIF", exifTiff("II", 6)));

    expect(stripped(input, "image/webp")).toEqual(webp(vp8x(0x08), VP8, WEBP_ORIENTATION_6));
  });

  it("keeps ICCP, ANIM, ANMF, ALPH and the bitstream chunks", () => {
    const input = webp(
      vp8x(0x32),
      ICCP,
      riffChunk("ANIM", hex("ffffffff 0000")),
      riffChunk("ANMF", cat(new Uint8Array(16), riffChunk("ALPH", ascii("alpha")), VP8)),
      riffChunk("ANMF", cat(new Uint8Array(16), riffChunk("VP8L", ascii("lossless")))),
    );

    expect(stripped(input, "image/webp")).toEqual(input);
  });

  it("drops the chunks an animation frame carries after its bitstream, where RFC 9649 lets unknown ones sit", () => {
    const ANIM = riffChunk("ANIM", hex("ffffffff 0000"));
    const frame = (...chunks: Uint8Array[]): Uint8Array =>
      riffChunk("ANMF", cat(new Uint8Array(16), ...chunks));
    const input = webp(
      vp8x(0x02),
      ANIM,
      frame(
        VP8,
        riffChunk("XMP ", ascii("<x>XMP-SECRET</x>")),
        riffChunk("UNKN", ascii("U-SECRET")),
      ),
    );

    expect(stripped(input, "image/webp")).toEqual(webp(vp8x(0x02), ANIM, frame(VP8)));
  });

  it("drops a chunk it does not know", () => {
    const input = webp(vp8x(0x00), VP8, riffChunk("UNKN", ascii("UNKNOWN-SECRET")));

    expect(stripped(input, "image/webp")).toEqual(webp(vp8x(0x00), VP8));
  });

  it("passes a simple-format WebP (no VP8X) through whole", () => {
    const input = webp(VP8);

    expect(stripped(input, "image/webp")).toEqual(input);
  });

  it("drops the bytes after the RIFF", () => {
    expect(stripped(cat(webp(VP8), ascii("TRAILER-SECRET")), "image/webp")).toEqual(webp(VP8));
  });

  it.each([
    ["a RIFF size past the end of the file (truncated)", webp(VP8).subarray(0, 20)],
    // The chunk's bytes exist past the RIFF's end: only the RIFF bound refuses it.
    [
      "a chunk longer than the RIFF",
      cat(ascii("RIFF"), le32(12), ascii("WEBP"), riffChunk("VP8 ", ascii("sixteen bytes..."))),
    ],
    [
      "an animation frame shorter than its 16-byte header",
      webp(riffChunk("ANMF", new Uint8Array(10))),
    ],
    // The bytes exist past the frame's end: only the frame's own bound refuses it.
    [
      "a frame's chunk longer than the frame",
      webp(
        riffChunk("ANMF", cat(new Uint8Array(16), ascii("VP8 "), le32(40))),
        riffChunk("UNKN", ascii("forty bytes of the next chunk, and more....")),
      ),
    ],
  ])("refuses %s", (_name, input) => {
    expect(refusal(input, "image/webp")).toEqual({
      reason: "malformed",
      container: "webp",
      detail: expect.any(String),
    });
  });
});

// --------------------------------------------------------------------------
// GIF
// --------------------------------------------------------------------------

// 16x16, no global colour table.
const GIF_HEAD = cat(ascii("GIF89a"), hex("1000 1000 00 00 00"));
const subBlocks = (...blocks: Uint8Array[]): Uint8Array =>
  cat(...blocks.map((b) => cat(Uint8Array.of(b.length), b)), Uint8Array.of(0));
const ext = (label: number, ...blocks: Uint8Array[]): Uint8Array =>
  cat(Uint8Array.of(0x21, label), subBlocks(...blocks));
const appExt = (id: string, ...data: Uint8Array[]): Uint8Array => ext(0xff, ascii(id), ...data);
const GCE = ext(0xf9, hex("04 0a00 00"));
// Descriptor (no local table), LZW minimum code size, one data sub-block.
const FRAME = cat(hex("2c 0000 0000 1000 1000 00"), Uint8Array.of(2), subBlocks(hex("4c01")));
const gif = (...blocks: Uint8Array[]): Uint8Array => cat(GIF_HEAD, ...blocks, Uint8Array.of(0x3b));

describe("stripImageMetadata: GIF", () => {
  it("drops Comment extensions", () => {
    expect(stripped(gif(ext(0xfe, ascii("COMMENT-SECRET")), FRAME), "image/gif")).toEqual(
      gif(FRAME),
    );
  });

  it("drops the XMP application extension", () => {
    const xmp = appExt("XMP DataXMP", ascii("<x>XMP-SECRET</x>"));

    expect(stripped(gif(xmp, FRAME), "image/gif")).toEqual(gif(FRAME));
  });

  it("drops application extensions and extension labels it does not know", () => {
    const input = gif(
      appExt("MGK8BIM0000", ascii("PHOTOSHOP-SECRET")),
      ext(0x99, ascii("x")),
      FRAME,
    );

    expect(stripped(input, "image/gif")).toEqual(gif(FRAME));
  });

  it.each(["NETSCAPE2.0", "ANIMEXTS1.0"])("keeps the %s loop and every frame", (id) => {
    const input = gif(appExt(id, hex("01 0000")), FRAME, FRAME);

    expect(stripped(input, "image/gif")).toEqual(input);
  });

  it("keeps Graphic Control and Plain Text extensions", () => {
    const input = gif(GCE, ext(0x01, new Uint8Array(12), ascii("drawn text")), FRAME);

    expect(stripped(input, "image/gif")).toEqual(input);
  });

  it("keeps the ICC application extension", () => {
    const input = gif(appExt("ICCRGBG1012", ascii("icc-profile")), FRAME);

    expect(stripped(input, "image/gif")).toEqual(input);
  });

  it("walks past the global colour table", () => {
    // Packed 0x81: a global table of 4 colours, 12 bytes.
    const head = cat(ascii("GIF89a"), hex("1000 1000 81 00 00"), new Uint8Array(12));
    const input = cat(head, ext(0xfe, ascii("COMMENT-SECRET")), FRAME, Uint8Array.of(0x3b));

    expect(stripped(input, "image/gif")).toEqual(cat(head, FRAME, Uint8Array.of(0x3b)));
  });

  it("walks past a frame's local colour table", () => {
    // Packed 0x81: a local table of 4 colours, 12 bytes, before the LZW data.
    const frame = cat(
      hex("2c 0000 0000 1000 1000 81"),
      new Uint8Array(12),
      Uint8Array.of(2),
      subBlocks(hex("4c01")),
    );

    expect(stripped(gif(frame, ext(0xfe, ascii("COMMENT-SECRET"))), "image/gif")).toEqual(
      gif(frame),
    );
  });

  it("drops the bytes after the trailer", () => {
    expect(stripped(cat(gif(FRAME), ascii("TRAILER-SECRET")), "image/gif")).toEqual(gif(FRAME));
  });

  it.each([
    ["no trailer (truncated)", cat(GIF_HEAD, FRAME)],
    ["a sub-block longer than the file", cat(GIF_HEAD, hex("21 fe 20"), ascii("short"))],
    ["an unknown block introducer", cat(GIF_HEAD, hex("77"), FRAME, hex("3b"))],
  ])("refuses %s", (_name, input) => {
    expect(refusal(input, "image/gif")).toEqual({
      reason: "malformed",
      container: "gif",
      detail: expect.any(String),
    });
  });
});

// --------------------------------------------------------------------------
// The container comes from the bytes, never from the declared type alone
// --------------------------------------------------------------------------

describe("stripImageMetadata: which container", () => {
  it("refuses bytes whose container disagrees with the declared type", () => {
    expect(refusal(png(), "image/jpeg")).toEqual({
      reason: "type_mismatch",
      declared: "image/jpeg",
      detected: "png",
    });
  });

  it("takes image/apng and image/png as one container", () => {
    expect(stripped(png(), "image/apng")).toEqual(png());
  });

  it("refuses bytes that are no image container it knows", () => {
    expect(refusal(ascii("%PDF-1.7 not an image"), "image/png")).toEqual({
      reason: "unknown_container",
      declared: "image/png",
    });
  });

  it.each(["image/heic", "image/svg+xml", "video/mp4", ""])(
    "refuses the declared type %j: not one of the five images",
    (mime) => {
      expect(refusal(jpeg(IMAGE), mime)).toEqual({ reason: "unsupported_type", declared: mime });
    },
  );

  it("reads the declared type through parameters and case", () => {
    expect(stripped(jpeg(IMAGE), "IMAGE/JPEG; q=1")).toEqual(jpeg(IMAGE));
  });

  it("has a container for every image type the upload allowlist accepts", () => {
    const sample = { jpeg: jpeg(IMAGE), png: png(), webp: webp(VP8), gif: gif(FRAME) };
    const byMime: Record<(typeof IMAGE_MIMES)[number], Uint8Array> = {
      "image/png": sample.png,
      "image/jpeg": sample.jpeg,
      "image/gif": sample.gif,
      "image/webp": sample.webp,
      "image/apng": sample.png,
    };

    for (const mime of IMAGE_MIMES)
      expect(stripImageMetadata(byMime[mime], mime)).toHaveProperty("ok");
  });
});

// --------------------------------------------------------------------------
// Video: the transcode's output, or nothing
// --------------------------------------------------------------------------

describe("encryptedVideoOutcome", () => {
  const original = new File([new Uint8Array(16)], "clip.mp4", { type: "video/mp4" });

  it("sends a fresh transcode output", () => {
    const transcoded = new File([new Uint8Array(8)], "clip.mp4", { type: "video/mp4" });

    expect(encryptedVideoOutcome(original, { ok: transcoded })).toEqual({ ok: transcoded });
  });

  it("refuses the original coming back: it was never transcoded, so its tags are intact", () => {
    expect(encryptedVideoOutcome(original, { ok: original })).toEqual({
      refused: { reason: "video_unprocessed", detail: expect.any(String) },
    });
  });

  it("refuses a clip over the duration ceiling, naming its duration", () => {
    const result = { error: { kind: "too_long", durationSeconds: 200 } } as const;

    expect(encryptedVideoOutcome(original, result)).toEqual({
      refused: { reason: "video_too_long", durationSeconds: 200 },
    });
  });

  it.each([
    { kind: "unsupported", detail: "no H.264 encoder (WebCodecs)" },
    { kind: "failed", message: "decoder crashed" },
  ] as const)(
    "refuses a transcode that could not run ($kind) instead of falling back to the original",
    (error) => {
      expect(encryptedVideoOutcome(original, { error })).toEqual({
        refused: {
          reason: "video_unprocessed",
          detail: "detail" in error ? error.detail : error.message,
        },
      });
    },
  );
});
