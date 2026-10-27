// issue 2467 — on iOS, the click that opens the file panel lets go of the
// compose focus.
//
// The reported defect is device-only: after a file upload on an iPhone, the
// compose row came back up under the keyboard's accessory bar. WebKit's file
// panel resigns the web view's first responder when its attach menu shows,
// without blurring the element, and keepKeyboard's mousedown arm had held the
// compose focused across the paperclip tap. So the compose was left focused
// with no keyboard under it, and the keyboard then came back without the fresh
// focus every earlier appearance had started from. What a page can do about it
// is release the focus on the click that opens the panel, and that release is
// what this measures, on a real engine, together with the panel still opening
// after it.
//
// 🔴 WHAT THIS SPEC IS NOT: it does not see the accessory bar, the keyboard or
// how the keyboard comes back. No project here has them: chromium is not iOS,
// and Playwright's webkit is not UIKit. That half is checked on the phone.
//
// Why `chromium-pixel-touch` with an iPhone user agent, and not
// `webkit-iphone-15`: the release sits behind isIos(), and the stale focus
// came from keepKeyboard's MOUSEDOWN arm, which only a tap that synthesises
// compat mouse events reaches. On webkit-iphone-15 a `tap()` dispatches no
// mousedown and no click at all (measured in
// issue1831-tap-send-modal-survives.spec.ts), so the paperclip would not even
// open the panel there. The user agent turns isIos() on and leaves chromium's
// tap pipeline alone. `html.is-ios` is asserted first, so a user agent that
// did not take reads as red, not as a pass.

import { TINY_PNG_HEX } from "../fixtures/bytes";
import { composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";
import { mediaScrollbackRow } from "../fixtures/uploadJourney";

const CHANNEL = AUTOJOIN_CHANNELS[0];

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

test.use({ userAgent: IPHONE_UA });

test("@touch issue 2467 — tapping the paperclip opens the file panel and leaves the compose unfocused", async ({
  page,
}) => {
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  // The privacy notice is one-shot per host and is not what this is about.
  await page.evaluate(() =>
    localStorage.setItem("image-upload-privacy-acknowledged:embedded", "1"),
  );

  // isIos() is on, or nothing below is about the iOS path.
  await expect(page.locator("html")).toHaveClass(/\bis-ios\b/);

  const ta = composeTextarea(page);
  await ta.tap();
  await expect(ta).toBeFocused();

  const chooserOpened = page.waitForEvent("filechooser", { timeout: 5_000 });
  await page.getByRole("button", { name: /upload file/i }).tap();
  const chooser = await chooserOpened;
  // The compose's own picker, not some other file input.
  expect(chooser.isMultiple()).toBe(true);

  // BODY, not merely "not the compose". Without keepKeyboard's mousedown arm,
  // chromium would move the focus to the paperclip button on the tap and the
  // compose would be unfocused for a reason that has nothing to do with this
  // fix. With the arm and without the fix, the compose stays focused.
  await expect
    .poll(() => page.evaluate(() => document.activeElement === document.body), {
      timeout: 2_000,
    })
    .toBe(true);

  // The pick still reaches the upload after the release: the chooser's files
  // arrive on the input's `change` and the row lands. A journey check, not
  // evidence for the release itself.
  await chooser.setFiles({
    name: "issue2467.png",
    mimeType: "image/png",
    buffer: Buffer.from(TINY_PNG_HEX, "hex"),
  });
  await mediaScrollbackRow(page, "📸", ".png");
});
