// issue 2611 — the FEATURE flow, end to end, through the real send path.
//
// The sibling spec (`issue2611-speech-api-does-not-kill-the-page`) pins the
// BLOCKER and rightly refuses to stub the engine: the crash lived inside the
// browser's own implementation, and a fake would not have it. That argument is
// about the crash. Everything else — the press, the segment, the prefix, the
// stop control, the send that lands in the channel — is OUR code, and a
// `page.addInitScript` fake runs it end to end.
//
// What the fake does is what the spec says the real engine does: `available()`
// answers `"available"`, `start()` begins a session, and a final result arrives
// as a `result` event. `stop()` finalises: it answers `onend` and nothing else,
// which is the ordinary "say a sentence, tap stop" gesture.
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const OTHER_CHANNEL = AUTOJOIN_CHANNELS[1];

// The page's handle on the fake, so the spec can make it say something.
type SpeechPage = {
  __speechEngine: { started: number; stopped: number } | null;
  __speechSay: (text: string) => void;
};

/** Installs the fake before any page script runs. */
async function installFakeEngine(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler = ((event: unknown) => void) | null;
    class FakeRecognition {
      static available = async () => "available";
      static install = async () => true;
      lang = "";
      continuous = false;
      interimResults = false;
      processLocally = false;
      onresult: Handler = null;
      onerror: Handler = null;
      onend: Handler = null;
      started = 0;
      stopped = 0;
      start(): void {
        this.started += 1;
      }
      stop(): void {
        this.stopped += 1;
        // The engine finalises and says it is done; the words already arrived
        // as `result` events, which is what `onresult` above carries.
        this.onend?.(undefined);
      }
      abort(): void {
        this.onend?.(undefined);
      }
    }
    const scope = window as unknown as SpeechPage & { SpeechRecognition?: unknown };
    scope.SpeechRecognition = FakeRecognition;
    scope.__speechEngine = null;
    // `startDictation` constructs the engine itself: this is where the spec
    // gets its handle on the instance the app is talking to.
    const RealCtor = FakeRecognition;
    scope.SpeechRecognition = class extends RealCtor {
      constructor() {
        super();
        scope.__speechEngine = this as unknown as SpeechPage["__speechEngine"];
      }
    };
    scope.__speechSay = (text: string) => {
      const engine = scope.__speechEngine as unknown as {
        onresult: ((event: unknown) => void) | null;
      } | null;
      engine?.onresult?.({
        resultIndex: 0,
        results: [{ isFinal: true, 0: { transcript: text } }],
      });
    };
  });
}

test.describe("issue 2611 — dictating a line, end to end", () => {
  test("a press, a spoken segment and a stop put a 🔊 row in the channel", async ({ page }) => {
    const vjt = specUser();
    await installFakeEngine(page);
    await loginAs(page, vjt);
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    // The probe asks the engine on the first gesture (the login and the window
    // click above), so the microphone is in the send slot by now.
    const mic = page.getByTestId("compose-mic");
    await expect(mic).toBeVisible({ timeout: 10_000 });
    await expect(mic).toHaveAttribute("aria-label", "dictate");

    // The press starts the session and the control turns into stop-and-send.
    await mic.click();
    await expect(mic).toHaveAttribute("aria-label", "stop dictating and send");
    await expect
      .poll(() => page.evaluate(() => (window as unknown as SpeechPage).__speechEngine?.started))
      .toBe(1);

    // The operator says a sentence; the engine finalises it.
    await page.evaluate(() => (window as unknown as SpeechPage).__speechSay("ciao a tutti"));
    await expect(page.getByTestId("compose-dictation")).toBeVisible();

    // The stop finalises and sends: the segment is its own message, prefixed,
    // and it never went through the draft.
    await mic.click();
    await expect(mic).toHaveAttribute("aria-label", "dictate");

    await expect(
      page.locator('[data-testid="scrollback-line"]').filter({ hasText: "🔊 ciao a tutti" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByLabel("compose message")).toHaveValue("");

    // And it is on the wire, through the same dispatch a typed line takes.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: CHANNEL,
      sender: specNick(),
      body: "🔊 ciao a tutti",
    });
  });

  test("a window switch mid-session stops it, and its words go nowhere", async ({ page }) => {
    await installFakeEngine(page);
    await loginAs(page, specUser());
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });

    const mic = page.getByTestId("compose-mic");
    await expect(mic).toBeVisible({ timeout: 10_000 });
    await mic.click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as SpeechPage).__speechEngine?.started))
      .toBe(1);

    // The compose box is ONE component whose props follow the selection: a
    // switch does not remount it, so the session has to be ended by hand —
    // otherwise every segment said in a private query goes out in whatever
    // channel is open next.
    await selectChannel(page, NETWORK_SLUG, OTHER_CHANNEL);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as SpeechPage).__speechEngine?.stopped))
      .toBe(1);

    // Words the engine had already handed over reach nobody.
    await page.evaluate(() => (window as unknown as SpeechPage).__speechSay("parole private"));
    await expect(
      page.locator('[data-testid="scrollback-line"]').filter({ hasText: "🔊 parole private" }),
    ).toHaveCount(0);
  });
});
