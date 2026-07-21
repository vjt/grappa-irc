// #366 (companion to #79) — when the keyboard is up, a LONG-PRESS on a
// scrollback message must SELECT THE ENTIRE message, bypassing the
// unreliable native char-range selection on mobile (#79 tracks that native
// failure).
//
// REAL-iOS fix (vjt 2026-07-21): the select-all rides `touchend`, NOT the
// synthetic mousedown. The prior mousedown-gated path assumed iOS
// dispatches a mousedown on finger-release even for a long-press, but real
// iOS Safari synthesizes mouse events ONLY for taps — a long-press that
// enters native text-selection fires none, so the select-all did
// "absolutely nothing" on device. keepKeyboard now detects the long-press
// from touchstart→touchend timing (with a move-cancel so a scroll doesn't
// grab text).
//
// This is a WIRING/CONTRACT guard, not a device-feel test. Real iOS
// long-press physics (magnifier, handles) are NOT reproducible on
// Playwright webkit-iphone-15 (feedback_playwright_webkit_not_ios_scroll),
// so the determinism here is JS-level: synthetic touchstart/touchend
// dispatch — and NO mousedown, matching the real gesture — plus a real
// wall-clock hold drives the production handler, and the assertion reads
// the REAL browser `window.getSelection()`, which (unlike jsdom's no-op
// Selection) actually serializes the selected text. The two selection
// assertions only go green TOGETHER if the select-all fires on the
// long-press AND stays off on the tap. The FEEL (selection visibly
// appearing on a real device) is vjt post-ship.

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
const MESSAGE_BODY = `longpress-select-all ${Date.now()}`;

// Comfortably above keepKeyboard's LONG_PRESS_MS (500) so the held-time
// classification is deterministic under load; setTimeout never fires early.
const HOLD_MS = 650;

test.setTimeout(60_000);

test("@webkit iOS — long-press on a scrollback message selects the ENTIRE message (short tap does not); keyboard preserved", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  await composeSend(page, MESSAGE_BODY);
  const row = scrollbackLine(page, "privmsg", MESSAGE_BODY);
  await expect(row).toBeVisible({ timeout: 5_000 });

  // The precondition: compose focused (keyboard open) — that is what
  // keepKeyboard gates on. composeSend clears the draft but must not be
  // relied on to leave focus in place.
  await composeTextarea(page).focus();

  const outcome = await page.evaluate(
    async ({ body, holdMs }) => {
      const activeIsTextarea = document.activeElement instanceof HTMLTextAreaElement;
      const isIos = document.documentElement.classList.contains("is-ios");

      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      // keepKeyboard stamps touchStartAt on this document touchstart, then
      // reads it on the mousedown iOS dispatches on release.
      function touchStart(el: Element): void {
        el.dispatchEvent(new Event("touchstart", { bubbles: true }));
      }
      function touchEnd(el: Element): void {
        el.dispatchEvent(new Event("touchend", { bubbles: true }));
      }
      const selectedText = (): string => window.getSelection()?.toString() ?? "";

      const rows = Array.from(
        document.querySelectorAll('[data-testid="scrollback-line"][data-kind="privmsg"]'),
      );
      const scrollbackRow = rows.find((r) => r.textContent?.includes(body)) ?? null;
      if (scrollbackRow === null) {
        return { activeIsTextarea, isIos, missing: true } as const;
      }

      window.getSelection()?.removeAllRanges();

      // SHORT tap: touchstart → immediate touchend (held ≈ 0). NO mousedown
      // is dispatched — real iOS Safari withholds it on this gesture, which
      // is precisely why #366's select-all had to move onto touchend. Below
      // the threshold → no select-all → the message must NOT be selected.
      touchStart(scrollbackRow);
      touchEnd(scrollbackRow);
      const selectedAfterTap = selectedText();

      // LONG press: touchstart → hold past the threshold → touchend, again
      // with NO mousedown (the production gesture real iOS actually fires).
      // Long-press → select-all → the WHOLE row's text is selected.
      touchStart(scrollbackRow);
      await sleep(holdMs);
      touchEnd(scrollbackRow);
      const selectedAfterLongPress = selectedText();

      return {
        activeIsTextarea,
        isIos,
        missing: false,
        selectedAfterTap,
        selectedAfterLongPress,
      } as const;
    },
    { body: MESSAGE_BODY, holdMs: HOLD_MS },
  );

  // Live surface preconditions — if these fail the assertions below are
  // meaningless (no hollow green).
  expect(outcome.missing).toBe(false);
  expect(outcome.isIos).toBe(true);
  expect(outcome.activeIsTextarea).toBe(true);

  // The #366 contract: a short touch grabs nothing (a tap → keyboard
  // dismisses), a long-press selects the ENTIRE message. Driven purely by
  // touchstart/touchend — NO synthetic mousedown — so this reds if the
  // select-all regresses to the mousedown path that real iOS never triggers.
  expect(outcome.selectedAfterTap).not.toContain(MESSAGE_BODY);
  expect(outcome.selectedAfterLongPress).toContain(MESSAGE_BODY);
  // Whole-line, not body-only: the sender nick lives in a sibling button
  // OUTSIDE `.scrollback-body`, so its presence in the serialized selection
  // proves the entire row (not just the body) was grabbed — validating the
  // whole-`.scrollback-line` rationale end-to-end (this message is
  // self-sent, so the sender is the operator's own nick).
  expect(outcome.selectedAfterLongPress).toContain(NETWORK_NICK);
});
