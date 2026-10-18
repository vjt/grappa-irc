// issue 2430 — the offline queue of end-to-end encrypted messages, end to end
// through a real ircd.
//
// grappa relays an encrypted query and reads none of it: a peer's `E2E` CTCP
// is reassembled, QUEUED opaque per (subject, network) until a client takes
// it, and never becomes a scrollback row. Two things a human can see come out
// of that queue, and this spec drives both with real frames — peer → bahamut
// → EventRouter → `Grappa.E2eInbox` → the sweep / the push trigger:
//
//   * the recipient-only "undeliverable" notice. What waits past the queue's
//     TTL is dropped, and the recipient — never the sender, by vjt's ruling —
//     is told in the peer's query window how many messages could not be read.
//     The TTL is seven days and the sweep hourly, so the spec ages the queue
//     through the dev/test door `expireE2eInbox`, which then runs the
//     session's OWN sweep: the expiry, the row and the window are production.
//   * the push. A queued message a person wrote (MSG/PKMSG) notifies
//     "encrypted message" from the nick; key material does not.
//
// ## What makes this spec able to fail
//
// The peer's message is never a scrollback row, so the usual barrier —
// `assertMessagePersisted` — cannot prove it arrived. The proof is the queue
// itself (`awaitE2eQueued`), read through the REST door a client drains it
// by. Without it, the "no window yet" and "no push for KEYS" halves below are
// absences that would pass on a message that never left the peer (#1152).
//
//   * Queue the messages without a window: a window minted on arrival would
//     already be in the sidebar before the sweep, and the first absence
//     assertion goes red.
//   * Drop the sweep's notice, or word it wrong: the window never appears, or
//     the line reads differently.
//   * Push for KEYS: the absence arm goes red. Push for nothing: the MSG arm
//     times out.
//
// The payloads hold no real Olm — grappa never decodes one and nobody here
// holds a key — but they are shaped like the agreed wire (padded standard
// base64 of a `"v":1` JSON object, an 11-char unpadded msgid), so the spec
// does not lean on grappa being lax about anything it checks.

import { randomBytes } from "node:crypto";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { awaitE2eQueued, expireE2eInbox, fetchE2eInbox } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import {
  assertNoPushDeliveryAfter,
  awaitPushDeliveryAfter,
  type DeliveryProof,
  enablePushFromSettings,
  expectRfc8291Delivery,
  pushCatcherEndpoint,
  resetPushCatcher,
  resetPushSubscriptions,
  setPageVisibility,
  stubPushManager,
} from "../fixtures/push";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

// 8 random bytes, standard base64, unpadded: the agreed msgid shape.
const newMsgid = (): string => randomBytes(8).toString("base64").replace(/=+$/, "");

// The padded standard base64 of a `"v":1` payload: one whole chunk, 1/1.
const payloadB64 = (payload: Record<string, unknown>): string =>
  Buffer.from(JSON.stringify({ v: 1, ...payload }), "utf8").toString("base64");

// A curve25519 key's shape (32 bytes, unpadded) for the MSG's `ck` field.
const fakeKey = (): string => randomBytes(32).toString("base64").replace(/=+$/, "");

test("encrypted messages nobody reads expire into one recipient-only notice in the peer's query window", async ({
  page,
}) => {
  const vjt = specUser();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: "i2430-unread" });
  try {
    const msgids = [newMsgid(), newMsgid()];
    for (const msgid of msgids) {
      peer.e2eSend(
        specNick(),
        "MSG",
        msgid,
        payloadB64({ ck: fakeKey(), body: "AwogY2lwaGVydGV4dA" }),
      );
    }
    for (const msgid of msgids) {
      const entry = await awaitE2eQueued(vjt.token, NETWORK_SLUG, msgid);
      expect(entry.verb).toBe("msg");
      expect(entry.from).toBe(peer.nick);
    }

    // Queued, not shown: an encrypted message mints no window on arrival —
    // there is nothing grappa could put in it.
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(0);

    await expireE2eInbox(vjt.token, NETWORK_SLUG);

    // The sweep's row opens the query window — the recipient's, and it is
    // the only place the notice is told.
    await expect(sidebarWindow(page, NETWORK_SLUG, peer.nick)).toHaveCount(1, { timeout: 10_000 });
    await selectChannel(page, NETWORK_SLUG, peer.nick);

    const notice = page.locator('[data-testid="e2e-undeliverable"]');
    await expect(notice).toHaveCount(1, { timeout: 10_000 });
    await expect(notice).toHaveText(
      `*** ${peer.nick} sent you 2 encrypted messages that cannot be read here`,
    );

    // What expired is gone: the notice replaces the messages, it does not
    // sit beside them.
    expect(await fetchE2eInbox(vjt.token, NETWORK_SLUG)).toEqual([]);
  } finally {
    await peer.disconnect("2430 offline queue done");
  }
});

test("a queued encrypted message pushes 'encrypted message' from the nick, and key material does not", async ({
  page,
  context,
}) => {
  const vjt = specUser();
  const subId = "issue2430-e2e";
  await resetPushCatcher();
  await resetPushSubscriptions(vjt.token);
  await stubPushManager(context, { endpoint: pushCatcherEndpoint(subId) });
  await context.grantPermissions(["notifications"]);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });
  await enablePushFromSettings(page, context, { id: subId, token: vjt.token });

  // Background the device so #182's foreground suppression decides neither
  // arm: the only variable left between them is the verb.
  await setPageVisibility(page, false);

  const peer = await IrcPeer.connect({ nick: "i2430-pusher" });
  const queued = (msgid: string, verb: string): DeliveryProof => ({
    describe: `<${peer.nick}> E2E ${verb} ${msgid} → ${specNick()}`,
    delivered: async () => {
      await awaitE2eQueued(vjt.token, NETWORK_SLUG, msgid);
    },
  });

  try {
    // Negative arm — KEYS is the protocol talking to itself.
    const keysId = newMsgid();
    peer.e2eSend(
      specNick(),
      "KEYS",
      keysId,
      payloadB64({
        id: { curve25519: fakeKey(), ed25519: fakeKey(), sig: "c2ln" },
        otk: { key: fakeKey(), fallback: false, sig: "c2ln" },
      }),
    );
    await assertNoPushDeliveryAfter(subId, queued(keysId, "KEYS"), 1_500);

    // Positive arm — a MSG is a person writing. It also keeps the negative
    // arm from passing because push broke outright.
    const msgId = newMsgid();
    peer.e2eSend(
      specNick(),
      "MSG",
      msgId,
      payloadB64({ ck: fakeKey(), body: "AwogY2lwaGVydGV4dA" }),
    );
    const deliveries = await awaitPushDeliveryAfter(subId, queued(msgId, "MSG"), {});
    expect(deliveries).toHaveLength(1);
    expectRfc8291Delivery(deliveries[0]);
  } finally {
    await peer.disconnect("2430 push done");
    await resetPushSubscriptions(vjt.token).catch(() => {});
  }
});
