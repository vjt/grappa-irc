// #250 — nick excluded from touch-selection on Android (follow-up to #179).
//
// On real Android (Chrome), a drag text-selection that starts at the
// timestamp and crosses the row EXCLUDES the author nick; iOS + desktop
// include it. The nick renders as `<button class="scrollback-sender
// nick-clickable">` (ScrollbackPane.tsx senderSpan) — an INTERACTIVE
// inline element. Android's native touch-selection engine skips an
// interactive `<button>`, so the nick token falls outside the captured
// range while timestamp + body stay in. Desktop mouse-selection keeps it
// (no touch-selection engine), and iOS keeps it via the
// `html.is-ios .scrollback { user-select: text }` cascade.
//
// Root cause: that selectable-text re-enable was scoped to `html.is-ios`
// ONLY (default.css), and there is no `is-android` class — so on Android
// `.nick-clickable` computes to the default `user-select: auto` and the
// interactive button is skipped. The fix sets `user-select: text`
// UNCONDITIONALLY on `.nick-clickable`, so the button's own text stays
// inside a drag selection on EVERY platform (keeping its tap handler).
//
// ⚠️ WIRING CHECK ONLY — THIS DOES NOT PROVE THE REAL ANDROID FIX. ⚠️
// Playwright/DOM can only assert the CSS computed-style wiring. It CANNOT
// exercise Android's native touch-selection handles — the very code path
// that fails. A `Range`/mouse-drag serialization includes the whole row
// subtree on every engine regardless of the touch-selection UI: that is
// exactly the false-negative that got #179 mis-closed. A green run here
// is NOT device verification. Real proof needs a physical Android device
// or emulator exercising the native selection handles (vjt post-ship,
// batchable with #245). See docs/DESIGN_NOTES.md 2026-07-15.
//
// Why chromium is the RED→GREEN surface: the chromium project runs the
// NON-`is-ios` path, so asserting `.nick-clickable` computes to
// `user-select: text` THERE directly proves the rule is UNCONDITIONAL
// (not gated behind `html.is-ios`). On unfixed code the button inherits
// the default `auto` and the assertion fails. The `@webkit` twin is a
// regression guard that iOS keeps the nick selectable after the change.

import { test, expect } from "../fixtures/test";
import { composeSend, loginAs, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Date.now() suffix (house pattern): the e2e sqlite scrollback persists
// across KEEP_STACK=1 re-runs — a static body double-matches on rerun and
// trips Playwright strict mode.
const MESSAGE_BODY = `android-nick-select target ${Date.now()}`;

// Read the computed selection policy off the freshly-rendered sender
// button of a message we just sent (NETWORK_NICK is vjt's own nick), so
// the `.nick-clickable` under test is guaranteed present and attributed.
async function nickSelectionStyles(page: import("@playwright/test").Page) {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  await composeSend(page, MESSAGE_BODY);
  const row = scrollbackLine(page, "privmsg", MESSAGE_BODY);
  await expect(row).toBeVisible({ timeout: 5_000 });

  const nick = row.locator(".scrollback-sender.nick-clickable");
  await expect(nick).toContainText(NETWORK_NICK);

  return nick.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      htmlIsIos: document.documentElement.classList.contains("is-ios"),
      userSelect: cs.userSelect,
      webkitUserSelect: cs.webkitUserSelect,
    };
  });
}

test("#250 desktop — .nick-clickable is user-select:text unconditionally (not is-ios-gated)", async ({
  page,
}) => {
  const styles = await nickSelectionStyles(page);

  // chromium project → NON-is-ios path: proving `text` here proves the
  // rule is unconditional. Fails (inherited `auto`) on unfixed code.
  expect(styles.htmlIsIos).toBe(false);
  expect(styles.userSelect).toBe("text");
  expect(styles.webkitUserSelect).toBe("text");
});

test("@webkit #250 iOS — .nick-clickable stays user-select:text (regression guard)", async ({
  page,
}) => {
  const styles = await nickSelectionStyles(page);

  // iPhone 15 UA → is-ios: the nick was already selectable via the
  // `.scrollback` cascade; guard that the unconditional rule keeps it so.
  // WebKit reflects only the PREFIXED `webkitUserSelect` in computed
  // style (the unprefixed `userSelect` reads `undefined` there) — same
  // property the sibling text-selection-restored.spec asserts on iOS.
  expect(styles.htmlIsIos).toBe(true);
  expect(styles.webkitUserSelect).toBe("text");
});
