// issue 2577 — an encrypted message on its way, end to end through a real
// ircd. A peer's PKMSG or MSG that spans several lines takes seconds to come
// whole (the sender paces its lines), and grappa reassembles it: the client
// never sees a line. grappa announces the first one on the user topic
// (`e2e_incoming`), and the encrypted window shows the sender and, in place of
// the text, a cloud of squares; the message takes the cloud's place when it
// lands, and the cloud goes when grappa says it never will
// (`e2e_incoming_lost`).
//
// ## What makes this spec able to fail
//
//   * grappa announces nothing at the first line (or cic drops the event):
//     no cloud ever shows, and the first test times out before its line lands.
//   * The cloud stays once the message lands, or the line lands elsewhere
//     than the cloud's place: the cloud count, or the last-row check, is red.
//   * A message that will never complete leaves its cloud behind (grappa does
//     not say so, or cic does not listen): the second test's clouds stay.
//   * Two messages in flight share one cloud: the count of two is red, and
//     dropping one takes both clouds away.
//   * The shimmer ignores `prefers-reduced-motion`: the reduced arm reads an
//     animation name other than `none`.
//
// The first test is two browsers, two grappa users and two real vodozemac
// engines: the cloud comes from a real multi-line PKMSG. The second is one
// browser and a raw IRC peer, because a message that never completes cannot
// be made by a client that completes what it sends: the peer writes the
// first line of each message, then a line that contradicts it (another line
// count, same msgid), which is what grappa drops a message for.

import { randomBytes } from "node:crypto";
import type { Page } from "@playwright/test";
import { boot, equery, KEYS_TIMEOUT, peerPage, row, send } from "../fixtures/encryptedQuery";
import { soleE2eDevice } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

/** The open encrypted window's messages on their way. */
const clouds = (page: Page) => page.getByTestId("e2e-pane").getByTestId("scrollback-arriving");

/** The pane's last row, whatever it is: a line, a cloud, the divider. */
const lastRow = (page: Page) => page.getByTestId("scrollback").locator(":scope > :last-child");

// The animation the first square of the first cloud runs, as the engine
// computes it from the theme.
const shimmer = (page: Page) =>
  clouds(page)
    .first()
    .locator(".scrollback-arriving-cloud > i")
    .first()
    .evaluate((el) => getComputedStyle(el).animationName);

test("a long encrypted message shows as arriving from its first line, then its line takes the cloud's place", async ({
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
    await equery(page, aliceNick, bob.nick);
    await equery(peer.page, bob.nick, aliceNick);

    // Long enough to take several IRC lines whatever the Olm framing adds.
    const long = "2577: questo messaggio cifrato arriva a pezzi, una riga dopo l'altra. "
      .repeat(10)
      .trim();
    await send(page, long);
    const theirs = row(peer.page, "in", long);

    // The first line reached bob's grappa: the cloud, before the line.
    await expect(clouds(peer.page)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await expect(theirs).toHaveCount(0);
    const cloud = clouds(peer.page).first();
    await expect(cloud).toHaveAttribute("data-nick", aliceNick);
    await expect(cloud.locator(".scrollback-arriving-cloud")).toHaveAttribute(
      "aria-label",
      `an encrypted message from ${aliceNick} is arriving`,
    );
    await expect(lastRow(peer.page)).toHaveAttribute("data-testid", "scrollback-arriving");

    // The last line: the message, where the cloud was.
    await expect(theirs).toHaveCount(1, { timeout: 2 * KEYS_TIMEOUT });
    await expect(clouds(peer.page)).toHaveCount(0);
    await expect(lastRow(peer.page)).toHaveAttribute("data-testid", "scrollback-line");
    await expect(lastRow(peer.page).locator(".scrollback-body")).toHaveText(long);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});

// 8 random bytes, standard base64, unpadded: the agreed msgid shape.
const newMsgid = (): string => randomBytes(8).toString("base64").replace(/=+$/, "");

// A device id as the wire spells it (8 bytes, base64url, 11 chars). The
// peer's is made up: nothing here checks the sender's device.
const newDid = (): string => randomBytes(8).toString("base64url");

// One line of a MSG for `did`, in MSG v2's shape. grappa reads none of it.
const chunk = (did: string): string =>
  JSON.stringify({
    v: 2,
    ck: randomBytes(32).toString("base64").replace(/=+$/, ""),
    bodies: { [did]: "AwogY2lwaGVydGV4dA" },
  });

test("a message that will never come whole takes its cloud away, each of two in flight on its own", async ({
  page,
}) => {
  const bobNick = specNick();
  await boot(page, specUser());
  const did = (await soleE2eDevice(specUser().token, NETWORK_SLUG)).did;

  const peer = await IrcPeer.connect({ nick: "i2577-sender" });
  try {
    await equery(page, bobNick, peer.nick);
    const peerDid = newDid();
    const [first, second] = [newMsgid(), newMsgid()];

    // The first line of two messages, each of three lines: two clouds, in
    // the order they began.
    peer.e2eFragment(bobNick, "MSG", first, 1, 3, peerDid, "*", chunk(did));
    await expect(clouds(page)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    peer.e2eFragment(bobNick, "MSG", second, 1, 3, peerDid, did, chunk(did));
    await expect(clouds(page)).toHaveCount(2, { timeout: KEYS_TIMEOUT });
    await expect(clouds(page).first()).toHaveAttribute("data-nick", peer.nick);

    // The shimmer, and none of it under reduced motion: the squares stay.
    expect(await shimmer(page)).toBe("scrollback-arriving-shimmer");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await shimmer(page)).toBe("none");
    await expect(clouds(page).first().locator(".scrollback-arriving-cloud > i")).toHaveCount(24);
    await page.emulateMedia({ reducedMotion: "no-preference" });

    // A line that contradicts the first message (another line count): grappa
    // drops it and says so, and its cloud goes. The second stays.
    peer.e2eFragment(bobNick, "MSG", first, 2, 4, peerDid, "*", chunk(did));
    await expect(clouds(page)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    // The same for the second: nothing is left, and nothing landed in its place.
    peer.e2eFragment(bobNick, "MSG", second, 2, 4, peerDid, did, chunk(did));
    await expect(clouds(page)).toHaveCount(0, { timeout: KEYS_TIMEOUT });
    await expect(page.getByTestId("e2e-pane").getByTestId("scrollback-line")).toHaveCount(0);
  } finally {
    await peer.disconnect("2577 arriving done");
  }
});
