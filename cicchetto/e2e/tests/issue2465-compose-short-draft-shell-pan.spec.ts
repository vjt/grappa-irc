// issue 2465 — on an iPhone with the keyboard open, a vertical swipe on the
// compose box panned the WHOLE app shell. The textarea is `touch-action: pan-y`
// (so a long draft can scroll), and ComposeBox only preventDefaults once
// `claimAxis` claims, past the 8px slop: the moves before the claim went to the
// browser, and on a draft that FITS nothing inside could take them, so UIKit
// panned the visual viewport. The cure is the Shell's document `touchmove`
// guard, installed for the Shell's whole life instead of only while an overlay
// is open: it cancels a move nothing under the finger can scroll.
//
// What each test proves, and where (feedback_playwright_webkit_not_ios_scroll):
//
//   * WIRING (chromium, untagged): in the real bundle, with the real layout and
//     NO overlay open, the FIRST touchmove on a one-line draft — 2px, far under
//     the slop, so ComposeBox has not claimed — is cancelled. Dispatched on
//     purpose: the question is a JS-level fact about one event, and only a
//     dispatched sequence can stop after exactly one move. RED before the cure:
//     with no overlay open the guard did not exist.
//   * THE CONSUMER (chromium, untagged): a draft that OVERFLOWS keeps its native
//     scroll. A REAL drag through chromium's input pipeline, hit-tested by the
//     engine, and the textarea's own scrollTop moves. Get the guard's scroller
//     test wrong and every long draft stops scrolling on touch.
//   * THE ENGINE FACT (@webkit @touch): the textarea computes `overflow-y:
//     auto`, which is what that scroller test reads — on WebKit too.
//
// NOT proven here, and not provable off-device: that UIKit no longer pans the
// visual viewport. Chromium is not iOS, Playwright's webkit is not UIKit, and
// the keyboard's viewport geometry exists only on the phone. That is vjt's
// device check, listed in the PR.

import { composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { dragScroller } from "../fixtures/shellTouch";
import { expect, specNick, specUser, test } from "../fixtures/test";

// iPhone-15-ish portrait: narrow enough for isMobile(), so the compose box sits
// in the real `.shell-mobile` tree the guard walks.
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const CHANNEL = AUTOJOIN_CHANNELS[0];
const COMPOSE = ".compose-box textarea";

test("issue2465 — on a one-line draft the FIRST touchmove is cancelled, before any claim, with no overlay open", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  const ta = composeTextarea(page);
  await ta.fill("hello");
  await expect(ta).toHaveValue("hello");

  const result = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!(el instanceof HTMLTextAreaElement)) throw new Error("compose textarea not found");
    const touch = (y: number) => new Touch({ identifier: 1, target: el, clientX: 100, clientY: y });
    const fire = (type: "touchstart" | "touchmove", y: number): boolean => {
      const t = touch(y);
      return el.dispatchEvent(
        new TouchEvent(type, {
          bubbles: true,
          cancelable: true,
          touches: [t],
          targetTouches: [t],
          changedTouches: [t],
        }),
      );
    };
    const pre = {
      fits: el.scrollHeight <= el.clientHeight,
      overlayOpen: document.documentElement.classList.contains("overlay-open"),
      inMobileShell: document.querySelector(".shell-mobile")?.contains(el) === true,
    };
    fire("touchstart", 300);
    // dispatchEvent returns false iff a listener called preventDefault.
    const prevented = !fire("touchmove", 298);
    return { ...pre, prevented };
  }, COMPOSE);

  // The pre-state the case rests on: a draft that fits, in the mobile shell,
  // with nothing open — the configuration of the report.
  expect(result.fits).toBe(true);
  expect(result.inMobileShell).toBe(true);
  expect(result.overlayOpen).toBe(false);
  expect(result.prevented).toBe(true);
});

test("issue2465 — a draft that OVERFLOWS keeps its native scroll under the guard (real drag)", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  const ta = composeTextarea(page);
  const longDraft = Array.from({ length: 40 }, (_, i) => `draft line ${i}`).join("\n");
  await ta.fill(longDraft);
  await expect(ta).toHaveValue(longDraft);

  // Mid-scroll, so the drag has room and ComposeBox's own claim (which fires
  // only at the edge the drag points to) stays out of it.
  const box = await ta.evaluate((el: HTMLTextAreaElement) => {
    el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) / 2);
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
      overflowY: getComputedStyle(el).overflowY,
    };
  });
  // The guard's scroller test reads COMPUTED overflow; the textarea declares
  // none, and qualifies only because the engine computes it as auto.
  expect(box.overflowY).toBe("auto");

  // Finger UP across the box: the content scrolls toward the end, scrollTop grows.
  const drag = await dragScroller(page, COMPOSE, [
    { x: box.x, y: box.y + 10 },
    { x: box.x, y: box.y + 4 },
    { x: box.x, y: box.y - 2 },
    { x: box.x, y: box.y - 8 },
    { x: box.x, y: box.y - 14 },
  ]);

  expect(drag.landsOnScroller).toBe(true);
  expect(drag.overflowPx).toBeGreaterThan(80);
  expect(drag.moves).toBeGreaterThan(0);
  expect(drag.prevented).toBe(false);
  expect(drag.scrollTopAfter).toBeGreaterThan(drag.scrollTopBefore);
  await expect(ta).toHaveValue(longDraft); // no recall hijacked it
});

// The engine fact the guard's scroller test rests on, measured on BOTH touch
// engines — WebKit is where the defect lives. The compose textarea declares no
// `overflow`; Blink and WebKit compute a textarea's `visible` as `auto`, which
// is what makes a long draft count as a scroller the guard stands aside for.
// Lose it and every long draft stops scrolling on touch.
test("@webkit @touch issue2465 — the compose textarea computes overflow-y: auto", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  const overflowY = await composeTextarea(page).evaluate((el) => getComputedStyle(el).overflowY);
  expect(overflowY).toBe("auto");
});
