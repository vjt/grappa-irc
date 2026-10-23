// issue 2430 X1 — a second browser of one user paired into the user's E2E
// identity, the way a person pairs it: the holder shows the link in the
// encrypted pane, the new browser opens it and shows a two-digit code, the
// holder's user types it, the new browser confirms. For the specs that need
// two devices of ONE account as their setup (S1's copies); the pairing's own
// acceptance is `issue2430-pairing.spec.ts`.
//
// `newBrowserOf`, `joinWithLink`, `typeCode` and `awaitBundleOf` are the same
// code as that spec's private helpers; it still keeps its own copies, which
// should import from here instead.

import type { Browser, Page } from "@playwright/test";
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

/**
 * The holder shows the pairing link in the panel; the new browser opens it,
 * the way its OS camera would land it on `/pair`. Resolves with the code the
 * new browser shows.
 */
export async function joinWithLink(holder: Page, joiner: Page): Promise<string> {
  await holder.getByTestId("e2e-add-device").click();
  const link = holder.getByTestId("pair-url");
  await expect(link).toContainText("#pair=", { timeout: STEP });
  const url = (await link.textContent())?.trim() ?? "";
  expect(url).toMatch(/\/pair#pair=/);

  await joiner.goto(url);
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
export async function pairByLink(holder: Page, joiner: Page, token: string): Promise<string> {
  const before = await fetchE2eDevices(token, NETWORK_SLUG);
  const code = await joinWithLink(holder, joiner);
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
    throw new Error(`pairByLink: the pairing listed ${added.length} new devices, not 1`);
  }
  return device.did;
}
