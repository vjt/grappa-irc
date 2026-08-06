// #80 — multi-line paste flood guard.
//
// A multi-line paste into the compose box becomes one PRIVMSG per line on
// submit (compose.ts → messageLines.ts), so a pasted block can flood a
// channel. Any paste that becomes MORE THAN ONE MESSAGE is intercepted and an
// explicit confirm dialog opens BEFORE the text lands, stating how many
// messages it will become; Cancel drops it (the safe default), the "Paste"
// button inserts it + refocuses the textarea. A one-message paste stays
// frictionless (no dialog).
//
// #816 replaced #80's >3-line carve-out with that rule, and moved the quoted
// number from lines to messages — see lib/pasteFlood.
//
// The guard reuses the store-driven confirm dialog (ConfirmModal.tsx /
// lib/confirmDialog) — no new modal — so it inherits the overlay scroll-lock,
// the #232 shared Esc-to-close, and the Cancel-is-safe default for free.
//
// vitest (ComposeBox.test.tsx + pasteFlood.test.ts) proves the threshold
// boundary + the store wiring in jsdom; this spec is the real-browser proof
// that the modal actually RENDERS, that the affirmative button lands the text
// in a live compose box, and that Cancel gates it — the render/focus that
// jsdom cannot show. A real ClipboardEvent + DataTransfer (both constructible
// in chromium) drives the production onPaste handler deterministically.

import { expect, test } from "../fixtures/test";
import {
  composeTextarea,
  confirmModal,
  confirmModalAlternative,
  confirmModalBody,
  confirmModalCancel,
  confirmModalYes,
  scrollbackLine,
  loginAs,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import type { Page } from "@playwright/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Dispatch a real ClipboardEvent "paste" carrying `text` into the compose
// textarea. Chromium constructs ClipboardEvent + DataTransfer, so this fires
// the production onPaste handler with a genuine text payload — the same path a
// real Ctrl+V takes, minus the OS-clipboard permission dance (which is flaky
// in CI). preventDefault in the handler suppresses the (untrusted-event)
// native insert regardless, so the confirm branch is the only one that lands
// text — exactly what we assert.
async function pasteText(page: Page, text: string): Promise<void> {
  await composeTextarea(page).evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData("text/plain", t);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }),
    );
  }, text);
}

test("#80 — multi-line paste: dialog opens, Cancel drops it, Paste inserts it", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();
  await expect(ta).toHaveValue("");

  // 4 messages → guarded.
  const block = "riga uno\nriga due\nriga tre\nriga quattro";

  // Paste → confirm dialog with the interpolated message count + channel name.
  // The text has NOT landed yet — the guard holds it back.
  await pasteText(page, block);
  await expect(confirmModal(page)).toBeVisible();
  await expect(confirmModalBody(page)).toContainText("4");
  await expect(confirmModalBody(page)).toContainText(CHANNEL);
  await expect(ta).toHaveValue("");

  // Cancel (the safe default) → modal dismisses, textarea stays empty (no
  // flood). Reverting the guard (native paste) reds this half.
  await confirmModalCancel(page);
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(ta).toHaveValue("");

  // Paste again → the affirmative "Paste" button → the block lands verbatim
  // and focus returns to the textarea so the operator can edit / send.
  await pasteText(page, block);
  await expect(confirmModal(page)).toBeVisible();
  await confirmModalYes(page);
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(ta).toHaveValue(block);
  await expect(ta).toBeFocused();
});

test("#816 — a one-message paste is frictionless; two messages already guard", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();

  // One message, with the trailing newline a copy leaves behind → NO dialog.
  // That artifact is why the guard counts messages and not lines: as lines
  // this is two, and it would have cost a dialog for nothing.
  await pasteText(page, "riga unica\n");
  await expect(confirmModal(page)).toHaveCount(0);

  // Positive control: TWO messages already open the dialog. Proves the guard
  // is live in this browser, so the no-op above is a real frictionless pass
  // and not a dead handler that never fires — and pins the #816 boundary at
  // 2, where #80 had it at 4.
  await pasteText(page, "riga uno\nriga due");
  await expect(confirmModal(page)).toBeVisible();
});

// #816 — the hard cap and its second door.
//
// Above the ceiling the block never enters the composer at all. Refusing
// outright was rejected: the operator gets upload-as-file (the text becomes a
// text/plain File on the existing upload path, and the URL is posted as one
// 📄 PRIVMSG instead of N) or cancel.
//
// The end of that chain — multipart POST, auto-send, IRC echo — is exactly
// what jsdom cannot follow (ComposeBox.test.tsx can only assert that
// `triggerUploads` was called with the right File), so this is the gate that
// proves the reuse actually reuses: a text paste really does traverse the
// image-upload plumbing and come back as a link in the channel.
test("#816 — a paste over the hard cap uploads as a file instead of flooding", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "shares the upload plumbing gated to chromium by the uploads specs; the paste half is browser-agnostic and covered above",
  );
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Pre-ack the embedded-host privacy modal so the upload runs unattended
  // (that flow is covered by ux-6-b-embedded-upload).
  await page.evaluate(() =>
    localStorage.setItem("image-upload-privacy-acknowledged:embedded", "1"),
  );

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();
  await expect(ta).toHaveValue("");

  // Six messages — one past the ceiling of five.
  const tag = crypto.randomUUID().slice(0, 8);
  const block = Array.from({ length: 6 }, (_, i) => `over ${tag} riga ${i}`).join("\n");

  await pasteText(page, block);
  await expect(confirmModal(page)).toBeVisible();
  // Both numbers, so the operator knows what would fit.
  await expect(confirmModalBody(page)).toContainText("6");
  await expect(confirmModalBody(page)).toContainText("5");
  // No third door up here: the paste door is exactly what the cap closed, so
  // uploading IS the affirmative. Two buttons, not three.
  await expect(confirmModalAlternative(page)).toHaveCount(0);

  // Cancel first: the safe default drops the paste with no upload and no
  // text in the box. Asserted before the affirmative so a handler that
  // uploaded unconditionally could not pass this spec.
  await confirmModalCancel(page);
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(ta).toHaveValue("");

  // The second door. The block must NOT land in the composer — it goes out
  // as one 📄-prefixed link instead of six frames.
  await pasteText(page, block);
  await expect(confirmModal(page)).toBeVisible();
  await confirmModalYes(page);
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(ta).toHaveValue("");

  const rows = scrollbackLine(page, "privmsg", "📄");
  await expect.poll(async () => await rows.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);

  // And the burst never happened: none of the pasted lines went to the
  // channel as its own message. Without this, an implementation that
  // uploaded AND pasted would still be green above.
  await expect(scrollbackLine(page, "privmsg", `over ${tag} riga 0`)).toHaveCount(0);
});

// #816, vjt's ruling (2026-08-06) — the .txt upload is a CHOICE, not a
// punishment.
//
// Before the ruling this door existed only ABOVE the hard cap: the operator
// had to be REFUSED before being told there was another way. The ruling makes
// it an alternative offered on every guarded paste, so a block of four lines
// — perfectly sendable as a burst — can still go out as one link if that is
// what the operator prefers.
//
// jsdom (ComposeBox.test.tsx) can only assert that the request CARRIES an
// alternative and that firing the store verb calls triggerUploads. This is
// the gate that proves the button RENDERS as a third choice beside the other
// two and that picking it drives the whole upload chain to a link in the
// channel, with the paste door still there and still working.
test("#816 — an under-cap paste offers the .txt upload beside Paste, and it works", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "shares the upload plumbing gated to chromium by the uploads specs",
  );
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Pre-ack the embedded-host privacy modal so the upload runs unattended
  // (that flow is covered by ux-6-b-embedded-upload).
  await page.evaluate(() =>
    localStorage.setItem("image-upload-privacy-acknowledged:embedded", "1"),
  );

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();
  await expect(ta).toHaveValue("");

  // FOUR messages — well under the ceiling of five, i.e. a paste the guard
  // would happily let through. That is the whole point: the door is open
  // before any refusal.
  const tag = crypto.randomUUID().slice(0, 8);
  const block = Array.from({ length: 4 }, (_, i) => `under ${tag} riga ${i}`).join("\n");

  await pasteText(page, block);
  await expect(confirmModal(page)).toBeVisible();
  await expect(confirmModalBody(page)).toContainText("4");
  // Three doors, not two: the affirmative still pastes, and the alternative
  // is a peer choice next to it. A build that kept the .txt door cap-only
  // reds right here.
  const alt = confirmModalAlternative(page);
  await expect(alt).toBeVisible();
  await expect(alt).toHaveText("Upload as .txt");

  // Cancel first — the safe default still fires NEITHER door. Asserted before
  // the alternative so a handler that uploaded unconditionally cannot pass.
  await confirmModalCancel(page);
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(ta).toHaveValue("");

  // Now take the third door: the block leaves as one 📄-prefixed link and
  // never enters the composer.
  await pasteText(page, block);
  await expect(confirmModal(page)).toBeVisible();
  await confirmModalAlternative(page).click();
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(ta).toHaveValue("");

  const rows = scrollbackLine(page, "privmsg", "📄");
  await expect.poll(async () => await rows.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
  // The burst never happened — an implementation that uploaded AND pasted
  // would still be green above.
  await expect(scrollbackLine(page, "privmsg", `under ${tag} riga 0`)).toHaveCount(0);

  // …and the paste door is still a door: the same block, confirmed, lands in
  // the composer verbatim. The alternative ADDED a choice, it did not replace
  // the affirmative.
  await pasteText(page, block);
  await expect(confirmModal(page)).toBeVisible();
  await confirmModalYes(page);
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(ta).toHaveValue(block);
});
