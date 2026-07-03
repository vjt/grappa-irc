// #123 — velocity-gate the compose swipe so a slow finger-drag scrolls a
// long draft instead of being hijacked into history recall.
//
// TWO guards, one per what's actually provable where:
//
//   1. WIRING (chromium, untagged): the velocity gate is wired end-to-end.
//      We dispatch synthetic TouchEvents with CONTROLLED timing on the
//      textarea — a fast swipe-up (all events same tick → ~0ms elapsed)
//      recalls the previous sent line; a slow drag (real 350ms gap → below
//      the 0.3px/ms threshold) leaves the draft untouched. This is NOT iOS
//      momentum (webkit can't reproduce that — feedback_playwright_webkit_
//      not_ios_scroll); it's the JS classification, which is deterministic
//      because the handler reads clientX/Y + performance.now() diffs we
//      control. Chromium supports the TouchEvent constructor; webkit's is
//      unreliable, so the wiring test runs on the default project.
//
//   2. CSS CONTRACT (@webkit, iPhone 15): the OTHER half of the fix — the
//      textarea must be `touch-action: pan-y` (+ overscroll-behavior:
//      contain) for native vertical scroll to be possible at all. Asserted
//      via getComputedStyle on the real target browser, the established
//      touch-scroll regression-guard pattern (ux-6-a). Reverting to the old
//      `touch-action: none` turns this red.
//
// The velocity FEEL (is 0.3px/ms the right cut?) is a DEVICE call — vjt
// dogfoods post-ship. The load-bearing classifier gate is the isFastSwipe
// unit test (src/__tests__/swipe.test.ts, jsdom); these e2es guard the
// wiring, not the physics. No hollow green: each fails on a real regression.

import { expect, test } from "../fixtures/test";
import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// Dispatch a synthetic touch drag on `.compose-box textarea` in the page
// context, from (startX,startY) to (endX,endY). When `slowMs` > 0 a real
// delay separates touchstart from touchmove/touchend so the handler's
// performance.now() diff crosses the velocity threshold. Returns nothing;
// the caller asserts the resulting draft. Coordinates are arbitrary client
// px — dispatchEvent fires on the element regardless of hit-testing.
async function synthSwipe(
  page: import("@playwright/test").Page,
  args: { startX: number; startY: number; endX: number; endY: number; slowMs: number },
): Promise<void> {
  await page.evaluate(
    async ({ startX, startY, endX, endY, slowMs }) => {
      const ta = document.querySelector(".compose-box textarea");
      if (!(ta instanceof HTMLTextAreaElement)) throw new Error("compose textarea not found");
      const touch = (x: number, y: number) =>
        new Touch({ identifier: 1, target: ta, clientX: x, clientY: y });
      const fire = (type: "touchstart" | "touchmove" | "touchend", x: number, y: number) => {
        const t = touch(x, y);
        const ended = type === "touchend";
        ta.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            touches: ended ? [] : [t],
            targetTouches: ended ? [] : [t],
            changedTouches: [t],
          }),
        );
      };
      fire("touchstart", startX, startY);
      if (slowMs > 0) await new Promise((r) => setTimeout(r, slowMs));
      fire("touchmove", endX, endY);
      fire("touchend", endX, endY);
    },
    args,
  );
}

test("issue123 — fast swipe-up recalls history, slow drag does not (velocity gate wiring)", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Seed one history entry: a sent line is what recallPrev pulls back.
  const tag = crypto.randomUUID().slice(0, 8);
  const sent = `swipe-recall ${tag}`;
  await composeSend(page, sent); // draft clears, history = [sent]

  const ta = composeTextarea(page);
  await expect(ta).toHaveValue("");

  // FAST swipe UP (80px, same tick → ~0ms → ≫0.3px/ms): claims the gesture,
  // touchend classifies "up" (≥40px floor) → recallPrev → draft == sent.
  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 0 });
  await expect(ta).toHaveValue(sent, { timeout: 2_000 });

  // Back to an empty draft (typing resets historyCursor; history stays).
  await ta.fill("");
  await expect(ta).toHaveValue("");

  // SLOW drag UP (same 80px, but over 350ms → ~0.23px/ms < 0.3): abandoned
  // at touchmove, native pan-y owns it, touchend does NOT recall → draft
  // stays empty. This is the #123 hijack, gone.
  await synthSwipe(page, { startX: 100, startY: 300, endX: 100, endY: 220, slowMs: 350 });
  await expect(ta).toHaveValue("");
});

test("@webkit issue123 — compose textarea is touch-action: pan-y + overscroll-behavior: contain", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // The CSS half of the fix: without pan-y a long draft can't scroll on
  // touch no matter what the JS does; overscroll-behavior:contain stops a
  // past-the-limit scroll chaining to the shell / chrome. Assert the
  // rendered contract on the real webkit target (ux-6-a precedent).
  const styles = await composeTextarea(page).evaluate((el) => {
    const cs = getComputedStyle(el);
    return { touchAction: cs.touchAction, overscrollBehaviorY: cs.overscrollBehaviorY };
  });
  expect(styles.touchAction).toBe("pan-y");
  expect(styles.overscrollBehaviorY).toBe("contain");
});
