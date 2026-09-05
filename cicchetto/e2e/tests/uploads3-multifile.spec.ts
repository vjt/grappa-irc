// uploads-3 (#118) — multi-file paste/drag-drop/picker upload.
//
// #118's three trigger surfaces already funnel into the upload pipeline,
// but each uploaded the FIRST file only. The orchestrator now holds a
// sequential per-channel queue: a batch of files uploads one at a time,
// each auto-sending its own emoji-URL PRIVMSG (the documented model —
// no draft splicing).
//
// This spec drives the picker (deterministic — setInputFiles stages N
// files with no OS dialog; the `multiple` attr + onPickerChange forward
// the whole list) and asserts BOTH files complete: two 📸 PRIVMSGs land,
// with two distinct upload slugs (sequential = two separate POSTs).
//
// The privacy modal is pre-acked here so the batch runs unattended; the
// modal flow itself is covered by ux-6-b-embedded-upload. Per
// `feedback_ux_e2e_mandatory`: a cic UX-behavior change ships with a
// Playwright e2e — vitest jsdom can't follow the multipart → IRC-echo
// chain twice in sequence.

import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { setUploadConfirmEnabled } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { sendPickedFiles } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("uploads-3 #118 — multi-file picker uploads ALL files sequentially → two 📸 links", async ({
  page,
}) => {
  const vjt = specUser();
  // #1883 — the send-confirm is an OPT-IN setting now, default OFF. This spec
  // is ABOUT the confirm, so it turns it on rather than relying on a default
  // that no longer holds. Server-side and per-user, so it survives the load.
  await setUploadConfirmEnabled(vjt.token, true);
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Pre-ack the embedded-host privacy modal so the batch runs unattended.
  await page.evaluate(() =>
    localStorage.setItem("image-upload-privacy-acknowledged:embedded", "1"),
  );

  // Stage TWO PNGs on the (now `multiple`) picker → the 1883 send-confirm →
  // triggerUploads([a, b]). The confirm lists the WHOLE batch, so both names
  // are on screen before either byte moves.
  const png = Buffer.from(TINY_PNG_HEX, "hex");
  const picker = page.locator("input[data-file-picker]");
  await picker.setInputFiles([
    { name: "multi-a.png", mimeType: "image/png", buffer: png },
    { name: "multi-b.png", mimeType: "image/png", buffer: png },
  ]);
  await expect(page.getByTestId("confirm-modal-attachment")).toHaveCount(2);
  await sendPickedFiles(page);

  // Both upload sequentially → two 📸 PRIVMSGs land after the IRC echo.
  const rows = scrollbackLine(page, "privmsg", "📸");
  await expect.poll(async () => await rows.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

  // Two distinct upload slugs — sequential = two separate POSTs, each
  // minting its own bytes-access slug.
  const texts = await rows.allTextContents();
  const slugs = new Set(
    texts.flatMap((t) => Array.from(t.matchAll(/\/uploads\/([a-z2-7]{26})/g)).map((m) => m[1])),
  );
  expect(slugs.size).toBeGreaterThanOrEqual(2);
});
