// issue 2430 slice d — two people verify each other's key by comparing 7
// emoji (SAS), end to end: two browsers, two grappa users, two real vodozemac
// engines, one real ircd. Every step is an inner message on the Olm session
// the query already runs (`lib/e2e/sas.ts`): grappa relays MSG lines and sees
// nothing else.
//
// The first test is the plain case: the two first spoke with keys taken on
// first use (unverified), Alice asks, Bob accepts, both see the same emoji,
// both say they match, and each key reads verified on the other side. The
// second is fork 7 (2430 comment 6339695571): Bob's browser forgets its
// identity and he starts a new one, so his nick speaks with a master Alice
// never pinned; she sees the alarm, takes the new key unverified from the
// alarm itself, and verifies it by the same comparison.
//
// ## What makes this spec able to fail
//
//   * The two sides derive the emoji from different bytes (role order, the
//     curve keys, the tx): the two lists differ.
//   * A step is lost or answered by the wrong tab (the drain, the page that
//     holds the secret, the commitment check): a side never reaches the
//     comparison.
//   * A match does not verify, or the MACs disagree: the badge never reads
//     verified, and there is no verified row.
//   * The alarm cannot be answered: no button, or the badge stays on alarm
//     once the key is taken. Taking a key verifies it (fork 7 says it must
//     not): the badge reads verified before any comparison.

import type { Page } from "@playwright/test";
import {
  boot,
  equery,
  KEYS_TIMEOUT,
  ownKey,
  peerPage,
  replaceIdentity,
  row,
  send,
} from "../fixtures/encryptedQuery";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

// grappa answers a nick's KEYREQ at most once per 30 s (`E2eKeyAnswers`) and
// drops the rest without a word; cic asks again after its own 30 s
// (`KEYREQ_RETRY_MS`, lib/e2e/engine.ts). A request for keys right after
// another one to the same nick may wait that long before it is answered.
const AFTER_A_REASK = 30_000 + KEYS_TIMEOUT;

const trust = (page: Page) => page.getByTestId("e2e-peer-trust");

const phase = (page: Page, value: string, timeout: number) =>
  expect(page.getByTestId("e2e-sas")).toHaveAttribute("data-phase", value, { timeout });

const emoji = (page: Page): Promise<(string | null)[]> =>
  page
    .getByTestId("e2e-sas-emoji")
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-index")));

// Alice asks, Bob accepts, both compare the same 7 emoji and both say they
// match: each one's key reads verified on the other side. The request
// reaches Bob within `askedWithin`.
async function compareEmoji(
  alice: Page,
  bob: Page,
  aliceKey: string,
  bobKey: string,
  askedWithin: number,
): Promise<void> {
  await alice.getByTestId("e2e-sas-start").click();
  await phase(alice, "waiting", KEYS_TIMEOUT);
  await expect(row(alice, "sas_asked", "you asked")).toHaveCount(1);

  await phase(bob, "asked", askedWithin);
  await expect(row(bob, "sas_asked", "asked to compare emoji with you")).toHaveCount(1);
  await bob.getByTestId("e2e-sas-accept").click();

  await phase(alice, "compare", KEYS_TIMEOUT);
  await phase(bob, "compare", KEYS_TIMEOUT);
  const seenByAlice = await emoji(alice);
  expect(seenByAlice).toHaveLength(7);
  expect(await emoji(bob)).toEqual(seenByAlice);

  await alice.getByTestId("e2e-sas-match").click();
  await phase(alice, "confirmed", KEYS_TIMEOUT);
  await bob.getByTestId("e2e-sas-match").click();

  for (const [page, key] of [
    [alice, bobKey],
    [bob, aliceKey],
  ] as const) {
    await expect(trust(page)).toHaveAttribute("data-trust", "verified", {
      timeout: KEYS_TIMEOUT,
    });
    await expect(row(page, "verified", key)).toHaveCount(1);
    await expect(page.getByTestId("e2e-sas")).toHaveCount(0);
    await expect(page.getByTestId("e2e-sas-start")).toHaveCount(0);
  }
}

test("two people compare 7 emoji: the same on both sides, and a match verifies each key on the other", async ({
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

    // The first message pins each key on first use: unverified both ways.
    const hello = "ciao bob, ci verifichiamo?";
    await send(page, hello);
    await expect(row(peer.page, "in", hello)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await expect(trust(page)).toHaveAttribute("data-trust", "unverified");
    await expect(trust(peer.page)).toHaveAttribute("data-trust", "unverified");

    await compareEmoji(page, peer.page, await ownKey(page), await ownKey(peer.page), KEYS_TIMEOUT);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});

test("a nick that speaks with a new key: the alarm takes it unverified, and comparing emoji verifies it", async ({
  page,
  browser,
}, testInfo) => {
  // Two boots, a reload, and a request that may wait for a re-ask.
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
    const hello = "ciao bob";
    await send(page, hello);
    await expect(row(peer.page, "in", hello)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    const oldKey = await ownKey(peer.page);
    await expect(page.getByTestId("e2e-peer-key")).toHaveText(oldKey);

    // Bob's browser forgets its identity. grappa still holds it, so the next
    // page reads "elsewhere" and writes nothing; Bob starts a new identity
    // here on purpose (the inline confirm), which drops the old one and makes
    // a new master.
    await peer.page.evaluate(() => window.__cic_e2eResetForTests?.());
    await peer.page.reload();
    await equery(peer.page, bob.nick, aliceNick);
    await expect(peer.page.getByTestId("e2e-identity-elsewhere")).toBeVisible();
    await replaceIdentity(peer.page);
    const newKey = await ownKey(peer.page);
    expect(newKey).not.toBe(oldKey);

    // What the new key writes is ignored, and shown as an alarm.
    const again = "sono sempre io, browser nuovo";
    await send(peer.page, again);
    const alarm = row(page, "key_alarm", newKey);
    await expect(alarm).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await expect(row(page, "in", again)).toHaveCount(0);
    await expect(trust(page)).toHaveAttribute("data-trust", "alarm");

    // Alice takes the new key from the alarm: written to now, not verified.
    await alarm.getByTestId("e2e-alarm-accept").click();
    await expect(row(page, "accepted", newKey)).toHaveCount(1);
    await expect(page.getByTestId("e2e-peer-key")).toHaveText(newKey);
    await expect(trust(page)).toHaveAttribute("data-trust", "unverified");
    await expect(page.getByTestId("e2e-alarm-accept")).toHaveCount(0);

    // Alice asked for Bob's old key moments ago, and the comparison needs
    // the new one's: grappa may leave her request to cic's re-ask.
    await compareEmoji(page, peer.page, await ownKey(page), newKey, AFTER_A_REASK);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
