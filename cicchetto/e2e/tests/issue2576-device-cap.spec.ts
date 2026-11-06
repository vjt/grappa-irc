// issue 2576 — an identity holds at most 3 devices. Each device costs a body,
// about one IRC line, on every message to the user and on every order
// challenge, whose window that time comes out of; so pairing a fourth asks to
// revoke one first. The cap is grappa's (`DeviceList.max_devices/0`) and
// cic's (`DEVICE_CAP`), and the master's browser says so beside its device
// list once the list holds 3.
//
// Browser A starts the identity and opens the encrypted query that carries
// the rail; B and C, two more logins of the same account, pair into it from
// the banner (fixtures/pairing.ts). The peer of the query never needs to
// boot: nothing here is sent to it.
//
// ## What makes this spec able to fail
//
//   * The rail says the identity is full below 3 devices, or does not say it
//     at 3.
//   * A browser without the master is told to revoke, which it cannot do.
//   * Revoking one leaves the notice up, though there is room again.

import type { Page } from "@playwright/test";
import {
  awaitServiceWorkerActive,
  confirmModalBody,
  confirmModalYes,
} from "../fixtures/cicchettoPage";
import { boot, equery } from "../fixtures/encryptedQuery";
import { fetchE2eDevices } from "../fixtures/grappaApi";
import { newBrowserOf, pairFromBanner, type SecondBrowser } from "../fixtures/pairing";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

const devices = (page: Page) => page.getByTestId("e2e-rail-own").getByTestId("e2e-own-device");
const deviceRow = (page: Page, did: string) =>
  page.getByTestId("e2e-rail-own").locator(`[data-testid="e2e-own-device"][data-did="${did}"]`);
const full = (page: Page) => page.getByTestId("e2e-own-devices-full");

const FULL_TEXT = "An identity holds at most 3 devices: revoke one to add another.";

test("issue 2576 — at 3 devices the master's browser is told to revoke one before adding another, and not once one is revoked", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const seconds: SecondBrowser[] = [];
  try {
    await boot(page, alice);
    await equery(page, aliceNick, bob.nick);
    await expect(devices(page)).toHaveCount(1);

    // B pairs in: 2 devices, room for one more, no notice.
    const b = await newBrowserOf(browser, alice);
    seconds.push(b);
    const bDid = await pairFromBanner(page, b.page, alice.token);
    await page.getByTestId("add-device-close").click();
    await expect(devices(page)).toHaveCount(2);
    await expect(full(page)).toHaveCount(0);

    // C pairs in: 3 devices, and the master's browser says the identity is full.
    const c = await newBrowserOf(browser, alice);
    seconds.push(c);
    const cDid = await pairFromBanner(page, c.page, alice.token);
    await page.getByTestId("add-device-close").click();
    await expect(devices(page)).toHaveCount(3);
    await expect(full(page)).toHaveText(FULL_TEXT);

    // B, which holds no master, lists the same 3 devices and is told nothing
    // it cannot act on.
    await b.page.goto("/");
    await awaitServiceWorkerActive(b.page);
    await equery(b.page, aliceNick, bob.nick);
    await expect(devices(b.page)).toHaveCount(3);
    await expect(deviceRow(b.page, bDid)).toHaveAttribute("data-here", "true");
    await expect(full(b.page)).toHaveCount(0);

    // A revokes C: room again, and the notice goes.
    await deviceRow(page, cDid).getByTestId("e2e-own-device-revoke").click();
    await expect(confirmModalBody(page)).toContainText(cDid);
    await confirmModalYes(page);
    await expect(devices(page)).toHaveCount(2);
    await expect(full(page)).toHaveCount(0);
    await expect
      .poll(async () => (await fetchE2eDevices(alice.token, NETWORK_SLUG)).map((d) => d.did))
      .not.toContain(cDid);
  } finally {
    for (const second of seconds) await second.context.close();
    await teardownSpecSubject(bob);
  }
});
