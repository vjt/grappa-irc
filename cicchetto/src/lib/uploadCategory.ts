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

export type UploadCategory = "image" | "video" | "document" | "audio";

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

// Audio (GH #115) — 1:1 mirror of the server's audio block in
// uploads_controller.ex @mime_categories, SAME ORDER. mp3, m4a/m4r
// (AAC + ALAC both ride audio/mp4), wav, flac. opus/ogg deferred OUT.
export const AUDIO_MIMES = [
  "audio/mpeg",
  "audio/mp4",
  "audio/x-m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/flac",
  "audio/x-flac",
] as const;

const MIME_CATEGORIES: Record<string, UploadCategory> = Object.fromEntries([
  ...IMAGE_MIMES.map((m) => [m, "image"] as const),
  ...VIDEO_MIMES.map((m) => [m, "video"] as const),
  ...DOCUMENT_MIMES_PORTABLE.map((m) => [m, "document"] as const),
  ...DOCUMENT_MIMES_OFFICE.map((m) => [m, "document"] as const),
  ...AUDIO_MIMES.map((m) => [m, "audio"] as const),
]);

/** Single MIME→category map. null = not uploadable, reject at boundary. */
export function categoryOf(mime: string): UploadCategory | null {
  return MIME_CATEGORIES[mime] ?? null;
}

// Audio extension → canonical MIME — 1:1 mirror of the server's
// @audio_ext_canonical_mime (uploads_controller.ex). Browsers give
// uncommon audio extensions an unreliable file.type: iOS labels .m4r
// (ringtones) empty/octet-stream, and .m4a/.flac are sometimes
// octet-stream too. The server has an octet-stream→canonical rescue,
// but cic's categoryOf would reject these BEFORE upload — so cic must
// relabel by extension to the canonical audio MIME first.
const AUDIO_EXT_CANONICAL_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  m4r: "audio/mp4",
  wav: "audio/wav",
  flac: "audio/flac",
};

/**
 * Relabel a File whose browser-assigned `type` is not a recognized
 * upload MIME but whose extension is a known audio type — returns a new
 * File with the canonical audio MIME (same bytes, same name). Returns
 * the original File when the type is already recognized or the
 * extension is unknown. Idempotent. Keeps cic and the server's
 * extension-rescue consistent so the gate AND the uploaded
 * Content-Type agree.
 */
export function normalizeUploadFile(file: File): File {
  if (categoryOf(file.type) !== null) return file;
  const ext = file.name.split(".").pop()?.toLowerCase() ?? "";
  const canonical = AUDIO_EXT_CANONICAL_MIME[ext];
  if (canonical === undefined) return file;
  return new File([file], file.name, { type: canonical, lastModified: file.lastModified });
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
  | (typeof DOCUMENT_MIMES_OFFICE)[number]
  | (typeof AUDIO_MIMES)[number],
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
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
};

/** Widened lookup for host MIME lists (typed `ReadonlyArray<string>`).
 *  Unknown MIME → echo the MIME itself rather than crash the copy. */
export function mimeExtLabel(mime: string): string {
  return (MIME_EXT_LABEL as Readonly<Record<string, string>>)[mime] ?? mime;
}
