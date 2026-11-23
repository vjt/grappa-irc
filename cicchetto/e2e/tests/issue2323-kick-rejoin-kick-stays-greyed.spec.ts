// issue 2323 — kicked by someone else, the channel vanished from the sidebar.
//
// Reported live on Azzurra: `void KICK #grappa vjt`, vjt rejoined, `void KICK
// #grappa vjt` again, and after that the row was gone. cp15-b6 already covers
// ONE kick with the kicked window focused, and it is green, so the report is a
// sequence it never walks. This spec walks the reported one — kick, rejoin,
// kick — and asserts the VISIBLE outcome after each kick: the sidebar row is
// still there, and it is greyed (the not-joined treatment), for as long as the
// operator has not pressed × or rejoined.
//
// Two focus shapes, because which window vjt was reading at the time was not
// recorded and the selection close-watcher behaves differently for the
// focused window: (1) the channel is selected throughout; (2) the operator is
// reading another channel while both kicks land.
//
// "Stays" is an absence of a disappearance, so after each kick the row is
// asserted, then asserted AGAIN after a settle: the user-topic
// `channels_changed` / `archive_changed` pushes and the `kicked` event have no
// ordering guarantee between them, and a drop that lands a beat after the
// first assertion is exactly the class this issue is about.

import type { Page } from "@playwright/test";
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const SETTLE_MS = 2_000;

let peer: IrcPeer | null = null;
let channel = "";

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
  await partChannel(specUser().token, NETWORK_SLUG, channel).catch(() => {});
});

const joinLines = (page: Page) =>
  page
    .locator('[data-testid="scrollback-line"][data-kind="join"]')
    .filter({ hasText: specNick() })
    .filter({ hasText: channel });

// The join is proven by the member list, not by the row: a row exists in
// pending too, and a kick sent before bahamut has the JOIN would miss.
async function awaitJoined(page: Page): Promise<void> {
  await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });
  const row = sidebarWindow(page, NETWORK_SLUG, channel);
  await expect(row.locator(".sidebar-window-greyed")).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator(".members-pane li", { hasText: specNick() })).toBeVisible({
    timeout: 10_000,
  });
}

async function expectGreyedRowStays(page: Page, reason: string): Promise<void> {
  const row = sidebarWindow(page, NETWORK_SLUG, channel);
  // The kick has reached this client: its window state flipped.
  await expect(row.locator(".sidebar-window-greyed")).toBeVisible({ timeout: 10_000 });
  await expect(row, `after "${reason}" the row must still be in the sidebar`).toHaveCount(1);
  await page.waitForTimeout(SETTLE_MS);
  await expect(row, `after "${reason}" + ${SETTLE_MS} ms the row must still be there`).toHaveCount(
    1,
  );
  await expect(row.locator(".sidebar-window-greyed")).toBeVisible();
}

async function setUp(page: Page, tag: string): Promise<void> {
  channel = `#i2323-${tag}-${crypto.randomUUID().slice(0, 8)}`;
  // The founding JOINer is auto-opped on the testnet bahamut, so the peer
  // can KICK.
  peer = await IrcPeer.connect({ nick: `i2323${tag}-${crypto.randomUUID().slice(0, 5)}` });
  await peer.join(channel);

  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });
  await composeSend(page, `/join ${channel}`);
  await expect(joinLines(page).first()).toBeVisible({ timeout: 10_000 });
  await awaitJoined(page);
}

test("issue 2323 — kick, rejoin, kick with the channel focused: the row stays, greyed", async ({
  page,
}) => {
  await setUp(page, "f");

  await peer?.kick(channel, specNick(), "loser");
  await expectGreyedRowStays(page, "first kick");

  await composeSend(page, `/join ${channel}`);
  await expect(joinLines(page)).toHaveCount(2, { timeout: 10_000 });
  await awaitJoined(page);

  await peer?.kick(channel, specNick(), "loser again");
  await expectGreyedRowStays(page, "second kick");
});

test("issue 2323 — kick, rejoin, kick while reading another channel: the row stays, greyed", async ({
  page,
}) => {
  await setUp(page, "u");

  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });
  await peer?.kick(channel, specNick(), "loser");
  await expectGreyedRowStays(page, "first kick");

  // A kicked window: nothing new to wait for on its topic, just open it.
  await selectChannel(page, NETWORK_SLUG, channel, { awaitWsReady: false });
  await composeSend(page, `/join ${channel}`);
  await expect(joinLines(page)).toHaveCount(2, { timeout: 10_000 });
  await awaitJoined(page);

  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });
  await peer?.kick(channel, specNick(), "loser again");
  await expectGreyedRowStays(page, "second kick");
});

// The PHONE shape — where the report was actually made. The expected
// behaviour, as declared for this issue, is that after a kick the channel
// STAYS in the bottom bar. How that relates to the #902/#402 decision (a
// kicked window on a phone is reached through the archive) is OPEN, and so
// is the FORM of the surviving tab (greyed? a ×?): this test asserts only
// the declared fact — the tab is still there — and nothing about its look.
//
// On a phone the members pane is a drawer and the Sidebar pseudo-rows do not
// exist, so the desktop helpers above do not apply: the join is proven by our
// own JOIN line (via `selectChannel`'s ownNick wait) and the kick by the KICK
// line in the focused window. The channel is NOT in autojoin, so after a kick
// it leaves `channelsBySlug` and the bar has no other source for its tab.
test("@webkit @touch issue 2323 — kick, rejoin, kick on a phone: the bottom-bar tab stays", async ({
  page,
}) => {
  channel = `#i2323-m-${crypto.randomUUID().slice(0, 8)}`;
  peer = await IrcPeer.connect({ nick: `i2323m-${crypto.randomUUID().slice(0, 5)}` });
  await peer.join(channel);

  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });
  await composeSend(page, `/join ${channel}`);
  await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });

  const tab = sidebarWindow(page, NETWORK_SLUG, channel);
  const kickLines = page
    .locator('[data-testid="scrollback-line"][data-kind="kick"]')
    .filter({ hasText: specNick() });

  async function expectTabStays(reason: string, kicks: number): Promise<void> {
    await expect(kickLines).toHaveCount(kicks, { timeout: 10_000 });
    await expect(tab, `after "${reason}" the tab must still be in the bottom bar`).toHaveCount(1);
    await page.waitForTimeout(SETTLE_MS);
    await expect(
      tab,
      `after "${reason}" + ${SETTLE_MS} ms the tab must still be there`,
    ).toHaveCount(1);
  }

  await peer.kick(channel, specNick(), "loser");
  await expectTabStays("first kick", 1);

  await composeSend(page, `/join ${channel}`);
  await expect(joinLines(page)).toHaveCount(2, { timeout: 10_000 });

  await peer.kick(channel, specNick(), "loser again");
  await expectTabStays("second kick", 2);
});
