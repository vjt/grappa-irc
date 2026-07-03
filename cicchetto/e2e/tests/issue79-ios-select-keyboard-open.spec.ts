// #79 (2026-07-03) — on iOS, tap-hold text selection in the scrollback
// worked ONLY with the on-screen keyboard closed. With compose focused
// (keyboard open), keepKeyboard's document-level capture mousedown
// preventDefault — installed to pin the keyboard across chrome taps —
// ALSO cancelled the text-selection-drag start, so a long-press on a
// scrollback line never began a selection. Fix: keepKeyboard skips its
// preventDefault when the mousedown lands on a selectable-text surface
// (.scrollback / .topic-modal-text, minus the .scrollback-invite-join
// control). Full arc: docs/DESIGN_NOTES.md 2026-06-11 + 2026-07-03.
//
// This is a WIRING/CONTRACT guard, not a "handles appear" test: real
// iOS long-press selection (magnifier, handles) is NOT reproducible on
// Playwright webkit-iphone-15 (feedback_playwright_webkit_not_ios_scroll).
// So on the live is-ios surface, with compose focused, we dispatch a
// cancelable mousedown and assert the discrimination the fix installs:
//   - on a real .scrollback line  → defaultPrevented === false (the
//     selection drag would be allowed to start), and
//   - on chrome (the send button) → defaultPrevented === true (keyboard
//     preserve still fires).
// The two assertions only go green together if the guard actually
// discriminates — reverting the fix reds the scrollback half. The FEEL
// (selection handles actually appearing with the keyboard up) is a
// real-device test (vjt post-ship).

import { test, expect } from "../fixtures/test";
import {
  composeSend,
  composeTextarea,
  loginAs,
  scrollbackLine,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];
// Date.now() suffix (house pattern): the e2e sqlite scrollback persists
// across KEEP_STACK=1 re-runs — a static body would match two rows on a
// second run and trip Playwright strict mode.
const MESSAGE_BODY = `select-with-keyboard-open ${Date.now()}`;

test.setTimeout(60_000);

test("@webkit iOS — keep-keyboard skips its mousedown preventDefault on scrollback so selection can start with the keyboard open, still fires on chrome", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  await composeSend(page, MESSAGE_BODY);
  const row = scrollbackLine(page, "privmsg", MESSAGE_BODY);
  await expect(row).toBeVisible({ timeout: 5_000 });

  // The bug's precondition: compose focused (keyboard open). composeSend
  // clears the draft but must not be relied on to leave focus in place.
  await composeTextarea(page).focus();

  const outcome = await page.evaluate((body) => {
    // Sanity: the fix only matters while a text entry holds focus
    // (that is what keepKeyboard gates on) and on the is-ios surface.
    const activeIsTextarea = document.activeElement instanceof HTMLTextAreaElement;
    const isIos = document.documentElement.classList.contains("is-ios");

    function dispatch(el: Element | null): boolean | null {
      if (el === null) return null;
      const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      return e.defaultPrevented;
    }

    const rows = Array.from(
      document.querySelectorAll('[data-testid="scrollback-line"][data-kind="privmsg"]'),
    );
    const scrollbackRow = rows.find((r) => r.textContent?.includes(body)) ?? null;
    const sendButton = document.querySelector(".compose-box button[type='submit']");

    return {
      activeIsTextarea,
      isIos,
      scrollbackPrevented: dispatch(scrollbackRow),
      chromePrevented: dispatch(sendButton),
    };
  }, MESSAGE_BODY);

  // Live surface preconditions — if these fail the assertions below are
  // meaningless (no hollow green).
  expect(outcome.isIos).toBe(true);
  expect(outcome.activeIsTextarea).toBe(true);

  // The contract: scrollback selection can start (not prevented) while
  // chrome keep-keyboard still fires (prevented).
  expect(outcome.scrollbackPrevented).toBe(false);
  expect(outcome.chromePrevented).toBe(true);
});
