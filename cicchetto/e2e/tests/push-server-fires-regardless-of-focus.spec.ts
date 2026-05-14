// push-server-fires-regardless-of-focus — push notifications cluster
// B5 spec 5 (2026-05-14).
//
// Coverage: server-side fan-out is unconditional on cic focus state.
// When the operator is FOCUSED on `#b5-focus-target` and a peer
// mentions them in that same channel, `Push.Sender.send_to_user`
// STILL fires — push-catcher receives the POST. Cic's SW is the
// only layer that knows about focus; suppression of the OS-level
// notification is the SW's `clients.matchAll().focused` check
// (cicchetto/src/service-worker.ts handlePush).
//
// Why we're testing the server-side contract here, not the SW
// suppression itself:
//
//   * The integration harness has NO real Web Push vendor
//     reachable, so the SW never receives a real PushEvent. Driving
//     a synthetic PushEvent into the SW would require either (a) a
//     CDP `ServiceWorker.deliverPushMessage` call (which still
//     requires a vendor-issued registration id chromium tracks
//     internally — not present without real FCM), or (b) a build-
//     time test seam in service-worker.ts that compiles to dead
//     code in production (a meaningful but non-trivial test-
//     surface change).
//
//   * The SW dedup logic is pure-JS, deterministic, and covered by
//     `cicchetto/src/__tests__/pushPayload.test.ts` (`urlMatches`
//     contract — which `handlePush` calls into). Re-asserting that
//     same predicate via Playwright would be redundant.
//
//   * The actual e2e regression risk is "server-side trigger logic
//     accidentally consults focus state and skips the push". That's
//     EXACTLY what this spec catches: focused-window mention →
//     push-catcher MUST still receive the POST. If the server ever
//     started consulting WSPresence for focus before pushing, this
//     spec breaks.
//
// Manual SW-side dedup verification is the B6 manual smoke pass on
// a real iOS / Android device.

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import {
  awaitPushDelivery,
  enablePushFromSettings,
  pushCatcherEndpoint,
  resetPushCatcher,
  resetPushSubscriptions,
  stubPushManager,
} from "../fixtures/push";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "b5-focuser";
const TARGET_CHANNEL = "#b5-focus";
const SUB_ID = "focused-window";

test("push fires server-side regardless of cic focus on the target window", async ({
  page,
  context,
}) => {
  const vjt = getSeededVjt();
  await resetPushCatcher();
  await resetPushSubscriptions(vjt.token);
  await stubPushManager(context, { endpoint: pushCatcherEndpoint(SUB_ID) });
  await context.grantPermissions(["notifications"]);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  await enablePushFromSettings(page, context, { id: SUB_ID, token: vjt.token });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(TARGET_CHANNEL);
    await page.locator(".compose-box textarea").fill(`/join ${TARGET_CHANNEL}`);
    await page.locator(".compose-box textarea").press("Enter");
    await selectChannel(page, NETWORK_SLUG, TARGET_CHANNEL, { ownNick: NETWORK_NICK });

    // Operator is now FOCUSED on the mention target. Peer mentions.
    // Server-side trigger MUST still fire regardless of focus —
    // dedup is the SW's job, not the server's.
    peer.privmsg(TARGET_CHANNEL, `${NETWORK_NICK}: hey, you focused?`);

    const deliveries = await awaitPushDelivery(SUB_ID);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0].headers["content-encoding"]).toBe("aesgcm");
  } finally {
    await peer.disconnect("B5 focused-window done");
    await partChannel(vjt.token, NETWORK_SLUG, TARGET_CHANNEL).catch(() => {});
  }
});
