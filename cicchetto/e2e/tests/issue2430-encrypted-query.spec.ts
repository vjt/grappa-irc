// issue 2430 — an encrypted query between two people, end to end: two
// browsers, two grappa users, two real vodozemac engines, one real ircd.
//
// Each cic keeps its own Olm account and fills its own key bundle on grappa.
// Alice opens the query with `/equery`, both pin the other's key by hand
// (read off the other's pane, the way a person reads it off a peer), and the
// messages go KEYREQ → KEYS → PKMSG → MSG through grappa, which relays the
// lines and reads none of them.
//
// ## What makes this spec able to fail
//
//   * A message is not encrypted to the peer's key, or the session breaks:
//     the peer never shows the text.
//   * The send door or the drain loses a message, or never acknowledges the
//     inbox: the text never shows, or the inbox is not empty at the end.
//   * Something plaintext reaches grappa's scrollback: the DM history with
//     the peer is not empty.
//   * The pin is not applied: the badge does not read verified.
//   * The unread count or the read-on-view is wrong: the badge never shows,
//     or stays after the window is opened.
//
// The peer is a second subject (`provisionPeerSubject`) in a second browser
// context: different users, so the multi-device question (2430 comment
// 6333417572) does not arise.

import type { Browser, Page } from "@playwright/test";
import {
  awaitServiceWorkerActive,
  composeSend,
  e2eBundleUploaded,
  loginAs,
  selectChannel,
  sidebarMessageBadge,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { fetchAllMessagesAsc, fetchE2eInbox, type SeededUser } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

const KEYS_TIMEOUT = 30_000;

const e2eWindow = (nick: string) => `$e2e:${nick}`;

// Logs in, waits for the key bundle (a peer's KEYREQ is answered from it),
// and lets the service worker take the page, so no reload lands mid-test and
// takes the (unpersisted) encrypted window with it.
async function boot(page: Page, user: SeededUser): Promise<void> {
  const uploaded = e2eBundleUploaded(page, NETWORK_SLUG);
  await loginAs(page, user);
  await uploaded;
  await awaitServiceWorkerActive(page);
}

// Opens the encrypted query with `nick` from a channel's compose box.
async function equery(page: Page, ownNick: string, nick: string): Promise<void> {
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick });
  await composeSend(page, `/equery ${nick}`, { expectUnmount: true });
  await expect(page.getByTestId("e2e-pane")).toBeVisible();
  await expect(page.getByTestId("e2e-compose-input")).toHaveAttribute(
    "placeholder",
    `encrypted message to ${nick}`,
  );
}

const ownKey = async (page: Page): Promise<string> => {
  const key = page.getByTestId("e2e-own-identity");
  await expect(key).toHaveText(/^[A-Za-z0-9+/]{43}$/);
  return (await key.textContent()) ?? "";
};

async function pin(page: Page, key: string): Promise<void> {
  await page.getByTestId("e2e-pin-input").fill(key);
  await page.getByTestId("e2e-pin-submit").click();
  await expect(page.getByTestId("e2e-peer-key")).toHaveText(key);
  await expect(page.getByTestId("e2e-peer-trust")).toHaveAttribute("data-trust", "verified");
}

async function send(page: Page, body: string): Promise<void> {
  await page.getByTestId("e2e-compose-input").fill(body);
  await page.getByTestId("e2e-compose-input").press("Enter");
  await expect(page.getByTestId("e2e-compose-input")).toHaveValue("");
}

const row = (page: Page, kind: string, body: string) =>
  page.locator(`[data-testid="e2e-row"][data-row-kind="${kind}"]`, { hasText: body });

async function peerPage(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test("two people talk in an encrypted query: real Olm both ways, pinned by hand, nothing in grappa's scrollback", async ({
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

    // Each reads the other's key off the other's pane and pins it.
    const aliceKey = await ownKey(page);
    const bobKey = await ownKey(peer.page);
    expect(aliceKey).not.toBe(bobKey);
    await pin(page, bobKey);
    await pin(peer.page, aliceKey);
    await expect(row(page, "pinned", bobKey)).toHaveCount(1);

    // Alice → Bob: no session yet, so the message waits for Bob's keys, then
    // goes as a pre-key message.
    const first = "ciao bob, questo è cifrato 🔐";
    await send(page, first);
    const out = row(page, "out", first);
    await expect(out.getByTestId("e2e-row-state")).toHaveAttribute("data-state", "sent", {
      timeout: KEYS_TIMEOUT,
    });
    await expect(row(peer.page, "in", first)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await expect(peer.page.getByTestId("e2e-peer-trust")).toHaveAttribute("data-trust", "verified");

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
    // and no DM history either way.
    expect(await fetchE2eInbox(alice.token, NETWORK_SLUG)).toEqual([]);
    expect(await fetchE2eInbox(bob.user.token, NETWORK_SLUG)).toEqual([]);
    expect(await fetchAllMessagesAsc(alice.token, NETWORK_SLUG, bob.nick)).toEqual([]);
    expect(await fetchAllMessagesAsc(bob.user.token, NETWORK_SLUG, aliceNick)).toEqual([]);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
