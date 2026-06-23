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
