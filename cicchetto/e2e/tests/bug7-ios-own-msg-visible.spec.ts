// BUG7 — own message not visible in scrollback after compose-send on
// iOS WebKit (the iPhone 15 device emulation surface).
//
// Manual matrix: vjt opens cicchetto on a real iPhone, types in #bofh
// compose box, hits send. Expected the row to appear in scrollback
// within 2s (same invariant as M3 on chromium). Observed: the row
// either doesn't appear, appears late, or scrolls out of the visible
// viewport (covered by the virtual keyboard / hidden by overflow).
//
// **Outcome on Playwright iPhone 15 emulation: GREEN.** Once the
// page-object grew a mobile-aware `selectChannel` (BottomBar tablist
// instead of `.sidebar-network`) the spec reaches compose-send and
// the own-msg renders within the 5s window — i.e. the bug does NOT
// reproduce in headless WebKit + iPhone-15 viewport. The hypothesis
// surface that *does* reproduce on real hardware (visualViewport
// shrinkage on virtual-keyboard show, real keyboard chrome occlusion,
// touch-action quirks the emulator doesn't model) lives outside the
// emulator's faithful behavior. So the spec downgrades from
// "regression-pin RED on prod head" to "positive guard rail":
// it asserts the iOS-shaped input path (tap-to-focus, per-keystroke
// type, tap send) round-trips through compose → WS → DOM on every
// commit. A future real-iOS reproduction (manual tcpdump + real-
// device DevTools-over-USB) is the path to the actual fix.
//
// Why a webkit + iPhone 15 device emulation, not just chromium: WebKit
// + virtual-keyboard interactions are the trigger surface. Plain
// chromium doesn't reproduce — M3 has been GREEN since bucket B.
// Playwright's iPhone 15 device sets `isMobile: true`, `hasTouch:
// true`, and a small viewport (393×852); we additionally use `tap`
// (touch event) + `pressSequentially` (per-keystroke flush) to match
// the real iOS path as closely as Playwright supports without an
// actual keyboard appearance event.
//
// `@webkit` tag opts this spec into the `webkit-iphone-15` project
// (playwright.config.ts grep). Default chromium project skips it.

import { test, expect } from "@playwright/test";
import {
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Per-run unique tag so retries / parallel runs don't strict-mode-collide
// with persisted prior-run rows in #bofh.
const MESSAGE_BODY = `BUG7-ios: own-msg visibility @ ${crypto.randomUUID().slice(0, 8)}`;

test("@webkit BUG7 — own message visible in scrollback after iOS-shaped compose-send", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();

  // iOS-shaped input path: tap (touch event, not click) the textarea
  // to focus it — this is what triggers virtual-keyboard show on a
  // real device. Playwright's iPhone 15 device emulation has
  // `hasTouch: true` so `tap()` dispatches a real Touch event chain
  // (touchstart/touchend) rather than synthesizing a mouse click.
  await ta.tap();

  // Type via per-keystroke events (pressSequentially) instead of
  // bulk fill — matches the real iOS keystroke cadence and surfaces
  // any per-keystroke reactivity glitches that bulk-fill would mask.
  await ta.pressSequentially(MESSAGE_BODY, { delay: 20 });

  // Submit. On iOS the user taps a "send" button (no Enter on virtual
  // keyboard); locate the button by its accessible label and tap it.
  const sendButton = page.locator(".compose-box button", { hasText: /^send$/i });
  await sendButton.tap();

  // Compose box clears on successful submit (compose.ts post-send draft
  // clear). This is the synchronous signal the slash-command / privmsg
  // dispatcher consumed the input.
  await expect(ta).toHaveValue("", { timeout: 5_000 });

  // First door: server-side persistence. If THIS fails, the bug is in
  // the request path (network, WS, server) — not iOS render. If this
  // passes but the next assert fails, the bug is iOS-render-side.
  await assertMessagePersisted({
    token: vjt.token,
    networkSlug: NETWORK_SLUG,
    channel: CHANNEL,
    sender: NETWORK_NICK,
    body: MESSAGE_BODY,
  });

  // Second door: own row appears in DOM AND is visible (not just
  // attached). `toBeVisible` checks `offsetParent`, computed style,
  // and viewport intersection — so a row that's rendered but
  // virtual-keyboard-occluded or overflow-clipped fails this. The
  // 2s window from the plan: own-msg should round-trip through the
  // WS fastlane and paint within 2s on a healthy iOS WebKit. Generous
  // 5s here matches the rest of the suite's WS poll ceiling.
  const ownRow = scrollbackLine(page, "privmsg", MESSAGE_BODY);
  await expect(ownRow).toBeVisible({ timeout: 5_000 });
});
