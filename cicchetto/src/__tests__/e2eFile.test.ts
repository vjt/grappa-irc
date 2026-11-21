// issue 2517 — an encrypted attachment's crypto, its inner, and the click
// that opens one: the ciphertext is exactly the plaintext plus the GCM tag,
// a wrong key or a changed byte opens nothing, and nothing a peer says makes
// this client fetch another host or render a document in its own origin.
import { afterEach, describe, expect, it, vi } from "vitest";
import { openBytes, sealBytes } from "../lib/e2e/fileCrypto";
import {
  type FileInner,
  onGrappaOrigin,
  parseFileInner,
  sanitizeFileName,
} from "../lib/e2e/fileInner";
import { base64Unpadded } from "../lib/e2e/wire";
import { inlineKindOf, openEncryptedFile } from "../lib/encryptedFileOpen";

const bytes = (n: number, fill = 7): Uint8Array<ArrayBuffer> => new Uint8Array(n).fill(fill);
const b64 = (n: number): string => base64Unpadded(bytes(n));
const SLUG = "abcdefghijklmnopqrstuvwxyz";

const fileInner = (over: Partial<FileInner> = {}): FileInner => ({
  t: "file",
  url: `${location.origin}/uploads/${SLUG}`,
  key: b64(32),
  iv: b64(12),
  name: "holiday.jpg",
  mime: "image/jpeg",
  size: 123,
  category: "image",
  expires_at: "2099-01-01T00:00:00Z",
  ...over,
});

describe("sealBytes / openBytes (issue 2517)", () => {
  it("round-trips, and the ciphertext is the plaintext plus the 16-byte tag", async () => {
    const plaintext = bytes(1000);
    const sealed = await sealBytes(plaintext);

    expect(sealed.ciphertext.length).toBe(1000 + 16);
    expect(await openBytes(sealed.ciphertext, sealed.key, sealed.iv)).toEqual(plaintext);
  });

  it("gives every file its own key and IV", async () => {
    const one = await sealBytes(bytes(8));
    const two = await sealBytes(bytes(8));

    expect(one.key).not.toBe(two.key);
    expect(one.iv).not.toBe(two.iv);
    expect(one.ciphertext).not.toEqual(two.ciphertext);
  });

  it("opens nothing with the wrong key, a changed byte, or a changed IV", async () => {
    const sealed = await sealBytes(bytes(64));
    const other = await sealBytes(bytes(64));
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[0] = (tampered[0] as number) ^ 0xff;

    expect(await openBytes(sealed.ciphertext, other.key, sealed.iv)).toBeNull();
    expect(await openBytes(tampered, sealed.key, sealed.iv)).toBeNull();
    expect(await openBytes(sealed.ciphertext, sealed.key, other.iv)).toBeNull();
  });
});

describe("parseFileInner (issue 2517)", () => {
  it("takes a well-formed attachment", () => {
    expect(parseFileInner(fileInner())).toEqual(fileInner());
  });

  // The inner carries no digest of the ciphertext (DESIGN_NOTES #2517a): the
  // GCM tag, under a key only the Olm message carries, already authenticates
  // every byte, so a digest beside it would refuse nothing GCM lets through.
  // `toEqual` ignores a key the other side lacks, so the KEYS are compared:
  // an inner that comes back demanding a digest refuses the first case, and
  // one that keeps carrying it fails the second.
  it("needs no digest, and does not keep one an older peer still sends", () => {
    const expected = Object.keys(fileInner()).sort();
    expect(expected).not.toContain("sha256");

    const plain = parseFileInner(fileInner());
    expect(typeof plain === "object" && Object.keys(plain).sort()).toEqual(expected);

    const older = parseFileInner({ ...fileInner(), sha256: b64(32) });
    expect(typeof older === "object" && Object.keys(older).sort()).toEqual(expected);
  });

  it("refuses every field that is not what the wire says it is", () => {
    const cases: Array<[Partial<FileInner>, string]> = [
      [{ key: b64(31) }, "bad-key"],
      [{ key: b64(33) }, "bad-key"],
      [{ key: "not base64!" }, "bad-key"],
      [{ iv: b64(16) }, "bad-iv"],
      [{ name: "" }, "bad-name"],
      [{ mime: "" }, "bad-mime"],
      // The mime is the PEER's word and it is shown on the card: a value
      // outside the RFC 6838 token set (bidi overrides, controls) is refused
      // at the door, not rendered.
      [{ mime: "image/png‮" }, "bad-mime"],
      [{ mime: "text/html; charset=utf-8" }, "bad-mime"],
      [{ mime: "https://evil.test/x" }, "bad-mime"],
      [{ mime: "image" }, "bad-mime"],
      [{ size: -1 }, "bad-size"],
      [{ size: 1.5 }, "bad-size"],
      [{ category: "executable" as FileInner["category"] }, "bad-category"],
      [{ expires_at: "not a date" }, "bad-expiry"],
      [{ url: 42 as unknown as string }, "bad-url"],
    ];
    for (const [over, reason] of cases) {
      expect(parseFileInner(fileInner(over))).toBe(reason);
    }
  });

  // A sibling copy can write `file: null` for a text message: a refusal, never
  // a throw, since this runs inside the drain.
  it("never throws on wire input that is not an object", () => {
    expect(parseFileInner(null as unknown as Record<string, unknown>)).toBe("not-a-file");
    expect(parseFileInner(undefined as unknown as Record<string, unknown>)).toBe("not-a-file");
    expect(parseFileInner("file" as unknown as Record<string, unknown>)).toBe("not-a-file");
    expect(parseFileInner(7 as unknown as Record<string, unknown>)).toBe("not-a-file");
  });
});

describe("onGrappaOrigin (issue 2517)", () => {
  it("takes this grappa's own upload path and nothing else", () => {
    const origin = location.origin;
    expect(onGrappaOrigin(`${origin}/uploads/${SLUG}`, origin)).toBe(true);
    expect(onGrappaOrigin(`https://evil.example/uploads/${SLUG}`, origin)).toBe(false);
    expect(onGrappaOrigin(`${origin}/uploads/${SLUG}?x=1`, origin)).toBe(false);
    expect(onGrappaOrigin(`${origin}/uploads/${SLUG}#f`, origin)).toBe(false);
    expect(onGrappaOrigin(`${origin}/api/uploads/${SLUG}`, origin)).toBe(false);
    expect(onGrappaOrigin(`${origin}/uploads/../secret`, origin)).toBe(false);
    expect(onGrappaOrigin(`${origin}/uploads/${SLUG}.jpg`, origin)).toBe(false);
  });
});

describe("sanitizeFileName (issue 2517)", () => {
  it("takes out separators, control characters and bidi overrides", () => {
    expect(sanitizeFileName("../../etc/passwd")).toBe("....etcpasswd");
    expect(sanitizeFileName("a\u0000b\nc")).toBe("abc");
    expect(sanitizeFileName("invoice‮gpj.exe")).toBe("invoicegpj.exe");
    expect(sanitizeFileName("  holiday   photo.jpg  ")).toBe("holiday photo.jpg");
  });

  it("caps the length, and answers empty when nothing printable is left", () => {
    expect(sanitizeFileName("x".repeat(500))).toHaveLength(120);
    expect(sanitizeFileName("‮⁦\u0007")).toBe("");
  });

  // A download is saved under this name, typed `application/octet-stream`, so
  // nothing gives back an extension the cut took: the stem gets shorter.
  it("cuts a long name in its stem and keeps the extension", () => {
    expect(sanitizeFileName(`${"a".repeat(130)}.pdf`)).toBe(`${"a".repeat(116)}.pdf`);
    expect(sanitizeFileName(`${"写".repeat(200)}.tar.gz`)).toBe(`${"写".repeat(117)}.gz`);
    // A blank the cut leaves at the end of the stem goes with it.
    expect(sanitizeFileName(`${"a".repeat(115)} ${"b".repeat(20)}.pdf`)).toBe(
      `${"a".repeat(115)}.pdf`,
    );
  });

  it("cuts a tail past the extension length, or with a blank in it, as more name", () => {
    const longTail = `a.${"b".repeat(200)}`;
    expect(sanitizeFileName(longTail)).toBe(longTail.slice(0, 120));
    const blankTail = `${"a".repeat(130)}.not an extension`;
    expect(sanitizeFileName(blankTail)).toBe("a".repeat(120));
  });

  // A name is shown and saved as what it visibly says: whatever Unicode draws
  // as nothing, or uses to steer the layout rather than to write text, goes.
  it("takes out every code point that draws as nothing or steers the layout", () => {
    expect(sanitizeFileName("a\u061Cb")).toBe("ab");
    expect(sanitizeFileName(`invoice.jpg${"\u3164".repeat(20)}.exe`)).toBe("invoice.jpg.exe");
    expect(sanitizeFileName("a\uFFF9b\uFFFAc\uFFFBd")).toBe("abcd");
    expect(sanitizeFileName("a\u00ADb\u180Ec")).toBe("abc");
    expect(sanitizeFileName("a\uD800b")).toBe("ab");
  });

  it("collapses a run of Braille blanks like any other run of blanks", () => {
    expect(sanitizeFileName(`invoice.jpg${"\u2800".repeat(20)}.exe`)).toBe("invoice.jpg .exe");
  });

  // Taking too much out is a bug as well: a name in any script, with the marks
  // its script writes (and a macOS name in decomposed form), keeps every code
  // point.
  it.each([
    "שָׁלוֹם.pdf",
    "مَرْحَبًا.pdf",
    "사진.jpg",
    "写真.png",
    "फ़ाइल.txt",
    "ไฟล์.txt",
    "cafe\u0301.jpg",
    "Ελληνικά.doc",
    "файл.txt",
    "🎉.png",
  ])("keeps the name %s as it was written", (name) => {
    expect(sanitizeFileName(name)).toBe(name);
  });

  // U+200C and U+200D stay only between two visible characters the name
  // keeps; U+FE0E and U+FE0F stay only right after a base; a run of either
  // collapses to one; at an edge, or anywhere else, they go. Compared
  // as code points, since every one of them draws as nothing.
  const points = (text: string): string[] =>
    [...text].map((char) => (char.codePointAt(0) as number).toString(16));

  it.each([
    ["the ZWNJ inside a Persian word", "می\u200Cخواهم.pdf"],
    ["the ZWJs of an emoji family sequence", "👨\u200D👩\u200D👧.png"],
    ["the emoji selector of ❤️", "❤\uFE0F.png"],
    ["a ZWJ after a kept selector", "❤\uFE0F\u200D🔥.png"],
  ])("keeps %s", (_what, name) => {
    expect(points(sanitizeFileName(name))).toEqual(points(name));
  });

  it.each([
    ["a joiner between two blanks", "a \u200D b.pdf", "a b.pdf"],
    ["a joiner at the start", "\u200Cabc.pdf", "abc.pdf"],
    ["a joiner at the end", "abc\u200D", "abc"],
    // Of a run of joiners, the one that stays is the last: it touches the
    // character after it, and the others touch another joiner.
    ["all but the last of a run of joiners", "a\u200C\u200C\u200Db.pdf", "a\u200Db.pdf"],
    ["a selector at the start", "\uFE0Fx.png", "x.png"],
    ["a selector after a blank", "a \uFE0F.png", "a .png"],
    // Of a run of selectors, the first: it touches the base.
    ["all but the first of a run of selectors", "❤\uFE0F\uFE0E.png", "❤\uFE0F.png"],
    // The joiner sat between two letters; the cut leaves it at the end of the stem.
    [
      "a joiner the cut leaves at the end of the stem",
      `${"a".repeat(115)}\u200D${"b".repeat(10)}.pdf`,
      `${"a".repeat(115)}.pdf`,
    ],
    [
      "a joiner the cut leaves at the end of a name with no extension",
      `${"a".repeat(119)}\u200D${"b".repeat(10)}`,
      "a".repeat(119),
    ],
  ])("takes out %s", (_what, name, expected) => {
    expect(points(sanitizeFileName(name))).toEqual(points(expected));
  });
});

describe("inlineKindOf (issue 2517)", () => {
  it("is an allowlist: SVG and HTML are saved, never rendered", () => {
    expect(inlineKindOf("image/jpeg")).toBe("image");
    expect(inlineKindOf("image/webp")).toBe("image");
    expect(inlineKindOf("video/mp4")).toBe("video");
    expect(inlineKindOf("audio/ogg")).toBe("audio");
    expect(inlineKindOf("image/svg+xml")).toBeNull();
    expect(inlineKindOf("text/html")).toBeNull();
    expect(inlineKindOf("application/pdf")).toBeNull();
  });
});

describe("openEncryptedFile (issue 2517)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const served = (ciphertext: Uint8Array<ArrayBuffer>, status = 200): void => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(status === 200 ? ciphertext : "nope", { status })),
    );
  };

  // A changed byte is refused at the open, through GCM alone, and nothing is
  // minted for it: no blob URL, no save.
  it("refuses a file one byte away from what was sealed, and renders nothing", async () => {
    const sealed = await sealBytes(bytes(32));
    const tampered = new Uint8Array(sealed.ciphertext);
    tampered[5] = (tampered[5] as number) ^ 0x01;
    served(tampered);
    const created = vi.spyOn(URL, "createObjectURL");

    const outcome = await openEncryptedFile(
      fileInner({ key: sealed.key, iv: sealed.iv, size: 32 }),
    );

    expect(outcome).toEqual({ ok: false, error: "the file could not be decrypted" });
    expect(created).not.toHaveBeenCalled();
  });

  it("refuses a file its key does not open", async () => {
    const sealed = await sealBytes(bytes(32));
    const other = await sealBytes(bytes(32));
    served(sealed.ciphertext);

    expect(await openEncryptedFile(fileInner({ key: other.key, iv: other.iv, size: 32 }))).toEqual({
      ok: false,
      error: "the file could not be decrypted",
    });
  });

  it("says expired when the server no longer holds it", async () => {
    served(bytes(0), 404);
    expect(await openEncryptedFile(fileInner({ expires_at: "2000-01-01T00:00:00Z" }))).toEqual({
      ok: false,
      error: "expired",
    });
  });

  it("opens an allowlisted image as a blob, and saves anything else", async () => {
    const sealed = await sealBytes(bytes(16));
    served(sealed.ciphertext);
    const created = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:one");

    const image = await openEncryptedFile(fileInner({ key: sealed.key, iv: sealed.iv, size: 16 }));
    expect(image).toEqual({ ok: true, kind: "inline", url: "blob:one", media: "image" });

    const html = await openEncryptedFile(
      fileInner({
        key: sealed.key,
        iv: sealed.iv,
        size: 16,
        mime: "text/html",
      }),
    );
    expect(html).toEqual({ ok: true, kind: "download" });
    expect(created).toHaveBeenCalledTimes(2);
    // The saved blob's type is NOT the peer's `mime`: a download is an
    // unknown-type file by definition, and typing it `text/html` would hand
    // the OS a document it might open rather than save.
    const saved = created.mock.calls[1]?.[0];
    expect(saved).toBeInstanceOf(Blob);
    expect((saved as Blob).type).toBe("application/octet-stream");
  });
});
