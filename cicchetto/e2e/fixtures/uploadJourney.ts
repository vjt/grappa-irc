// Shared picker → privacy-modal → POST /api/uploads journey.
//
// 2026-06-11 review finding: this vertical had FOUR drifted copies
// (media-link-modal-viewer `uploadPngAndGetLink`, uploads2-video-doc
// `uploadViaPicker`, ux-6-b-embedded-upload inline, i2b-litterbox
// inline). One parameterized helper, all call sites migrated — drift
// in timeouts/assertions now impossible by construction.
//
// Layering (so the litterbox path can reuse the modal half without
// the embedded-host POST half):
//   sendPickedFiles() — answer the 1883 send-confirm the picker now
//                       raises between selection and dispatch.
//   pickFile()        — feed the hidden picker, Send, then wait for the
//                       privacy modal. Heading is a REQUIRED param: it
//                       names the active upload host (embedded grappa vs
//                       litterbox.catbox.moe) and a wrong-host modal
//                       must fail loudly, not match loosely.
//   uploadViaPicker() — pickFile + Continue + pin POST /api/uploads
//                       201 + parse {slug, url}. Embedded-host only:
//                       litterbox uploads never touch /api/uploads.
//   mediaScrollbackRow() — the emoji-prefixed PRIVMSG row + anchor
//                       after the IRC echo round-trip.
//
// Timeouts are explicit params at every call site — the video path
// lazy-loads the transcode chunk and runs a transcode (or its
// fallback probe) before the POST, so its budget is 6× the image
// path's. A shared default would silently misbudget one of them.

import { expect, type Locator, type Page } from "@playwright/test";
import { scrollbackLine } from "./cicchettoPage";

export interface PickerFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export interface UploadResponse {
  slug: string;
  url: string;
  expires_at: string;
}

// Modal headings per active upload host (server-side `ActiveHost`
// setting). Exported so cancel-path specs can reuse them with
// pickFile without restating the regex.
export const EMBEDDED_MODAL_HEADING = /Upload to .+grappa/i;
export const LITTERBOX_MODAL_HEADING = /Upload to litterbox\.catbox\.moe/i;

// #1883 — the send-confirm, raised BEFORE the privacy modal and before
// anything reaches the orchestrator's queue. Every journey passes through it,
// so it lives here rather than being restated: a spec that forgot it would
// hang on the privacy modal instead of failing on the step it actually
// skipped. Not picker-only since the gate moved into `triggerUploads` (vjt's
// ruling, 2026-08-31) — the pane-drop and paste-to-.txt specs call it too.
//
// Scoped by the dialog's own HEADING, not by `confirm-modal` alone. The
// #80/#816 paste guard renders through the SAME singleton, and on the
// paste -> "upload as .txt" route the two dialogs swap within one tick: a
// testid-only locator is already visible while the PASTE dialog is still up,
// so it would act on that one. The title is also the dialog's aria-label.
export const SEND_CONFIRM_HEADING = /^Send to /;

export async function sendPickedFiles(page: Page): Promise<void> {
  const confirm = page.getByRole("dialog", { name: SEND_CONFIRM_HEADING });
  await expect(confirm).toBeVisible({ timeout: 5_000 });
  await expect(confirm.getByTestId("confirm-modal-confirm")).toHaveText("Send");
  await confirm.getByTestId("confirm-modal-confirm").click();
  await expect(confirm).toBeHidden({ timeout: 5_000 });
}

// Feed the hidden file input (no OS dialog under setInputFiles),
// authorise the 1883 send-confirm, and wait for the privacy modal.
// Fresh context per test → both modals fire every time. Returns the
// PRIVACY modal locator for the caller to Continue or Cancel.
export async function pickFile(
  page: Page,
  file: PickerFile,
  modalHeading: RegExp,
): Promise<Locator> {
  const picker = page.locator("input[data-file-picker]");
  await picker.setInputFiles(file);
  await sendPickedFiles(page);

  const modal = page.getByRole("dialog", { name: modalHeading });
  await expect(modal).toBeVisible({ timeout: 5_000 });
  return modal;
}

// Full embedded-host journey: picker → modal → Continue → POST
// /api/uploads 201. Races the Continue click against the POST
// response so the 201 is pinned before the caller chases the IRC
// echo. Pins the server's slug/url contract (slug doubles as the
// bytes-access token) and the modal dismissal.
export async function uploadViaPicker(
  page: Page,
  file: PickerFile,
  opts: { postTimeout: number },
): Promise<UploadResponse> {
  const modal = await pickFile(page, file, EMBEDDED_MODAL_HEADING);

  const [uploadRes] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes("/api/uploads") && r.request().method() === "POST",
      { timeout: opts.postTimeout },
    ),
    modal.locator("button", { hasText: /continue/i }).click(),
  ]);
  expect(uploadRes.status()).toBe(201);
  const body = (await uploadRes.json()) as UploadResponse;
  expect(body.slug).toMatch(/^[a-z2-7]{26}$/);
  // #418: the URL now carries the media type as a file extension
  // (`/uploads/<slug>.<ext>`, ext from Grappa.Uploads.MimeExt). Every
  // accepted MIME maps (lockstep), so an embedded upload always has one.
  expect(body.url).toMatch(/\/uploads\/[a-z2-7]{26}\.[a-z0-9]+$/);

  await expect(modal).toBeHidden({ timeout: 5_000 });
  return body;
}

// The emoji-prefixed PRIVMSG row that lands after the IRC echo, plus
// its anchor. `emoji` is the category prefix (📸 image, 🎬 video,
// 📄 document); `marker` narrows to THIS upload (slug for embedded,
// full URL for litterbox). Anchor-class assertions (e.g.
// scrollback-media-link) stay in the specs that own them — only
// image/video anchors carry the media class.
export async function mediaScrollbackRow(
  page: Page,
  emoji: string,
  marker: string,
): Promise<{ row: Locator; link: Locator }> {
  const row = scrollbackLine(page, "privmsg", emoji).filter({ hasText: marker });
  await expect(row.first()).toBeVisible({ timeout: 15_000 });
  const link = row.first().locator(".scrollback-link").first();
  return { row: row.first(), link };
}
