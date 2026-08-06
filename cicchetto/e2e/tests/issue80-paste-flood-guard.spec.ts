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
  confirmModalBody,
  confirmModalCancel,
  confirmModalYes,
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
