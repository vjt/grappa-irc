// push-trigger-channel-mention — push notifications cluster B5 spec 3
// (2026-05-14).
//
// Coverage: when a peer mentions the operator's nick in a channel
// the operator has push enabled for, B4's `Push.Triggers` evaluates
// `Mentions.mentioned?/3 == true` and fires `Push.Sender.send_to_user`
// which fans out to every stored subscription. The push-catcher
// sidecar receives the HTTP POST that proves fan-out fired with a
// vendor-shaped header set.
//
// Asserting the OUTCOME — not implementation details:
//   * Catcher saw at least one POST for the seeded subscription's id
//   * The POST carries `content-encoding: aesgcm` (the lib
//     encrypted the payload — RFC 8188 legacy encoding emitted by
//     `:web_push_elixir` v0.8.0; new spec is RFC 8291 `aes128gcm`,
//     bump the assertion when the lib upgrades)
//   * A `ttl` header (RFC 8030 — every vendor-bound push MUST set TTL)
//
// `urgency` is RFC 8030 SHOULD-set-but-optional; the upstream lib
// doesn't set it by default. Worth wiring through Sender's call
// site eventually (per-user importance hint affects iOS/APNs
// delivery), but out of B5 scope.
//
// Why we don't decrypt the body in-spec: cic SW receives the
// AES-GCM-encrypted payload from the vendor, decrypts with the
// subscription's keys, and then dispatches a parsed JSON. Doing
// that in the spec means re-implementing the W3C decrypt path
// (HKDF + AES-GCM with the p256dh + auth keys + salt header).
// The body shape is already validated by
// `test/grappa/push/payload_test.exs` server-side, so the e2e
// contract is "did fan-out fire to a vendor-shaped endpoint with
// vendor-shaped headers". Body decryption is a job for B6 manual
// PWA smoke (where a real iOS device renders the actual notif).

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import {
  assertNoPushDelivery,
  awaitPushDelivery,
  enablePushFromSettings,
  pushCatcherEndpoint,
  resetPushCatcher,
  resetPushSubscriptions,
  setPageVisibility,
  stubPushManager,
} from "../fixtures/push";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "b5-mentioner";
const TARGET_CHANNEL = "#b5-mention";
const SUB_ID = "channel-mention";

test("channel mention while push-enabled fires Sender → push-catcher receives a POST", async ({
  page,
  context,
}) => {
  const vjt = getSeededVjt();
  await resetPushCatcher();
  await resetPushSubscriptions(vjt.token);
  // Stub MUST install before page.goto (loginAs) — initScripts run
  // for FUTURE navigations only.
  await stubPushManager(context, { endpoint: pushCatcherEndpoint(SUB_ID) });
  await context.grantPermissions(["notifications"]);

  await loginAs(page, vjt);

  // Anchor focus on the autojoin channel so the topic-bar settings
  // button mounts. We deliberately stay on `#bofh` rather than the
  // mention target — we want the mention to land OUT of the focused
  // window so the SW dedup doesn't suppress it. Focused-channel
  // dedup is the dedup spec's concern; this spec asserts the
  // server-side trigger only.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  await enablePushFromSettings(page, context, { id: SUB_ID, token: vjt.token });

  // Peer joins the mention target then mentions the operator. Order
  // matters: cic's session must JOIN the channel server-side first so
  // the Triggers hot path actually evaluates against the operator's
  // own_nick. Easiest seam: have the operator JOIN via REST before
  // the peer says anything.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(TARGET_CHANNEL);
    // Operator joins via slash command so the channel is in
    // last_joined_channels + Session.Server's joined map.
    await page.locator(".compose-box textarea").fill(`/join ${TARGET_CHANNEL}`);
    await page.locator(".compose-box textarea").press("Enter");

    // Wait for the operator's auto-join line to land before the peer
    // sends — same race as M1 / b2 specs.
    await selectChannel(page, NETWORK_SLUG, TARGET_CHANNEL, { ownNick: NETWORK_NICK });

    // Re-focus #bofh so the mention lands UNFOCUSED.
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

    // #182 — background the device so the server delivers. The server
    // now suppresses at source when ANY device is visible, so the
    // former "land it in an unfocused window" trick is no longer what
    // lets the push through — the device being hidden is.
    await setPageVisibility(page, false);

    // Peer mentions the operator. Mentions.mentioned?/3 matches
    // the bare nick at a word boundary.
    peer.privmsg(TARGET_CHANNEL, `${NETWORK_NICK}: are you there?`);

    const deliveries = await awaitPushDelivery(SUB_ID);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);

    const headers = deliveries[0].headers;
    // RFC 8030 + lib invariants. Headers are downcased by node:http.
    expect(headers["content-encoding"]).toBe("aesgcm");
    expect(headers.ttl).toBeDefined();
    // The vendor sees the cic-stored endpoint via the URL path; the
    // path includes the per-spec id we minted.
    // (verified by push-catcher partitioning by id; recurrence here
    // would only show up as zero deliveries on the WRONG id, which
    // is a stronger negative caught by assertNoPushDelivery below.)

    // Negative cross-check: a never-used id sees zero deliveries —
    // proves push-catcher partitioning + Sender targeting (no
    // accidental fan-out to all known endpoints).
    await assertNoPushDelivery("channel-mention-unrelated");
  } finally {
    await peer.disconnect("B5 channel-mention done");
    await partChannel(vjt.token, NETWORK_SLUG, TARGET_CHANNEL).catch(() => {});
  }
});
