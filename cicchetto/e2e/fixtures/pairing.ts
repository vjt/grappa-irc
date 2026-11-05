// issue 2430 X1 — a second browser of one user paired into the user's E2E
// identity, the way a person pairs it: the holder opens "add a device" in the
// encrypted pane, the new browser takes the pairing from the banner grappa
// shows it (issue 2549: there is no link) and shows a two-digit code, the
// holder's user types it, the new browser confirms. For the specs that need
// two devices of ONE account as their setup (S1's copies), and for the
// pairing's own acceptance, `issue2430-pairing.spec.ts`, which drives the
// same steps one by one with its own assertions in between.

import type { Browser, Locator, Page } from "@playwright/test";
import { loginAs } from "./cicchettoPage";
import { KEYS_TIMEOUT, peerPage } from "./encryptedQuery";
import { fetchE2eDevices, fetchE2eKeys, login, type SeededUser } from "./grappaApi";
import { NETWORK_SLUG } from "./seedData";
import { expect } from "./test";

// The channel runs through grappa's relay and two engines: a step may take as
// long as a key exchange does.
const STEP = KEYS_TIMEOUT;

/** A second browser context, and its page. */
export type SecondBrowser = Awaited<ReturnType<typeof peerPage>>;

// The same account logged in a second time: a new bearer, as a new browser
// would get from the login form.
async function secondLogin(user: SeededUser): Promise<SeededUser> {
  const result = await login(user.identifier, user.password);
  return { ...user, token: result.token, subjectJson: JSON.stringify(result.subject) };
}

/** A second context for the same user, logged in and on the shell. Its caller closes it. */
export async function newBrowserOf(browser: Browser, user: SeededUser): Promise<SecondBrowser> {
  const second = await peerPage(browser);
  await loginAs(second.page, await secondLogin(user));
  return second;
}

/** The banner offering a pairing, on a browser that can take it. */
export const offerBanner = (page: Page): Locator =>
  page.locator('.error-banner[data-source="pairing-offer"]');

/** The holder opens "add a device", and the pairing waits for a browser to accept it. */
export async function openAddDevice(holder: Page): Promise<void> {
  await holder.getByTestId("e2e-add-device").click();
  await expect(holder.getByTestId("pair-waiting")).toBeVisible({ timeout: STEP });
}

/**
 * The holder opens "add a device"; the new browser, already on the shell,
 * takes the pairing from its banner. Resolves with the code it shows.
 */
export async function joinFromBanner(holder: Page, joiner: Page): Promise<string> {
  await openAddDevice(holder);
  const banner = offerBanner(joiner);
  await expect(banner).toBeVisible({ timeout: STEP });
  await banner.locator(".error-banner-action").click();
  return readCheckCode(joiner);
}

/** The two-digit code the new browser shows on `/pair`, once it shows it. */
export async function readCheckCode(joiner: Page): Promise<string> {
  const shown = joiner.getByTestId("pair-check-code");
  await expect(shown).toHaveText(/\d{2}\s*$/, { timeout: STEP });
  const code = /(\d{2})\s*$/.exec((await shown.textContent()) ?? "")?.[1];
  if (code === undefined) throw new Error("the new browser showed no two-digit code");
  return code;
}

export async function typeCode(holder: Page, code: string): Promise<void> {
  await holder.getByTestId("pair-code-input").fill(code);
  await holder.getByTestId("pair-code-submit").click();
}

// How long the new device may take to upload its keys after it paired.
const BUNDLE_TIMEOUT_MS = 30_000;

/**
 * State, not an event: the new device is usable by a peer once its key bundle
 * holds one-time keys on grappa (a KEYREQ takes one of every listed device),
 * and by a sibling once it holds one to claim.
 */
export async function awaitBundleOf(token: string, did: string): Promise<void> {
  const deadline = Date.now() + BUNDLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await fetchE2eKeys(token, NETWORK_SLUG, did)).one_time_keys > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `awaitBundleOf: device ${did} never filled its key bundle within ${BUNDLE_TIMEOUT_MS}ms`,
  );
}

/**
 * Pairs `joiner`, a second login of the holder's account with fresh storage
 * (`newBrowserOf`), into the identity `holder` started. Call it with the
 * holder's encrypted pane open (`equery`): that is where "add a device" is.
 * Resolves, once both browsers report the device added, with the did grappa
 * lists for it: the one device the pairing added to the account's list.
 */
export async function pairFromBanner(holder: Page, joiner: Page, token: string): Promise<string> {
  const before = await fetchE2eDevices(token, NETWORK_SLUG);
  const code = await joinFromBanner(holder, joiner);
  await typeCode(holder, code);

  // The joiner is offered the networks only once the holder's offer arrived,
  // which proves the typed code matched; its tap is its confirmation.
  await joiner.getByTestId("pair-confirm").click({ timeout: STEP });
  await expect(holder.getByTestId(`pair-result-${NETWORK_SLUG}`)).toContainText("added", {
    timeout: STEP,
  });
  await expect(joiner.getByTestId("pair-done")).toBeVisible({ timeout: STEP });
  await expect(joiner.getByTestId(`pair-result-${NETWORK_SLUG}`)).toContainText("added");

  const added = (await fetchE2eDevices(token, NETWORK_SLUG)).filter(
    (d) => !before.some((b) => b.did === d.did),
  );
  const [device] = added;
  if (added.length !== 1 || device === undefined) {
    throw new Error(`pairFromBanner: the pairing listed ${added.length} new devices, not 1`);
  }
  return device.did;
}
