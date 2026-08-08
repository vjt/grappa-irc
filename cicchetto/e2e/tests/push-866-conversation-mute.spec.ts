// push-866-conversation-mute — per-conversation notification mute (#866).
//
// Sibling of `push-prefs-whitelist.spec.ts`, and deliberately the MIRROR of
// it: that spec proves the allow-list can let a channel through, this one
// proves the deny-list can hold a channel back — including a channel the
// operator is mentioned in, which nothing before #866 could silence without
// turning mentions off everywhere.
//
// What it gates, and why an e2e is the right shape for it:
//
//   * the mute is created through the SettingsDrawer picker (`pref-mute-picker`),
//     not by POSTing /me/settings/notification-prefs. So the folded key the
//     picker emits, the server's normalization, and the key
//     `Grappa.Push.Triggers` compares are all proven to be the SAME string. A
//     unit test on either side cannot see a fold mismatch between them.
//   * the assertion is on PUSH delivery, which is decided server-side. A
//     client-only mute would silence the tab and still ring the phone —
//     exactly the failure mode #866's own text calls out.
//   * the negative arm carries a MENTION. That is vjt's Q2 ruling under test:
//     the mute always wins, a highlight does not pierce it. Both truth-table
//     ports assert this too; here it is asserted end to end, where a mention
//     genuinely travels through `Mentions.mentioned?/3`.
//
// Removing the feature turns the negative arm red: with no mute, a mention in
// #866-muted delivers a push (channel_mentions defaults ON).

import { loginAs, openSettingsSection, selectChannel } from "../fixtures/cicchettoPage";
import { clearMutedConversations, muteKey, partChannel } from "../fixtures/grappaApi";
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
import { expect, test } from "../fixtures/test";

const PEER_NICK = "i866-muter";
const MUTED_CHANNEL = "#866-muted";
const LOUD_CHANNEL = "#866-loud";
const SUB_ID = "conversation-mute";

test("a muted channel swallows even a direct mention, while its unmuted sibling still pushes", async ({
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
    await peer.join(MUTED_CHANNEL);
    await peer.join(LOUD_CHANNEL);

    // Join operator-side FIRST: the mute picker offers the conversations the
    // operator actually has, so both windows must exist before the drawer can
    // list either of them. That ordering is the feature, not spec bookkeeping.
    for (const channel of [MUTED_CHANNEL, LOUD_CHANNEL]) {
      await page.locator(".compose-box textarea").fill(`/join ${channel}`);
      await page.locator(".compose-box textarea").press("Enter");
      await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });
    }

    await openSettingsSection(page, "push");

    // Leave `channel_mentions` at its default (ON). The whole point is that a
    // mention WOULD have pushed and the mute is what stops it — unchecking it
    // here would make the negative arm pass for the wrong reason.
    await expect(page.locator('[data-testid="pref-channel-mentions"]')).toBeChecked();

    const picker = page.locator('[data-testid="pref-mute-picker"]');
    const mutedKey = muteKey(NETWORK_SLUG, MUTED_CHANNEL);
    await expect(picker.locator(`option[value="${mutedKey}"]`)).toHaveCount(1);
    await picker.selectOption(mutedKey);

    // The row is drawn from the server's echo, so its presence is proof the
    // PUT landed and came back normalized — no sleep, no arbitrary timeout.
    await expect(page.locator(`[data-testid="pref-muted-${mutedKey}"]`)).toBeVisible({
      timeout: 10_000,
    });
    // ...and the loud channel is demonstrably NOT muted, so the two arms below
    // differ in exactly one variable.
    await expect(page.locator(`[data-testid="pref-muted-${muteKey(NETWORK_SLUG, LOUD_CHANNEL)}"]`)).toHaveCount(0);

    await page.locator('[data-testid="settings-drawer-backdrop"]').click({ force: true });

    // Focus a third window so neither target is "being read", and background
    // the device so #182's foreground-suppression is not what decides either
    // arm.
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });
    await setPageVisibility(page, false);

    // Negative arm — a MENTION in the muted channel. Pre-#866 this pushed.
    peer.privmsg(MUTED_CHANNEL, `${NETWORK_NICK}: you will not hear this`);
    await assertNoPushDelivery(SUB_ID, 1_500);

    // Positive arm — the same mention shape in the unmuted sibling. This is
    // what keeps the negative arm from passing because push broke outright.
    peer.privmsg(LOUD_CHANNEL, `${NETWORK_NICK}: but you will hear this`);
    const deliveries = await awaitPushDelivery(SUB_ID);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
  } finally {
    await peer.disconnect("#866 mute done");
    // The mute is PERSISTED per subject and vjt is shared by the whole suite —
    // leaving it behind silences #866-muted for every later spec, and the
    // victim fails on a missing notification with nothing pointing back here.
    await clearMutedConversations(vjt.token).catch(() => {});
    await partChannel(vjt.token, NETWORK_SLUG, MUTED_CHANNEL).catch(() => {});
    await partChannel(vjt.token, NETWORK_SLUG, LOUD_CHANNEL).catch(() => {});
  }
});
