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

import { expect, test } from "../fixtures/test";
import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("uploads-3 #118 — multi-file picker uploads ALL files sequentially → two 📸 links", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Pre-ack the embedded-host privacy modal so the batch runs unattended.
  await page.evaluate(() =>
    localStorage.setItem("image-upload-privacy-acknowledged:embedded", "1"),
  );

  // Stage TWO PNGs on the (now `multiple`) picker → triggerUploads([a, b]).
  const png = Buffer.from(TINY_PNG_HEX, "hex");
  const picker = page.locator("input[data-file-picker]");
  await picker.setInputFiles([
    { name: "multi-a.png", mimeType: "image/png", buffer: png },
    { name: "multi-b.png", mimeType: "image/png", buffer: png },
  ]);

  // Both upload sequentially → two 📸 PRIVMSGs land after the IRC echo.
  const rows = scrollbackLine(page, "privmsg", "📸");
  await expect.poll(async () => await rows.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);

  // Two distinct upload slugs — sequential = two separate POSTs, each
  // minting its own bytes-access slug.
  const texts = await rows.allTextContents();
  const slugs = new Set(
    texts.flatMap((t) =>
      Array.from(t.matchAll(/\/uploads\/([a-z2-7]{26})/g)).map((m) => m[1]),
    ),
  );
  expect(slugs.size).toBeGreaterThanOrEqual(2);
});
