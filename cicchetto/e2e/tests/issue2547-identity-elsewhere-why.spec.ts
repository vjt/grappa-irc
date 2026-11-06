// issue 2547 — a browser that holds no keys for the account's E2E identity
// says WHY, and leads to pairing. On prod the phone had two storage contexts
// logged in as the same account: the one vjt looked at held no E2E records,
// the other still held the original ones and kept using them. The window
// said only "lives on another device, or was lost", and its one visible way
// out was "start a new identity here", which rotated the key and set off a
// key alarm at every contact.
//
// Browser B holds the identity and talks to Bob. Browser A is a second login
// of the same account with empty storage (a second storage context, as on the
// phone), and opens the same encrypted query. A's window says that this
// browser holds no keys, that grappa lists one device of the account, and
// when that device was last active. Pairing is the way out it puts first;
// starting over sits behind a disclosure, still behind its confirmation.
// Pairing the way the window says (B opens "add a device", A takes the
// pairing from its banner) keeps the identity: A then shows the master B
// started, and nothing was deleted on grappa.
//
// ## What makes this spec able to fail
//
//   * The window gives no reason, or the wrong one: `data-reason` is not
//     "no-keys", or the text does not say this browser holds no keys.
//   * The window does not count grappa's devices, or does not say when one
//     was last active: grappa stamps no activity on a device, or cic does not
//     read it.
//   * Starting a new identity is still a visible way out before the user
//     asks for another one.
//   * The window does not say how to pair, or the pairing it points to does
//     not pair, or makes a new identity: A's master differs from B's, or
//     grappa lists anything but B's device and the one the pairing added.

import { awaitServiceWorkerActive } from "../fixtures/cicchettoPage";
import {
  boot,
  equery,
  KEYS_TIMEOUT,
  ownKey,
  peerPage,
  row,
  send,
} from "../fixtures/encryptedQuery";
import { fetchE2eDevices, soleE2eDevice } from "../fixtures/grappaApi";
import { newBrowserOf, pairFromBanner } from "../fixtures/pairing";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

// The channel runs through grappa's relay and two engines: a step may take as
// long as a key exchange does.
const STEP = KEYS_TIMEOUT;

test("a browser with no keys says why, counts grappa's devices and when one was active, and pairs instead of replacing", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const peer = await peerPage(browser);
  let second: Awaited<ReturnType<typeof newBrowserOf>> | null = null;
  try {
    // B starts the identity and talks to Bob: its device drains its inbox on
    // grappa, which is what grappa records as the device being active.
    await boot(page, alice);
    await boot(peer.page, bob.user);
    await equery(page, aliceNick, bob.nick);
    await equery(peer.page, bob.nick, aliceNick);
    const master = await ownKey(page);
    const line = "ciao bob, da B";
    await send(page, line);
    await expect(row(page, "out", line).getByTestId("e2e-row-state")).toHaveAttribute(
      "data-state",
      "sent",
      { timeout: STEP },
    );
    await expect(row(peer.page, "in", line)).toHaveCount(1, { timeout: STEP });
    const held = await soleE2eDevice(alice.token, NETWORK_SLUG);

    // A: the same account, empty storage.
    second = await newBrowserOf(browser, alice);
    const aliceA = second.page;
    await equery(aliceA, aliceNick, bob.nick);

    // The reason, in words and as data.
    const card = aliceA.getByTestId("e2e-identity-elsewhere");
    await expect(card).toBeVisible({ timeout: STEP });
    await expect(card).toHaveAttribute("data-reason", "no-keys");
    await expect(card).toContainText("this browser holds no keys");

    // What grappa holds: one device, active moments ago (B's drains). The
    // bound leaves room for a slow run, never for a device idle for hours.
    await expect(aliceA.getByTestId("e2e-identity-devices")).toHaveText(
      /^grappa lists 1 of your devices, active (\d+s|[1-4]m) ago$/,
      { timeout: STEP },
    );

    // Pairing first: the window says how, and starting over is out of view
    // until the user asks for another way.
    await expect(aliceA.getByTestId("e2e-identity-pair-how")).toBeVisible();
    await expect(aliceA.getByTestId("e2e-identity-replace")).toBeHidden();
    await aliceA.getByTestId("e2e-identity-other-way").click();
    await expect(aliceA.getByTestId("e2e-identity-replace")).toBeVisible();

    // The way out the window leads to: B opens "add a device", A takes the
    // pairing from its banner, and B types the code A shows.
    const paired = await pairFromBanner(page, aliceA, alice.token);

    // The identity stayed: A shows B's master, and grappa holds B's device
    // and A's, never a new identity.
    await aliceA.goto("/");
    await awaitServiceWorkerActive(aliceA);
    await equery(aliceA, aliceNick, bob.nick);
    await expect(aliceA.getByTestId("e2e-identity-elsewhere")).toHaveCount(0);
    expect(await ownKey(aliceA)).toBe(master);
    const devices = await fetchE2eDevices(alice.token, NETWORK_SLUG);
    expect(devices).toHaveLength(2);
    expect(devices.map((d) => d.did)).toEqual(expect.arrayContaining([held.did, paired]));
  } finally {
    await second?.context.close();
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
