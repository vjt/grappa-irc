// GH #1018 — a MUTED conversation (#866) is not a stop on the next-active
// cycle (#235: Alt+A, Ctrl+N/P, the on-screen affordance).
//
// Why an e2e and not just the unit test on `orderUnreadWindows`:
//
//   * the mute is created through the SettingsDrawer picker, so the folded
//     key the picker WRITES and the key the cycle READS are proven to be the
//     same string. Two unit suites on either side of that seam cannot see a
//     fold mismatch between them — the same argument
//     `push-866-conversation-mute.spec.ts` makes for the push port.
//   * the outcome under test is "which window did the operator land on",
//     which is only observable here.
//
// Scope guard under test too (#866 Q4): the muted channel keeps its sidebar
// unread badge. The mute changes the NAVIGATION order, not the counters.
//
// Desktop only, deliberately: all three doors dispatch the SAME verb
// (`jumpToNextActiveWindow`), and #235's own spec already gates the mobile
// button against that verb. This spec's variable is the mute, not the door.
//
// Removing the feature turns this red at the first jump: the muted channel
// heads the cycle (older activity, same tier) and Alt+A lands there.

import {
  loginAs,
  openSettingsSection,
  selectChannel,
  sidebarMessageBadge,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { clearMutedConversations, muteKey, partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

const PEER_NICK = "i1018-noise";
const MUTED_CHANNEL = "#1018-muted";
const LOUD_CHANNEL = "#1018-loud";

const NEXT_ACTIVE_BTN = '[data-testid="next-active-btn"]';
const NEXT_ACTIVE_COUNT = '[data-testid="next-active-btn"] .next-active-count';

test("Alt+A skips the muted channel and lands on the unmuted one, badge intact", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // Focus the seeded autojoin channel before anything else, for TWO
  // reasons that both bite silently if skipped:
  //   * the compose box below only exists once a scrollback-kind window
  //     is selected — Shell's `kindHasScrollback` Match owns ComposeBox,
  //     and boot auto-selects $home, which has none. Without this the
  //     `/join` fill waits 30s on a locator that never mounts.
  //   * the per-test reset clears every read cursor and re-seeds this
  //     channel with 200 rows, so it starts FULLY unread and would be a
  //     second stop on the cycle. Focusing it baselines the cursor to
  //     the tail, which is what makes the count assertion below read the
  //     two windows this spec drives and nothing else.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    await peer.join(MUTED_CHANNEL);
    await peer.join(LOUD_CHANNEL);

    // Join operator-side and visit each window: the picker offers the
    // conversations the operator actually has, and the visit baselines each
    // read cursor to the tail so the unread below is the traffic this spec
    // produces, not seed backlog.
    for (const channel of [MUTED_CHANNEL, LOUD_CHANNEL]) {
      await page.locator(".compose-box textarea").fill(`/join ${channel}`);
      await page.locator(".compose-box textarea").press("Enter");
      await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });
    }

    await openSettingsSection(page, "push");
    const picker = page.locator('[data-testid="pref-mute-picker"]');
    const mutedKey = muteKey(NETWORK_SLUG, MUTED_CHANNEL);
    await expect(picker.locator(`option[value="${mutedKey}"]`)).toHaveCount(1);
    await picker.selectOption(mutedKey);
    // The row is drawn from the server's normalized echo, so its presence
    // proves the PUT landed — no sleep, no arbitrary timeout.
    await expect(page.locator(`[data-testid="pref-muted-${mutedKey}"]`)).toBeVisible({
      timeout: 10_000,
    });
    // ...and the sibling is demonstrably NOT muted: the two arms below differ
    // in exactly one variable.
    await expect(page.locator(`[data-testid="pref-muted-${muteKey(NETWORK_SLUG, LOUD_CHANNEL)}"]`)).toHaveCount(0);
    await page.locator('[data-testid="settings-drawer-backdrop"]').click({ force: true });

    // Park focus on the neutral $server window — NOT part of the cycle — so
    // both channels accrue unread.
    await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });

    // The MUTED channel speaks FIRST: with the mute gone it is the older
    // activity in the same tier, i.e. the head of the cycle. That ordering is
    // what makes the assertion below discriminating.
    peer.privmsg(MUTED_CHANNEL, "1018 muted room, still noisy");
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, MUTED_CHANNEL)).toBeVisible({
      timeout: 10_000,
    });
    peer.privmsg(LOUD_CHANNEL, "1018 the room you actually read");
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, LOUD_CHANNEL)).toBeVisible({
      timeout: 10_000,
    });

    // TWO windows carry unread, but only ONE is a stop on the cycle.
    await expect(page.locator(NEXT_ACTIVE_COUNT)).toHaveText("1", { timeout: 10_000 });

    await page.keyboard.press("Alt+a");
    await expect(sidebarWindow(page, NETWORK_SLUG, LOUD_CHANNEL)).toHaveClass(/selected/, {
      timeout: 10_000,
    });

    // The unmuted room is read now. The muted one is STILL unread — and the
    // affordance is gone rather than offering it (#1018 Q2: when every
    // remaining unread window is muted the cycle is a no-op).
    await expect(page.locator(NEXT_ACTIVE_BTN)).toHaveCount(0, { timeout: 10_000 });

    // #866 Q4 scope guard: the mute took the window off the CYCLE, not off
    // the counters — its sidebar unread badge is untouched.
    await expect(sidebarMessageBadge(page, NETWORK_SLUG, MUTED_CHANNEL)).toBeVisible();
  } finally {
    await peer.disconnect("#1018 done");
    // The mute is PERSISTED per subject and vjt is shared by the whole suite —
    // leaving it behind silences #1018-muted for every later spec, and the
    // victim fails with nothing pointing back here.
    await clearMutedConversations(vjt.token).catch(() => {});
    await partChannel(vjt.token, NETWORK_SLUG, MUTED_CHANNEL).catch(() => {});
    await partChannel(vjt.token, NETWORK_SLUG, LOUD_CHANNEL).catch(() => {});
  }
});
