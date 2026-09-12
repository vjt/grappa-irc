// issue 2096 — the unread rollup badge on the archive launcher.
//
// Reported by Fairy: an archived window holding unread was invisible until you
// opened the ArchiveModal AND expanded the right network group. #532 B put
// per-row badges INSIDE the modal; the launcher that opens it carried nothing.
//
// What this pins, in ONE continuously-open rail menu, so every transition is
// observed LIVE rather than across reloads:
//
//   1. baseline — whatever the shared backend already holds, read off the
//      badge itself (the suite shares one account across specs, so an
//      absolute `0` would be a hostage to whatever ran before);
//   2. THE CONTROL — a peer message lands in a channel the operator is still
//      IN. The unread is real (the +1 in step 3 proves cic counted it), and
//      the badge must NOT move: an ACTIVE window has its own surface and is
//      not the archive's business. Without this reading, step 3 would only
//      say "a number appeared", not "the subtraction works";
//   3. APPEARS — PART the channel. Same unread, no new message, the window
//      simply stops having a nav surface, and the rollup gains exactly 1;
//   4. DISAPPEARS — JOIN it back. Still the same unread, the surface returns,
//      the rollup falls back to the baseline.
//
// Steps 3 and 4 are what makes this spec a real one rather than a green mirror
// of the code: the badge is DERIVED from `/me`'s seed minus what the nav
// draws (`lib/archiveRollup.ts`), so a rollup wired to anything else — the
// raw seed, a boot-time snapshot, the modal's lazily-loaded list — fails at
// 2, at 4, or at both.
//
// Both form factors, because `RailActions` is ONE component mounted by both
// branches of Shell's `isMobile()` split (#473). The desktop entry runs on the
// `chromium` project by subtraction; the `@touch` twin runs on
// `chromium-pixel-touch`. NOT `@webkit`: the claim here is "the rail menu on a
// phone-shaped viewport shows the badge", and WebKit tap semantics are a
// different axis (issue 1831) that this badge does not touch.

import type { Page } from "@playwright/test";
import { loginAs, openRailMenu, selectChannel } from "../fixtures/cicchettoPage";
import {
  assertMessagePersisted,
  awaitPartEcho,
  joinChannel,
  partChannel,
  restoreReadCursorToTail,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specLiveNick, specNick, specUser, test } from "../fixtures/test";

const CHANNEL = AUTOJOIN_CHANNELS[0];
const WITNESS = "#2096 — the line that must show up behind the archive door";

test.afterEach(async () => {
  const vjt = specUser();
  // Restore the seed-time joined state and a tail cursor: this spec PARTs the
  // shared autojoin channel and leaves an unread behind, and neither may
  // poison a sibling spec (or this one under --repeat-each). Both idempotent,
  // both guarded so a mid-test failure cannot cascade.
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
});

// The archive launcher's MESSAGE pill, as a number — 0 when no badge renders.
//
// Scoped to `.sidebar-msg-unread` and not to the whole cluster on purpose: the
// events pill is a separate tier (#265/#532) whose value depends on the
// operator's `show_event_badge` preference and on own-presence rows, and this
// spec's claim is strictly about the message rollup. `openRailMenu` is
// idempotent, so polling through it is safe and keeps the menu open across
// every reading.
async function archiveBadgeMessages(page: Page): Promise<number> {
  await openRailMenu(page);
  const pill = page.locator(
    ".rail-actions-menu [data-testid='rail-archive-unread'] .sidebar-msg-unread",
  );
  if ((await pill.count()) === 0) return 0;
  const text = (await pill.first().innerText()).trim();
  const parsed = Number.parseInt(text, 10);
  return Number.isNaN(parsed) ? -1 : parsed;
}

async function expectArchiveBadge(page: Page, expected: number): Promise<void> {
  await expect
    .poll(() => archiveBadgeMessages(page), { timeout: 10_000, intervals: [100, 200, 500] })
    .toBe(expected);
}

async function runBadgeJourney(page: Page): Promise<void> {
  const vjt = specUser();
  await loginAs(page, vjt);

  // Clean baseline on the channel itself, so the +1 below is OUR peer line and
  // not a leftover from a sibling spec.
  await restoreReadCursorToTail(vjt.token, NETWORK_SLUG, CHANNEL);

  // Focus the channel once (hydrates its pane + the per-channel topic), then
  // step off to the server window: a focused window suppresses its own badge,
  // and the server window has no compose, so it cannot produce client chatter
  // of its own. Addressed by the SLUG, which `sidebarWindow` resolves to
  // `$server` alongside the legacy `"Server"` label — a third hand-copy of
  // that constant is the drift #1646 pinned the e2e tree against.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: specNick() });
  await selectChannel(page, NETWORK_SLUG, NETWORK_SLUG, { awaitWsReady: false });

  // 1 — BASELINE, read off the badge. The shared account may already hold
  // archived unread from a sibling spec; the claim is the DELTA.
  await openRailMenu(page);
  const baseline = await archiveBadgeMessages(page);
  expect(baseline).toBeGreaterThanOrEqual(0);

  const peer = await IrcPeer.connect({ nick: `i2096-peer` });
  try {
    await peer.join(CHANNEL);
    peer.privmsg(CHANNEL, WITNESS);
    // Server-side barrier: the line exists. Without this the "badge did not
    // move" reading below could be a message that never arrived.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: CHANNEL,
      sender: peer.nick,
      body: WITNESS,
    });

    // 2 — THE CONTROL. The unread is in a channel the operator is still IN, so
    // it has a nav row of its own and the archive rollup must not claim it.
    await expectArchiveBadge(page, baseline);

    // 3 — APPEARS. PART only removes the surface; the unread is untouched.
    await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
    await awaitPartEcho(vjt.token, NETWORK_SLUG, CHANNEL, await specLiveNick());
    await expectArchiveBadge(page, baseline + 1);

    // 4 — DISAPPEARS. JOIN gives the surface back; still no message read.
    await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
    await expectArchiveBadge(page, baseline);
  } finally {
    await peer.disconnect("#2096 done");
  }
}

test("#2096 — the archive launcher badge counts a window ONLY while it is archived", async ({
  page,
}) => {
  await runBadgeJourney(page);
});

test("@touch #2096 — the same badge, on the mobile rail drawer", async ({ page }) => {
  // Same component, same derivation: `openRailMenu` opens the members drawer
  // first on a phone viewport, then the launcher. If the badge only ever
  // worked on the desktop rail, this entry is where that shows.
  await runBadgeJourney(page);
});
