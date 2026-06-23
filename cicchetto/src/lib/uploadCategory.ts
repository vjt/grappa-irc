// Upload category taxonomy — video+document uploads cluster Task 4
// (2026-06-09).
//
// Cycle-breaker module: `uploadHost.ts` imports `serverSettings.ts`
// (reactive per-category caps); `serverSettings.ts` needs
// `UploadCategory` for its view shape. Both import from here.
//
// The MIME lists below are a 1:1 mirror of the server's
// `@mime_categories` map in
// `lib/grappa_web/controllers/uploads_controller.ex` — keep entries
// in the SAME ORDER so a side-by-side diff stays trivial. Adding a
// MIME means touching both files in the same commit.

export type UploadCategory = "image" | "video" | "document";

export const IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/apng",
] as const;

export const VIDEO_MIMES = ["video/mp4", "video/quicktime", "video/webm"] as const;

export const DOCUMENT_MIMES_PORTABLE = [
  "application/pdf",
  "text/plain",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
] as const;

export const DOCUMENT_MIMES_OFFICE = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;

const MIME_CATEGORIES: Record<string, UploadCategory> = Object.fromEntries([
  ...IMAGE_MIMES.map((m) => [m, "image"] as const),
  ...VIDEO_MIMES.map((m) => [m, "video"] as const),
  ...DOCUMENT_MIMES_PORTABLE.map((m) => [m, "document"] as const),
  ...DOCUMENT_MIMES_OFFICE.map((m) => [m, "document"] as const),
]);

/** Single MIME→category map. null = not uploadable, reject at boundary. */
export function categoryOf(mime: string): UploadCategory | null {
  return MIME_CATEGORIES[mime] ?? null;
}

/** MIME → extension label for the unsupported-type error copy. Typed
 *  exhaustively over the MIME unions above so a 15th MIME added to a
 *  list without a label here is a compile error (Task 5 review
 *  follow-up, 2026-06-09 — formerly a stringly `Record` in
 *  uploadOrchestrator.ts that could silently drift). */
export const MIME_EXT_LABEL: Record<
  | (typeof IMAGE_MIMES)[number]
  | (typeof VIDEO_MIMES)[number]
  | (typeof DOCUMENT_MIMES_PORTABLE)[number]
  | (typeof DOCUMENT_MIMES_OFFICE)[number],
  string
> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/apng": "apng",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
};

/** Widened lookup for host MIME lists (typed `ReadonlyArray<string>`).
 *  Unknown MIME → echo the MIME itself rather than crash the copy. */
export function mimeExtLabel(mime: string): string {
  return (MIME_EXT_LABEL as Readonly<Record<string, string>>)[mime] ?? mime;
}
