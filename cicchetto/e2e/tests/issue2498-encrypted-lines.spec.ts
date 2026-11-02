// issue 2498 — the encrypted query's messages are the scrollback's own lines
// (vjt's ruling: one renderer, so a change to how a message reads lands in
// every window at once), end to end: two browsers, two grappa users, two real
// vodozemac engines, one real ircd.
//
// Our line names us by our nick, as any query's does, on our side and on the
// peer's; and the body starts beside the nick and flows on from there, as it
// does in the scrollback.
//
// ## What makes this spec able to fail
//
//   * The window draws a row of its own again: no scrollback line in the pane
//     holds the message, or the line's box is not a channel line's (display,
//     white-space, font, line height read differently off the engine).
//   * Our own line names us "you", or anything but our nick.
//   * The body leaves the nick's line (the bespoke row's flex wrap put a body
//     too long for the rest of the line on the next one): the body's first
//     line box starts below the nick.

import type { Locator } from "@playwright/test";
import { composeSend, scrollbackLine, selectChannel } from "../fixtures/cicchettoPage";
import { boot, equery, KEYS_TIMEOUT, peerPage, row, send } from "../fixtures/encryptedQuery";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

// What makes a line the scrollback's, as the engine computes it.
const BOX = ["display", "white-space", "font-family", "font-size", "line-height"];
const box = (line: Locator): Promise<string[]> =>
  line.evaluate((el, props) => {
    const style = getComputedStyle(el);
    return props.map((prop) => style.getPropertyValue(prop));
  }, BOX);

// How far below the nick the body's first line box starts, and how tall the
// whole line is, both in line heights. Beside the nick, the drop is a few
// pixels of half-leading (the nick is an inline button); on the next line it
// is a whole line height.
const placement = (line: Locator) =>
  line.evaluate((el) => {
    const nick = el.querySelector(".scrollback-sender")?.getBoundingClientRect();
    const body = el.querySelector(".scrollback-body")?.getClientRects()[0];
    if (nick === undefined || body === undefined) return null;
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight);
    return {
      drop: (body.top - nick.top) / lineHeight,
      lines: el.getBoundingClientRect().height / lineHeight,
    };
  });

test("an encrypted query's messages are the scrollback's lines: our nick, the body on the nick's line", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const peer = await peerPage(browser);
  try {
    await boot(page, alice);
    await boot(peer.page, bob.user);

    // A scrollback line of ours, to hold the encrypted ones against.
    const plain = `2498 in chiaro, da ${aliceNick}`;
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: aliceNick });
    await composeSend(page, plain);
    const channelLine = scrollbackLine(page, "privmsg", plain);
    await expect(channelLine).toHaveCount(1);
    const scrollbackBox = await box(channelLine);

    await equery(page, aliceNick, bob.nick);
    await equery(peer.page, bob.nick, aliceNick);

    // Too long for one line of the pane: the body has to start beside the
    // nick and wrap from there.
    const long = "questo messaggio cifrato è lungo apposta, ".repeat(8).trim();
    await send(page, long);
    const ours = row(page, "out", long);
    const theirs = row(peer.page, "in", long);
    await expect(ours).toHaveCount(1);
    await expect(theirs).toHaveCount(1, { timeout: KEYS_TIMEOUT });

    for (const line of [ours, theirs]) {
      await expect(line.locator(".scrollback-time")).toHaveText(/\d/);
      await expect(line.locator(".encrypted-marker")).toHaveCount(1);
      await expect(line.locator(".scrollback-sender")).toHaveText(`<${aliceNick}>`);
      await expect(line.locator(".scrollback-body")).toHaveText(long);
      expect(await box(line)).toEqual(scrollbackBox);
      const at = await placement(line);
      // The premise: the body does take more than one line.
      expect(at?.lines).toBeGreaterThanOrEqual(2);
      expect(Math.abs(at?.drop ?? Number.POSITIVE_INFINITY)).toBeLessThan(0.5);
    }

    // The peer's line names the peer, on both sides.
    const reply = "ricevuto";
    await send(peer.page, reply);
    await expect(row(page, "in", reply).locator(".scrollback-sender")).toHaveText(`<${bob.nick}>`, {
      timeout: KEYS_TIMEOUT,
    });
    await expect(row(peer.page, "out", reply).locator(".scrollback-sender")).toHaveText(
      `<${bob.nick}>`,
    );
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
