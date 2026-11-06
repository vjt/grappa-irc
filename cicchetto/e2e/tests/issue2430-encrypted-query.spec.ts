// issue 2430 — an encrypted query between two people, end to end: two
// browsers, two grappa users, two real vodozemac engines, one real ircd.
//
// Each cic is one device of its user's identity: it keeps its own Olm account
// and fills its device's key bundle on grappa. Alice opens the query with
// `/equery`, the messages go KEYREQ → KEYS → PKMSG → MSG through grappa,
// which relays the lines and reads none of them, and each side takes the
// other's master key on first use, then verifies it by hand against the key
// the other reads off its own pane, the way a person compares it with a peer
// (issue 2544: the pasted pin is gone).
//
// ## What makes this spec able to fail
//
//   * A message is not encrypted to the peer's key, or the session breaks:
//     the peer never shows the text.
//   * The send door or the drain loses a message, or never acknowledges the
//     inbox: the text never shows, or the inbox is not empty at the end.
//   * Something plaintext reaches grappa's scrollback: the DM history with
//     the peer is not empty.
//   * The key taken is not the peer's, or the verify is not applied: the
//     rail shows another key, or the badge does not read verified.
//   * The unread count or the read-on-view is wrong: the badge never shows,
//     or stays after the window is opened.
//
// The peer is a second subject (`provisionPeerSubject`) in a second browser
// context: different users with one device each; two devices of ONE user
// are the interop suite's.

import { selectChannel, sidebarMessageBadge, sidebarWindow } from "../fixtures/cicchettoPage";
import {
  boot,
  e2eWindow,
  equery,
  KEYS_TIMEOUT,
  ownKey,
  peerPage,
  row,
  send,
  verify,
} from "../fixtures/encryptedQuery";
import { fetchAllMessagesAsc, fetchE2eInbox, soleE2eDevice } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

test("two people talk in an encrypted query: real Olm both ways, keys verified by hand, nothing in grappa's scrollback", async ({
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
    await expect(page.getByTestId("e2e-peer-trust")).toHaveAttribute("data-trust", "unverified");

    // Each reads the other's key off the other's pane: what they compare.
    const aliceKey = await ownKey(page);
    const bobKey = await ownKey(peer.page);
    expect(aliceKey).not.toBe(bobKey);

    // Alice → Bob: no session yet, so the message waits for Bob's keys, then
    // goes as a pre-key message.
    const first = "ciao bob, questo è cifrato 🔐";
    await send(page, first);
    const out = row(page, "out", first);
    await expect(out.getByTestId("e2e-row-state")).toHaveAttribute("data-state", "sent", {
      timeout: KEYS_TIMEOUT,
    });
    await expect(row(peer.page, "in", first)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    // The keys Alice took named Bob's one device.
    await expect(page.getByTestId("e2e-peer-devices")).toHaveText("1 device");

    // Each side took the other's key on first use, not verified; compared
    // with what the other reads off its pane, it is verified by hand.
    for (const p of [page, peer.page]) {
      await expect(p.getByTestId("e2e-peer-trust")).toHaveAttribute("data-trust", "unverified");
    }
    await verify(page, bobKey);
    await verify(peer.page, aliceKey);

    // Bob → Alice, on the session Alice's message opened.
    const reply = "ciao alice, ricevuto";
    await send(peer.page, reply);
    await expect(row(page, "in", reply)).toHaveCount(1, { timeout: KEYS_TIMEOUT });

    // While Alice looks elsewhere, Bob's next message is unread in her row,
    // and read once she opens the window again.
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: aliceNick });
    const later = "ci sei ancora?";
    await send(peer.page, later);
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, e2eWindow(bob.nick))).toHaveText("1", {
      timeout: KEYS_TIMEOUT,
    });
    await sidebarWindow(page, NETWORK_SLUG, e2eWindow(bob.nick)).locator("button").first().click();
    await expect(row(page, "in", later)).toHaveCount(1);
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, e2eWindow(bob.nick))).toHaveCount(0);

    // grappa relayed and kept nothing: both inboxes drained and acknowledged,
    // and no DM history either way. Polled: each verify asked the other side
    // for its list (O1), and the answer, paced, may still be on its way here.
    const aliceDevice = await soleE2eDevice(alice.token, NETWORK_SLUG);
    const bobDevice = await soleE2eDevice(bob.user.token, NETWORK_SLUG);
    await expect
      .poll(() => fetchE2eInbox(alice.token, NETWORK_SLUG, aliceDevice.did), {
        timeout: KEYS_TIMEOUT,
      })
      .toEqual([]);
    await expect
      .poll(() => fetchE2eInbox(bob.user.token, NETWORK_SLUG, bobDevice.did), {
        timeout: KEYS_TIMEOUT,
      })
      .toEqual([]);
    expect(await fetchAllMessagesAsc(alice.token, NETWORK_SLUG, bob.nick)).toEqual([]);
    expect(await fetchAllMessagesAsc(bob.user.token, NETWORK_SLUG, aliceNick)).toEqual([]);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
