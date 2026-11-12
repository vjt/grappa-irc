// issue 2611 — the BLOCKER the delta-2 review measured, as an e2e.
//
// Mounting a compose box in a browser that HAS the speech API asked the
// engine from the mount path (`available()`, and `install()` for a
// downloadable model), and in headless Chromium that native call took the
// renderer down: 75 of 75 shard-4 failures were pages that closed 78–266 ms
// after a tap, none of them with a snapshot to look at. Moving the question to
// the operator's first gesture did not save the page either — measured on
// 81bbdfe58 (run 43092659314), all four e2e shards hung on their first gesture
// and were cancelled at the 60-minute timeout. The call is the defect, not the
// moment it is made.
//
// So the page refuses to ask a driven browser at all (`checkDictation` returns
// false under `navigator.webdriver`; the dictation-flow spec lifts that gate
// with a fake engine to run the feature). What this spec pins is that refusal:
// open a channel window in a browser that HAS the API, give it the gesture
// that used to kill it, and the page is still there, the box still there, and
// the native engine was never asked.
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];

type Spy = { asked: number };

test.describe("issue 2611 — a compose box in a browser with the speech API", () => {
  test("opening a channel window leaves the page alive, and asks the engine nothing", async ({
    page,
  }) => {
    // Counts the calls the page makes into the browser's own engine. The
    // wrapper is ours; the engine under it is not.
    await page.addInitScript(() => {
      const scope = window as unknown as {
        SpeechRecognition?: { available?: unknown };
        webkitSpeechRecognition?: { available?: unknown };
        __speechAsked: Spy;
      };
      scope.__speechAsked = { asked: 0 };
      for (const ctor of [scope.SpeechRecognition, scope.webkitSpeechRecognition]) {
        if (ctor === undefined || typeof ctor.available !== "function") continue;
        const native = ctor.available as (...args: unknown[]) => unknown;
        ctor.available = (...args: unknown[]) => {
          scope.__speechAsked.asked += 1;
          return native.apply(ctor, args);
        };
      }
    });

    await loginAs(page, specUser());

    // Read from the page, never stubbed: the crash lived inside the browser's
    // own implementation, and a stub would not have it.
    const hasApi = await page.evaluate(
      () => "SpeechRecognition" in window || "webkitSpeechRecognition" in window,
    );
    test.skip(!hasApi, "this browser has no SpeechRecognition: nothing native to ask");

    await selectChannel(page, NETWORK_SLUG, CHANNEL);

    // A gesture, as a human gives one: this is what asks the engine in a
    // browser that is not driven.
    const compose = page.getByLabel("compose message");
    await compose.click();
    // The probe's native call and the window the crash was measured in.
    await page.waitForTimeout(1_000);

    // Alive, and the box still there. A crashed renderer answers neither.
    expect(page.isClosed()).toBe(false);
    await expect(compose).toBeVisible();
    // And the engine was never asked: the refusal is what keeps the page up.
    expect(
      await page.evaluate(() => (window as unknown as { __speechAsked: Spy }).__speechAsked),
    ).toEqual({ asked: 0 });
    // One control in the send slot: the paper plane, because a driven browser
    // is never offered the microphone.
    await expect(page.locator('.compose-box button[aria-label="send message"]')).toHaveCount(1);
  });
});
