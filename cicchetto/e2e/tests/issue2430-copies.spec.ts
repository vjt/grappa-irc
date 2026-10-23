// issue 2430 S1 — a text sent from one device of an account shows on the
// account's other devices as sent, end to end: three browser contexts, two
// grappa users, real vodozemac engines, one real ircd.
//
// Browser A starts Alice's identity and opens an encrypted query with Bob;
// browser B, a second login of Alice with fresh storage, is paired into the
// identity through the real pairing UI (`fixtures/pairing.ts`). A then writes
// to Bob. Once grappa takes the text, A lists the account's devices, claims a
// one-time key of B (`POST …/e2e/devices/:did/claim`), and queues a copy
// encrypted to B through the copy door (`POST …/e2e/devices/:did/copies`),
// never IRC. grappa pushes it to B flagged `own`; B's drain reads it on the
// copy path (`Engine.receiveCopy`) and writes an `out` row, sent, in its chat
// with Bob, a chat B never opened. B never writes to Bob here, so an `out`
// row on B can only be a copy.
//
// ## What makes this spec able to fail
//
//   * A copies nothing, or to no sibling (the device list is not read, B is
//     not admitted, the claim or the copy door fails), or B cannot read the
//     copy (the session, the sibling check, the `own` routing): B never
//     shows the encrypted window with Bob.
//   * B shows the copy as a message Bob wrote, as unread, as not sent, or
//     twice: the `in`-row absence, the badge absence, `data-state` or the
//     count goes red.
//   * The second text claims a new key instead of riding the session the
//     first opened: the claim count reads 2. The session not kept at all:
//     the second text never shows on B.
//   * A shows a text of its own twice, or B never acknowledges what it read
//     (its inbox on grappa is not empty at the end).
//
// ## What it does not cover
//
// A text grappa REFUSES is never copied: that is `e2eClient.test.ts` ("a text
// grappa refuses is never copied"). No real refusal is reachable here without
// contortions: every one the send door answers takes a full peer queue (32
// texts through the pacer), a payload the engine will not build, a device
// grappa does not list, an order deadline, or no live session upstream. And
// faking one with `page.route` would prove the branch, not the behaviour.

import {
  awaitServiceWorkerActive,
  sidebarMessageBadge,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import {
  boot,
  e2eWindow,
  equery,
  KEYS_TIMEOUT,
  peerPage,
  row,
  send,
} from "../fixtures/encryptedQuery";
import { fetchE2eInbox } from "../fixtures/grappaApi";
import { awaitBundleOf, newBrowserOf, pairByLink, type SecondBrowser } from "../fixtures/pairing";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

// How long a page may take to show its shell after a reload.
const SHELL_TIMEOUT_MS = 10_000;

test("a text sent on one device of an account shows on its other device as sent, in a chat it never opened", async ({
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
  let second: SecondBrowser | null = null;
  try {
    // A starts the identity and opens the encrypted query that carries the
    // "add a device" button; B pairs into it.
    await boot(page, alice);
    await equery(page, aliceNick, bob.nick);
    second = await newBrowserOf(browser, alice);
    const aliceB = second.page;
    const bDid = await pairByLink(page, aliceB, alice.token);

    // B back on the shell, a device of the identity, with a key of its own
    // on grappa for A to claim. It opens no encrypted query.
    await aliceB.goto("/");
    await awaitServiceWorkerActive(aliceB);
    await expect(sidebarWindow(aliceB, NETWORK_SLUG, AUTOJOIN_CHANNELS[0])).toBeVisible({
      timeout: SHELL_TIMEOUT_MS,
    });
    await awaitBundleOf(alice.token, bDid);

    // Bob's key bundle is on grappa: it answers A's KEYREQ from it.
    await boot(bobContext.page, bob.user);

    // Every key of B that A asks grappa for, from here on.
    const claimPath = `/networks/${NETWORK_SLUG}/e2e/devices/${bDid}/claim`;
    let claims = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname === claimPath) {
        claims += 1;
      }
    });

    // A writes to Bob, and grappa takes it.
    const first = "una copia per l'altro browser 📱";
    await send(page, first);
    await expect(row(page, "out", first).getByTestId("e2e-row-state")).toHaveAttribute(
      "data-state",
      "sent",
      { timeout: KEYS_TIMEOUT },
    );

    // B gets the chat with Bob it never opened: our own text, so not unread.
    const bobWindow = sidebarWindow(aliceB, NETWORK_SLUG, e2eWindow(bob.nick));
    await expect(bobWindow).toBeVisible({ timeout: KEYS_TIMEOUT });
    await expect(sidebarMessageBadge(aliceB, NETWORK_SLUG, e2eWindow(bob.nick))).toHaveCount(0);

    // In it, the text reads as sent from here, once, and never as Bob's.
    await bobWindow.locator("button").first().click();
    await expect(aliceB.getByTestId("e2e-pane")).toBeVisible();
    const copy = row(aliceB, "out", first);
    await expect(copy).toHaveCount(1);
    await expect(copy.getByTestId("e2e-row-state")).toHaveAttribute("data-state", "sent");
    await expect(row(aliceB, "in", first)).toHaveCount(0);

    // A second text rides the session the first copy opened to B.
    const next = "e una seconda, sulla stessa sessione";
    await send(page, next);
    await expect(row(page, "out", next).getByTestId("e2e-row-state")).toHaveAttribute(
      "data-state",
      "sent",
      { timeout: KEYS_TIMEOUT },
    );
    const nextCopy = row(aliceB, "out", next);
    await expect(nextCopy).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    await expect(nextCopy.getByTestId("e2e-row-state")).toHaveAttribute("data-state", "sent");
    // Both copies are on B, so every claim behind them has been made: one
    // key of B spent for two texts.
    expect(claims).toBe(1);

    // A copied nothing to itself, and B took and acknowledged both copies.
    await expect(row(page, "out", first)).toHaveCount(1);
    await expect(row(page, "out", next)).toHaveCount(1);
    await expect
      .poll(() => fetchE2eInbox(alice.token, NETWORK_SLUG, bDid), { timeout: 10_000 })
      .toEqual([]);
  } finally {
    await second?.context.close();
    await bobContext.context.close();
    await teardownSpecSubject(bob);
  }
});
