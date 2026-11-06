// issue 2544 — vjt's rulings on the encrypted query's key, points 1 and 3:
//   1. the key the peer's nick is pinned to is verified with a button beside
//      it in the rail, for when the user compared it with the peer out of
//      band; the form that pinned a pasted key is gone (either the key shown
//      is the peer's, or someone is in the middle and the chat must be
//      closed);
//   3. a tap on the top bar's trust badge shows the peer's whole key, all 43
//      characters: verified, the key alone; not verified, the key with the
//      same verify button and the emoji comparison as a second action. The
//      key is the full Ed25519 key, 256 bits, compared out of band; the emoji
//      are a ~42-bit summary, safe only inside the synchronous comparison.
//
// Two browsers, two grappa users, two real vodozemac engines, one real ircd.
// The keys are taken on first use (a line each way), so each side holds the
// other's key, not verified. On desktop Alice verifies Bob's from the badge's
// dialog and Bob verifies Alice's from the rail: each reads the key off the
// other's own pane, as a person compares it with a peer. On a phone the
// badge is the one door in reach, the rail being a drawer.
//
// ## What makes this spec able to fail
//
//   * The badge's dialog does not show the peer's whole key, or shows another
//     key than the one the peer holds.
//   * Verify does not verify, or verifies on the wrong side: the badge does
//     not read verified, or the peer's badge moves too.
//   * A verified key still offers verify or the emoji comparison, or a key
//     not verified does not offer both.
//   * The rail still holds a field to paste a key, or no verify button beside
//     a key not verified.
//   * On a phone, the key's dialog opens out of view, or the tap opens the
//     drawer. (A drawer already open when a dialog opens is closed by the
//     pane's `onDialogOpen`, pinned by the unit suite, not walked here.)

import type { Page } from "@playwright/test";
import {
  boot,
  equery,
  KEYS_TIMEOUT,
  keyDialog,
  ownKey,
  peerPage,
  row,
  send,
  trust,
  verify,
} from "../fixtures/encryptedQuery";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

const rail = (page: Page) => page.getByTestId("e2e-rail");
const body = (page: Page) => page.getByTestId("e2e-pane").locator(".e2e-body");

// A line each way: each side takes the other's key on first use, not verified.
async function exchangeKeys(alice: Page, bob: Page): Promise<void> {
  const hello = "2544 ciao, scambiamo le chiavi";
  await send(alice, hello);
  await expect(row(bob, "in", hello)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
  const reply = "2544 ricevuto";
  await send(bob, reply);
  await expect(row(alice, "in", reply)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
  for (const p of [alice, bob]) {
    await expect(trust(p)).toHaveAttribute("data-trust", "unverified");
  }
}

// The key the badge's dialog shows: the whole key, as the peer holds it.
async function dialogShows(page: Page, key: string): Promise<void> {
  await expect(keyDialog(page)).toBeVisible();
  await expect(keyDialog(page).getByTestId("e2e-key-dialog-key")).toHaveText(key);
  expect(key).toMatch(/^[A-Za-z0-9+/]{43}$/);
}

test("issue 2544 — the badge shows the peer's whole key and verifies it, the rail verifies it beside the key, and nothing pastes one", async ({
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
    const aliceKey = await ownKey(page);
    const bobKey = await ownKey(peer.page);

    // Before any key: nothing to verify, and no field to paste one.
    await expect(rail(page).getByTestId("e2e-peer-verify")).toHaveCount(0);
    await expect(rail(page).locator("input")).toHaveCount(0);

    await exchangeKeys(page, peer.page);
    await expect(rail(page).getByTestId("e2e-peer-key")).toHaveText(bobKey);
    await expect(rail(page).getByTestId("e2e-peer-verify")).toBeVisible();
    await expect(rail(page).locator("input")).toHaveCount(0);

    // Alice, from the badge: the whole key, verify first, the emoji second.
    await trust(page).click();
    await dialogShows(page, bobKey);
    const actions = await keyDialog(page)
      .locator("button")
      .evaluateAll((buttons) => buttons.map((b) => b.getAttribute("data-testid")));
    expect(actions).toEqual(["e2e-key-verify", "e2e-key-compare", "e2e-key-close"]);
    await expect
      .poll(() =>
        body(page)
          .locator(".e2e-body-content")
          .evaluate((el) => (el as HTMLElement).inert),
      )
      .toBe(true);
    await keyDialog(page).getByTestId("e2e-key-verify").click();
    await expect(keyDialog(page)).toHaveCount(0);
    await expect(trust(page)).toHaveAttribute("data-trust", "verified");
    await expect(rail(page).getByTestId("e2e-rail-trust")).toHaveAttribute(
      "data-trust",
      "verified",
    );
    await expect(rail(page).getByTestId("e2e-peer-verify")).toHaveCount(0);
    // No emoji were compared, and the rail does not say they were.
    await expect(rail(page).getByTestId("e2e-rail-comparison")).toHaveCount(0);
    // One side's verification: Bob's view of Alice's key has not moved.
    await expect(trust(peer.page)).toHaveAttribute("data-trust", "unverified");

    // Verified: the badge shows the key alone, from the keyboard too.
    await page.getByRole("button", { name: /^verified: show .*'s key$/ }).press("Enter");
    await dialogShows(page, bobKey);
    await expect(keyDialog(page).getByTestId("e2e-key-verify")).toHaveCount(0);
    await expect(keyDialog(page).getByTestId("e2e-key-compare")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(keyDialog(page)).toHaveCount(0);

    // Bob, from the rail: the button beside the key.
    await verify(peer.page, aliceKey);
    await expect(rail(peer.page).getByTestId("e2e-rail-comparison")).toHaveCount(0);

    // Verified both ways, the chat goes on.
    const after = "2544 verificati a mano";
    await send(page, after);
    await expect(row(peer.page, "in", after)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});

test("@touch @webkit issue 2544 — on a phone, a tap on the badge shows the peer's whole key in view and verifies it, the drawer shut", async ({
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
    const bobKey = await ownKey(peer.page);
    await exchangeKeys(page, peer.page);

    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toHaveCount(0);
    await trust(page).tap();
    await dialogShows(page, bobKey);
    // The whole key on screen, and the verify button with it.
    await expect(keyDialog(page).getByTestId("e2e-key-dialog-key")).toBeInViewport({ ratio: 1 });
    await expect(keyDialog(page).getByTestId("e2e-key-verify")).toBeInViewport();
    await expect(drawer).toHaveCount(0);

    await keyDialog(page).getByTestId("e2e-key-verify").tap();
    await expect(keyDialog(page)).toHaveCount(0);
    await expect(trust(page)).toHaveAttribute("data-trust", "verified");
    await expect(drawer).toHaveCount(0);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
