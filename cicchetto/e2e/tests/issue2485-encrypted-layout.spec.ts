// issue 2485 — the encrypted query window as vjt laid it out for production,
// end to end: two browsers, two grappa users, two real vodozemac engines, one
// real ircd. The rulings are on the issue and in DESIGN_NOTES #2485:
//   * the chat body shows only what finishing the key exchange needs, and
//     nothing of the E2E machinery once it is done (a pinned key, no alarm
//     open, verified or not);
//   * the right rail holds every key setting and action, in sections;
//   * the top bar shows the peer's verification only (plus the chat's two
//     tools, a magnifier and a shredder), and the emoji comparison runs in the
//     window itself, a dialog over the chat body, nothing sent until it ends.
//
// One flow walks all three: before the exchange, after it (keys taken on
// first use: unverified), and after an emoji comparison (verified). A second,
// on a phone, walks the one path a phone changes: the rail is a drawer OVER
// the pane, reached from the top bar's ☰, and a comparison the peer asks for
// while it is open opens its dialog in the pane behind it, so the drawer has
// to go. Issue 2507: the comparison starts from the top bar's trust badge,
// no longer from the rail.
//
// ## What makes this spec able to fail
//
//   * A key event comes back as a chat row (pinned, taken, compared): the body
//     shows a row that is neither in nor out, or a master key in its text.
//   * The step card outlives the exchange, or never shows before it.
//   * A key setting stays in the pane or the top bar, or leaves the rail: a
//     key or an input under the top bar, or a key action missing from the
//     rail's sections.
//   * The comparison runs anywhere but over the chat body, or leaves the body
//     usable while it runs.
//   * On a phone: the top bar hosts no door to the rail, or the drawer stays
//     over the dialog a peer's request opened.

import type { Page } from "@playwright/test";
import {
  boot,
  equery,
  KEYS_TIMEOUT,
  ownKey,
  peerPage,
  row,
  send,
} from "../fixtures/encryptedQuery";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

const topBar = (page: Page) => page.getByTestId("e2e-pane").locator("header");
const body = (page: Page) => page.getByTestId("e2e-pane").locator(".e2e-body");
const rail = (page: Page) => page.getByTestId("e2e-rail");
const trust = (page: Page) => page.getByTestId("e2e-peer-trust");

// The chat body holds messages and nothing else of the E2E machinery: only
// message lines (issue 2498: the scrollback's own), no step card, no master
// key anywhere in its text.
async function bodyIsClean(page: Page, keys: string[]): Promise<void> {
  await expect(body(page).getByTestId("e2e-step")).toHaveCount(0);
  const kinds = await body(page)
    .getByTestId("scrollback-line")
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-kind")));
  expect(kinds.length).toBeGreaterThan(0);
  expect(kinds.filter((k) => k !== "privmsg")).toEqual([]);
  const text = (await body(page).textContent()) ?? "";
  for (const key of keys) expect(text).not.toContain(key);
}

// The top bar is the peer's verification: the badge (the comparison's door,
// issue 2507), the check signal when there is one, and the chat's two tools.
// No key, no input, no comparison running in it.
async function topBarIsVerificationOnly(page: Page, keys: string[]): Promise<void> {
  const bar = topBar(page);
  await expect(bar.getByTestId("e2e-peer-trust")).toHaveCount(1);
  await expect(bar.getByTestId("e2e-search-toggle")).toHaveCount(1);
  await expect(bar.getByTestId("e2e-delete-chat")).toHaveCount(1);
  await expect(bar.locator("input")).toHaveCount(0);
  await expect(bar.getByTestId("e2e-sas")).toHaveCount(0);
  const text = (await bar.textContent()) ?? "";
  for (const key of keys) expect(text).not.toContain(key);
}

test("the encrypted window: key steps in the chat until the exchange is done, settings in the rail, verification in the top bar, the comparison over the chat", async ({
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
    const keys = [aliceKey, bobKey];

    // Before the exchange: the one step still needed, and the rail holds
    // every key setting and action, in its two sections.
    const step = body(page).getByTestId("e2e-step");
    await expect(step).toHaveAttribute("data-step", "no-key");
    await expect(step).toContainText(`no keys exchanged with ${bob.nick} yet`);
    const peerSection = rail(page).getByTestId("e2e-rail-peer");
    const ownSection = rail(page).getByTestId("e2e-rail-own");
    await expect(peerSection.getByTestId("e2e-peer-key")).toHaveText("none yet");
    await expect(peerSection.getByTestId("e2e-pin-input")).toBeVisible();
    await expect(ownSection.getByTestId("e2e-own-identity")).toHaveText(aliceKey);
    await expect(ownSection.getByTestId("e2e-own-identity-copy")).toBeVisible();
    await expect(ownSection.getByTestId("e2e-add-device")).toBeVisible();
    await topBarIsVerificationOnly(page, keys);
    await expect(trust(page)).toHaveAttribute("data-trust", "unverified");

    // The exchange: Alice writes, each side takes the other's key on first
    // use. Done, unverified: the step goes, and nothing replaces it.
    const hello = "ciao bob, scambiamo le chiavi";
    await send(page, hello);
    await expect(row(peer.page, "in", hello)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    const reply = "ricevuto";
    await send(peer.page, reply);
    await expect(row(page, "in", reply)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    for (const [p, key] of [
      [page, bobKey],
      [peer.page, aliceKey],
    ] as const) {
      await expect(rail(p).getByTestId("e2e-peer-key")).toHaveText(key);
      await expect(trust(p)).toHaveAttribute("data-trust", "unverified");
      await bodyIsClean(p, keys);
      await topBarIsVerificationOnly(p, keys);
    }
    await expect(peerSection.getByTestId("e2e-peer-devices")).toHaveText("1 device");
    await expect(peerSection.getByTestId("e2e-rail-trust")).toHaveAttribute(
      "data-trust",
      "unverified",
    );

    // The comparison starts from the top bar's badge (issue 2507) and runs
    // over each chat body: a dialog inside the window, the body inert
    // beneath it.
    await trust(page).click();
    const aliceDialog = body(page).getByRole("dialog");
    await expect(aliceDialog).toHaveAttribute("data-phase", "waiting", { timeout: KEYS_TIMEOUT });
    const bobDialog = body(peer.page).getByRole("dialog");
    await expect(bobDialog).toHaveAttribute("data-phase", "asked", { timeout: KEYS_TIMEOUT });
    for (const p of [page, peer.page]) {
      await expect
        .poll(() =>
          body(p)
            .locator(".e2e-body-content")
            .evaluate((el) => (el as HTMLElement).inert),
        )
        .toBe(true);
      await topBarIsVerificationOnly(p, keys);
    }
    await bobDialog.getByTestId("e2e-sas-accept").click();
    await expect(aliceDialog).toHaveAttribute("data-phase", "compare", { timeout: KEYS_TIMEOUT });
    await expect(bobDialog).toHaveAttribute("data-phase", "compare", { timeout: KEYS_TIMEOUT });
    await expect(aliceDialog.getByTestId("e2e-sas-emoji")).toHaveCount(7);
    await aliceDialog.getByTestId("e2e-sas-match").click();
    await bobDialog.getByTestId("e2e-sas-match").click();

    // Verified: the top bar says so, the rail says how it ended, and the
    // chat body is back to messages alone, usable again.
    for (const p of [page, peer.page]) {
      await expect(trust(p)).toHaveAttribute("data-trust", "verified", { timeout: KEYS_TIMEOUT });
      await expect(body(p).getByRole("dialog")).toHaveCount(0);
      await expect(rail(p).getByTestId("e2e-rail-comparison")).toHaveText("matched");
      await expect
        .poll(() =>
          body(p)
            .locator(".e2e-body-content")
            .evaluate((el) => (el as HTMLElement).inert),
        )
        .toBe(false);
      await bodyIsClean(p, keys);
      await topBarIsVerificationOnly(p, keys);
    }
    const after = "verificati";
    await send(page, after);
    await expect(row(peer.page, "in", after)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await bodyIsClean(peer.page, keys);
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});

test("@touch on a phone, the encrypted window's top bar opens the rail, and a comparison the peer asks for closes the drawer over its dialog", async ({
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

    // Keys taken on first use: a pinned key, not verified, so either side
    // can ask to compare.
    const hello = "ciao bob, dal telefono";
    await send(page, hello);
    await expect(row(peer.page, "in", hello)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    const reply = "ricevuto";
    await send(peer.page, reply);
    await expect(row(page, "in", reply)).toHaveCount(1, { timeout: KEYS_TIMEOUT });

    // The rail's door is the top bar's last control: the floating ☰ would
    // land on the shredder.
    const drawer = page.locator(".shell-members.open");
    await expect(drawer).toHaveCount(0);
    await topBar(page).locator(".topic-bar-hamburger").tap();
    await expect(drawer).toHaveCount(1);
    await expect(rail(page).getByTestId("e2e-pin-input")).toBeVisible();

    // Bob asks while the phone shows the rail: the request opens its dialog
    // over the chat body, behind the drawer, so the drawer goes and the
    // dialog is what the phone shows.
    await trust(peer.page).click();
    await expect(body(peer.page).getByRole("dialog")).toHaveAttribute("data-phase", "waiting", {
      timeout: KEYS_TIMEOUT,
    });
    const dialog = body(page).getByRole("dialog");
    await expect(dialog).toHaveAttribute("data-phase", "asked", { timeout: KEYS_TIMEOUT });
    await expect(drawer).toHaveCount(0);
    await expect(dialog).toBeVisible();
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
