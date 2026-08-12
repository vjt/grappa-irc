import { describe, expect, it } from "vitest";
import {
  baseMime,
  categoryOf,
  DOCUMENT_MIMES_OFFICE,
  DOCUMENT_MIMES_PORTABLE,
  IMAGE_MIMES,
  type UploadCategory,
  VIDEO_MIMES,
} from "../uploadCategory";

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
  it("covers all 14 server-mirrored MIMEs", () => {
    expect(matrix.length).toBe(14);
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
  ])("unknown MIME %j → null", (mime) => {
    expect(categoryOf(mime)).toBeNull();
  });
});
