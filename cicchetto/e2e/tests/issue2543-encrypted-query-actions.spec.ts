// issue 2543 — in an encrypted query every command that sends the peer an
// ACTION goes the way `/me` does (issue 2536): one message inside Olm, drawn
// as an action on the other side. `/np` sends one to the window it was typed
// in, `/ctcp <peer> ACTION` to the nick. Two browsers, two grappa users, the
// real ircd; the radio's now-playing feed answered in the page.
//
// ## What makes this spec able to fail
//
//   * Either command goes in clear (the defect): it never reaches the
//     encrypted window as an action, on either side, and both grappas keep
//     the clear CTCP ACTION as DM history between the two nicks.
//   * Either goes as text: no action line.
//   * The ciphertext view shows the action's words instead of the payloads.
//
// The clear-ACTION check is the wire one, read off Bob's grappa: whatever the
// ircd delivers to Bob's nick that is not an `E2E` payload becomes a DM row
// there, so an empty DM history is "no clear PRIVMSG reached Bob from Alice".
// Its barrier is the order: a clear send skips the E2E engine and grappa's
// E2E pacer, so it would have reached Bob before the encrypted lines did.

import type { Page } from "@playwright/test";
import { silentMp3 } from "../fixtures/bytes";
import { openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import {
  actionRow,
  bodies,
  boot,
  equery,
  FRAME,
  flip,
  KEYS_TIMEOUT,
  peerPage,
  send,
} from "../fixtures/encryptedQuery";
import { answerFetchInPage } from "../fixtures/fetchInPage";
import { fetchAllMessagesAsc } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

// Literals rather than imports from `src/lib/radioStations`, for #682's
// reason: a table edit that renames this station must fail HERE.
const STATION_ID = "groovesalad";
const SONGS_URL = /^https:\/\/api\.somafm\.com\/songs\//;
const TRACK_TITLE = "Structures from Silence";
const TRACK_ARTIST = "Steve Roach";

const WAVE = "2543 waves at bob from the encrypted window";

// The radio's now-playing feed answered in the page (a `page.route` does not
// see a fetch the service worker mediates: #1702) and its stream on a route,
// so tuning sends nothing to the network. Before the page loads: the feed's
// stub is an init script.
async function stubTheRadio(page: Page): Promise<void> {
  await answerFetchInPage(page, { url: SONGS_URL, method: null }, () => ({
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: STATION_ID,
      songs: [{ artist: TRACK_ARTIST, title: TRACK_TITLE }],
    }),
  }));
  await page.route("https://ice.somafm.com/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "audio/mpeg", body: silentMp3(8) });
  });
}

test("issue 2543 — in an encrypted query /np and /ctcp <peer> ACTION reach the peer encrypted, as actions, never in clear", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const peer = await peerPage(browser);
  try {
    await stubTheRadio(page);
    await boot(page, alice);
    await boot(peer.page, bob.user);

    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: aliceNick });
    await openRailMenu(page);
    await page.getByTestId("rail-action-radio").click();
    await page.getByTestId(`rail-radio-station-${STATION_ID}`).click();
    // `/np` has a track once the bar names it.
    await expect(page.getByTestId("audio-mini-player-track")).toContainText(TRACK_TITLE, {
      timeout: 15_000,
    });

    await equery(page, aliceNick, bob.nick);
    await equery(peer.page, bob.nick, aliceNick);

    // The first message waits for the peer's keys, alone (the engine queues
    // at most 16 for them); the second finds the session.
    await send(page, `/ctcp ${bob.nick} ACTION ${WAVE}`);
    await expect(
      actionRow(page, "out", WAVE).locator('[data-testid="e2e-row-state"][data-state="sent"]'),
    ).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await send(page, "/np");
    await expect(
      actionRow(page, "out", TRACK_TITLE).locator(
        '[data-testid="e2e-row-state"][data-state="sent"]',
      ),
    ).toHaveCount(1, { timeout: KEYS_TIMEOUT });

    // Bob reads both as Alice's actions, in the encrypted window.
    const wave = actionRow(peer.page, "in", WAVE);
    await expect(wave).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await expect(wave).toContainText(aliceNick);
    const np = actionRow(peer.page, "in", TRACK_TITLE);
    await expect(np).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await expect(np).toContainText(`${TRACK_ARTIST} — ${TRACK_TITLE}`);

    // No clear ACTION crossed IRC: neither grappa holds DM history between
    // the two nicks, Bob's being what the ircd delivered.
    expect(await fetchAllMessagesAsc(bob.user.token, NETWORK_SLUG, aliceNick)).toEqual([]);
    expect(await fetchAllMessagesAsc(alice.token, NETWORK_SLUG, bob.nick)).toEqual([]);

    // And what crossed IRC, shown on both ends, is payloads, never the words.
    await flip(page, bob.nick, "Show ciphertext");
    await flip(peer.page, aliceNick, "Show ciphertext");
    const frames = [expect.stringMatching(FRAME), expect.stringMatching(FRAME)];
    await expect.poll(() => bodies(page)).toEqual(frames);
    await expect.poll(() => bodies(peer.page)).toEqual(await bodies(page));
    for (const p of [page, peer.page]) {
      const pane = p.getByTestId("e2e-pane");
      await expect(pane).not.toContainText(WAVE);
      await expect(pane).not.toContainText(TRACK_TITLE);
    }
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
