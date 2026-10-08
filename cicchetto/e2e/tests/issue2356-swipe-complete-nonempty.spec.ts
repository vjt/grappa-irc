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

// The drafts, each ending in a nick prefix at the caret. vjt's two reported
// repros come verbatim in shape (his words, his nick swapped for the spec's),
// and the controls split the two readings of "it depends on the content":
// the NUMBER of words vs the LENGTH of the line.
type Case = { name: string; lead: string; word: (nick: string) => string };
const CASES: Case[] = [
  { name: "bare prefix", lead: "", word: (n) => n.slice(0, 3) },
  { name: "vjt repro 1", lead: "asd d dh dh hdj djjdjd ", word: (n) => n },
  { name: "vjt repro 1, prefix", lead: "asd d dh dh hdj djjdjd ", word: (n) => n.slice(0, 3) },
  { name: "vjt repro 2", lead: "a a a a a a a ", word: (n) => n },
  { name: "vjt repro 2, prefix", lead: "a a a a a a a ", word: (n) => n.slice(0, 3) },
  { name: "1 word, same length as repro 2", lead: "aaaaaaaaaaaaa ", word: (n) => n.slice(0, 3) },
  { name: "2 words", lead: "a ", word: (n) => n.slice(0, 3) },
  {
    name: "wraps past the input width",
    lead: "una riga lunga che va a capo nel textarea stretto del telefono ",
    word: (n) => n.slice(0, 3),
  },
];

test("@touch issue 2356 — a swipe right completes the nick at the caret", async ({ page }) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const nick = specNick();
  // The production gesture diag ring (`cic_diag`): ComposeBox pushes its own
  // CLAIM / END lines, which name the action the touchend resolved to.
  await page.addInitScript(() => localStorage.setItem("cic_diag", "1"));
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: nick });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();
  await ta.click();

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
          `${type} t=${Math.round(e.timeStamp)} prevented=${e.defaultPrevented} sel=${el.selectionStart},${el.selectionEnd} st=${el.scrollTop} value=${JSON.stringify(el.value)}`,
        );
      });
    }
  });
  const cdp = await page.context().newCDPSession(page);

  for (const c of CASES) {
    const draft = c.lead + c.word(nick);
    // A nick that is the first token is an addressee (": "), anywhere else a
    // word (" ") — the engine's own suffix rule.
    const completed = `${c.lead}${nick}${c.lead === "" ? ": " : " "}`;

    // Barrier, per case: the keyboard door completes THIS draft, so a swipe
    // red below can only be the gesture door, never the engine or the members.
    await ta.fill(draft);
    await ta.press("Tab");
    await expect.soft(ta, `${c.name}: Tab`).toHaveValue(completed);

    // Re-arm: `fill` fires input → setDraft, which drops the tab cycle.
    await ta.fill(draft);
    await expect(ta).toHaveValue(draft);
    await page.evaluate(() => {
      (window as unknown as { __touchLog: string[] }).__touchLog.length = 0;
    });

    const box = await ta.boundingBox();
    if (box === null) throw new Error("compose textarea has no box");
    // Start over the typed text — the reported shape — and drag right.
    await cdpSwipeRight(cdp, box.x + 12, box.y + box.height / 2, 120);

    await expect.soft(ta, `${c.name}: swipe`).toHaveValue(completed);
    const log = await page.evaluate(
      () => (window as unknown as { __touchLog: string[] }).__touchLog,
    );
    const diag = await page.getByTestId("diag-float-swipe").innerText();
    const body = `draft=${JSON.stringify(draft)} final=${JSON.stringify(await ta.inputValue())}\n${log.join("\n")}\n--- diag ring (newest first) ---\n${diag}`;
    // Printed as well as attached: a green run keeps no attachments, and a
    // green case is evidence too.
    console.log(`[2356] ${c.name}\n${body}`);
    await test.info().attach(`touch-log ${c.name}`, { body, contentType: "text/plain" });
  }
});
