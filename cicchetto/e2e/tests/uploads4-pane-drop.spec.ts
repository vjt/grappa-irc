// uploads-4 (#351) — whole-message-pane drag-and-drop upload.
//
// #351 hoisted the file-drop target from the compose box up to the whole
// conversation pane: `DropUploadZone` (Shell) wraps ScrollbackPane +
// ComposeBox, so a file dropped anywhere over the messages uploads exactly
// as a drop on the compose strip did before. Before #351 a file dropped
// over the scrollback — the large part of the screen — did nothing; the
// operator had to aim at the small compose box.
//
// This is a real browser drag-and-drop feature, so a Chromium e2e is the
// right gate (per feedback_ux_e2e_mandatory + the issue): vitest jsdom has
// no DataTransfer/DragEvent and can't follow the multipart → auto-send →
// IRC-echo chain. Chromium constructs DataTransfer + DragEvent (same as
// issue80's paste spec), so we build a genuine file drag in-page and
// dispatch dragenter/dragover/drop on the `.scrollback` scroller — proving
// the SCROLLBACK, not just the compose box, is the drop target.
//
// Desktop-scoped: drag-and-drop of an OS file is a pointer/desktop
// interaction (there is no file drag on a phone), and WebKit's programmatic
// DragEvent/DataTransfer construction is unreliable. The mobile Shell branch
// wires the SAME DropUploadZone component (tsc-checked); the browser
// behaviour is asserted once, on the browser where it is a real gesture.

import { expect, test } from "../fixtures/test";
import { TINY_PNG_HEX } from "../fixtures/bytes";
import { loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Dispatch a genuine file drag of `type` on the element, carrying a PNG
// decoded from the shared hex fixture. A fresh DataTransfer per call (the
// object cannot survive across page.evaluate boundaries); Chromium populates
// `dataTransfer.types` with "Files" when a file item is added, so the
// production `dragHasFiles` guard engages exactly as a real OS drag would.
async function fireFileDrag(
  scrollback: ReturnType<typeof scrollbackLine>,
  type: "dragenter" | "dragover" | "drop",
): Promise<void> {
  await scrollback.evaluate((el, { hex, evType }) => {
    const bytes = Uint8Array.from((hex.match(/../g) ?? []).map((h) => Number.parseInt(h, 16)));
    const file = new File([bytes], "dropped-on-scrollback.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    el.dispatchEvent(
      new DragEvent(evType, { bubbles: true, cancelable: true, dataTransfer: dt }),
    );
  }, { hex: TINY_PNG_HEX, evType: type });
}

test("uploads-4 #351 — a file dropped over the SCROLLBACK uploads (whole pane is the drop target)", async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName !== "chromium",
    "drag-and-drop of an OS file is a desktop-pointer feature; WebKit programmatic DragEvent/DataTransfer is unreliable",
  );
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Pre-ack the embedded-host privacy modal so the upload runs unattended
  // (the modal flow is covered by ux-6-b-embedded-upload).
  await page.evaluate(() =>
    localStorage.setItem("image-upload-privacy-acknowledged:embedded", "1"),
  );

  const scrollback = page.locator(".scrollback");
  await expect(scrollback).toBeVisible();

  // A FILE drag entering the scrollback arms the "Drop to upload" overlay —
  // the pane, not the compose strip, is now the affordance.
  await fireFileDrag(scrollback, "dragenter");
  await fireFileDrag(scrollback, "dragover");
  await expect(page.getByText("Drop to upload")).toBeVisible();

  // Dropping the file over the scrollback uploads it and clears the overlay.
  await fireFileDrag(scrollback, "drop");
  await expect(page.getByText("Drop to upload")).toHaveCount(0);

  // The upload → auto-send → IRC echo lands a 📸 PRIVMSG carrying the
  // bytes-access URL. Reverting #351 (drop only on the compose box) reds
  // this: the scrollback drop would do nothing at all.
  const rows = scrollbackLine(page, "privmsg", "📸");
  await expect.poll(async () => await rows.count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(1);
});
