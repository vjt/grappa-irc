// #66 — mobile virtual-keyboard overlaps the message list. On iOS the
// on-screen keyboard slides over the bottom of the scrolled scrollback,
// covering the latest messages (and, the reporter feared, the composer),
// forcing a re-scroll after every focus. The fix the issue asks for has
// two facets:
//
//   (1) LAYOUT — the message list + composer shrink to the reduced
//       VISIBLE region so the composer never sits behind the keyboard.
//   (2) SCROLL ANCHOR — the scrollback re-pins to the bottom when the
//       visible region shrinks, so the latest messages stay in view.
//
// This spec asserts the CSS+JS CONTRACT for both under a SIMULATED
// keyboard, NOT real iOS keyboard physics. Playwright webkit has no OS
// keyboard, so it cannot shrink the real `window.visualViewport`; we
// mirror what `lib/viewportHeight.ts:installViewportHeightTracker`
// writes from `vv.height` on a real device — both `--viewport-height`
// AND `--vh` — and dispatch the `visualViewport` `resize` event that
// the tracker + `ScrollbackPane`'s re-anchor (`scrollToActivation`,
// wired in onMount since 8a49ea3) listen for. A bare `setProperty` fires
// no event, so the JS re-anchor facet would otherwise never run.
//
// Honest-scope caveat (feedback_playwright_webkit_not_ios_scroll):
// real on-device keyboard occlusion + visualViewport timing differ from
// this emulation. A GREEN here means the contract holds; it does NOT
// close #66 — that needs a real-iPhone Mezmerize dogfood, because iOS
// Safari ≠ Playwright webkit for keyboard/scroll. Mirrors the
// simulate-via-setProperty approach of names143-modal-mobile.spec.ts.
//
// `@webkit` opts this spec into the `webkit-iphone-15` project
// (playwright.config.ts grep) so `html.is-ios` engages and the real iOS
// height path (`body { height: calc(var(--vh) * 100) }`) is exercised.

import {
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Stand-in for "the keyboard leaves ~300px of the screen visible" — far
// below the iPhone 15 device viewport (393×659) so the shrink is real.
// Same value names143 uses for the modal-occlusion contract.
const FAKE_VISIBLE_PX = 300;
// Per-run unique tag so retries / parallel rows in #bofh don't collide.
const MESSAGE_BODY = `issue66 keyboard-overlap @ ${crypto.randomUUID().slice(0, 8)}`;

test("@webkit issue66 — composer + last message stay inside the keyboard-shrunk viewport", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Guarantee a concrete last row to anchor on — the seeded scrollback
  // may be empty. Compose-send a tagged privmsg via the iOS-shaped path
  // and confirm it round-trips (persisted + painted) before we simulate
  // the keyboard.
  const ta = composeTextarea(page);
  await ta.tap();
  await ta.fill(MESSAGE_BODY);
  await ta.press("Enter");
  await expect(ta).toHaveValue("", { timeout: 5_000 });
  await assertMessagePersisted({
    token: vjt.token,
    networkSlug: NETWORK_SLUG,
    channel: CHANNEL,
    sender: NETWORK_NICK,
    body: MESSAGE_BODY,
  });
  const ownRow = scrollbackLine(page, "privmsg", MESSAGE_BODY);
  await expect(ownRow).toBeVisible({ timeout: 5_000 });

  // Simulate the iOS keyboard opening. We can't shrink the real
  // `window.visualViewport.height` from Playwright (it's OS-keyboard
  // driven, read-only), so we STUB it to FAKE_VISIBLE_PX and dispatch
  // the `resize` the production code listens for. This makes the real
  // production tracker our ally: `installViewportHeightTracker`'s own
  // resize handler reads the stubbed `vv.height` and writes BOTH
  // `--viewport-height` AND `--vh` to the shrunk value (a bare
  // `setProperty` would be clobbered the instant any resize fires), and
  // `ScrollbackPane`'s `scrollToActivation` re-anchor fires off the SAME
  // event — so both the layout-shrink and scroll-re-anchor facets run
  // exactly as they do on device, against a shrunk visible region.
  await page.evaluate((px) => {
    const vv = window.visualViewport;
    if (!vv) throw new Error("issue66 spec: window.visualViewport unavailable");
    Object.defineProperty(vv, "height", { configurable: true, get: () => px });
    vv.dispatchEvent(new Event("resize"));
  }, FAKE_VISIBLE_PX);

  // Guard: confirm the simulated keyboard actually shrank the var BEFORE
  // asserting geometry — so a failure below means "an element overflows
  // the shrunk region" (the #66 bug), never "the simulation didn't take".
  await expect
    .poll(
      async () =>
        page.evaluate(() =>
          document.documentElement.style.getPropertyValue("--viewport-height").trim(),
        ),
      { timeout: 5_000 },
    )
    .toBe(`${FAKE_VISIBLE_PX}px`);

  // Facet (1) — the composer must sit fully inside the visible region,
  // never behind the keyboard. Its bottom edge cannot fall past
  // FAKE_VISIBLE_PX. (`.compose-box` is the composer's outer flex row.)
  const composeBox = page.locator(".compose-box");
  await expect
    .poll(
      async () => {
        const box = await composeBox.boundingBox();
        return box ? box.y + box.height : Number.POSITIVE_INFINITY;
      },
      { timeout: 5_000 },
    )
    .toBeLessThanOrEqual(FAKE_VISIBLE_PX + 1);

  // Facet (2) — after the re-anchor (`scrollToActivation`'s double-rAF
  // tail.scrollIntoView), the LAST message must be back in view inside
  // the shrunk region — both its top above 0 and its bottom at-or-above
  // FAKE_VISIBLE_PX. expect.poll absorbs the rAF settle.
  await expect
    .poll(
      async () => {
        const box = await ownRow.boundingBox();
        return box ? box.y + box.height : Number.POSITIVE_INFINITY;
      },
      { timeout: 5_000 },
    )
    .toBeLessThanOrEqual(FAKE_VISIBLE_PX + 1);
  const lastBox = await ownRow.boundingBox();
  expect(lastBox).not.toBeNull();
  if (lastBox) {
    expect(lastBox.y).toBeGreaterThanOrEqual(-1);
  }
});
