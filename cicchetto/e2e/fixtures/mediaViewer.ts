// The media-viewer door (#1441): one place that knows how the viewer is
// named, opened and closed.
//
// ## What was measured before the lift (on 5ec44475)
//
// THIRTEEN opening call sites across TEN spec files — not "ten copies". The
// issue's ten is right at FILE granularity and low at call-site granularity:
// media-link-modal-viewer.spec.ts alone opened it three times and
// media-link-cross-host-modal.spec.ts twice.
//
// They were NOT byte-identical, a claim the issue explicitly refused to make.
// Counting raw bytes there were FIVE distinct bodies (indentation splits them:
// the two sites inside a `test.describe` are indented one level deeper);
// normalising indentation and comments away leaves THREE, and the third is
// only "shorter because the dialog was already bound above". So the real
// divergence is ONE axis, below.
//
// ## The one axis that genuinely diverges, and why it gets two verbs
//
// Nine sites clicked with `link.click()` — Playwright's click, which scrolls
// the anchor into view first. Four clicked with
// `link.evaluate((el) => (el as HTMLElement).click())` — the anchor's OWN
// click, dispatched where it sits. That is not drift. Those four
// (#196-preserve, #219, #213, #1438) MEASURE the scrollback's scroll position
// across the open, and Playwright's scroll-into-view would move the very thing
// under test before the gesture it is testing ever fires.
//
// So this module exports two verbs rather than one verb with a `scroll: bool`.
// A boolean at thirteen call sites is a coin flip a reviewer cannot check; two
// names are two things a reviewer can read. `openMediaViewerInPlace` says what
// it protects in its name, which is the whole reason those four specs are
// green.
//
// ## Wait conditions: from the strictest copy, and then frozen
//
// All thirteen waited `toBeVisible({ timeout: 5_000 })` on the dialog, so the
// strictest and the uniform value are the same 5_000 — kept, not raised.
// It is a module constant and NOT a per-call-site parameter, deliberately
// against `uploadJourney.ts`'s opposite rule: there the image and video budgets
// genuinely differ 6×, here every caller wants the same answer to the same
// question, and a parameter would re-open the drift axis this module exists to
// close. A future viewer that needs longer changes it here, for everyone, on
// purpose.
//
// #213 additionally waited for `.media-viewer-media--zoomable` to be visible.
// That barrier stays in #213: it is image-and-zoom specific (the cross-host
// video case has no zoomable element at all), and it is also the locator that
// spec goes on to drive. Strictest COMMON wait, not strictest anywhere.
//
// ## Not in scope here
//
// `media-link-cross-host-modal.spec.ts` and `media-link-alias-modal.spec.ts`
// produce their anchor by composing a URL rather than by uploading, so they
// use the openers but not `uploadImageAndGetLink`. That is the domain
// boundary, not a gap: the thing they share is the DOOR, and they use it.

import { expect, type Locator, type Page } from "@playwright/test";
import { TINY_PNG_HEX } from "./bytes";
import { mediaScrollbackRow, uploadViaPicker } from "./uploadJourney";

// The accessible name MediaViewerModal renders (role=dialog + aria-label), and
// its close control. Ten spec files used to spell these out, so renaming the
// label meant finding ten call sites by hand and the eleventh by CI.
const DIALOG_NAME = "Media viewer";
const CLOSE_BUTTON_NAME = "Close media viewer";

// Measured uniform across all thirteen pre-lift call sites. See the header for
// why it is a constant and not a parameter.
const VIEWER_SETTLE_MS = 5_000;

// The upload budget for the IMAGE path only — uniform across the eight upload
// preambles. `uploadJourney.uploadViaPicker` deliberately demands this per call
// site because the video path needs 6× as long; `uploadImageAndGetLink` is
// image-only, so the budget is intrinsic to the verb. A video caller keeps
// using `uploadViaPicker` directly and keeps choosing its own.
const IMAGE_POST_TIMEOUT_MS = 10_000;

// The viewer dialog, open or not. Exported so a NEGATIVE assertion (the audio
// path must NOT open the modal) reads the same locator the positive ones do.
export function mediaViewer(page: Page): Locator {
  return page.getByRole("dialog", { name: DIALOG_NAME });
}

// Open by a real user click. Playwright scrolls the anchor into view first,
// which is correct everywhere the scroll position is not itself the subject.
export async function openMediaViewer(page: Page, link: Locator): Promise<Locator> {
  await link.click();
  return settled(page);
}

// Open WITHOUT moving the pane: dispatch the anchor's own click where it sits.
// The four scroll-position specs need this — Playwright's click would scroll
// the container they are about to measure.
export async function openMediaViewerInPlace(page: Page, link: Locator): Promise<Locator> {
  await link.evaluate((el) => (el as HTMLElement).click());
  return settled(page);
}

// Close by the X, and wait for the dialog to actually go. Every caller wants
// the barrier — a close that is only issued races whatever the spec asserts
// next about the pane underneath.
export async function closeMediaViewer(viewer: Locator): Promise<void> {
  await viewer.getByRole("button", { name: CLOSE_BUTTON_NAME }).click();
  await expect(viewer).toBeHidden({ timeout: VIEWER_SETTLE_MS });
}

async function settled(page: Page): Promise<Locator> {
  const viewer = mediaViewer(page);
  await expect(viewer).toBeVisible({ timeout: VIEWER_SETTLE_MS });
  return viewer;
}

// The eight-copy preamble: upload a tiny PNG through the real picker, wait for
// the 📸 row the IRC echo brings back, and hand over its anchor.
//
// `fileName` stays a parameter: it lands in the upload and names the spec that
// made it, which is how a leftover in the store is attributed.
//
// The media-class assertion is HERE rather than at the call sites. Six of the
// eight preambles made it and two (#213, #1438) did not — strictest wins, so
// the two gain a precondition they were relying on silently. Without the class
// the anchor never opens the viewer, and the failure used to surface as a
// five-second timeout on the dialog instead of naming the classifier.
// `uploadJourney.mediaScrollbackRow` deliberately does NOT assert it (it serves
// 📄 documents too, which carry no media class); this verb is image-only, so
// here it is a fact and not an assumption.
export async function uploadImageAndGetLink(
  page: Page,
  fileName: string,
): Promise<{ slug: string; url: string; row: Locator; link: Locator }> {
  const { slug, url } = await uploadViaPicker(
    page,
    { name: fileName, mimeType: "image/png", buffer: Buffer.from(TINY_PNG_HEX, "hex") },
    { postTimeout: IMAGE_POST_TIMEOUT_MS },
  );
  const { row, link } = await mediaScrollbackRow(page, "📸", slug);
  await expect(link).toHaveClass(/scrollback-media-link/);
  return { slug, url, row, link };
}
