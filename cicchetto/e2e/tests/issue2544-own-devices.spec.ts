// issue 2544 — vjt's ruling, point 2: under "your identity" the encrypted
// query's rail lists this identity's devices (an id, when it was added, and
// which one is this browser), and the browser that holds the master revokes
// any other one behind an explicit confirmation. Another browser of the
// identity lists them read-only, under the add-device row's hint.
//
// A revoke is one signed act: the master signs the list one version up
// without the device, and grappa, taking it, drops the device with its keys
// and its queue (`E2eKeys.put_list/3`). The revoked browser's next sync finds
// a list that leaves it out, and reads the identity as held elsewhere.
//
// Browser A starts the identity and opens the encrypted query that carries
// the rail; browser B, a second login of the same account, pairs into it
// from the banner (fixtures/pairing.ts). The peer of the query never needs to
// boot: nothing here is sent to it.
//
// ## What makes this spec able to fail
//
//   * The rail lists no device, a device the list does not name, or marks
//     the wrong one as this browser.
//   * A browser without the master offers a revoke, or the master's browser
//     offers one for its own device.
//   * A revoke goes without the confirmation, or the confirmation does not
//     name the device.
//   * The revoke leaves the device on grappa or in the list, or the revoked
//     browser still reads the identity as its own.

import type { Page } from "@playwright/test";
import {
  awaitServiceWorkerActive,
  confirmModalBody,
  confirmModalYes,
} from "../fixtures/cicchettoPage";
import { boot, equery } from "../fixtures/encryptedQuery";
import { fetchE2eDevices, fetchE2eList } from "../fixtures/grappaApi";
import { newBrowserOf, pairFromBanner, type SecondBrowser } from "../fixtures/pairing";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

const devices = (page: Page) => page.getByTestId("e2e-rail-own").getByTestId("e2e-own-device");
const deviceRow = (page: Page, did: string) =>
  page.getByTestId("e2e-rail-own").locator(`[data-testid="e2e-own-device"][data-did="${did}"]`);
const revokeButtons = (page: Page) =>
  page.getByTestId("e2e-rail-own").getByTestId("e2e-own-device-revoke");

test("issue 2544 — the rail lists the identity's devices, and the master's browser revokes the other one behind a confirmation", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  let second: SecondBrowser | null = null;
  try {
    // A alone: one device, this browser, nothing to revoke.
    await boot(page, alice);
    await equery(page, aliceNick, bob.nick);
    const [aDevice] = await fetchE2eDevices(alice.token, NETWORK_SLUG);
    if (aDevice === undefined) throw new Error("A made no device");
    await expect(devices(page)).toHaveCount(1);
    await expect(deviceRow(page, aDevice.did)).toHaveAttribute("data-here", "true");
    await expect(deviceRow(page, aDevice.did)).toContainText("this browser");
    await expect(deviceRow(page, aDevice.did)).toContainText("added ");
    await expect(revokeButtons(page)).toHaveCount(0);

    // B pairs in; A's panel closes, and the list reads again.
    second = await newBrowserOf(browser, alice);
    const aliceB = second.page;
    const bDid = await pairFromBanner(page, aliceB, alice.token);
    await page.getByTestId("add-device-close").click();
    await expect(devices(page)).toHaveCount(2);
    await expect(deviceRow(page, bDid)).toHaveAttribute("data-here", "false");
    await expect(deviceRow(page, bDid)).not.toContainText("this browser");
    await expect(revokeButtons(page)).toHaveCount(1);
    await expect(deviceRow(page, bDid).getByTestId("e2e-own-device-revoke")).toBeVisible();

    // B, which holds no master: the same two devices, itself marked, no
    // revoke, and the hint that says where devices are managed.
    await aliceB.goto("/");
    await awaitServiceWorkerActive(aliceB);
    await equery(aliceB, aliceNick, bob.nick);
    await expect(devices(aliceB)).toHaveCount(2);
    await expect(deviceRow(aliceB, bDid)).toHaveAttribute("data-here", "true");
    await expect(deviceRow(aliceB, aDevice.did)).toHaveAttribute("data-here", "false");
    await expect(revokeButtons(aliceB)).toHaveCount(0);
    await expect(aliceB.getByTestId("e2e-add-device-hint")).toHaveText(
      "Devices are added and revoked from the browser that started this identity.",
    );

    // A revokes B: the confirmation names it, and only its yes revokes.
    const listBefore = await fetchE2eList(alice.token, NETWORK_SLUG);
    await deviceRow(page, bDid).getByTestId("e2e-own-device-revoke").click();
    await expect(confirmModalBody(page)).toContainText(bDid);
    expect((await fetchE2eDevices(alice.token, NETWORK_SLUG)).map((d) => d.did)).toContain(bDid);
    await confirmModalYes(page);
    await expect(devices(page)).toHaveCount(1);
    await expect(deviceRow(page, aDevice.did)).toHaveAttribute("data-here", "true");
    await expect(page.getByTestId("e2e-own-devices-error")).toHaveCount(0);

    // On grappa: the list one version up without B, and B's device gone.
    await expect
      .poll(async () => (await fetchE2eDevices(alice.token, NETWORK_SLUG)).map((d) => d.did))
      .toEqual([aDevice.did]);
    const listAfter = await fetchE2eList(alice.token, NETWORK_SLUG);
    expect(listAfter.ver).toBe(listBefore.ver + 1);
    expect(listAfter.devices).toEqual([aDevice.ed25519]);

    // B's next sync finds itself left out: the identity is held elsewhere.
    await aliceB.reload();
    await awaitServiceWorkerActive(aliceB);
    await equery(aliceB, aliceNick, bob.nick);
    await expect(aliceB.getByTestId("e2e-rail-elsewhere")).toBeVisible();
    await expect(aliceB.getByTestId("e2e-own-devices")).toHaveCount(0);
  } finally {
    await second?.context.close();
    await teardownSpecSubject(bob);
  }
});
