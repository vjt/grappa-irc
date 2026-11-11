// issue 2611 — the BLOCKER the delta-2 review measured, as an e2e.
//
// Mounting a compose box in a browser that HAS the speech API asked the
// engine from the mount path (`available()`, and `install()` for a
// downloadable model), and in headless Chromium that native call took the
// renderer down: 75 of 75 shard-4 failures were pages that closed 78–266 ms
// after a tap, none of them with a snapshot to look at. The vitest arms can
// only see the JS around the call — the question is now armed by the mount and
// asked from the operator's first gesture — and a fake `SpeechRecognition`
// installed in the page could not reproduce a crash inside the real one. This
// is the spec that opens a channel window in a browser with the API present
// and then asks the page whether it is still there.
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.describe("issue 2611 — a compose box in a browser with the speech API", () => {
  test("opening a channel window leaves the page alive, with its compose box", async ({ page }) => {
    await loginAs(page, specUser());

    // Read from the page, never stubbed: the crash lived inside the browser's
    // own implementation, and a stub would not have it.
    const hasApi = await page.evaluate(
      () => "SpeechRecognition" in window || "webkitSpeechRecognition" in window,
    );
    test.skip(!hasApi, "this browser has no SpeechRecognition: nothing native to ask");

    await selectChannel(page, NETWORK_SLUG, CHANNEL);

    // A gesture, as a human gives one: this is what asks the engine now.
    const compose = page.getByLabel("compose message");
    await compose.click();
    // The probe's native call and the window the crash was measured in.
    await page.waitForTimeout(1_000);

    // Alive, and the box still there. A crashed renderer answers neither.
    expect(page.isClosed()).toBe(false);
    await expect(compose).toBeVisible();
    // One control in the send slot: the paper plane, or the microphone if the
    // engine answered that it can dictate on device (a headless Chromium with
    // no speech model does not, and its answer is what the probe decides).
    await expect(
      page.locator(
        '.compose-box button[aria-label="send message"], .compose-box [data-testid="compose-mic"]',
      ),
    ).toHaveCount(1);
  });
});
