// push-prefs-whitelist — push notifications cluster B5 spec 6
// (2026-05-14).
//
// Coverage: B3's notification_prefs whitelist gating. Operator
// configures:
//   * `channel_messages_all = false`
//   * `channel_mentions = false`
//   * `channel_messages_only = ["#b5-allow"]`
//
// Then:
//   * peer says ANY message (no mention) in `#b5-other` → NO push
//     (server-side prefs filter rejects)
//   * peer says ANY message (no mention) in `#b5-allow` → push
//     fires (channel-in-whitelist branch)
//
// Asserts via push-catcher poll + assertNoPushDelivery for the
// negative arm. The positive arm proves the whitelist's allow
// path; the negative arm proves the eval predicate's deny path.
//
// Why this spec is the LANDED gate for B4's trigger logic: a
// regression in `channel_in_whitelist?/2` would let traffic in
// channels the operator deliberately silenced through. That's a
// privacy + UX bug at the same time. Vitest covers
// `should_notify?/4` predicate-level (test/grappa/push/triggers_test.exs);
// this spec covers the UI → REST → server eval roundtrip.

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

const PEER_NICK = "b5-prefser";
const ALLOW_CHANNEL = "#b5-allow";
const OTHER_CHANNEL = "#b5-other";
const SUB_ID = "prefs-whitelist";

test("notification_prefs whitelist: messages in allow-list push, messages elsewhere don't", async ({
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

  // Configure prefs via the SettingsDrawer UI (production code path)
  // rather than POSTing /me/settings/notification-prefs directly —
  // that proves the cic UI's commit hooks (`commitChannelsOnly`,
  // togglePref) flow into the same persisted state Triggers reads.
  // enablePushFromSettings closes the drawer; reopen for prefs edit.
  await page.locator('[aria-label="open settings"]').click();
  const channelAll = page.locator('[data-testid="pref-channel-all"]');
  if (await channelAll.isChecked()) await channelAll.uncheck();
  const channelMentions = page.locator('[data-testid="pref-channel-mentions"]');
  if (await channelMentions.isChecked()) await channelMentions.uncheck();
  const privateAll = page.locator('[data-testid="pref-private-all"]');
  if (await privateAll.isChecked()) await privateAll.uncheck();
  const channelsOnly = page.locator('[data-testid="pref-channels-only"]');
  await channelsOnly.fill(ALLOW_CHANNEL);
  await channelsOnly.blur();

  // Close the drawer so the topic-bar is hit-targetable for compose
  // (drawer overlay sits over compose). Backdrop click dismisses.
  await page.locator('[data-testid="settings-drawer-backdrop"]').click({ force: true });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Bring up both channels operator-side.
    await peer.join(ALLOW_CHANNEL);
    await peer.join(OTHER_CHANNEL);

    for (const channel of [ALLOW_CHANNEL, OTHER_CHANNEL]) {
      await page.locator(".compose-box textarea").fill(`/join ${channel}`);
      await page.locator(".compose-box textarea").press("Enter");
      await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });
    }

    // Refocus #bofh — keep both target channels unfocused so neither
    // can be mistaken for "user is reading this" (irrelevant server-
    // side, but keeps the spec's semantics clean).
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

    // #182 — background the device so the delivery this spec asserts is
    // gated by PREFS, not foreground-suppression. Set hidden before BOTH
    // paths so the negative path proves the prefs skip (not a visible
    // device suppressing) and the positive path can actually deliver.
    await setPageVisibility(page, false);

    // Negative path FIRST — peer talks in OTHER, no mention. No push
    // expected because: channel_messages_all=false, channel_mentions=false,
    // channel_messages_only doesn't include #b5-other.
    peer.privmsg(OTHER_CHANNEL, "small talk in other");
    await assertNoPushDelivery(SUB_ID, 1_500);

    // Positive path — peer talks in ALLOW, no mention. Push expected
    // because channel_messages_only includes #b5-allow.
    peer.privmsg(ALLOW_CHANNEL, "small talk in allow");
    const deliveries = await awaitPushDelivery(SUB_ID);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
    expect(deliveries[0].headers["content-encoding"]).toBe("aesgcm");
  } finally {
    await peer.disconnect("B5 prefs done");
    await partChannel(vjt.token, NETWORK_SLUG, ALLOW_CHANNEL).catch(() => {});
    await partChannel(vjt.token, NETWORK_SLUG, OTHER_CHANNEL).catch(() => {});
  }
});
