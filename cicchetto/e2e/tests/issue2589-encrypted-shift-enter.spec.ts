// issue 2589 — in an encrypted query Shift+Enter breaks the line and Enter
// sends the whole body as ONE encrypted message, end to end: two browsers, two
// grappa users, two real vodozemac engines, one real ircd. Every other window
// keeps #974 (every Enter sends): issue974-shift-enter-sends.spec.ts.
//
// The vitest half (ComposeBox.test.tsx, EncryptedChatPane.test.tsx) shows the
// handler lets the keystroke through and the line keeps the body's breaks in
// its text. This is the proof of what jsdom cannot show: the browser puts the
// line break in the box, and the message is painted as two lines, ours and
// the peer's. It runs twice, on desktop Chromium and on WebKit (`@webkit`,
// the iPhone project): the default action of an un-prevented Shift+Enter is
// each engine's own.
//
// ## What makes this spec able to fail
//
//   * Shift+Enter sends, or eats the keystroke: the box does not read the two
//     typed lines, or a message shows before Enter. (The box does not grow:
//     it is one row that scrolls inside, #123, so its height says nothing.)
//   * Enter sends the lines as separate messages, or drops one: either side
//     shows a line reading only one of them, or the line does not read both.
//   * The line breaks are lost on the way or in the paint: either side's line
//     does not render the break (its `innerText`, the rendered text, reads a
//     space or nothing where the break is). The reading is shown able to tell:
//     the same line with its breaks collapsed (`white-space: normal`) renders
//     a space there.

import type { Browser, Locator, Page, TestInfo } from "@playwright/test";
import {
  bodies,
  boot,
  chatLines,
  composer,
  equery,
  KEYS_TIMEOUT,
  peerPage,
  row,
} from "../fixtures/encryptedQuery";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

const FIRST = "riga uno";
const SECOND = "riga due";
const BODY = `${FIRST}\n${SECOND}`;

// The body of `line` as the layout reads it: `innerText` is the RENDERED
// text, so a line break the style keeps reads as "\n" and one it collapses
// reads as a space. Read once as the page styles it, then once more with the
// line's breaks collapsed (`white-space: normal`), the reading it has to tell
// apart.
//
// No geometry, on purpose. Box readings went red on WebKit four times while
// its screenshots showed both rows: there a range starting just after the
// line break returns a box that starts at the FIRST row's top and spans both
// (measured on the iPhone project: the second line's first glyph read top
// 512.92, height 35.59, the first's top 512.92, height 16), so no box
// comparison could tell the rows apart. Agreed with the orchestrator as the
// ceiling: the rendered text stays, the boxes go.
const rendered = (line: Locator): Promise<{ asStyled: string; collapsed: string }> =>
  line.evaluate((el) => {
    const body = el.querySelector<HTMLElement>(".scrollback-body");
    if (body === null) throw new Error("the line has no body");
    const asStyled = body.innerText;
    const line = el as HTMLElement;
    line.style.whiteSpace = "normal";
    const collapsed = body.innerText;
    line.style.whiteSpace = "";
    return { asStyled, collapsed };
  });

async function expectTwoLines(line: Locator): Promise<void> {
  const { asStyled, collapsed } = await rendered(line);
  expect(asStyled).toBe(BODY);
  // The premise: the same reading gives one row when the breaks are not kept.
  expect(collapsed).toBe(`${FIRST} ${SECOND}`);
}

// Alice types two lines into the encrypted query with Bob, Shift+Enter
// between them, and sends them with Enter.
async function shiftEnterInEncryptedQuery(
  page: Page,
  browser: Browser,
  testInfo: TestInfo,
): Promise<void> {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const peer = await peerPage(browser);
  try {
    await boot(page, alice);
    await boot(peer.page, bob.user);
    await equery(page, aliceNick, bob.nick);
    await equery(peer.page, bob.nick, aliceNick);

    // Typed as a person types it: the first line, Shift+Enter, the second.
    const box = composer(page);
    await box.click();
    await page.keyboard.type(FIRST);
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(SECOND);

    // The break is in the box, and nothing went.
    await expect(box).toHaveValue(BODY);
    await expect(chatLines(page)).toHaveCount(0);

    await page.keyboard.press("Enter");
    await expect(box).toHaveValue("");

    // One message on each side, reading both lines.
    const ours = row(page, "out", FIRST);
    await expect(ours.getByTestId("e2e-row-state")).toHaveAttribute("data-state", "sent", {
      timeout: KEYS_TIMEOUT,
    });
    const theirs = row(peer.page, "in", FIRST);
    await expect(theirs).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    for (const p of [page, peer.page]) {
      await expect(chatLines(p)).toHaveCount(1);
      expect(await bodies(p)).toEqual([BODY]);
    }

    // Painted as two lines, ours and the peer's.
    await expectTwoLines(ours);
    await expectTwoLines(theirs);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
}

test("issue 2589 — in an encrypted query Shift+Enter breaks the line, and Enter sends both lines as one message, painted as two on both sides", async ({
  page,
  browser,
}, testInfo) => {
  await shiftEnterInEncryptedQuery(page, browser, testInfo);
});

// The other engine: WebKit, on the iPhone project (`@webkit` only — the
// touch project is Blink again, the engine the desktop test already reads).
test("@webkit issue 2589 — on WebKit too, Shift+Enter breaks the line in an encrypted query, and both sides paint the message as two lines", async ({
  page,
  browser,
}, testInfo) => {
  await shiftEnterInEncryptedQuery(page, browser, testInfo);
});
