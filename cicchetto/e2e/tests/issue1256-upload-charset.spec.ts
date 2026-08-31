// #1256 — an uploaded UTF-8 paste must RENDER as the text that was
// pasted, not as mojibake.
//
// `GET /uploads/:slug` used to serve `text/plain` with no charset, so a
// browser had no declared encoding and fell back to its locale default
// (windows-1252 in a Western locale): `è` painted as `Ã¨`, `—` as
// `â€”`. The bytes on disk were always fine — the DECLARATION was
// missing, and it could not get in either, because the upload
// allowlist matched the client-declared content type by whole-string
// equality. A client labelling its encoding honestly
// (`text/plain; charset=utf-8`) was the one earning a 415.
//
// The fix is two-sided and this spec is the only gate that sees both
// halves at once: cic labels the File it builds from a JS string
// (pasteRoute.ts — UTF-8 by File-constructor spec, a fact and not a
// guess), and the server splits the parameter off the type before
// matching its allowlist, persists the charset in a closed set, and
// rebuilds the response header from it (Grappa.Uploads.ContentType).
//
// The oracle is deliberately the RENDERED text, read out of a real
// navigation to the upload URL — the response header is asserted too,
// but a header assertion alone would not prove the browser stopped
// guessing. Server-side unit coverage (uploads_controller_test.exs)
// pins the header matrix; vitest pins the File's label; only a real
// browser can show the accents surviving the trip.

import type { Page } from "@playwright/test";
import {
  composeTextarea,
  confirmModal,
  confirmModalYes,
  loginAs,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { sendPickedFiles } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Every line carries bytes that differ between UTF-8 and windows-1252:
// accented vowels (2 bytes) and an em dash (3 bytes). Six lines — one
// past the paste hard cap of five — so the guard's affirmative IS the
// upload door (#816).
const LINES = 6;
const accentedBlock = (tag: string): string =>
  Array.from(
    { length: LINES },
    (_, i) => `${tag} riga ${i} — perché è così, più o meno: àèìòù`,
  ).join("\n");

// Same paste driver as issue80-paste-flood-guard: a real ClipboardEvent
// with a real DataTransfer, so the production onPaste handler runs.
async function pasteText(page: Page, text: string): Promise<void> {
  await composeTextarea(page).evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, text);
}

test("#1256 — a pasted UTF-8 block uploads labelled and renders with its accents intact", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "shares the upload plumbing the uploads specs gate to chromium",
  );
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");

  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

  // Pre-ack the embedded-host privacy modal so the upload runs
  // unattended (that flow is covered by ux-6-b-embedded-upload).
  await page.evaluate(() =>
    localStorage.setItem("image-upload-privacy-acknowledged:embedded", "1"),
  );

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();

  const tag = crypto.randomUUID().slice(0, 8);
  const block = accentedBlock(tag);

  await pasteText(page, block);
  await expect(confirmModal(page)).toBeVisible();

  // Over the cap the upload IS the affirmative. Race the click against
  // the POST so the 201 is pinned before we chase the served bytes.
  // #1883 — the POST can no longer be raced against the paste affirmative:
  // that door now opens the send-confirm, and nothing dispatches until Send.
  // Arm the waiter first, then walk both dialogs.
  const uploadPost = page.waitForResponse(
    (r) => r.url().includes("/api/uploads") && r.request().method() === "POST",
    { timeout: 20_000 },
  );
  await confirmModalYes(page);
  await sendPickedFiles(page);
  const uploadRes = await uploadPost;

  // Pre-fix this is a 415: the labelled File was refused at the door.
  expect(uploadRes.status()).toBe(201);
  const { url } = (await uploadRes.json()) as { slug: string; url: string };

  // Navigate the way a recipient clicking the link does. Path-only, so
  // the assertion does not depend on Endpoint.url() matching the
  // browser's origin in this stack.
  const path = new URL(url).pathname;
  const served = await page.goto(path);

  expect(served?.status()).toBe(200);
  expect(served?.headers()["content-type"]).toBe("text/plain; charset=utf-8");

  // The visible outcome. Unlabelled, this body reads `perchÃ©` /
  // `Ã¨` / `â€”` in a Western-locale browser.
  const rendered = await page.locator("body").innerText();
  expect(rendered).toContain("perché è così, più o meno: àèìòù");
  expect(rendered).toContain("—");
  expect(rendered).toContain(`${tag} riga ${LINES - 1}`);
  // Negative control: no windows-1252 misread survived anywhere in the
  // document. `Ã` cannot occur in the pasted text, so its presence
  // means exactly one thing.
  expect(rendered).not.toContain("Ã");
});
