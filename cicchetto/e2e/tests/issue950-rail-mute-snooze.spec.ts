// issue950-rail-mute-snooze — the TIME-BOXED mute, from the rail (#950).
//
// #866 shipped every part of the snooze except a way to reach it: the storage
// carries `until`, both readers (cic's `withLiveMutes`, the server's
// `get_notification_prefs/1`) resolve it, and the tests on both sides cover it
// — but every UI mute wrote `{ until: null }`, so no integer ever existed
// outside a fixture. This spec is the proof that one now does, end to end.
//
// Sibling of `push-866-conversation-mute.spec.ts`, and deliberately NOT a copy:
// that spec proves a PERMANENT mute created in the settings drawer holds a push
// back. This one proves
//
//   * the RAIL picker — a different door, gated on the selected conversation —
//     writes a mute at all, and
//   * what it writes is a SNOOZE. The drawer's global list renders a remaining
//     span ("… left") only for an entry whose `until` is an integer, so that
//     row is the visible outcome that separates this feature from #866's. A
//     picker that wrote `until: null` (the pre-#950 behaviour) would still
//     silence the channel and would still leave the push arm below green — and
//     would fail HERE.
//
// The push arms remain, because a mute that only paints a settings row is not
// a mute: the suppression is decided server-side from the integer this client
// computed, which is the one thing no unit test on either side can observe.
//
// Removing the feature turns the spec red at the picker (absent from the rail).
// Making the picker write a permanent mute again turns it red at the "… left"
// row while leaving the push arms green — the discrimination this spec exists
// for.

import { loginAs, openRailMenu, openSettingsSection, selectChannel } from "../fixtures/cicchettoPage";
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

const PEER_NICK = "i950-snoozer";
const SNOOZED_CHANNEL = "#950-snoozed";
const LOUD_CHANNEL = "#950-loud";
const SUB_ID = "rail-mute-snooze";

test("a one-hour snooze picked from the rail silences the channel and says how long it has left", async ({
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
    await peer.join(SNOOZED_CHANNEL);
    await peer.join(LOUD_CHANNEL);

    for (const channel of [SNOOZED_CHANNEL, LOUD_CHANNEL]) {
      await page.locator(".compose-box textarea").fill(`/join ${channel}`);
      await page.locator(".compose-box textarea").press("Enter");
      await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });
    }

    // The rail picker is CONTEXT-SENSITIVE: it mutes whatever conversation is
    // selected, so selecting the target IS half the gesture.
    await selectChannel(page, NETWORK_SLUG, SNOOZED_CHANNEL, { ownNick: NETWORK_NICK });
    await openRailMenu(page);
    const picker = page.getByTestId("rail-mute-picker");
    await expect(picker).toBeVisible();
    await picker.selectOption("1h");

    // The menu closes on the choice (a snooze resolves, unlike the denoise
    // toggle beside it) — the first observable consequence of the pick.
    await expect(page.locator(".rail-actions-menu")).toHaveCount(0);

    // Re-open the rail: the row itself now reads "muted", because the write
    // mirrored the SERVER's echo back into the shared prefs signal. This is a
    // second visible outcome AND the honest barrier for everything below — the
    // write is two round-trips (GET then PUT) and nothing else in the UI would
    // otherwise tell the spec it had landed.
    await openRailMenu(page);
    await expect(page.getByTestId("rail-action-mute")).toContainText("muted");

    await openSettingsSection(page, "push");

    // Drawn from the server's echo, so the row's presence proves the PUT landed
    // and came back normalized. No sleep, no arbitrary timeout.
    const snoozedKey = muteKey(NETWORK_SLUG, SNOOZED_CHANNEL);
    await expect(page.getByTestId(`pref-muted-${snoozedKey}`)).toBeVisible({
      timeout: 10_000,
    });
    // THE discriminator: a remaining span exists only for an integer `until`.
    // "1h 0m left" at the top of the hour, "59m left" a minute in — both match,
    // and a permanent mute renders no such element at all.
    await expect(page.getByTestId(`pref-muted-until-${snoozedKey}`)).toHaveText(
      /^(1h \d+m|5\dm) left$/,
    );
    // ...and the sibling channel is demonstrably not muted, so the two push
    // arms below differ in exactly one variable.
    await expect(page.getByTestId(`pref-muted-${muteKey(NETWORK_SLUG, LOUD_CHANNEL)}`)).toHaveCount(0);
    await expect(page.getByTestId("pref-channel-mentions")).toBeChecked();

    await page.getByTestId("settings-drawer-backdrop").click({ force: true });

    // Focus a third window so neither target is "being read", and background the
    // device so #182's foreground suppression is not what decides either arm.
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });
    await setPageVisibility(page, false);

    // Negative arm — a MENTION inside the snoozed hour. The server compares the
    // integer this client wrote against its own clock and holds the push.
    peer.privmsg(SNOOZED_CHANNEL, `${NETWORK_NICK}: not for the next hour`);
    await assertNoPushDelivery(SUB_ID, 1_500);

    // Positive arm — the same shape in the unmuted sibling, so the negative arm
    // cannot be passing because push broke outright.
    peer.privmsg(LOUD_CHANNEL, `${NETWORK_NICK}: but you will hear this`);
    const deliveries = await awaitPushDelivery(SUB_ID);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
  } finally {
    await peer.disconnect("#950 snooze done");
    // The mute is PERSISTED per subject and vjt is shared by the whole suite —
    // an hour-long snooze left behind silences #950-snoozed for every later
    // spec, which would fail on a missing notification with nothing pointing
    // back here.
    await clearMutedConversations(vjt.token).catch(() => {});
    await partChannel(vjt.token, NETWORK_SLUG, SNOOZED_CHANNEL).catch(() => {});
    await partChannel(vjt.token, NETWORK_SLUG, LOUD_CHANNEL).catch(() => {});
  }
});
