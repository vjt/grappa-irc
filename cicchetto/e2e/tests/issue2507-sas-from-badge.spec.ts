// issue 2507 — vjt, after testing the encrypted flow end to end: a new
// encrypted chat showed, in the chat area, inputs to paste the peer's key,
// the most prominent thing on screen and noise for anyone not pinning a
// bot's key; and the emoji comparison, what matters to a normal user, was
// the hard thing to find. His rulings (on the issue): key pinning lives in
// the right rail only, and the comparison, the synchronized 7-emoji exchange
// kept as it is, starts from a tap on the top bar's `not verified` or
// `verified` badge, with no more taps and screens than the protocol needs.
//
// Two browsers, two grappa users, two real vodozemac engines, one real ircd.
// The desktop test walks the chat before the exchange (no key to paste in
// the chat area, the rail's pin form still there), then one tap on
// `not verified` to a match, then one tap on `verified` to check again. The
// phone test walks the same tap where the rail is a drawer: before 2507 the
// comparison was behind the ☰, now the badge is one tap in the top bar, and
// a tap target.
//
// ## What makes this spec able to fail
//
//   * The chat area holds a key input again (the no-key card's pin form, the
//     alarm card's): an `input` under the chat body.
//   * The badge is not the comparison's door: a click on it opens no dialog,
//     or opens it only while not verified (no check again).
//   * The rail still offers its own start: a button naming the comparison.
//   * On a phone, the badge's door is smaller than the tap floor, or reaching
//     the comparison still opens the drawer.

import type { Page } from "@playwright/test";
import {
  boot,
  compareEmoji,
  equery,
  KEYS_TIMEOUT,
  ownKey,
  peerPage,
  row,
  send,
  trust,
} from "../fixtures/encryptedQuery";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

const body = (page: Page) => page.getByTestId("e2e-pane").locator(".e2e-body");
const rail = (page: Page) => page.getByTestId("e2e-rail");
const dialog = (page: Page) => body(page).getByRole("dialog");

// Before the exchange the chat body says what to do, and has nothing to
// paste a key into: the compose box is its only text field.
async function noKeyInputInChat(page: Page, peer: string): Promise<void> {
  const step = body(page).getByTestId("e2e-step");
  await expect(step).toHaveAttribute("data-step", "no-key");
  await expect(step).toContainText(`no keys exchanged with ${peer} yet`);
  await expect(body(page).locator("input")).toHaveCount(0);
  await expect(step.locator("button")).toHaveCount(0);
  await expect(body(page).locator("textarea")).toHaveCount(1);
}

// Each side takes the other's key on first use: pinned, not verified.
async function exchangeKeys(alice: Page, bob: Page): Promise<void> {
  const hello = "ciao bob, scambiamo le chiavi";
  await send(alice, hello);
  await expect(row(bob, "in", hello)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
  const reply = "ricevuto";
  await send(bob, reply);
  await expect(row(alice, "in", reply)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
  for (const p of [alice, bob]) {
    await expect(trust(p)).toHaveAttribute("data-trust", "unverified");
  }
}

test("a new encrypted chat has no key to paste in the chat area, and the emoji comparison is one tap on the top bar's badge, verified or not", async ({
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

    await noKeyInputInChat(page, bob.nick);
    await expect(rail(page).getByTestId("e2e-pin-input")).toBeVisible();
    await expect(rail(page).getByTestId("e2e-own-identity-copy")).toBeVisible();

    await exchangeKeys(page, peer.page);
    await expect(rail(page).getByRole("button", { name: /compar/ })).toHaveCount(0);

    // `not verified`: one click on the badge is the whole start. The fixture
    // clicks it once, then walks accept, compare and match to verified.
    await compareEmoji(page, peer.page, await ownKey(page), await ownKey(peer.page), KEYS_TIMEOUT);

    // `verified`: the same badge checks again. Bob declines, and nothing
    // changes but the dialogs going.
    await trust(page).click();
    await expect(dialog(page)).toHaveAttribute("data-phase", "waiting", { timeout: KEYS_TIMEOUT });
    await expect(dialog(peer.page)).toHaveAttribute("data-phase", "asked", {
      timeout: KEYS_TIMEOUT,
    });
    await dialog(peer.page).getByTestId("e2e-sas-cancel").click();
    for (const p of [page, peer.page]) {
      await expect(dialog(p)).toHaveCount(0, { timeout: KEYS_TIMEOUT });
      await expect(trust(p)).toHaveAttribute("data-trust", "verified");
    }
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});

test("@touch on a phone, the emoji comparison is one tap on the top bar's badge, a tap target, and the rail's drawer stays shut", async ({
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

    await noKeyInputInChat(page, bob.nick);
    await exchangeKeys(page, peer.page);

    // The door is the button the badge sits in: at least the tap floor tall.
    const door = page.getByRole("button", { name: /^not verified: compare emoji with / });
    await expect(door).toBeVisible();
    const box = await door.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);

    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toHaveCount(0);
    await trust(page).tap();
    await expect(dialog(page)).toHaveAttribute("data-phase", "waiting", { timeout: KEYS_TIMEOUT });
    await expect(dialog(page)).toBeInViewport();
    await expect(drawer).toHaveCount(0);
    await expect(dialog(peer.page)).toHaveAttribute("data-phase", "asked", {
      timeout: KEYS_TIMEOUT,
    });
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
