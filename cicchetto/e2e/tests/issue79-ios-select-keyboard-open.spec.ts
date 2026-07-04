// #79 (2026-07-04, long-press rework) — on iOS, tap-hold text selection
// in the scrollback worked ONLY with the on-screen keyboard closed. With
// compose focused (keyboard open), keepKeyboard's document-level capture
// mousedown either preventDefaulted the selection-drag start (v0) OR
// (v1, 8d8dab1) skipped preventDefault unconditionally on .scrollback —
// which let a plain tap's focus-shift close the keyboard AND let the
// keyboard-close reflow tear down the long-press before iOS committed a
// selection. Rework: keepKeyboard DURATION-GATES its preventDefault on
// selectable surfaces. iOS dispatches the mousedown on finger-release, so
// the held time (touchstart → mousedown) tells a tap from a long-press:
//   - SHORT tap   → NOT prevented → focus shift proceeds → keyboard
//     closes (vjt-confirmed tap-to-close, KEPT), and
//   - LONG press  → prevented → keyboard stays up so the selection iOS
//     began is not torn down by a reflow, and
//   - chrome (send button) → prevented unconditionally (UX-3 preserve).
// Full arc: docs/DESIGN_NOTES.md 2026-06-11 + 2026-07-03 + 2026-07-04.
//
// This is a WIRING/CONTRACT guard, not a "handles appear" test: real iOS
// long-press selection (magnifier, handles) is NOT reproducible on
// Playwright webkit-iphone-15 (feedback_playwright_webkit_not_ios_scroll).
// The determinism here is JS-level — synthetic touchstart/mousedown
// dispatch plus a real wall-clock hold — independent of touch physics.
// The three assertions only go green TOGETHER if the duration gate
// actually discriminates: reverting to the unconditional skip (v1) reds
// the long-press half; reverting to the unconditional preventDefault (v0)
// reds the tap half. The FEEL (selection actually appearing, and the tap
// dismissing the keyboard on-device) is a real-device test (vjt post-ship).

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

// Comfortably above keepKeyboard's LONG_PRESS_MS (500) so the held-time
// classification is deterministic under load; setTimeout never fires early.
const HOLD_MS = 650;

test.setTimeout(60_000);

test("@webkit iOS — keep-keyboard duration-gates its mousedown preventDefault on scrollback: short tap not prevented (keyboard closes), long-press prevented (selection kept), chrome always prevented", async ({
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

  const outcome = await page.evaluate(
    async ({ body, holdMs }) => {
      // Sanity: the fix only matters while a text entry holds focus
      // (that is what keepKeyboard gates on) and on the is-ios surface.
      const activeIsTextarea = document.activeElement instanceof HTMLTextAreaElement;
      const isIos = document.documentElement.classList.contains("is-ios");

      const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
      // keepKeyboard stamps touchStartAt on this document touchstart, then
      // reads it on the mousedown iOS dispatches on release.
      function touchStart(el: Element): void {
        el.dispatchEvent(new Event("touchstart", { bubbles: true }));
      }
      function mouseDown(el: Element): boolean {
        const e = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
        el.dispatchEvent(e);
        return e.defaultPrevented;
      }

      const rows = Array.from(
        document.querySelectorAll('[data-testid="scrollback-line"][data-kind="privmsg"]'),
      );
      const scrollbackRow = rows.find((r) => r.textContent?.includes(body)) ?? null;
      const sendButton = document.querySelector(".compose-box button[type='submit']");
      if (scrollbackRow === null || sendButton === null) {
        return { activeIsTextarea, isIos, missing: true } as const;
      }

      // SHORT tap: touchstart → immediate mousedown (held ≈ 0).
      touchStart(scrollbackRow);
      const shortTapPrevented = mouseDown(scrollbackRow);

      // LONG press: touchstart → hold past the threshold → mousedown.
      touchStart(scrollbackRow);
      await sleep(holdMs);
      const longPressPrevented = mouseDown(scrollbackRow);

      // Chrome (send button): keep-keyboard fires regardless of duration.
      const chromePrevented = mouseDown(sendButton);

      return {
        activeIsTextarea,
        isIos,
        missing: false,
        shortTapPrevented,
        longPressPrevented,
        chromePrevented,
      } as const;
    },
    { body: MESSAGE_BODY, holdMs: HOLD_MS },
  );

  // Live surface preconditions — if these fail the assertions below are
  // meaningless (no hollow green).
  expect(outcome.missing).toBe(false);
  expect(outcome.isIos).toBe(true);
  expect(outcome.activeIsTextarea).toBe(true);

  // The contract: tap-to-close preserved, long-press keeps the keyboard so
  // the selection survives, chrome keep-keyboard unchanged.
  expect(outcome.shortTapPrevented).toBe(false);
  expect(outcome.longPressPrevented).toBe(true);
  expect(outcome.chromePrevented).toBe(true);
});
