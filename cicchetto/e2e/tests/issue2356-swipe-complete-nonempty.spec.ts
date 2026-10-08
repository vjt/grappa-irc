// issue 2356 — swipe-RIGHT on the compose textarea is the phone's Tab: it
// completes the nick prefix under the caret. Reported dead on mobile "when the
// draft already has text" — which is the only case it can do anything in, an
// empty draft has no word to complete (`tabComplete` returns null).
//
// Harness: the chromium-pixel-touch project (`@touch` — Pixel 7, isMobile +
// hasTouch), and the drag goes through chromium's OWN input pipeline via CDP
// `Input.dispatchTouchEvent`, so the touches are TRUSTED and the engine applies
// its native default actions (caret placement, selection) around them. A
// dispatched in-page TouchEvent would skip exactly the part under suspicion.
// ⚠️ Chromium is not iOS: WebKit has no touch-drag verb in Playwright at all.
//
// The Tab press first is the BARRIER, not decoration: it proves the members
// list is seeded (no other barrier exists for it on a 412px viewport, the
// members pane lives in a drawer) and that the completion engine completes
// this prefix. After it, a red on the swipe can only be the gesture door.
import type { CDPSession } from "@playwright/test";
import { composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test.setTimeout(90_000);

const CHANNEL = AUTOJOIN_CHANNELS[0];

// One finger dragged right by `dx` from (x, y) through the real pipeline, in
// TWO moves and no waits. The gesture fires only above 0.3px/ms measured from
// touchstart to touchend (`SWIPE_MIN_VELOCITY_PX_PER_MS`), and every CDP round
// trip costs ~30-40ms of the page's clock: measured, 12 moves of 10px took
// 448ms for 120px (0.27px/ms) and the production diag read `act=none` — the
// harness was a slow drag, not a flick. Two moves keep it a flick.
async function cdpSwipeRight(cdp: CDPSession, x: number, y: number, dx: number): Promise<void> {
  const point = (at: number) => [{ x: at, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(x) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x + dx / 2) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(x + dx) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("@touch issue 2356 — a swipe right completes a non-empty nick prefix", async ({ page }) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const nick = specNick();
  // The production gesture diag ring (`cic_diag`): ComposeBox pushes its own
  // CLAIM / END lines, which name the action the touchend resolved to.
  await page.addInitScript(() => localStorage.setItem("cic_diag", "1"));
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: nick });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();
  const prefix = nick.slice(0, 3);
  const completed = `${nick}: `;

  // Barrier: the keyboard door completes the same prefix.
  await ta.click();
  await ta.fill(prefix);
  await ta.press("Tab");
  await expect(ta).toHaveValue(completed);

  // Re-arm: `fill` fires input → setDraft, which drops the tab cycle.
  await ta.fill(prefix);
  await expect(ta).toHaveValue(prefix);
  expect(await ta.evaluate((el: HTMLTextAreaElement) => el.selectionEnd)).toBe(prefix.length);

  // Probe: every touch phase as the textarea saw it, read AFTER the
  // production listener ran (a bubble listener on window), so a red explains
  // itself — claimed or not, and where the caret/selection stood.
  await ta.evaluate((el: HTMLTextAreaElement) => {
    const w = window as unknown as { __touchLog: string[] };
    w.__touchLog = [];
    for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
      window.addEventListener(type, (e) => {
        if (e.target !== el) return;
        w.__touchLog.push(
          `${type} t=${Math.round(e.timeStamp)} trusted=${e.isTrusted} cancelable=${e.cancelable} prevented=${e.defaultPrevented} sel=${el.selectionStart},${el.selectionEnd} value=${JSON.stringify(el.value)}`,
        );
      });
    }
  });

  const box = await ta.boundingBox();
  if (box === null) throw new Error("compose textarea has no box");
  const cdp = await page.context().newCDPSession(page);
  // Start over the typed text — the reported shape — and drag right.
  await cdpSwipeRight(cdp, box.x + 12, box.y + box.height / 2, 120);

  const log = await page.evaluate(() => (window as unknown as { __touchLog: string[] }).__touchLog);
  const diag = await page.getByTestId("diag-float-swipe").innerText();
  await test.info().attach("touch-log", {
    body: `${log.join("\n")}\n--- diag ring (newest first) ---\n${diag}`,
    contentType: "text/plain",
  });

  await expect(ta).toHaveValue(completed);
});
