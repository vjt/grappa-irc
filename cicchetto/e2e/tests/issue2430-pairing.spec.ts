// issue 2430, X1-crypto — a second browser of one user pairs into the user's
// E2E identity by QR, end to end: three browser contexts, two grappa users,
// real vodozemac engines (ECIES for the channel, Olm for the chat), one real
// ircd, grappa's relay carrying the pairing channel without reading it.
//
// The first test is the acceptance the thread names (2430 comment
// 6345727309): two browsers of one user pair, a peer sees two devices, and
// one message reaches both. Browser A holds the identity and shows the link;
// browser B (a second login of the same user, fresh storage) opens it, shows
// a two-digit code, and A's user TYPES that code. B's "Pair this browser" tap
// then lets A sign B into the device list. The second test types a wrong code.
//
// ## What makes this spec able to fail
//
//   * The channel breaks anywhere (ECIES either side, the initial payload
//     wrapping, a message the other side refuses): B never shows its code, or
//     A never shows a result, or B never reaches `pair-done`.
//   * A's typed code is not compared against B's: the wrong code still gets
//     an offer (B reaches the confirm step, and a device is listed).
//   * The certificate or the list B receives does not verify, or B does not
//     keep it: the peer reads one device, or the line never shows on B.
//   * The device list on grappa is not the one pairing should leave: it holds
//     one device after a pairing, or two after a refused one.

import type { Browser, Page } from "@playwright/test";
import { awaitServiceWorkerActive, loginAs } from "../fixtures/cicchettoPage";
import {
  boot,
  equery,
  KEYS_TIMEOUT,
  ownKey,
  peerPage,
  row,
  send,
} from "../fixtures/encryptedQuery";
import {
  fetchE2eDevices,
  fetchE2eKeys,
  login,
  type SeededUser,
  soleE2eDevice,
} from "../fixtures/grappaApi";
import { NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

// The channel runs through grappa's relay and two engines: a step may take as
// long as a key exchange does.
const STEP = KEYS_TIMEOUT;

// The same account logged in a second time: a new bearer, as a new browser
// would get from the login form.
async function secondLogin(user: SeededUser): Promise<SeededUser> {
  const result = await login(user.identifier, user.password);
  return { ...user, token: result.token, subjectJson: JSON.stringify(result.subject) };
}

// The holder shows the pairing link in the panel; the new browser opens it,
// the way its OS camera would land it on `/pair`. Resolves with the code the
// new browser shows.
async function joinWithLink(holder: Page, joiner: Page): Promise<string> {
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

// How long the new device may take to upload its keys after it paired.
const BUNDLE_TIMEOUT_MS = 30_000;

// State, not an event: the new device is usable by a peer once its key bundle
// holds one-time keys on grappa (a KEYREQ takes one of every listed device).
async function awaitBundleOf(token: string, did: string): Promise<void> {
  const deadline = Date.now() + BUNDLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await fetchE2eKeys(token, NETWORK_SLUG, did)).one_time_keys > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(
    `awaitBundleOf: device ${did} never filled its key bundle within ${BUNDLE_TIMEOUT_MS}ms`,
  );
}

async function typeCode(holder: Page, code: string): Promise<void> {
  await holder.getByTestId("pair-code-input").fill(code);
  await holder.getByTestId("pair-code-submit").click();
}

// A second context for the same user, logged in and on the shell.
async function newBrowserOf(browser: Browser, user: SeededUser) {
  const second = await peerPage(browser);
  await loginAs(second.page, await secondLogin(user));
  return second;
}

test("a second browser of one user pairs by QR: the peer sees two devices and one line reaches both", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const bobContext = await peerPage(browser);
  // B exists only after A started the identity: a browser logging in first
  // would be the one that starts it.
  let second: Awaited<ReturnType<typeof newBrowserOf>> | null = null;
  try {
    // A starts the identity and opens the encrypted query that carries the
    // "add a device" button.
    await boot(page, alice);
    await equery(page, aliceNick, bob.nick);
    second = await newBrowserOf(browser, alice);
    const aliceB = second.page;
    const master = await ownKey(page);
    const before = await fetchE2eDevices(alice.token, NETWORK_SLUG);
    expect(before).toHaveLength(1);

    // B opens the link and shows the code; A's user types it.
    const code = await joinWithLink(page, aliceB);
    await typeCode(page, code);

    // B is offered the networks only once A's offer arrived, which proves the
    // typed code matched; B's tap is its confirmation.
    await aliceB.getByTestId("pair-confirm").click({ timeout: STEP });
    await expect(page.getByTestId(`pair-result-${NETWORK_SLUG}`)).toContainText("added", {
      timeout: STEP,
    });
    await expect(aliceB.getByTestId("pair-done")).toBeVisible({ timeout: STEP });
    await expect(aliceB.getByTestId(`pair-result-${NETWORK_SLUG}`)).toContainText("added");
    const after = await fetchE2eDevices(alice.token, NETWORK_SLUG);
    expect(after).toHaveLength(2);
    const added = after.find((d) => !before.some((b) => b.did === d.did));
    if (added === undefined) throw new Error("pairing listed no new device");

    // B is now a device of the same identity: it opens the same query and
    // shows the master A started, not a new one.
    await aliceB.goto("/");
    await awaitServiceWorkerActive(aliceB);
    await equery(aliceB, aliceNick, bob.nick);
    expect(await ownKey(aliceB)).toBe(master);
    await awaitBundleOf(alice.token, added.did);

    // Bob asks Alice's nick for keys and reads two devices; the line he sends
    // is encrypted to both and shows in both browsers.
    await boot(bobContext.page, bob.user);
    await equery(bobContext.page, bob.nick, aliceNick);
    const line = "ciao alice, uno per browser";
    await send(bobContext.page, line);
    await expect(bobContext.page.getByTestId("e2e-peer-devices")).toContainText("2 devices", {
      timeout: STEP,
    });
    await expect(row(page, "in", line)).toHaveCount(1, { timeout: STEP });
    await expect(row(aliceB, "in", line)).toHaveCount(1, { timeout: STEP });
  } finally {
    await second?.context.close();
    await bobContext.context.close();
    await teardownSpecSubject(bob);
  }
});

test("a wrong code typed on the holder: nothing is offered, the new browser ends, and the list keeps one device", async ({
  page,
  browser,
}, testInfo) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  // B exists only after A started the identity: a browser logging in first
  // would be the one that starts it.
  let second: Awaited<ReturnType<typeof newBrowserOf>> | null = null;
  try {
    await boot(page, alice);
    await equery(page, aliceNick, bob.nick);
    const device = await soleE2eDevice(alice.token, NETWORK_SLUG);
    second = await newBrowserOf(browser, alice);
    const aliceB = second.page;

    const code = await joinWithLink(page, aliceB);
    const wrong = String((Number(code) + 1) % 100).padStart(2, "0");
    expect(wrong).not.toBe(code);
    await typeCode(page, wrong);

    await expect(page.getByTestId("code-mismatch")).toBeVisible({ timeout: STEP });
    await expect(aliceB.getByTestId("pair-ended")).toBeVisible({ timeout: STEP });
    await expect(aliceB.getByTestId("pair-confirm")).toHaveCount(0);
    await expect(page.locator('[data-testid^="pair-result-"]')).toHaveCount(0);

    // grappa still lists only A's device, and it is the one A started with.
    expect(await soleE2eDevice(alice.token, NETWORK_SLUG)).toEqual(device);
  } finally {
    await second?.context.close();
    await teardownSpecSubject(bob);
  }
});
