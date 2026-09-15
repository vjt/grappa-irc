// #1964 — the upload confirm previews the file it is asking about, and Enter
// answers yes.
//
// The defect, reported from the paste path: #1883's confirm was built around
// an image thumbnail, and every other type got `thumbnail: null` — an empty
// box. On the paste-as-.txt door (#816) the filename is the constant
// `paste.txt` for every paste in every window, so the dialog asked the
// operator to authorise an upload showing a constant name, a byte count and
// nothing else. The second half: Cancel took focus, so Enter — the key you
// press after reading a dialog — discarded the batch.
//
// Why a real browser and not jsdom. Both halves are engine behaviour that a
// DOM mock cannot witness:
//
//   * the previews are `blob:` object URLs handed to `<img>`, `<video>` and
//     `<audio>`, and the prod CSP gets a vote. #1883 measured exactly this
//     failure for `img-src` (`blockedURI: blob`, attribute intact, empty box —
//     green in jsdom, broken on screen). `media-src` is a separate directive,
//     so video and audio need their own witness here.
//   * "Enter sends" is the browser turning a keypress on a focused button into
//     a click. jsdom can assert which element has focus; only a real engine
//     can show that the key reaches the wire.
//
// Parity: the dialog is subject-shape-agnostic (client-side rendering of a
// local file, no subject in the question), so the seeded user suffices — the
// same argument #1883 makes.

import type { Page } from "@playwright/test";
import { DECODABLE_VIDEO, TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { setUploadConfirmEnabled } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Four lines, so the fifth is the witness for the cap: a preview that showed
// the whole file would be a file viewer, and a 40 MB log pasted into IRC would
// render 40 MB of DOM.
const TEXT_BODY = "alpha one\nbeta two\ngamma three\ndelta four\nepsilon five\nzeta six\n";

const png = { name: "keep.png", mimeType: "image/png", buffer: Buffer.from(TINY_PNG_HEX, "hex") };
const txt = { name: "paste.txt", mimeType: "text/plain", buffer: Buffer.from(TEXT_BODY, "utf8") };
const pdf = {
  name: "spec.pdf",
  mimeType: "application/pdf",
  buffer: Buffer.from("%PDF-1.4\n", "utf8"),
};
// VP9-in-WebM, and the choice is load-bearing rather than incidental: this row
// is the only one in the suite that asks a REAL engine to decode, and only one
// of the two browser builds Playwright installs has H.264 — see
// DECODABLE_VIDEO in ../fixtures/bytes (issue 2026). The spec is about the
// dialog previewing a video as a video, not about the mp4 path, so the
// container is a detail and the decodability is not.
const webm = DECODABLE_VIDEO;

// A 0.1 s silent 16-bit PCM mono WAV, built here rather than committed as a
// binary: the header is 44 bytes of documented layout and the payload is
// zeroes, so a reader can check it against the spec instead of trusting an
// opaque blob. Silence is enough — the audio preview is a PLAYER, not a
// waveform, so what is asserted is that the element exists and the engine
// accepts the source.
function silentWav(): Buffer {
  const rate = 8000;
  const samples = rate / 10;
  const dataBytes = samples * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); // PCM header size
  buf.writeUInt16LE(1, 20); // format: PCM
  buf.writeUInt16LE(1, 22); // channels: mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); // byte rate
  buf.writeUInt16LE(2, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);
  return buf;
}

const wav = { name: "tone.wav", mimeType: "audio/wav", buffer: silentWav() };

// The operator this issue is about: opted INTO the confirm (it is off by
// default since #1883) and past the one-shot privacy notice, so the confirm is
// the only thing on screen.
async function asConfirmingOperator(page: Page): Promise<void> {
  await setUploadConfirmEnabled(specUser().token, true);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await page.evaluate(() =>
    localStorage.setItem("image-upload-privacy-acknowledged:embedded", "1"),
  );
}

test("#1964 — each staged file previews as what it actually is", async ({ page }) => {
  await asConfirmingOperator(page);

  await page.locator("input[data-file-picker]").setInputFiles([png, webm, wav, txt, pdf]);

  const confirm = page.getByTestId("confirm-modal");
  await expect(confirm).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("confirm-modal-attachment")).toHaveCount(5);

  // ── image: unchanged from #1883, and it must DECODE ─────────────────────
  const thumb = page.getByTestId("confirm-modal-attachment-thumb");
  await expect(thumb).toHaveAttribute("src", /^blob:/);
  await expect
    .poll(() => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 5_000 })
    .toBeGreaterThan(0);

  // ── video: playable, from the same local bytes ──────────────────────────
  const video = page.getByTestId("confirm-modal-attachment-video");
  await expect(video).toHaveAttribute("src", /^blob:.*#t=0\.1$/);
  // A video is a thing that MOVES, so recognising the take means watching it.
  await expect(video).toHaveAttribute("controls", "");
  // The CSP witness, and the reason it is not `videoWidth`: decoding is the
  // engine's own schedule (a hidden page defers it), but a `media-src` refusal
  // is immediate and lands as MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED — the
  // same signature `videoPolicy.ts` documents for a blocked blob:.
  //
  // 🔴 That signature is SHARED, and it is why the fixture above has to be one
  // both browser builds can decode. A `media-src` refusal and "this engine has
  // no decoder for these bytes" are the SAME code 4, so on an H.264 fixture
  // this poll could not tell them apart — it read as a blocked blob on the one
  // host where the decoder is missing, and issue 2026 spent nine data points
  // finding that out. With a codec measured present on both builds, the only
  // remaining way to reach 4 is the refusal this assertion is here for.
  await expect
    .poll(() => video.evaluate((el) => (el as HTMLVideoElement).error?.code ?? 0), {
      timeout: 5_000,
    })
    .toBe(0);

  // ── audio: for sound there is no picture, so the preview is the player ───
  const audio = page.getByTestId("confirm-modal-attachment-audio");
  await expect(audio).toHaveAttribute("src", /^blob:/);
  await expect(audio).toHaveAttribute("controls", "");

  // ── text: the case the issue was filed for ──────────────────────────────
  const source = page.getByTestId("confirm-modal-attachment-source");
  await expect(source).toContainText("alpha one");
  await expect(source).toContainText("delta four");
  // Capped: this is a head, not a viewer.
  await expect(source).not.toContainText("epsilon five");

  // ── pdf: no preview, and it SAYS so ─────────────────────────────────────
  // cic has no PDF renderer — the viewer has four arms and a 📄 link falls
  // through to the browser — so this row states the limit in words instead of
  // showing an empty box that reads as a picture which failed to load.
  const pdfRow = page.getByTestId("confirm-modal-attachment").filter({ hasText: "spec.pdf" });
  await expect(pdfRow).toContainText("preview not supported");
  // One preview element per renderable row and no more: 5 rows, 4 previews,
  // and the PDF holds none of them.
  await expect(page.getByTestId("confirm-modal-attachment-video")).toHaveCount(1);
  await expect(page.getByTestId("confirm-modal-attachment-audio")).toHaveCount(1);
  await expect(page.getByTestId("confirm-modal-attachment-source")).toHaveCount(1);
  await expect(thumb).toHaveCount(1);

  await page.getByTestId("confirm-modal-cancel").click();
  await expect(confirm).toBeHidden({ timeout: 5_000 });
});

test("#1964 — Enter sends the batch instead of discarding it", async ({ page }) => {
  await asConfirmingOperator(page);

  await page.locator("input[data-file-picker]").setInputFiles([txt]);
  const confirm = page.getByTestId("confirm-modal");
  await expect(confirm).toBeVisible({ timeout: 5_000 });

  // The affirmative holds focus, so the key lands on it. Asserted as well as
  // pressed: a passing Enter with focus elsewhere (the document, a stray
  // button) would be a different mechanism that happens to work today.
  await expect(page.getByTestId("confirm-modal-confirm")).toBeFocused({ timeout: 5_000 });
  await page.keyboard.press("Enter");

  await expect(confirm).toBeHidden({ timeout: 5_000 });
  // The outcome that reaches the channel, not the button that was clicked.
  await expect(scrollbackLine(page, "privmsg", "📄").first()).toBeVisible({ timeout: 20_000 });
});

test("#1964 — Enter still answers after a row is removed", async ({ page }) => {
  await asConfirmingOperator(page);

  await page.locator("input[data-file-picker]").setInputFiles([png, txt]);
  const confirm = page.getByTestId("confirm-modal");
  await expect(confirm).toBeVisible({ timeout: 5_000 });
  await expect(page.getByTestId("confirm-modal-attachment")).toHaveCount(2);

  // Measured in a browser during #1964: the × the operator presses unmounts
  // with its row and focus falls to <body>, so the next Enter answers NOTHING
  // — in the one dialog where Enter is meant to send. The cure hands focus
  // back to the request's default button.
  await page.getByRole("button", { name: /remove keep\.png/i }).click();
  await expect(page.getByTestId("confirm-modal-attachment")).toHaveCount(1);
  await expect(page.getByTestId("confirm-modal-confirm")).toBeFocused({ timeout: 5_000 });

  await page.keyboard.press("Enter");
  await expect(confirm).toBeHidden({ timeout: 5_000 });
  await expect(scrollbackLine(page, "privmsg", "📄").first()).toBeVisible({ timeout: 20_000 });
  // The removed file did not ride along.
  await expect(scrollbackLine(page, "privmsg", "📸")).toHaveCount(0);
});
