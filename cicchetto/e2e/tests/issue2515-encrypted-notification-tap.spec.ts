// issue 2515 — tapping the "encrypted message" notification from a peer opens
// the ENCRYPTED query with that peer: never the plaintext query, whether one
// is already open or not (vjt's report: it opened the plaintext one, in both
// cases).
//
// The tap is the real one as far as a headless browser allows: a
// `notificationclick` dispatched into the live service worker, whose handler
// posts the navigate to the page (`tapNotification`, the #146 recurrence
// harness), and the cold shape — the app not running, the SW's
// `openWindow(url)` booting a fresh document at the deep link, served by the
// SW that controls the origin. The deep link is the one the server writes for
// an encrypted message (`buildEncryptedPushDeepLink` ↔
// `Push.Payload.build_e2e/2`, pinned server-side): a push payload is
// encrypted for the push service, so the spec cannot read it off the wire.
//
// No second person is needed: the notification names the peer, and the tap
// opens the encrypted chat with it the way `/equery` does, whether or not a
// message from it reached this device yet.
//
// ## What makes this spec able to fail
//
//   * The tap focuses the plaintext query (the bug): the encrypted window is
//     not the selected row, the pane is not the encrypted one.
//   * The tap opens a plaintext query that was not there. Read off the server
//     after a reload, not off the sidebar as the tap left it: an open the tap
//     asked for may not have come back yet, so an absence there passes at once.
//   * The cold boot routes nowhere, or to the plaintext query.
//
// The service-worker tap runs on desktop chromium only: Playwright reaches a
// service worker on Chromium alone. The cold boot runs there and on both
// phones (`@webkit` for the engine of the report, an iOS PWA; `@touch` for
// the other), where the bottom bar holds the windows.

import type { Page } from "@playwright/test";
import {
  composeSend,
  selectChannel,
  sidebarWindow,
  waitForQueryWindowReady,
} from "../fixtures/cicchettoPage";
import { boot, composer, e2eWindow } from "../fixtures/encryptedQuery";
import { buildEncryptedPushDeepLink, tapNotification } from "../fixtures/pushTap";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// One peer per test, so no test's windows can answer another's assertions.
const PEER_WITH_QUERY = "e2515-plain";
const PEER_NO_QUERY = "e2515-none";
const PEER_COLD = "e2515-cold";
// A plaintext query opened before the tap: in the list the server sends on a
// join, it proves the list has landed.
const CONTROL = "e2515-control";

/** Opens the plaintext query with `nick` from a channel's compose box, and waits until it is live. */
async function openPlaintextQuery(page: Page, nick: string): Promise<void> {
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
  await composeSend(page, `/query ${nick}`);
  await waitForQueryWindowReady(page, NETWORK_SLUG, nick);
}

// The encrypted query with `nick` is the focused window, and it is the
// encrypted pane that shows, composing to `nick`.
async function encryptedQueryFocused(page: Page, nick: string): Promise<void> {
  await expect(sidebarWindow(page, NETWORK_SLUG, e2eWindow(nick))).toHaveClass(/selected/, {
    timeout: 15_000,
  });
  await expect(page.getByTestId("e2e-pane")).toBeVisible();
  await expect(composer(page)).toHaveAttribute("placeholder", `encrypted message to ${nick}`);
}

// The server holds no plaintext query with `peer`: a reload is a fresh join,
// whose snapshot lists every query window the server holds, CONTROL included.
async function noPlaintextQueryOnServer(page: Page, peer: string): Promise<void> {
  await page.reload();
  await expect(sidebarWindow(page, NETWORK_SLUG, CONTROL)).toHaveCount(1, { timeout: 15_000 });
  await expect(sidebarWindow(page, NETWORK_SLUG, peer)).toHaveCount(0);
}

test.describe("issue 2515 — the encrypted-message notification opens the encrypted query", () => {
  test("with a plaintext query already open, the tap opens the encrypted one", async ({
    page,
    context,
  }) => {
    await boot(page, specUser());
    await openPlaintextQuery(page, PEER_WITH_QUERY);
    // The premise: the plaintext query is there, and it is where the reader is.
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_WITH_QUERY)).toHaveClass(/selected/);

    await tapNotification(context, buildEncryptedPushDeepLink(NETWORK_SLUG, PEER_WITH_QUERY));

    await encryptedQueryFocused(page, PEER_WITH_QUERY);
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_WITH_QUERY)).not.toHaveClass(/selected/);
  });

  test("with no plaintext query, the tap opens the encrypted one and no plaintext query", async ({
    page,
    context,
  }) => {
    await boot(page, specUser());
    await openPlaintextQuery(page, CONTROL);
    await expect(sidebarWindow(page, NETWORK_SLUG, PEER_NO_QUERY)).toHaveCount(0);

    await tapNotification(context, buildEncryptedPushDeepLink(NETWORK_SLUG, PEER_NO_QUERY));

    await encryptedQueryFocused(page, PEER_NO_QUERY);
    await noPlaintextQueryOnServer(page, PEER_NO_QUERY);
  });

  test("with the app not running, the tap boots it on the encrypted query", async ({ page }) => {
    await coldTap(page);
  });

  test("@webkit @touch on a phone, with the app not running, the tap boots it on the encrypted query", async ({
    page,
  }) => {
    await coldTap(page);
  });
});

// Logged in once, so the service worker controls the origin; the tap then
// boots a fresh document at the deep link, as `openWindow(url)` does on an
// installed PWA.
async function coldTap(page: Page): Promise<void> {
  await boot(page, specUser());
  await openPlaintextQuery(page, CONTROL);
  await page.goto(buildEncryptedPushDeepLink(NETWORK_SLUG, PEER_COLD));

  await encryptedQueryFocused(page, PEER_COLD);
  await noPlaintextQueryOnServer(page, PEER_COLD);
}
