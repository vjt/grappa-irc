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
import { composeSend, composeTextarea, loginAs, selectChannel } from "../fixtures/cicchettoPage";
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
async function cdpSwipe(
  cdp: CDPSession,
  x: number,
  y: number,
  dx: number,
  dy: number,
): Promise<void> {
  const point = (f: number) => [
    { x: x + dx * f, y: y + dy * f, radiusX: 8, radiusY: 8, force: 1, id: 1 },
  ];
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: point(0) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(0.5) });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: point(1) });
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
    // Start 12px in from the left edge, over the first character. Where the
    // start sits relative to the text is the next test's subject.
    await cdpSwipe(cdp, box.x + 12, box.y + box.height / 2, 120, 0);

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

// The x, in client px, of the centre of a glyph in the middle of a one-line
// draft: the first character at or right of the middle that is not a space,
// located from the textarea's left content edge by the rendered width in its
// own font. A canvas measures it because a textarea's glyphs live in a UA
// shadow tree no Range can reach.
async function overGlyphX(ta: ReturnType<typeof composeTextarea>, text: string): Promise<number> {
  return ta.evaluate((el: HTMLTextAreaElement, t: string) => {
    let i = Math.floor(t.length / 2);
    while (t.charAt(i) === " ") i += 1;
    if (i >= t.length) throw new Error(`no glyph right of the middle of ${JSON.stringify(t)}`);
    const cs = getComputedStyle(el);
    const ctx = document.createElement("canvas").getContext("2d");
    if (ctx === null) throw new Error("no 2d context");
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    // A font string the canvas cannot parse is dropped without a word, and
    // the measure would then come from its 10px default.
    if (!ctx.font.includes(cs.fontSize)) throw new Error(`canvas refused font: ${ctx.font}`);
    const r = el.getBoundingClientRect();
    const left = r.left + Number.parseFloat(cs.borderLeftWidth) + Number.parseFloat(cs.paddingLeft);
    return left + ctx.measureText(t.slice(0, i)).width + ctx.measureText(t.charAt(i)).width / 2;
  }, text);
}

// vjt, 2026-11-04: the swipe is recognised when it starts in the left part of
// the input, left of the text, and ignored when it starts over the middle of
// the typed text — for right, up AND down. Each direction is driven from both
// starting points; the left-padding start is the control.
test("@touch issue 2356 — a swipe that starts over the typed text acts like one that starts left of it", async ({
  page,
}) => {
  if (!CHANNEL) throw new Error("AUTOJOIN_CHANNELS empty");
  const nick = specNick();
  await page.addInitScript(() => localStorage.setItem("cic_diag", "1"));
  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: nick });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();
  const sent = `swipe over text ${crypto.randomUUID().slice(0, 8)}`;
  await composeSend(page, sent); // history = [sent]
  await ta.click();
  const cdp = await page.context().newCDPSession(page);

  const box = await ta.boundingBox();
  if (box === null) throw new Error("compose textarea has no box");
  const y = box.y + box.height / 2;
  const starts = {
    "left of the text": async () => box.x + 3,
    "over the text": async () => overGlyphX(ta, await ta.inputValue()),
  };

  for (const [where, startX] of Object.entries(starts)) {
    const swipe = async (what: string, dx: number, dy: number) => {
      const x = await startX();
      await cdpSwipe(cdp, x, y, dx, dy);
      const diag = await page.getByTestId("diag-float-swipe").innerText();
      const final = JSON.stringify(await ta.inputValue());
      console.log(`[2356] ${where} ${what} x=${Math.round(x - box.x)} final=${final}\n${diag}`);
    };

    // UP over a one-line draft recalls the last sent line.
    const draft = "una bozza ancora corta";
    await ta.fill(draft);
    await expect(ta).toHaveValue(draft);
    await swipe("up", 0, -120);
    await expect.soft(ta, `${where}: swipe up recalls`).toHaveValue(sent);

    // DOWN walks back to the stashed draft, so it runs only from a recalled
    // line. A failed UP is already reported above, and RIGHT still runs.
    if ((await ta.inputValue()) === sent) {
      await swipe("down", 0, 120);
      await expect.soft(ta, `${where}: swipe down returns to the draft`).toHaveValue(draft);
    }

    // RIGHT completes the nick prefix at the caret.
    const lead = "ciao ";
    await ta.fill(`${lead}${nick.slice(0, 3)}`);
    await expect(ta).toHaveValue(`${lead}${nick.slice(0, 3)}`);
    await swipe("right", 120, 0);
    await expect.soft(ta, `${where}: swipe right completes`).toHaveValue(`${lead}${nick} `);
  }
});
