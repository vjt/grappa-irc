// issue 2537 — "add a device" offers its pairing to the account's other
// sessions. Moving the pairing link from a phone to a PC meant a laptop
// camera or retyping it; now grappa pushes the code the QR carries to every
// session of the account, and a browser that can be paired shows a banner
// whose button opens `/pair` with that code. It never joins on its own: a
// rendezvous takes one joiner, and a forgotten tab would win the race. The
// link also gets a copy button.
//
// Browser A holds the identity and opens "add a device"; browser B is a
// second login of the same account with fresh storage, so the account's
// identity is "elsewhere" for it.
//
// ## What makes this spec able to fail
//
//   * The open carries no key, or grappa offers nothing: B never shows the
//     banner.
//   * The offer is pushed only live: B, logged in after the QR went up, never
//     hears of it (the first test's B has no socket at the open).
//   * The banner's button does not carry the code to `/pair`: B never shows a
//     check code, and the device list keeps one device.
//   * The offer outlives its rendezvous: B keeps the banner after A closes
//     the panel.
//   * "Not now" does nothing: the banner stays.
//   * The copy button copies anything but the link.

import type { Page } from "@playwright/test";
import { boot, equery, KEYS_TIMEOUT } from "../fixtures/encryptedQuery";
import { fetchE2eDevices } from "../fixtures/grappaApi";
import { newBrowserOf, readCheckCode, typeCode } from "../fixtures/pairing";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

// The channel runs through grappa's relay and two engines: a step may take as
// long as a key exchange does.
const STEP = KEYS_TIMEOUT;

const offerBanner = (page: Page) => page.locator('.error-banner[data-source="pairing-offer"]');

// A opens "add a device" and the QR's link shows. Resolves with the link.
async function showPairingLink(holder: Page): Promise<string> {
  await holder.getByTestId("e2e-add-device").click();
  const link = holder.getByTestId("pair-url");
  await expect(link).toContainText("#pair=", { timeout: STEP });
  return (await link.textContent())?.trim() ?? "";
}

test("a browser that logs in while the QR is up is offered it, pairs from the banner, and the link copies", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  let second: Awaited<ReturnType<typeof newBrowserOf>> | null = null;
  try {
    // A starts the identity and opens the encrypted query that carries the
    // "add a device" button.
    await boot(page, alice);
    await equery(page, aliceNick, bob.nick);
    const before = await fetchE2eDevices(alice.token, NETWORK_SLUG);
    expect(before).toHaveLength(1);
    const url = await showPairingLink(page);

    await page.getByTestId("pair-url-copy").click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url);

    // B logs in only now, after the offer's one live push: what it hears
    // comes from its user-topic join.
    second = await newBrowserOf(browser, alice);
    const aliceB = second.page;
    const banner = offerBanner(aliceB);
    await expect(banner).toBeVisible({ timeout: STEP });

    // The button opens `/pair` with the code: B joins and shows its check
    // code, A's user types it, B confirms.
    await banner.locator(".error-banner-action").click();
    const code = await readCheckCode(aliceB);
    await typeCode(page, code);
    await aliceB.getByTestId("pair-confirm").click({ timeout: STEP });
    await expect(page.getByTestId(`pair-result-${NETWORK_SLUG}`)).toContainText("added", {
      timeout: STEP,
    });
    await expect(aliceB.getByTestId("pair-done")).toBeVisible({ timeout: STEP });
    expect(await fetchE2eDevices(alice.token, NETWORK_SLUG)).toHaveLength(2);
  } finally {
    await second?.context.close();
    await teardownSpecSubject(bob);
  }
});

test("an open browser's offer goes when the pairing closes, a new one comes live, and Not now hides it", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  let second: Awaited<ReturnType<typeof newBrowserOf>> | null = null;
  try {
    await boot(page, alice);
    await equery(page, aliceNick, bob.nick);
    second = await newBrowserOf(browser, alice);
    const banner = offerBanner(second.page);

    await showPairingLink(page);
    await expect(banner).toBeVisible({ timeout: STEP });

    // A leaves "add a device": the rendezvous closes, and B's offer with it.
    await page.getByTestId("add-device-close").click();
    await expect(banner).toHaveCount(0, { timeout: STEP });

    // B has heard an offer already, so its socket is up: this one is the
    // live push. "Not now" hides it.
    await showPairingLink(page);
    await expect(banner).toBeVisible({ timeout: STEP });
    await banner.getByRole("button", { name: "Not now" }).click();
    await expect(banner).toHaveCount(0);
  } finally {
    await second?.context.close();
    await teardownSpecSubject(bob);
  }
});
