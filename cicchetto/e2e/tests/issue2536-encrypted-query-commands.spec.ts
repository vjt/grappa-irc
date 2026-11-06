// issue 2536 — a slash command typed in an encrypted query runs as it would in
// the plain query, in clear, and never reaches the peer; `/me` is the one
// exception and goes to the peer encrypted, as an action. Two browsers, two
// grappa users, the real ircd and its real NickServ.
//
// ## What makes this spec able to fail
//
//   * A command goes to the peer as text (2512's behaviour, and the leak that
//     made 2536 a fix: the peer read `/ns identify <password>`): Bob's window
//     shows it, or Alice's shows it as a message of hers.
//   * The command does not run: NickServ never answers Alice.
//   * `/me` goes as text: neither window shows an action line.
//   * `/me` goes in clear: grappa's DM history between them is not empty.
//
// The absence has a barrier, and it is the order: Alice's encrypted messages
// to one peer leave in the order she sent them (the engine queues them for the
// peer's keys, grappa's E2E pacer per recipient), so an identify sent to Bob
// would have reached him before the action typed after it. Once the action is
// in, the identify is not coming.

import type { Page } from "@playwright/test";
import {
  actionRow,
  boot,
  chatLines,
  equery,
  KEYS_TIMEOUT,
  peerPage,
  send,
} from "../fixtures/encryptedQuery";
import { fetchAllMessagesAsc } from "../fixtures/grappaApi";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

// NickServ's notices to `token`'s user that name `nick`: services notices
// land in the server window (`EventRouter`'s services arm), one row each. A
// one-argument IDENTIFY from an unregistered nick is answered with that nick
// (azzurra/services `do_identify` → ERROR_NICK_NOT_REG, "Nickname %s is not
// registered." / "Il nick %s non e' registrato."), which a notice of another
// cause would not carry.
const nickServNotices = async (token: string, nick: string): Promise<number> =>
  (await fetchAllMessagesAsc(token, NETWORK_SLUG, "$server")).filter(
    (m) => m.kind === "notice" && /^nickserv$/i.test(m.sender) && (m.body ?? "").includes(nick),
  ).length;

const linesReading = (page: Page, text: string) => chatLines(page).filter({ hasText: text });

test("issue 2536 — in an encrypted query a command runs in clear and never reaches the peer; /me reaches them encrypted, as an action", async ({
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

    const before = await nickServNotices(alice.token, aliceNick);
    await send(page, "/ns identify notforbob");
    // The command ran: NickServ answered it.
    await expect
      .poll(() => nickServNotices(alice.token, aliceNick), { timeout: KEYS_TIMEOUT })
      .toBeGreaterThan(before);

    await send(page, "/me waves at bob");
    // Alice's own line is an action, and grappa took it.
    await expect(
      actionRow(page, "out", "waves at bob").locator(
        '[data-testid="e2e-row-state"][data-state="sent"]',
      ),
    ).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    // Bob's is the peer's action, named for Alice.
    const action = actionRow(peer.page, "in", "waves at bob");
    await expect(action).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await expect(action).toContainText(aliceNick);

    // The barrier above is passed: what the identify would have been is not
    // in either window.
    await expect(linesReading(peer.page, "notforbob")).toHaveCount(0);
    await expect(linesReading(page, "notforbob")).toHaveCount(0);

    // And the action went inside Olm, not as a clear CTCP: grappa keeps no
    // DM history between them.
    expect(await fetchAllMessagesAsc(alice.token, NETWORK_SLUG, bob.nick)).toEqual([]);
    expect(await fetchAllMessagesAsc(bob.user.token, NETWORK_SLUG, aliceNick)).toEqual([]);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
