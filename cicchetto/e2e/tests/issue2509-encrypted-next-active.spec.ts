// issue 2509 — vjt: encrypted (🔒) query windows were not part of the
// next-active cycle. Alt+A, Ctrl+N / Ctrl+P and the next-active button
// skipped them even with unread messages, because the cycle's candidates
// were channels and plain queries only. Expected: an encrypted query with
// unread messages is a stop like a plain query, in the DM tier, driving the
// button's count and colour the same way, its unread counted from the
// encrypted chat's own state (the plaintext lives only in the browser).
//
// Two browsers, two grappa users, two real vodozemac engines, one real ircd.
// Alice parks on the server window, a window outside the cycle, with nothing
// unread; Bob writes in the encrypted query. Alice's next-active button must
// count it, in the DM tier's colour, and the jump (Alt+A on desktop, the
// button on a phone) must land in the encrypted window, Bob's line on
// screen, after which nothing is left to jump to.
//
// ## What makes this spec able to fail
//
//   * The encrypted window is no candidate, or its unread is read from
//     grappa's counts, which never hold it: the button never shows.
//   * It is a candidate outside the DM tier: the count reads normal (blue).
//   * The jump goes elsewhere, or the window stays a stop once read: the
//     button does not go.
//   * A chat with no line whose unread is a key alarm is never read: the
//     button stays after the jump, a stop no jump can clear.

import type { Page } from "@playwright/test";
import { selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import {
  boot,
  e2eWindow,
  equery,
  KEYS_TIMEOUT,
  ownKey,
  peerPage,
  pin,
  replaceIdentity,
  row,
  send,
  trust,
} from "../fixtures/encryptedQuery";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

const NEXT_ACTIVE_BTN = '[data-testid="next-active-btn"]';
const NEXT_ACTIVE_COUNT = '[data-testid="next-active-btn"] .next-active-count';

// Both sides in the encrypted query, keys exchanged (Bob read Alice's first
// line), then Alice on the server window with nothing to jump to.
async function encryptedQueryThenServerWindow(
  page: Page,
  peer: Page,
  aliceNick: string,
  bobNick: string,
): Promise<void> {
  await equery(page, aliceNick, bobNick);
  await equery(peer, bobNick, aliceNick);
  const hello = "ciao bob, scambiamo le chiavi";
  await send(page, hello);
  await expect(row(peer, "in", hello)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
  await expect(page.getByTestId("e2e-pane")).toHaveCount(0);
  await expect(page.locator(NEXT_ACTIVE_BTN)).toHaveCount(0);
}

// Bob writes: Alice's button counts the encrypted query, in the DM tier.
async function bobWrites(page: Page, peer: Page, line: string): Promise<void> {
  await send(peer, line);
  await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", { timeout: KEYS_TIMEOUT });
  await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveClass(/next-active-count-priority/);
}

// The jump landed: the encrypted window is the one selected, Bob's line on
// screen, and nothing is left to jump to.
async function landedInEncryptedQuery(page: Page, bobNick: string, line: string): Promise<void> {
  await expect(sidebarWindow(page, NETWORK_SLUG, e2eWindow(bobNick))).toHaveClass(/selected/);
  await expect(row(page, "in", line)).toBeVisible();
  await expect(page.locator(NEXT_ACTIVE_BTN)).toHaveCount(0, { timeout: 10_000 });
}

test("desktop: an encrypted query with an unread message is a next-active stop in the DM tier, and Alt+A lands in it", async ({
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
    await encryptedQueryThenServerWindow(page, peer.page, aliceNick, bob.nick);

    const line = "2509 un messaggio cifrato";
    await bobWrites(page, peer.page, line);
    await page.keyboard.press("Alt+a");
    await landedInEncryptedQuery(page, bob.nick, line);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});

test("@webkit @touch mobile: the next-active button counts an encrypted query with an unread message and lands in it", async ({
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
    await encryptedQueryThenServerWindow(page, peer.page, aliceNick, bob.nick);

    const line = "2509 dal telefono, cifrato";
    await bobWrites(page, peer.page, line);
    await page.locator(NEXT_ACTIVE_BTN).click();
    await landedInEncryptedQuery(page, bob.nick, line);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});

// The alarm's chat has no line: Alice pinned Bob's key by hand and nobody
// wrote, then Bob comes back with a new identity, and what its key writes is
// ignored and shown as the alarm, which counts. There is no last line to see,
// so the window shown is what reads it: one jump, and the button goes.
test("desktop: a key alarm in a chat with no line is one stop, cleared by the jump that lands on it", async ({
  page,
  browser,
}, testInfo) => {
  // Two boots, a reload, and a new identity.
  test.setTimeout(180_000);
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const peer = await peerPage(browser);
  try {
    await boot(page, alice);
    await boot(peer.page, bob.user);
    await equery(page, aliceNick, bob.nick);
    await equery(peer.page, bob.nick, aliceNick);
    await pin(page, await ownKey(peer.page));
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });
    await expect(page.locator(NEXT_ACTIVE_BTN)).toHaveCount(0);

    await peer.page.evaluate(() => window.__cic_e2eResetForTests?.());
    await peer.page.reload();
    await equery(peer.page, bob.nick, aliceNick);
    await replaceIdentity(peer.page);
    await send(peer.page, "2509 da un browser nuovo");

    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", { timeout: KEYS_TIMEOUT });
    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveClass(/next-active-count-priority/);
    await page.keyboard.press("Alt+a");
    await expect(sidebarWindow(page, NETWORK_SLUG, e2eWindow(bob.nick))).toHaveClass(/selected/);
    await expect(page.getByTestId("e2e-step")).toHaveAttribute("data-step", "alarm");
    await expect(trust(page)).toHaveAttribute("data-trust", "alarm");
    await expect(page.getByTestId("e2e-pane").getByTestId("scrollback-line")).toHaveCount(0);
    await expect(page.locator(NEXT_ACTIVE_BTN)).toHaveCount(0, { timeout: 10_000 });
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
