# Video + Document Uploads — Design

**Date:** 2026-06-09
**Status:** approved by vjt (brainstorm 2026-06-09), pending spec review
**Cluster:** uploads-2 (extends images cluster I-1/I-2 + UX-6 bucket B)

## Goal

Allow uploads of videos and documents from cic, mirroring the existing
image-upload UX. Videos are downscaled client-side (WebCodecs) before
upload; documents upload as-is. IRC stays text-only: the only artifact
on the wire is an emoji-prefixed URL in a PRIVMSG (`🎬 <url>`,
`📄 <url>`, mirroring `📸 <url>`).

## Decisions (vjt, 2026-06-09)

| Topic | Decision |
|---|---|
| Video output | Adaptive: max output ~50MB; bitrate budget picks 720p when it fits, else 480p. Max duration 2 minutes. |
| Video codec | H.264 (avc) in mp4 — broadest encode + playback support. |
| Document MIME | Office-friendly: pdf, txt, odt, ods, docx, xlsx (no macro-enabled variants). |
| Server caps | Per-type: `upload.{image,video,document}_per_file_cap_bytes` (10MB / 50MB / 10MB defaults). Old single key migrated. |
| Emoji prefixes | 🎬 video, 📄 document (📸 image unchanged). |
| Issue #49 | Fixed inside this cluster (stale retry buffer — same code being refactored). |
| Issue #39 | Out of cluster. Transcoded video is metadata-free by construction (new container); fallback originals carry metadata — known, accepted leak until #39 generalizes. |
| Unsupported platforms | Fallback: upload the original if ≤ video cap, else clear rejection. (Initially "reject always"; vjt reverted to fallback for compatibility.) |
| Transcode library | mediabunny (MPL-2.0, zero runtime deps, same author as mp4-muxer). Rejected: ffmpeg.wasm (25MB, COOP/COEP, mobile memory), hand-rolled mp4box.js + WebCodecs loop + mp4-muxer (3 deps, own the frame loop + manual audio passthrough). |
| Architecture | Generalize `ImageHost` → `UploadHost` with per-category accept/caps; single orchestrator with a pre-upload transform hook. No per-type orchestrator forks, no extend-in-place branches. |

## Client (cic)

### `uploadHost.ts` (rename of `image-upload.ts`)

```ts
export type UploadCategory = "image" | "video" | "document";
export function categoryOf(mime: string): UploadCategory | null;

export interface UploadHost {
  // id, displayName, retentionStatement, ttlOptions, defaultTtl,
  // supportsProgress, upload() — unchanged from ImageHost
  acceptedMimeTypes: Record<UploadCategory, ReadonlyArray<string>>;
  maxFileSizeBytes: Record<UploadCategory, number | null>;
}
```

`categoryOf` is the single MIME→category map. Unknown MIME rejected at
the boundary (null → pre-check error listing supported extensions per
category).

Per-host lists:

- **embedded** — image: existing five; video (selectable): `video/mp4`,
  `video/quicktime`, `video/webm`; document: `application/pdf`,
  `text/plain`, odt, ods, docx, xlsx. Caps read reactively from
  `serverSettings()` per category (cold-start literals mirror the
  server defaults).
- **litterbox** — same minus docx/xlsx (litterbox blocks `.doc*`,
  verified against their FAQ 2026-06-09; litterbox cap 1GB is above
  all our ceilings).

`acceptedMimeTypes.video` governs what the user can *select*; the
*uploaded* video file is the transcoded mp4 except on the fallback
path, where the original (mov/webm possible) uploads as-is.

### `videoTranscode.ts` (new)

```ts
export function videoTranscodeSupported(): Promise<boolean>;
export function transcodeVideo(
  file: File,
  onProgress: (fraction: number) => void,
): Promise<{ ok: File } | { error: TranscodeError }>;

export type TranscodeError =
  | { kind: "too_long"; durationSeconds: number }  // > 120s — no fallback, hard reject
  | { kind: "unsupported" }                        // gate or decode failure — fallback eligible
  | { kind: "failed"; message: string };           // mid-conversion crash — fallback eligible
```

- Gate: `typeof VideoEncoder !== "undefined"` + mediabunny `canEncode`
  probe for avc. Result cached for the session.
- Policy: duration > 120s → `too_long` (hard reject, fallback does NOT
  apply — the limit is policy, not capability). Duration is read via a
  `<video>` element's `loadedmetadata` (works without WebCodecs), so
  the 2-minute limit is enforced on the fallback path too. Bitrate
  budget = (0.95 × video cap × 8) / duration − audio bitrate; budget ≥
  `RESOLUTION_THRESHOLD_BPS` (named constant, initial value 2 Mbps) →
  720p target height, else 480p. Never upscale (source below target →
  keep source height).
- **Always transcode when supported**, even when the source already
  fits: output is uniformly H.264/mp4 and metadata-free (fresh
  container — GPS/EXIF die by construction).
- Audio: mediabunny passthrough when the source track fits mp4 (AAC —
  the iPhone case, avoids Chrome's missing AAC encoder); unmanageable
  track → proceed video-only with a non-blocking warning.
- 95% budget margin absorbs VBR overshoot; output still above cap →
  standard cap error.

### `uploadOrchestrator.ts` (rename of `imageUploadOrchestrator.ts`)

Single pipeline in `dispatchUpload`:

1. `categoryOf(file.type)` — null → pre-check error.
2. Transform hook: video → gate + `transcodeVideo` (progress drives a
   `transcoding` phase); on `unsupported`/`failed` → fall back to the
   original if ≤ video cap (log the transcode failure reason to
   console for dogfood diagnosis — no silent swallow), else cap
   error. image/document → identity.
3. Cap pre-check per category on the file that will actually upload.
4. `host.upload` → URL → `sendMessage` with `📸/🎬/📄` per category.

Privacy modal, progress state, retry, cancel: single shared machinery,
unchanged in shape. `UploadStateEntry` gains
`phase: "transcoding" | "uploading"`.

**#49 fix:** a new file selection always replaces the staged state
(`lastAttempt` + the file input's value). Root cause to be confirmed
by reading ComposeBox during planning (systematic-debugging); ships
with a regression test.

### ComposeBox + serverSettings

- `<input accept>` = union of the active host's category lists; same
  gate for drag-drop and paste.
- Progress UI: transcoding phase first (fraction from mediabunny),
  then upload phase (existing behavior, indeterminate on litterbox).
- `ServerSettingsView` / `ServerSettingsWirePayload`: three per-type
  cap fields replace `per_file_cap_bytes`, in lockstep with the
  server wire change (same deploy).

## Server (grappa)

### ServerSettings — per-type caps

| Key | Default |
|---|---|
| `upload.image_per_file_cap_bytes` | 10 MiB |
| `upload.video_per_file_cap_bytes` | 50 MiB |
| `upload.document_per_file_cap_bytes` | 10 MiB |

- `upload.active_host`, `upload.global_cap_bytes`: unchanged.
- DML migration renames the `upload.per_file_cap_bytes` row to
  `upload.image_per_file_cap_bytes` when present; the old key dies.
  No read-fallback on the old name (total migration, no half-state).
  Pure DML, no DDL — hot-deployable per the #41 classifier.
- `public_view/0`, `Wire`, `GET /api/server-settings`,
  `PUT /admin/settings`: three cap fields. cic `AdminSettingsTab`
  gets three inputs.

### UploadsController

- `@allowed_mimes` flat list → `@mime_categories` map
  (`%{"video/mp4" => :video, ...}`). `validate_mime` returns
  `{mime, category}`; cap resolved per category from ServerSettings.
  Unknown MIME → 415 at the boundary, as today.
- Category is **derived** from mime — no new column on `uploads`, no
  DDL. Reaper, global cap, slug machinery, routes, nginx allowlist:
  untouched.
- Content-sniffing posture unchanged: `content_type` is
  client-supplied and spoofable — same posture as images today;
  magic-bytes validation belongs to a #39 follow-up, not this
  cluster.

### Plug.Parsers latent-bug fix

`endpoint.ex` does not set `:length` on `Plug.Parsers`; the multipart
default is 8MB, so a 9MB upload 413s today despite the advertised
10MB cap. Fix: explicit `length: 64MB` static ceiling (policy stays
in the admin-tunable per-type caps). Separate commit with a test
exercising a >8MB multipart body. nginx is already at
`client_max_body_size 100m` (`infra/snippets/locations-api.conf`).

## Error handling

| Case | Outcome |
|---|---|
| Unknown MIME at picker/drop/paste | Pre-check error listing supported extensions per category |
| Video > 2 minutes | Hard reject ("Video too long (max 2 minutes).") — no upload, no fallback |
| Gate absent / transcode failed | Original uploads if ≤ 2 minutes AND ≤ video cap, else clear rejection; failure reason logged to console |
| File (transcoded or original) > cap | Existing cap error, per category |
| Unmanageable audio track | Video-only output + non-blocking warning |
| Upload transport errors | Existing `UploadError` paths, unchanged |

Server: 415 unknown MIME, 413 over-cap, FallbackController — no new
patterns, no silent swallows.

## Testing

- **vitest:** `categoryOf` matrix; gate probe with/without
  `VideoEncoder`; `videoTranscode` contract tests with mediabunny
  mocked at the boundary (jsdom has no WebCodecs): budget→720/480
  selection, too_long, fallback eligibility; orchestrator per
  category (transform hook, phases, emoji); #49 regression;
  serverSettings new wire shape. Respect the cp60 gotcha: no
  `vi.unstubAllGlobals()` in beforeEach.
- **ExUnit:** ServerSettings get/put × 3 keys + DML migration;
  UploadsController MIME×category×cap matrix (201/413/415); Wire
  shape; >8MB multipart regression (the Plug.Parsers fix).
- **e2e:** document happy path (txt fixture); one video test on
  chromium with a ~1s mp4 fixture, skipped when `VideoEncoder` is
  absent (headless webkit). No iOS scroll-style repro attempts on
  Playwright webkit.
- **Mandatory iPhone dogfood:** real Safari iOS video (HEVC source,
  rotation, memory pressure) — exactly what e2e cannot cover.

## Work order

Worktree from local main; bite-sized commits:

1. Plug.Parsers `:length` fix + regression test (standalone bug fix).
2. ServerSettings per-type caps + DML migration + Wire + admin PUT.
3. UploadsController category map + per-category caps.
4. cic: `UploadHost` refactor (rename, categories, caps) + #49 fix.
5. cic: `videoTranscode.ts` + gate (mediabunny dep via scripts/bun.sh).
6. cic: orchestrator transform hook + ComposeBox + AdminSettingsTab.
7. e2e + docs (DESIGN_NOTES entry) + deploy m42 + iPhone dogfood.
