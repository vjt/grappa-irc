import { describe, expect, it } from "vitest";
import {
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
