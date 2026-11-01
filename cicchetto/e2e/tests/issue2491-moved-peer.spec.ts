// issue 2491 — a message that none of the peer's devices can read comes back
// as a NACK, and the sender re-keys only when the user asks. Two browsers, two
// grappa users, two real vodozemac engines, one real ircd.
//
// Alice and Bob already talk in an encrypted query. Bob's browser forgets its
// identity and he starts a new one (the e2e stand-in for a peer that moved to
// another grappa: either way the device Alice's session is keyed to is no
// longer listed for his nick). Alice writes: Bob's grappa holds no listed
// device the message is addressed to, so instead of dropping it in silence it
// NACKs it from `*` (vjt's ruling on 2491, lifting the 2430 "no sender-side
// notice" for this case). Alice's line reads not sent, and the chat's step
// says the peer could not read it. Nothing re-keys on its own: the peer may be
// an impostor. Alice asks for the keys again, the new master raises the key
// alarm, she takes it unverified, verifies it by comparing emoji, and what she
// writes next reaches Bob.
//
// ## What makes this spec able to fail
//
//   * grappa drops the message instead of NACKing it, or NACKs it from a
//     device the line was not addressed to: Alice's line never reads failed,
//     and the step never appears.
//   * cic reads the NACK as a refusal by a known device, or as a lost
//     session: the failure names another reason, or the engine re-keys by
//     itself and the step goes straight to the alarm with no click.
//   * The re-key asks nobody, or the answer is pinned without the alarm: the
//     step never reads alarm, or the rail shows no ignored key.
//   * The new key is taken but no session reaches Bob's new device: the
//     comparison never starts, or the last line never arrives.

import {
  AFTER_A_REASK,
  boot,
  compareEmoji,
  equery,
  KEYS_TIMEOUT,
  ownKey,
  peerPage,
  replaceIdentity,
  row,
  send,
  trust,
} from "../fixtures/encryptedQuery";
import { provisionPeerSubject, teardownSpecSubject } from "../fixtures/specSubject";
import { expect, specNick, specUser, test } from "../fixtures/test";

test("a message no device of the peer can read comes back as not sent, and the user's re-key goes through the alarm and the emoji", async ({
  page,
  browser,
}, testInfo) => {
  // Two boots, a reload, a NACK that waits on grappa's pacer, a re-key and a
  // comparison that may each wait for a re-ask.
  test.setTimeout(240_000);
  const alice = specUser();
  const aliceNick = specNick();
  const bob = await provisionPeerSubject(testInfo, "bob");
  const peer = await peerPage(browser);
  try {
    await boot(page, alice);
    await boot(peer.page, bob.user);
    await equery(page, aliceNick, bob.nick);
    await equery(peer.page, bob.nick, aliceNick);
    const hello = "ciao bob";
    await send(page, hello);
    await expect(row(peer.page, "in", hello)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
    const oldKey = await ownKey(peer.page);
    await expect(page.getByTestId("e2e-peer-key")).toHaveText(oldKey);

    // Bob's browser forgets its identity and he starts a new one: grappa now
    // lists only the new device for his nick.
    await peer.page.evaluate(() => window.__cic_e2eResetForTests?.());
    await peer.page.reload();
    await equery(peer.page, bob.nick, aliceNick);
    await expect(peer.page.getByTestId("e2e-identity-elsewhere")).toBeVisible();
    await replaceIdentity(peer.page);
    const newKey = await ownKey(peer.page);
    expect(newKey).not.toBe(oldKey);

    // Alice writes on the session she has: it is addressed to the old device.
    // Bob's grappa NACKs it from `*` (after its pacer's post-handshake bank),
    // and Alice's line reads not sent.
    const lost = "mi leggi ancora?";
    await send(page, lost);
    const state = row(page, "out", lost).getByTestId("e2e-row-state");
    await expect(state).toHaveAttribute("data-state", "failed", { timeout: KEYS_TIMEOUT });
    await expect(state).toContainText("none of the peer's devices can read it");
    await expect(row(peer.page, "in", lost)).toHaveCount(0);
    const step = page.getByTestId("e2e-step");
    await expect(step).toHaveAttribute("data-step", "unreadable");
    // Nothing was asked on Alice's behalf: the old key is still the pinned one.
    await expect(page.getByTestId("e2e-peer-key")).toHaveText(oldKey);
    await expect(trust(page)).toHaveAttribute("data-trust", "unverified");

    // Alice asks for the keys again. The answer carries a master she never
    // pinned: the alarm, with the new key in the rail. (The step may pass
    // through "rekey-asked" faster than a poll, so only the alarm is awaited.)
    // grappa answered her first request for Bob's keys moments ago, so this
    // one may wait for cic's re-ask.
    await step.getByTestId("e2e-rekey").click();
    await expect(step).toHaveAttribute("data-step", "alarm", { timeout: AFTER_A_REASK });
    await expect(page.getByTestId("e2e-rail-alarm-key")).toHaveText(newKey);
    await expect(trust(page)).toHaveAttribute("data-trust", "alarm");

    // She takes the new key unverified, then verifies it by comparing emoji.
    await step.getByTestId("e2e-alarm-accept").click();
    await expect(page.getByTestId("e2e-peer-key")).toHaveText(newKey);
    await expect(trust(page)).toHaveAttribute("data-trust", "unverified");
    await expect(page.getByTestId("e2e-step")).toHaveCount(0);
    await compareEmoji(page, peer.page, await ownKey(page), newKey, AFTER_A_REASK);

    // And what she writes now reaches Bob's new device.
    const back = "eccoti, ora ti leggo";
    await send(page, back);
    await expect(row(peer.page, "in", back)).toHaveCount(1, { timeout: KEYS_TIMEOUT });
  } finally {
    await peer.context.close();
    await teardownSpecSubject(bob);
  }
});
