// issue 2454 — the "undeliverable" row names the device it is about, and each
// browser tells its own device's row from a sibling's, end to end: two
// browser contexts of ONE account paired through the real pairing UI, a raw
// IRC peer, one real ircd, grappa's own sweep.
//
// Since wire v2 the offline queue is per device, and so is the notice: the
// sweep writes one `:server_event` per (sender, device) in the peer's query
// window, carrying `meta.e2e_device` (that device's id). The window is the
// account's, so every browser shows every device's row. Browser A starts the
// identity; browser B is paired into it. The peer sends a message to B's
// device alone, B does not read it (its inbox reads empty, as the offline
// queue spec holds it), and the sweep ages it out. A shows the row naming
// B's device; B shows the same row as "here".
//
// ## What makes this spec able to fail
//
//   * cic ignores `meta.e2e_device` (the bug): A reads "cannot be read here"
//     for a message only B missed, and the A assertion goes red.
//   * cic never learns this browser's own device id (the identity sync does
//     not hand it to the scrollback): B names its own device instead of
//     "here", and the B assertion goes red. A's row would pass without it,
//     since a row names its device while the own id is not known: that half
//     is B's to prove.
//   * The message never reaches B's queue: `awaitE2eQueued` times out, so the
//     absence of a row for A's device is not a message that never left.
//
// The single-device wording ("here" on the only device) stays with the
// offline queue spec, `issue2430-e2e-offline-queue.spec.ts`.

import { randomBytes } from "node:crypto";
import {
  awaitServiceWorkerActive,
  holdE2eInbox,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { boot, equery } from "../fixtures/encryptedQuery";
import { awaitE2eQueued, expireE2eInbox } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import {
  awaitBundleOf,
  newBrowserOf,
  pairFromBanner,
  type SecondBrowser,
} from "../fixtures/pairing";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// How long a page may take to show its shell after a reload, or a row the
// sweep wrote.
const SHOWN_TIMEOUT_MS = 10_000;

// 8 random bytes, standard base64, unpadded: the agreed msgid shape.
const newMsgid = (): string => randomBytes(8).toString("base64").replace(/=+$/, "");

// A device id as the wire spells it (8 bytes, base64url, 11 chars). The
// peer's is made up: nothing here checks the sender's device.
const newDid = (): string => randomBytes(8).toString("base64url");

// A MSG for one device, in MSG v2's compact JSON: the sender's curve key,
// then the body for that device. grappa reads none of it.
const msgPayload = (did: string): string =>
  JSON.stringify({
    v: 2,
    ck: randomBytes(32).toString("base64").replace(/=+$/, ""),
    bodies: { [did]: "AwogY2lwaGVydGV4dA" },
  });

test("a device's undeliverable row reads 'here' on that device and names it on the other", async ({
  page,
  browser,
}) => {
  test.slow();
  const alice = specUser();
  const aliceNick = specNick();
  const peer = await IrcPeer.connect({ nick: "i2454-unread" });
  // B exists only after A started the identity: a browser logging in first
  // would be the one that starts it.
  let second: SecondBrowser | null = null;
  try {
    // A starts the identity and opens the encrypted query that carries the
    // "add a device" button; B pairs into it.
    await boot(page, alice);
    await equery(page, aliceNick, peer.nick);
    second = await newBrowserOf(browser, alice);
    const aliceB = second.page;
    const bDid = await pairFromBanner(page, aliceB, alice.token);

    // B back on the shell, a device of the identity, its sync done (its keys
    // are up). It reads nothing: grappa's queue for it stays grappa's.
    await holdE2eInbox(aliceB, NETWORK_SLUG);
    await aliceB.goto("/");
    await awaitServiceWorkerActive(aliceB);
    await expect(sidebarWindow(aliceB, NETWORK_SLUG, AUTOJOIN_CHANNELS[0])).toBeVisible({
      timeout: SHOWN_TIMEOUT_MS,
    });
    await awaitBundleOf(alice.token, bDid);

    // A message for B's device alone, queued for it.
    const msgid = newMsgid();
    peer.e2eSend(aliceNick, "MSG", msgid, newDid(), bDid, msgPayload(bDid));
    expect((await awaitE2eQueued(alice.token, NETWORK_SLUG, bDid, msgid)).to_did).toBe(bDid);

    await expireE2eInbox(alice.token, NETWORK_SLUG);

    const wording = (where: string) =>
      `*** ${peer.nick} sent you 1 encrypted message that cannot be read ${where}`;

    // A: the row is its sibling's, named by the id grappa routes B by.
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, {
      timeout: SHOWN_TIMEOUT_MS,
    });
    await selectChannel(page, NETWORK_SLUG, peer.nick);
    const onA = page.getByTestId("e2e-undeliverable");
    await expect(onA).toHaveCount(1, { timeout: SHOWN_TIMEOUT_MS });
    await expect(onA).toHaveText(wording(`on your device ${bDid}`));
    await expect(onA.locator("code")).toHaveText(bDid);

    // B: the same row, its own.
    await expect(sidebarWindow(aliceB, NETWORK_SLUG, peer.nick)).toHaveCount(1, {
      timeout: SHOWN_TIMEOUT_MS,
    });
    await selectChannel(aliceB, NETWORK_SLUG, peer.nick);
    const onB = aliceB.getByTestId("e2e-undeliverable");
    await expect(onB).toHaveCount(1, { timeout: SHOWN_TIMEOUT_MS });
    await expect(onB).toHaveText(wording("here"));
  } finally {
    await second?.context.close();
    await peer.disconnect("2454 undeliverable device done");
  }
});
