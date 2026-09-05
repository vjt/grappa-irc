// 1883 — a gallery pick asks before it publishes.
//
// The defect: picking a file reached the wire with nothing in between.
// `onPickerChange` handed `input.files` straight to `triggerUploads`, and the
// only gate — the privacy modal — is one-shot per host, so for every operator
// who had ever ticked "remember" the sequence was tap paperclip -> tap photo
// -> it is public. On a phone the gallery grid is dense; a mis-tap picks the
// wrong photo and there is no undo.
//
// Why this has to be a real browser and not jsdom: the thing under test is
// whether an upload HAPPENS, and the only honest witness to that is the
// network. Every assertion here is either a POST counter over the real
// same-origin `/api/uploads` or a row that actually landed in scrollback
// after the IRC echo. A jsdom test can prove the orchestrator was not called;
// it cannot prove nothing left the machine.
//
// The counter pattern (and its positive control) is the one ux-6-b-embedded
// established: a same-origin `page.route()` stub would block cic's own
// bootstrap, so requests are counted instead, and a zero is only evidence
// once the SAME predicate has been shown to count a real upload.

import type { Page } from "@playwright/test";
import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { setUploadConfirmEnabled } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { EMBEDDED_MODAL_HEADING, sendPickedFiles } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

const png = (name: string) => ({
  name,
  mimeType: "image/png",
  buffer: Buffer.from(TINY_PNG_HEX, "hex"),
});

const txt = (name: string) => ({
  name,
  mimeType: "text/plain",
  buffer: Buffer.from("1883\n", "utf8"),
});

// Count real POSTs to the embedded upload host. Returns a reader, so the
// assertion sites read as `uploads()` rather than a mutable let.
function countUploadPosts(page: Page): () => number {
  let hits = 0;
  page.on("request", (req) => {
    if (req.method() === "POST" && req.url().endsWith("/api/uploads")) hits += 1;
  });
  return () => hits;
}

// The privacy modal is one-shot per host and is NOT what this spec is about;
// pre-acking it puts the browser in the exact state of the returning operator
// the issue describes — the one for whom nothing at all stood in the way.
async function asReturningOperator(page: Page): Promise<void> {
  // #1883 — the confirm is an OPT-IN setting now, default OFF. This whole
  // spec is ABOUT the confirm, so the operator it describes has opted in;
  // without this every case here would assert a dialog that never opens.
  await setUploadConfirmEnabled(specUser().token, true);
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await page.evaluate(() =>
    localStorage.setItem("image-upload-privacy-acknowledged:embedded", "1"),
  );
}

test("1883 — the returning operator is asked, and Cancel publishes nothing", async ({ page }) => {
  const uploads = countUploadPosts(page);
  await asReturningOperator(page);

  await page.locator("input[data-file-picker]").setInputFiles(png("gallery-mistap.png"));

  // The confirm shows WHAT is about to be sent and WHERE. This is the whole
  // cure: a mis-tap is only recoverable if the operator can see it is one.
  const confirm = page.getByTestId("confirm-modal");
  await expect(confirm).toBeVisible({ timeout: 5_000 });
  await expect(confirm).toContainText("gallery-mistap.png");
  // The destination is named, and it is the dialog's accessible name — the
  // one string a screen reader announces on open.
  await expect(confirm).toHaveAttribute("aria-label", `Send to ${CHANNEL}?`);
  // An image previews as a picture, from the operator's own bytes.
  const thumb = page.getByTestId("confirm-modal-attachment-thumb");
  await expect(thumb).toHaveAttribute("src", /^blob:/);
  // And it DECODED. The `src` above is set by cic and says nothing about what
  // the browser did with it: measured on this very stack, the prod CSP's
  // `img-src` refused the object URL (`blockedURI: blob`) and the row rendered
  // an empty box with the attribute intact — green here, broken on screen, in
  // the one dialog whose entire job is showing WHICH photo. `naturalWidth`
  // is the same witness `media-link-cross-host-modal` uses for the #1240
  // widening, and it is what a CSP revert has to red on.
  await expect
    .poll(() => thumb.evaluate((el) => (el as HTMLImageElement).naturalWidth), { timeout: 5_000 })
    .toBeGreaterThan(0);

  await page.getByTestId("confirm-modal-cancel").click();
  await expect(confirm).toBeHidden({ timeout: 5_000 });

  // Nothing went anywhere: no POST, and the privacy modal — the next step in
  // the old journey — never opened either.
  await page.waitForTimeout(500);
  expect(uploads()).toBe(0);
  await expect(page.getByRole("dialog", { name: EMBEDDED_MODAL_HEADING })).toHaveCount(0);
  await expect(scrollbackLine(page, "privmsg", "📸")).toHaveCount(0);

  // POSITIVE CONTROL, deliberately after the zero. A mistyped path, a
  // `.endsWith` that stopped matching after a route change, or a listener on
  // the wrong page all leave the counter at 0 with the guard broken — green in
  // both worlds. Drive the same journey to Send: the real POST goes through
  // the very predicate asserted empty above, so a blind counter reds here.
  await page.locator("input[data-file-picker]").setInputFiles(png("control.png"));
  await sendPickedFiles(page);
  await expect.poll(uploads, { timeout: 15_000 }).toBe(1);
  await expect(scrollbackLine(page, "privmsg", "📸").first()).toBeVisible({ timeout: 15_000 });
});

test("1883 — a removed file is not sent; the rest of the batch is", async ({ page }) => {
  const uploads = countUploadPosts(page);
  await asReturningOperator(page);

  // Two files, one image and one document, so the row rendering is exercised
  // on BOTH shapes: a thumbnail for the picture, name + size for the text.
  await page.locator("input[data-file-picker]").setInputFiles([png("keep.png"), txt("drop.txt")]);

  await expect(page.getByTestId("confirm-modal-attachment")).toHaveCount(2);
  // The non-image row carries no picture — it is named and sized instead.
  await expect(page.getByTestId("confirm-modal-attachment-thumb")).toHaveCount(1);
  await expect(page.getByTestId("confirm-modal-attachments")).toContainText("drop.txt");

  await page.getByRole("button", { name: /remove drop\.txt/i }).click();
  await expect(page.getByTestId("confirm-modal-attachment")).toHaveCount(1);
  await expect(page.getByTestId("confirm-modal-attachments")).not.toContainText("drop.txt");
  // Removing a file is not answering the question — the dialog is still up.
  await expect(page.getByTestId("confirm-modal")).toBeVisible();

  await sendPickedFiles(page);

  // Exactly ONE upload: the kept file. The batch counter would have shown
  // "(1/2)" and posted twice if the removal had only hidden a row.
  await expect.poll(uploads, { timeout: 20_000 }).toBe(1);
  await expect(scrollbackLine(page, "privmsg", "📸").first()).toBeVisible({ timeout: 15_000 });
  // Settle: give a second POST every chance to appear before claiming there
  // was none. Without this the `toBe(1)` above could simply be early.
  await page.waitForTimeout(1_000);
  expect(uploads()).toBe(1);
});

test("1883 — removing the last file closes the dialog and uploads nothing", async ({ page }) => {
  const uploads = countUploadPosts(page);
  await asReturningOperator(page);

  await page.locator("input[data-file-picker]").setInputFiles(png("only.png"));
  await expect(page.getByTestId("confirm-modal-attachment")).toHaveCount(1);

  await page.getByRole("button", { name: /remove only\.png/i }).click();

  // An empty dialog asking "send these?" has nothing to affirm, so it closes —
  // the same answer as Cancel, reached a different way.
  await expect(page.getByTestId("confirm-modal")).toBeHidden({ timeout: 5_000 });
  await page.waitForTimeout(500);
  expect(uploads()).toBe(0);

  // POSITIVE CONTROL — same counter, same page, a journey that must count.
  await page.locator("input[data-file-picker]").setInputFiles(png("control.png"));
  await sendPickedFiles(page);
  await expect.poll(uploads, { timeout: 15_000 }).toBe(1);
});
