// issue 2343 — the operator decides whether THIS batch's videos are shrunk, in
// the dialog that shows them the batch.
//
// The defect: "Shrink videos before sending" lived only in Settings, default
// OFF since #2173, so a 12.3 Mbps 1080p HEVC clip from Android went up
// untouched and the operator never learnt the switch existed. The upload
// confirm already asks one per-batch term (the TTL, #2094); it now asks this
// one beside it, seeded from the device preference.
//
// The oracle is the lazy transcode CHUNK, and the choice is deliberate.
// `prepareVideo` tests the switch ABOVE the `import("./videoTranscode")` — on
// purpose, so a phone with the switch off never fetches ~534kB of mediabunny
// (issue 2157) — which makes "the chunk was requested" the observable edge of
// "this batch was going to be transcoded". It is independent of whether the
// browser build can actually encode: the import happens before the WebCodecs
// capability check, so this spec needs no codec skip, unlike uploads2.
//
// The two arms are each other's positive control. Arm (a) PROVES the chunk's
// URL matches the pattern by seeing it; without that, arm (b)'s "never
// requested" would pass just as green on a pattern that matches nothing.

import type { Page } from "@playwright/test";
import { OPAQUE_VIDEO, TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { setUploadConfirmEnabled } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { SEND_CONFIRM_HEADING, sendPickedFiles } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// The device preference's key and label, as cicchetto/src/lib/videoProcessing
// spells them. Retyped because an e2e spec cannot import app source; the
// label assertion below is what catches drift on the visible half.
const VIDEO_PROCESSING_STORAGE_KEY = "cicchetto.videoProcessing";
const VIDEO_PROCESSING_LABEL = "Shrink videos before sending";

// Vite names a dynamic-import chunk after its module (`videoTranscode-<hash>.js`
// in the build, `/src/lib/videoTranscode.ts` under the dev server).
const TRANSCODE_CHUNK = /videoTranscode/;

function watchTranscodeChunk(page: Page): () => number {
  let seen = 0;
  page.on("request", (req) => {
    if (TRANSCODE_CHUNK.test(req.url())) seen += 1;
  });
  return () => seen;
}

// Opted into the confirm (the switch lives there), privacy notice pre-acked
// (one-shot per host, not this spec's subject), and the device preference set
// to the value the arm starts from.
async function openWithPreference(page: Page, shrink: boolean): Promise<void> {
  await setUploadConfirmEnabled(specUser().token, true);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await page.evaluate(
    ([key, value]) => {
      localStorage.setItem("image-upload-privacy-acknowledged:embedded", "1");
      localStorage.setItem(key, value);
    },
    [VIDEO_PROCESSING_STORAGE_KEY, shrink ? "true" : "false"] as const,
  );
}

function sendConfirm(page: Page) {
  return page.getByRole("dialog", { name: SEND_CONFIRM_HEADING });
}

test("2343 (a) — ticked in the dialog with Settings OFF: this batch is shrunk", async ({
  page,
}) => {
  const chunkRequests = watchTranscodeChunk(page);
  await openWithPreference(page, false);

  await page.locator("input[data-file-picker]").setInputFiles(OPAQUE_VIDEO);

  const confirm = sendConfirm(page);
  await expect(confirm).toBeVisible({ timeout: 5_000 });
  const toggle = confirm.getByLabel(VIDEO_PROCESSING_LABEL);
  // Seeded from the device: OFF, the #2173 default this operator kept.
  await expect(toggle).not.toBeChecked();
  await toggle.check();

  await sendPickedFiles(page);

  // Transcode-or-fallback, as in uploads2: the bytes may be the re-encode or
  // the original, and the link lands either way.
  await expect(scrollbackLine(page, "privmsg", "🎬").first()).toBeVisible({ timeout: 60_000 });
  expect(
    chunkRequests(),
    "the transcode chunk was never requested — the tick was ignored",
  ).toBeGreaterThan(0);
  // One-off: the dialog does not change the device preference.
  expect(
    await page.evaluate((key) => localStorage.getItem(key), VIDEO_PROCESSING_STORAGE_KEY),
  ).toBe("false");
});

test("2343 (b) — unticked in the dialog with Settings ON: this batch goes up untouched", async ({
  page,
}) => {
  const chunkRequests = watchTranscodeChunk(page);
  await openWithPreference(page, true);

  await page.locator("input[data-file-picker]").setInputFiles(OPAQUE_VIDEO);

  const confirm = sendConfirm(page);
  await expect(confirm).toBeVisible({ timeout: 5_000 });
  const toggle = confirm.getByLabel(VIDEO_PROCESSING_LABEL);
  await expect(toggle).toBeChecked();
  await toggle.uncheck();

  await sendPickedFiles(page);

  await expect(scrollbackLine(page, "privmsg", "🎬").first()).toBeVisible({ timeout: 15_000 });
  expect(chunkRequests(), "the transcode chunk was fetched — the untick was ignored").toBe(0);
  expect(
    await page.evaluate((key) => localStorage.getItem(key), VIDEO_PROCESSING_STORAGE_KEY),
  ).toBe("true");
});

test("2343 (c) — a batch with no video is not asked about shrinking", async ({ page }) => {
  await openWithPreference(page, false);

  await page.locator("input[data-file-picker]").setInputFiles({
    name: "still.png",
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_HEX, "hex"),
  });

  const confirm = sendConfirm(page);
  await expect(confirm).toBeVisible({ timeout: 5_000 });
  // The TTL row is the barrier: it renders in the same pass as the switch
  // would, so once it is up an absent switch is absent, not late.
  await expect(confirm.getByTestId("confirm-modal-choice")).toBeVisible();
  await expect(confirm.getByTestId("confirm-modal-toggle")).toHaveCount(0);
});
