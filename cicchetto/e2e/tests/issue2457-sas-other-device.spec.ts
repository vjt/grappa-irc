// issue 2457 — a SAS request reaches every device of the peer's account, and
// once one of them accepts, the others let go of it: three browser contexts,
// two grappa users, real vodozemac engines, one real ircd.
//
// Browser A1 starts Alice's identity; A2, a second login of Alice with fresh
// storage, is paired into it through the real pairing UI
// (`fixtures/pairing.ts`). Bob writes to Alice, so both of her devices hold a
// session with his, then asks to compare emoji: the start goes to every
// device of her master, and both browsers show the request. A1 accepts. Bob's
// side, on that first accept, sends `sas.cancel {reason: "other-device"}` to
// every device of hers but A1 (`lib/e2e/sas.ts`, `release`), and A2's request
// goes, its rail saying why; the comparison goes on between Bob and A1.
//
// ## What makes this spec able to fail
//
//   * Bob's side tells nobody (the bug this issue is about): A2's request
//     stays asked, and its dialog never leaves.
//   * It tells every device, A1 included, or tells them before A1's accept
//     fixed the device: A1's comparison ends, and Bob and A1 never compare.
//   * The reason reaches A2 but the rail has no words for it: the rail reads
//     the reason quoted, as a peer's own words, or says Bob stopped it.
//
// ## What it does not cover
//
// A decline, a step out of order, both sides asking at once, two devices
// accepting at once: `e2eSas.test.ts` ("SAS with a peer of several devices"),
// real engines on the fake grappa. They end the same way here, with the same
// cancel, and cost a pairing each to drive in browsers.

import { awaitServiceWorkerActive, sidebarWindow } from "../fixtures/cicchettoPage";
import {
  askToCompare,
  boot,
  emoji,
  equery,
  KEYS_TIMEOUT,
  peerPage,
  phase,
  row,
  send,
} from "../fixtures/encryptedQuery";
import {
  awaitBundleOf,
  newBrowserOf,
  pairFromBanner,
  type SecondBrowser,
} from "../fixtures/pairing";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

// How long a page may take to show its shell after a navigation.
const SHELL_TIMEOUT_MS = 10_000;

test("a request accepted on one device of the account goes from its other device, and the comparison goes on", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const bobContext = await peerPage(browser);
  // A2 exists only after A1 started the identity: a browser logging in first
  // would be the one that starts it.
  let second: SecondBrowser | null = null;
  try {
    // A1 starts the identity and opens the encrypted query that carries the
    // "add a device" button; A2 pairs into it and lands back on the shell,
    // with a key bundle of its own on grappa, before Bob asks for Alice's
    // keys: the KEYS he gets lists both devices.
    await boot(page, alice);
    await equery(page, aliceNick, bob.nick);
    second = await newBrowserOf(browser, alice);
    const a2 = second.page;
    const a2Did = await pairFromBanner(page, a2, alice.token);
    await a2.goto("/");
    await awaitServiceWorkerActive(a2);
    await expect(sidebarWindow(a2, NETWORK_SLUG, AUTOJOIN_CHANNELS[0])).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await awaitBundleOf(alice.token, a2Did);

    // Bob writes first: both of Alice's devices read him, so each holds a
    // session with his device.
    await boot(bobContext.page, bob.user);
    await equery(bobContext.page, bob.nick, aliceNick);
    await equery(a2, aliceNick, bob.nick);
    const hello = "ciao alice, su quale dei tuoi browser confrontiamo?";
    await send(bobContext.page, hello);
    for (const device of [page, a2]) {
      await expect(row(device, "in", hello)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    }

    // Bob asks: both of Alice's browsers show the request.
    await askToCompare(bobContext.page);
    await phase(bobContext.page, "waiting", KEYS_TIMEOUT);
    for (const device of [page, a2]) {
      await phase(device, "asked", KEYS_TIMEOUT);
    }

    // A1 accepts. A2's request goes, and its rail says another device took it.
    await page.getByTestId("e2e-sas-accept").click();
    await expect(a2.getByTestId("e2e-sas")).toHaveCount(0, { timeout: KEYS_TIMEOUT });
    await expect(a2.getByTestId("e2e-rail-comparison")).toHaveText("answered on another device");

    // Bob and A1 go on to compare the same 7 emoji.
    await phase(bobContext.page, "compare", KEYS_TIMEOUT);
    await phase(page, "compare", KEYS_TIMEOUT);
    const seenByBob = await emoji(bobContext.page);
    expect(seenByBob).toHaveLength(7);
    expect(await emoji(page)).toEqual(seenByBob);
    await expect(a2.getByTestId("e2e-sas")).toHaveCount(0);
  } finally {
    await second?.context.close();
    await bobContext.context.close();
    await teardownSpecSubject(bob);
  }
});
