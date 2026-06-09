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
