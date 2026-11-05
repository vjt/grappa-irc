// issue 2537 — "add a device" offers its pairing to the account's other
// sessions: grappa pushes the pairing's code to every session of the
// account, and a browser that can be paired shows a banner whose button
// opens `/pair`. It never joins on its own: a rendezvous takes one joiner,
// and a forgotten tab would win the race.
//
// Issue 2549 made that offer the ONLY way: "add a device" shows no link, no
// QR code and no copy button, because a link opens in the system browser and
// pairs it instead of the installed app, and `/pair` joins the account's
// offer whatever its URL says.
//
// Browser A holds the identity and opens "add a device"; browser B is a
// second login of the same account with fresh storage, so the account's
// identity is "elsewhere" for it.
//
// ## What makes this spec able to fail
//
//   * The open carries no key, or grappa offers nothing: B never shows the
//     banner.
//   * The offer is pushed only live: B, logged in after the pairing opened,
//     never hears of it (the first test's B has no socket at the open).
//   * `/pair` does not join the account's offer: B never shows a check code,
//     and the device list keeps one device.
//   * "add a device" still shows the pairing as a link, a QR code or a copy
//     button: anything on its panel but the Close button.
//   * The offer outlives its rendezvous: B keeps the banner after A closes
//     the panel.
//   * "Not now" does nothing: the banner stays.
//   * `/pair` joins without the banner: opened straight, with a code in its
//     URL and a pairing on offer, it joins instead of saying where pairing
//     starts.

import { boot, equery, KEYS_TIMEOUT } from "../fixtures/encryptedQuery";
import { fetchE2eDevices } from "../fixtures/grappaApi";
import {
  newBrowserOf,
  offerBanner,
  openAddDevice,
  readCheckCode,
  typeCode,
} from "../fixtures/pairing";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

// The channel runs through grappa's relay and two engines: a step may take as
// long as a key exchange does.
const STEP = KEYS_TIMEOUT;

test("a browser that logs in while the pairing is open is offered it and pairs from the banner, and add a device shows no link", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  let second: Awaited<ReturnType<typeof newBrowserOf>> | null = null;
  try {
    // A starts the identity and opens the encrypted query that carries the
    // "add a device" button.
    await boot(page, alice);
    await equery(page, aliceNick, bob.nick);
    const before = await fetchE2eDevices(alice.token, NETWORK_SLUG);
    expect(before).toHaveLength(1);
    await openAddDevice(page);

    // Nothing on A's screen carries the pairing: no link, no QR, no copy
    // button, only Close.
    const panel = page.getByTestId("add-device-panel");
    await expect(panel.locator("a, svg, img, input")).toHaveCount(0);
    await expect(panel.getByRole("button")).toHaveText(["Close"]);
    await expect(panel).not.toContainText("/pair");
    await expect(panel).not.toContainText("pair=");

    // B logs in only now, after the offer's one live push: what it hears
    // comes from its user-topic join.
    second = await newBrowserOf(browser, alice);
    const aliceB = second.page;
    const banner = offerBanner(aliceB);
    await expect(banner).toBeVisible({ timeout: STEP });

    // The button hands the offer to `/pair` and opens it: B shows its check
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

    await openAddDevice(page);
    await expect(banner).toBeVisible({ timeout: STEP });

    // A leaves "add a device": the rendezvous closes, and B's offer with it.
    await page.getByTestId("add-device-close").click();
    await expect(banner).toHaveCount(0, { timeout: STEP });

    // B has heard an offer already, so its socket is up: this one is the
    // live push. "Not now" hides it.
    await openAddDevice(page);
    await expect(banner).toBeVisible({ timeout: STEP });
    await banner.getByRole("button", { name: "Not now" }).click();
    await expect(banner).toHaveCount(0);
  } finally {
    await second?.context.close();
    await teardownSpecSubject(bob);
  }
});

test("with a pairing on offer, /pair opened without the banner joins nothing, whatever its URL says", async ({
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
    const before = await fetchE2eDevices(alice.token, NETWORK_SLUG);
    await openAddDevice(page);
    // B could take this offer: its banner says so.
    await expect(offerBanner(second.page)).toBeVisible({ timeout: STEP });

    // A Back, a reload or an old link lands on `/pair` with no tap on the
    // banner: B is told where pairing starts and joins nothing.
    await second.page.goto(`/pair#pair=${"r".repeat(22)}.${"c".repeat(43)}`);
    await expect(second.page.getByTestId("pair-none")).toContainText("add a device", {
      timeout: STEP,
    });

    // Nobody joined A's pairing: it still waits, with no code to type.
    await expect(page.getByTestId("pair-waiting")).toBeVisible();
    await expect(page.getByTestId("pair-code-input")).toHaveCount(0);
    expect(await fetchE2eDevices(alice.token, NETWORK_SLUG)).toEqual(before);
  } finally {
    await second?.context.close();
    await teardownSpecSubject(bob);
  }
});
