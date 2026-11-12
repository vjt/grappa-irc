// issue 2511 — vjt on iOS (PWA, iPhone portrait): in an encrypted query's
// top bar the title row held `🔒 <nick>`, the trust badge AND the
// `✓ id check <date>` stamp on one line. It did not fit, the row wrapped
// (`.e2e-header-main` was `flex-wrap: wrap`), and the buttons dropped to a
// second row: first the ☰ alone under `#`, then, once the stamp carried a
// full date, search, shredder and ☰ together. vjt's rulings on the issue:
// the stamp goes under the nick (or to the rail); the buttons stay on ONE
// row, with long nicks too; and the search and shredder icons get the ☰'s
// treatment, as big as its bars.
//
// The worst case is the one this spec builds, on both phones: the window bar
// off, so the bar carries the `#` door too, all four buttons; a bot's nick 26
// characters long; and an identity check, so the stamp is there. The stamp
// comes only from a bot (`IdentityCheck`: the last order challenge a bot sent),
// so the bot is the real irc-olm one (fixtures/e2eBot.ts), its key verified
// by hand and ours pinned there, and an order typed in a channel they share
// gives the check.
//
// ## What makes this spec able to fail
//
//   * The bar wraps: one of the four buttons sits lower than the others, or
//     the bar is taller than its buttons.
//   * The nick pushes the buttons instead of ellipsing: it is not cut, or it
//     runs under the search button.
//   * The stamp stays on the nick's line, or so does the badge (on a phone
//     with `#` that leaves the nick two to five characters: the rulings ask
//     for the stamp under the nick, and the badge goes with it).
//   * The search or shredder icon paints smaller than the ☰'s bars: their
//     ink, read off the drawing and its stroke, is not the bars' square.
//   * On the narrowest phone (280px, a Galaxy Fold's cover screen; the window
//     bar is back in flow below 383px, #2161, so the `#` leaves the bar), the
//     title runs under the tools instead of giving way: the badge's, the
//     stamp's or the nick's right edge passes the search button's left.

import type { Page } from "@playwright/test";
import {
  closeMembersDrawer,
  composeSend,
  hideWindowBar,
  openMembersDrawer,
  selectChannel,
} from "../fixtures/cicchettoPage";
import {
  botCmd,
  botPins,
  test as botTest,
  botWaitFor,
  escapeRe,
  KEYS_BOUND,
  ORDER_VERDICT,
  orderVerdict,
  PINS_RELOAD,
  registerNick,
  UNDER_WAY_BOUND,
  WHOIS_ASK,
} from "../fixtures/e2eBot";
import { boot, e2eWindow, equery, ownKey, row, send, verify } from "../fixtures/encryptedQuery";
import { joinChannel } from "../fixtures/grappaApi";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { expect } from "../fixtures/test";

const test = botTest;

// The mail, the registration, the bot's start, VERIFIED, the pin's load, the
// first message and the order, each at its bound, with room to spare.
test.setTimeout(480_000);

type Box = { top: number; bottom: number; left: number; right: number; height: number };

// The bar as the phone lays it out: its buttons (the `#` door first, when the
// bar carries it), the nick (and whether it is cut), the badge, the stamp,
// the bar's content height, the ☰'s bars and the two icons' ink (the
// drawing's box, grown by half its stroke on every side, in CSS pixels).
const layout = (page: Page) =>
  page
    .getByTestId("e2e-pane")
    .locator("header")
    .evaluate((header) => {
      const box = (el: Element): Box => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height };
      };
      const one = (selector: string): Element => {
        const found = header.querySelectorAll(selector);
        if (found.length !== 1) throw new Error(`${selector}: ${found.length} in the bar`);
        return found[0] as Element;
      };
      const ink = (button: Element) => {
        const svg = button.querySelector("svg") as SVGSVGElement;
        const bbox = svg.getBBox();
        const half = Number.parseFloat(getComputedStyle(svg).strokeWidth) / 2;
        const ctm = svg.getScreenCTM() as DOMMatrix;
        return { width: (bbox.width + 2 * half) * ctm.a, height: (bbox.height + 2 * half) * ctm.d };
      };
      const burger = one(".topic-bar-hamburger");
      const nick = one(".e2e-heading") as HTMLElement;
      const style = getComputedStyle(header);
      return {
        buttons: [
          ...Array.from(header.querySelectorAll(".topic-bar-windows-opener")),
          one('[data-testid="e2e-search-toggle"]'),
          one('[data-testid="e2e-delete-chat"]'),
          burger,
        ].map(box),
        nick: box(nick),
        nickCut: nick.scrollWidth > nick.clientWidth,
        badge: box(one('[data-testid="e2e-peer-trust"]')),
        stamp: box(one('[data-testid="e2e-check-chip"]')),
        content:
          header.clientHeight -
          Number.parseFloat(style.paddingTop) -
          Number.parseFloat(style.paddingBottom),
        bars: Number.parseFloat(getComputedStyle(burger, "::before").width),
        search: ink(one('[data-testid="e2e-search-toggle"]')),
        shredder: ink(one('[data-testid="e2e-delete-chat"]')),
      };
    });

test("@webkit @touch on a phone, the encrypted top bar keeps its four buttons on one row with a long nick and an id check, the stamp under the nick, and its icons as big as the ☰", async ({
  page,
  e2eBot,
  cic,
}) => {
  const run = Date.now().toString(36);
  await registerNick(cic, run);
  // 26 characters: well past what fits beside the badge, inside NICKLEN.
  const bot = await e2eBot.start({
    nick: `ib${run}-a-very-long-nick`.slice(0, 26),
    trust: [`${cic.nick} *`],
    dmallow: [],
  });
  await botWaitFor(
    new RegExp(` VERIFIED ${escapeRe(cic.nick)}$`, "i"),
    bot.since,
    WHOIS_ASK,
    "VERIFIED",
  );

  // Ours pinned in the bot; then one message, which takes the bot's key on
  // first use and opens the session the order's challenge travels in; then
  // the bot's key verified by hand against the one it prints (issue 2544), or
  // the bot's challenge goes unanswered. On a phone the verify button is in
  // the rail's drawer, behind the bar's ☰.
  await boot(page, cic.user);
  await equery(page, cic.nick, bot.nick);
  await botPins({ [cic.nick]: await ownKey(page) });
  await botWaitFor(/ E2E_PINS_LOADED N=1$/, bot.since, PINS_RELOAD, "cic's pin loaded");
  const hello = "2511 ciao bot";
  await send(page, hello);
  await expect(row(page, "out", hello).getByTestId("e2e-row-state")).toHaveAttribute(
    "data-state",
    "sent",
    { timeout: KEYS_BOUND },
  );
  await botWaitFor(
    new RegExp(` MSG TRUSTED ENCRYPTED=1 FROM=${escapeRe(cic.nick)} .* BODY=${escapeRe(hello)}$`),
    bot.since,
    UNDER_WAY_BOUND,
    "cic's message",
  );
  await openMembersDrawer(page);
  await verify(page, bot.ed25519);
  await closeMembersDrawer(page);

  // An order in a channel both are in: challenged, ACKed, confirmed. That is
  // the identity check the stamp shows.
  const chan = `#e2e-2511-${run}`;
  await botCmd(`JOIN ${chan}`);
  const joined = await botWaitFor(
    new RegExp(` JOIN ${escapeRe(bot.nick)} .* ${escapeRe(chan)}$`, "i"),
    bot.since,
    UNDER_WAY_BOUND,
    "the bot's JOIN",
  );
  await joinChannel(cic.user.token, NETWORK_SLUG, chan);
  await selectChannel(page, NETWORK_SLUG, chan, { ownNick: cic.nick });
  const order = `${bot.nick}: ping`;
  await composeSend(page, order);
  const verdict = await botWaitFor(
    orderVerdict(cic.nick, order),
    joined.n + 1,
    ORDER_VERDICT,
    "the verdict on the order",
  );
  expect(verdict.line).toMatch(/ MSG TRUSTED CONFIRMED=1 /);

  // The encrypted window, with the window bar off: all four buttons in the bar.
  await selectChannel(page, NETWORK_SLUG, e2eWindow(bot.nick), { awaitWsReady: false });
  // The window bar goes off, so the `#` door joins the top bar (#1766).
  await hideWindowBar(page);
  await expect(page.locator(".bottom-bar")).toHaveCount(0);
  const pane = page.getByTestId("e2e-pane");
  await expect(pane).toBeVisible();
  await expect(pane.locator("header").getByTestId("e2e-check-chip")).toHaveAttribute(
    "data-passed",
    "true",
  );

  const bar = await layout(page);
  expect(bar.buttons).toHaveLength(4);
  const [door, search, shredder, burger] = bar.buttons;
  if (!door || !search || !shredder || !burger) throw new Error("four buttons");

  // One row: every button at the same height, and the bar no taller than them.
  for (const button of [search, shredder, burger]) {
    expect(Math.abs(button.top - door.top)).toBeLessThanOrEqual(1);
  }
  expect(bar.content).toBeLessThanOrEqual(Math.max(...bar.buttons.map((b) => b.height)) + 1);

  // The nick is cut, and stops before the search button.
  expect(bar.nickCut).toBe(true);
  expect(bar.nick.right).toBeLessThanOrEqual(search.left);

  // The stamp, and the badge with it, under the nick: a second line.
  expect(bar.stamp.top).toBeGreaterThanOrEqual(bar.nick.bottom - 1);
  expect(bar.badge.top).toBeGreaterThanOrEqual(bar.nick.bottom - 1);
  expect(bar.stamp.right).toBeLessThanOrEqual(search.left);

  // The icons' ink is the ☰'s square: as big as its bars, both ways.
  for (const icon of [bar.search, bar.shredder]) {
    expect(Math.abs(icon.width - bar.bars)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(icon.height - bar.bars)).toBeLessThanOrEqual(0.5);
  }

  // The narrowest phone, 280px: the window bar is back in flow (#2161), so
  // three buttons; the stamp gives way, and nothing of the title reaches the
  // tools.
  const size = page.viewportSize();
  if (size === null) throw new Error("no viewport");
  await page.setViewportSize({ width: 280, height: size.height });
  await expect.poll(async () => (await layout(page)).buttons).toHaveLength(3);
  const narrow = await layout(page);
  const [narrowSearch, ...rest] = narrow.buttons;
  if (!narrowSearch) throw new Error("three buttons");
  for (const button of rest) {
    expect(Math.abs(button.top - narrowSearch.top)).toBeLessThanOrEqual(1);
  }
  expect(narrow.content).toBeLessThanOrEqual(Math.max(...narrow.buttons.map((b) => b.height)) + 1);
  expect(narrow.badge.right).toBeLessThanOrEqual(narrowSearch.left);
  expect(narrow.stamp.right).toBeLessThanOrEqual(narrowSearch.left);
  expect(narrow.nick.right).toBeLessThanOrEqual(narrowSearch.left);
});
