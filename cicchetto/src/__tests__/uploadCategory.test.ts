import { describe, expect, it } from "vitest";
import {
  baseMime,
  categoryOf,
  DOCUMENT_MIMES_OFFICE,
  DOCUMENT_MIMES_PORTABLE,
  IMAGE_MIMES,
  normalizeUploadFile,
  type UploadCategory,
  VIDEO_MIMES,
} from "../lib/uploadCategory";

// Mirror discipline: the lists in uploadCategory.ts are a 1:1 copy of
// the server's @mime_categories (uploads_controller.ex). These tests
// pin the full 14-MIME matrix so a list edit that forgets a category
// trips loudly.

const matrix: ReadonlyArray<[string, UploadCategory]> = [
  ...IMAGE_MIMES.map((m): [string, UploadCategory] => [m, "image"]),
  ...VIDEO_MIMES.map((m): [string, UploadCategory] => [m, "video"]),
  ...DOCUMENT_MIMES_PORTABLE.map((m): [string, UploadCategory] => [m, "document"]),
  ...DOCUMENT_MIMES_OFFICE.map((m): [string, UploadCategory] => [m, "document"]),
];

describe("categoryOf — full MIME matrix", () => {
  // 15 since #1764 added `text/markdown` to DOCUMENT_MIMES_PORTABLE (so a
  // `.md` can be uploaded and then read as source in the viewer).
  //
  // ⚠️ AUDIO_MIMES is NOT in this matrix and never has been: the audio block
  // arrived with #115, after this test was written, and mirrors the server
  // without being pinned here. Left as found — widening the matrix is a
  // different change from this one — but recorded so the next reader does not
  // take "full MIME matrix" at its word.
  it("covers all 15 server-mirrored image/video/document MIMEs", () => {
    expect(matrix.length).toBe(15);
  });

  it.each(matrix)("%s → %s", (mime, category) => {
    expect(categoryOf(mime)).toBe(category);
  });
});

// #1256 — a File may carry a charset the sender knows for certain (the
// paste-as-.txt path builds its File from a JS string, which the File
// constructor encodes as UTF-8 by spec). An exact-string gate dropped
// exactly that correctly-labelled File, client-side, before it could
// reach the upload — the mirror of the server's 415.
describe("baseMime — parameter tolerance", () => {
  it.each([
    ["text/plain", "text/plain"],
    ["text/plain; charset=utf-8", "text/plain"],
    ["text/plain;charset=utf-8", "text/plain"],
    [" TEXT/Plain ; Charset=UTF-8", "text/plain"],
    ["", ""],
  ])("%j → %j", (mime, expected) => {
    expect(baseMime(mime)).toBe(expected);
  });

  it("a labelled paste File still categorises as a document", () => {
    expect(categoryOf("text/plain; charset=utf-8")).toBe("document");
  });

  it("a parameter cannot smuggle an unlisted type past the gate", () => {
    expect(categoryOf("text/html; charset=utf-8")).toBeNull();
  });
});

describe("categoryOf — boundary rejection", () => {
  it.each([
    "image/svg+xml",
    "video/x-msvideo",
    "application/zip",
    "application/octet-stream",
    "text/html",
    "",
    // issue 2453 — a file's type is whatever the source declared, and
    // `constructor` and `__proto__` are valid strings.
    "constructor",
    "__proto__",
  ])("unknown MIME %j → null", (mime) => {
    expect(categoryOf(mime)).toBeNull();
  });
});

// The audio-extension rescue: an untyped file is relabelled by its
// extension. issue 2453 — a file name is the user's to choose; "bob" runs
// first as the control.
describe("normalizeUploadFile — extension rescue", () => {
  it("relabels an untyped .m4r as audio/mp4", () => {
    const ringtone = new File([new Uint8Array(1)], "ring.m4r", { type: "" });

    expect(normalizeUploadFile(ringtone).type).toBe("audio/mp4");
  });

  it.each(["bob", "constructor", "__proto__"])(
    "leaves an untyped file named x.%s as it was",
    (ext) => {
      const file = new File([new Uint8Array(1)], `x.${ext}`, { type: "" });

      expect(normalizeUploadFile(file)).toBe(file);
    },
  );
});
