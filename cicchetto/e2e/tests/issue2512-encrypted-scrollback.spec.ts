// issue 2512 — the encrypted query is the scrollback pane and the compose box
// every chat window has (vjt: reuse, do not reimplement), end to end: two
// browsers, two grappa users, two real vodozemac engines, one real ircd.
//
// Two bugs went with the list and the compose line the window used to draw
// itself, and this spec reads what they looked like on the screen:
//   * a chat reopened with more lines than fit did not land on its last line
//     (reported from the iOS PWA);
//   * the compose line did not wrap: a long draft ran off sideways in a
//     one-line input instead of growing as the compose box does.
// On a phone the window now carries the floating "next active" button in the
// pane's float stack, as every scrollback window does: exactly one of it.
// Issue 2510 reported that button's look over an encrypted query (opaque,
// placed apart: Shell's bare mount); since this issue it is the stack child
// it is over a channel, and the phone test reads that it LOOKS so: the same
// opacity and the same place in its pane as over a channel.
//
// The reopen runs on desktop and on both phones (`@webkit` for the engine the
// report came from, `@touch` for the other).
//
// ## What makes this spec able to fail
//
//   * The reopened window does not show its last line: covered by the compose
//     box, clipped below the pane, or scrolled away. Read by a hit test at the
//     line's first and last line box, whichever element holds the list. The
//     premise is checked too: the first line is out of sight, so the chat
//     does overflow.
//   * The encrypted compose is not a text area, a long draft overflows it
//     sideways, or it does not grow to a second line where the channel's
//     compose box does.
//   * On a phone, with another window unread: no "next active" button, two
//     of them, or one outside the pane's float stack.
//   * On a phone, that button looks or sits otherwise than over a channel:
//     another opacity, or another distance from its pane's corner (issue
//     2510), with scroll-to-bottom absent from both readings.

import type { Browser, Page, TestInfo } from "@playwright/test";
import { composeSend, selectChannel } from "../fixtures/cicchettoPage";
import {
  boot,
  chatLines,
  composer,
  e2eWindow,
  equery,
  KEYS_TIMEOUT,
  peerPage,
  send,
} from "../fixtures/encryptedQuery";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

/** How many messages the chat holds: more than a phone or a desktop pane shows at once. */
const LINES = 16;

// Whether the chat's first or last line is on the screen: a hit test at the
// top and at the bottom of the line lands on the line itself, so nothing
// covers it and nothing clips it.
const shown = (page: Page, which: "first" | "last") =>
  page.getByTestId("e2e-pane").evaluate((pane, which) => {
    const lines = pane.querySelectorAll<HTMLElement>('[data-testid="scrollback-line"]');
    const line = which === "first" ? lines[0] : lines[lines.length - 1];
    if (line === undefined) return false;
    const r = line.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 24);
    const hit = (y: number) => {
      const el = document.elementFromPoint(x, y);
      return el !== null && line.contains(el);
    };
    return hit(r.top + 2) && hit(r.bottom - 2);
  }, which);

// What the compose box does with a long draft: a text area, nothing running
// off sideways, and how many lines it has grown to.
const composeShape = (box: ReturnType<Page["locator"]>) =>
  box.evaluate((el) => {
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
    return {
      tag: el.tagName,
      sideways: el.scrollWidth > el.clientWidth,
      lines: Math.round(el.getBoundingClientRect().height / lineHeight),
    };
  });

type Chat = { aliceNick: string; peer: Page; bobNick: string };

// issue 2510 — the one "next active" button as the phone paints it: its
// opacity, whether it is a float-stack child, and how far its corner sits
// from the corner of the box it is placed in (the pane, for a stack child).
// Read with scroll-to-bottom absent, which would lift it within the stack.
type Look = { opacity: string; inStack: boolean; right: number; bottom: number };

async function look(page: Page): Promise<Look> {
  const button = page.getByTestId("next-active-btn");
  await expect(button).toHaveCount(1, { timeout: KEYS_TIMEOUT });
  await expect(button).toBeVisible();
  await expect(page.getByTestId("scroll-to-bottom")).toHaveCount(0);
  return button.evaluate((el) => {
    const stack = el.closest(".scrollback-float-stack");
    const box = (stack?.parentElement ?? document.documentElement).getBoundingClientRect();
    const own = el.getBoundingClientRect();
    return {
      opacity: getComputedStyle(el).opacity,
      inStack: stack !== null,
      right: box.right - own.right,
      bottom: box.bottom - own.bottom,
    };
  });
}

// The same look, to the pixel: a fractional rem lands either side of a
// rounding boundary, so the distances get one pixel of slack.
function expectSameLook(actual: Look, expected: Look): void {
  expect({ opacity: actual.opacity, inStack: actual.inStack }).toEqual({
    opacity: expected.opacity,
    inStack: expected.inStack,
  });
  expect(Math.abs(actual.right - expected.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(actual.bottom - expected.bottom)).toBeLessThanOrEqual(1);
}

// Alice and Bob in an encrypted query whose chat holds more lines than fit;
// Alice leaves it for a channel and comes back, and it opens on its last line.
// `then` goes on from there, before the two are torn down.
async function reopenedChat(
  page: Page,
  browser: Browser,
  testInfo: TestInfo,
  then: (chat: Chat) => Promise<void>,
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

    // Long enough to take two lines on any desktop pane (three beside the
    // rail), many enough to overflow anywhere.
    const filler =
      "una riga cifrata abbastanza lunga da andare a capo tre volte sul telefono e almeno una volta nel pannello di un desktop, anche senza la colonna a destra";
    // Alice's window holds a message from the moment grappa takes it: the
    // line reads "sent" and changes no more. The first one waits for the
    // keys (the engine holds only so many that wait); every later one finds
    // the session and is taken at once. Bob's copies trail by minutes, on
    // purpose: grappa's E2E pacer lets at most 3 lines reach one recipient
    // in any 6 s (bahamut's FLUD) and each one costs fake lag, so waiting on
    // Bob would time this spec rather than the window.
    const sent = page
      .getByTestId("e2e-pane")
      .locator('[data-testid="e2e-row-state"][data-state="sent"]');
    await send(page, `1 ${filler}`);
    await expect(sent).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    for (let i = 2; i <= LINES; i++) await send(page, `${i} ${filler}`);
    await expect(chatLines(page)).toHaveCount(LINES);
    await expect(sent).toHaveCount(LINES);

    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { awaitWsReady: false });
    await expect(page.getByTestId("e2e-pane")).toHaveCount(0);
    await selectChannel(page, NETWORK_SLUG, e2eWindow(bob.nick), { awaitWsReady: false });
    await expect(chatLines(page)).toHaveCount(LINES);
    await expect.poll(() => shown(page, "last")).toBe(true);
    expect(await shown(page, "first")).toBe(false);

    await then({ aliceNick, peer: peer.page, bobNick: bob.nick });
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
}

test("reopening an encrypted chat lands on its last line, and its compose box wraps as a channel's does", async ({
  page,
  browser,
}, testInfo) => {
  await reopenedChat(page, browser, testInfo, async ({ bobNick }) => {
    const long = "una bozza lunghissima che deve andare a capo nella casella ".repeat(4).trim();

    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { awaitWsReady: false });
    const channelBox = page.locator(".compose-box textarea");
    await channelBox.fill(long);
    const inChannel = await composeShape(channelBox);
    await channelBox.fill("");

    await selectChannel(page, NETWORK_SLUG, e2eWindow(bobNick), { awaitWsReady: false });
    await composer(page).fill(long);
    const inChat = await composeShape(composer(page));

    // The premise: the channel's box does wrap this draft.
    expect(inChannel).toMatchObject({ tag: "TEXTAREA", sideways: false });
    expect(inChannel.lines).toBeGreaterThanOrEqual(2);
    expect(inChat).toMatchObject({ tag: "TEXTAREA", sideways: false });
    expect(inChat.lines).toBeGreaterThanOrEqual(2);
  });
});

test("@webkit @touch on a phone, reopening an encrypted chat lands on its last line, and the next-active button is the pane's one, looking as over a channel", async ({
  page,
  browser,
}, testInfo) => {
  await reopenedChat(page, browser, testInfo, async ({ aliceNick, bobNick, peer }) => {
    // Another window with something unread: Bob writes Alice in clear.
    await selectChannel(peer, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { awaitWsReady: false });
    await composeSend(peer, `/msg ${aliceNick} 2512 in chiaro`);

    const buttons = page.getByTestId("next-active-btn");
    await expect(buttons).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await expect(
      page.locator(".scrollback-float-stack").getByTestId("next-active-btn"),
    ).toHaveCount(1);
    await expect(buttons).toBeVisible();

    // issue 2510 — and it looks as it does over a channel, both ways.
    const overEncrypted = await look(page);
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { awaitWsReady: false });
    await expect(page.getByTestId("e2e-pane")).toHaveCount(0);
    const overChannel = await look(page);
    expect(overChannel).toMatchObject({ opacity: "0.5", inStack: true });
    expectSameLook(overEncrypted, overChannel);
    await selectChannel(page, NETWORK_SLUG, e2eWindow(bobNick), { awaitWsReady: false });
    await expect(page.getByTestId("e2e-pane")).toBeVisible();
    expectSameLook(await look(page), overChannel);
  });
});
