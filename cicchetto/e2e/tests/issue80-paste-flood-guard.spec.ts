// #80 — multi-line paste flood guard.
//
// A multi-line paste into the compose box becomes one PRIVMSG per line on
// submit (compose.ts → messageLines.ts), so a big pasted block can flood a
// channel. Above a small line threshold (>3 lines) the paste is intercepted
// and an explicit confirm dialog opens BEFORE the text lands; Cancel drops it
// (the safe default), the "Paste" button inserts it + refocuses the textarea.
// At/below the threshold the paste stays frictionless (no dialog).
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

  // 4 lines > threshold (3) → guarded.
  const block = "riga uno\nriga due\nriga tre\nriga quattro";

  // Paste → confirm dialog with the interpolated line count + channel name.
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

test("#80 — a short (≤3-line) paste is frictionless; a longer one still guards", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();

  // 3 lines == threshold → NO dialog (frictionless).
  await pasteText(page, "riga uno\nriga due\nriga tre");
  await expect(confirmModal(page)).toHaveCount(0);

  // Positive control: a 4-line paste DOES open the dialog. Proves the guard
  // is live in this browser, so the 3-line no-op above is a real frictionless
  // pass — not a dead handler that never fires.
  await pasteText(page, "a\nb\nc\nd");
  await expect(confirmModal(page)).toBeVisible();
});
