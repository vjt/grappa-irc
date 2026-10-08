// issue 2323 — a channel we were KICKED from must stay in the sidebar as a
// greyed not-joined row until the operator closes it (×) or rejoins. vjt's
// report: *"void mi ha kickato e il chan è sparito dalla mia left sidebar"*.
//
// Two witnesses, because the report did not record which path dropped it:
//
//   1. LIVE, the reported timeline: kick → rejoin → kick again, with the
//      second kick landing while the operator is looking at ANOTHER window.
//      The row must be greyed after each kick and un-greyed after the rejoin.
//   2. RELOAD: the `kicked` state is broadcast on the user topic ONCE, at
//      KICK time. A channel we were kicked from is in neither the autojoin
//      list nor the live keyset, so `GET /channels` no longer lists it, and
//      the only thing that kept it on screen was cic's in-memory
//      `windowStateByChannel` — which a reload (or a backgrounded PWA)
//      throws away. The `Session.Server` still holds the window at `:kicked`,
//      so only the user-topic cold snapshot can bring the row back: the
//      #482 shape, on `:kicked`.
//
// Needs a live upstream and a session surviving a browser reload, which
// vitest cannot do.

import type { Page } from "@playwright/test";
import {
  composeSend,
  expectShellReady,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

let peer: IrcPeer | null = null;
let channel: string | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
  // The PART also clears a `:kicked` window server-side (#511:
  // `PartCleanup.cleanup_local` drops the key whatever the upstream says),
  // which is what keeps a surviving kicked row out of sibling specs.
  if (channel) {
    await partChannel(specUser().token, NETWORK_SLUG, channel).catch(() => {});
    channel = null;
  }
});

// Barrier: the JOIN echo landed and the window is JOINED, not merely
// pending. A self-JOIN scrollback line cannot be the gate on a REjoin — the
// first join's line already matches — and "not greyed" holds for a pending
// row too. Measured: the rejoin's JOIN sat ~2s in the send bucket, the gate
// passed on the stale line, and the next KICK hit a channel we were not in.
// So: the row must be the LIVE channel row (pseudo-rows, pending included,
// carry `data-window-state`), and the member list — rendered only for a
// joined window, which `/join` focuses — must name us.
async function joinAndAwait(page: Page, name: string): Promise<void> {
  await composeSend(page, `/join ${name}`);
  const row = sidebarWindow(page, NETWORK_SLUG, name);
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).not.toHaveAttribute("data-window-state", /.*/, { timeout: 15_000 });
  await expect(row.locator(".sidebar-window-greyed")).toHaveCount(0);
  await expect(page.locator(".members-pane li", { hasText: specNick() })).toBeVisible({
    timeout: 15_000,
  });
}

async function expectKickedRow(page: Page, name: string): Promise<void> {
  const row = sidebarWindow(page, NETWORK_SLUG, name);
  await expect(row).toHaveCount(1, { timeout: 10_000 });
  await expect(row.locator(".sidebar-window-greyed")).toBeVisible({ timeout: 10_000 });
}

test("issue 2323 — kick, rejoin, kick again from another window: the row stays, greyed each time", async ({
  page,
}) => {
  channel = `#i2323-l-${crypto.randomUUID().slice(0, 8)}`;
  // Founding JOINer is auto-opped on the testnet bahamut, so it may KICK.
  peer = await IrcPeer.connect({ nick: `i2323l-${crypto.randomUUID().slice(0, 6)}` });
  await peer.join(channel);

  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });

  await joinAndAwait(page, channel);
  await peer.kick(channel, specNick(), "first");
  await expectKickedRow(page, channel);

  // Rejoin from the seed channel, then look away before the second kick:
  // the reported second kick did not necessarily land on a selected window.
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });
  await joinAndAwait(page, channel);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });

  await peer.kick(channel, specNick(), "again");
  await expectKickedRow(page, channel);
});

test("issue 2323 — the kicked row survives a reload (user-topic cold snapshot)", async ({
  page,
}) => {
  channel = `#i2323-r-${crypto.randomUUID().slice(0, 8)}`;
  peer = await IrcPeer.connect({ nick: `i2323r-${crypto.randomUUID().slice(0, 6)}` });
  await peer.join(channel);

  await loginAs(page, specUser());
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: specNick() });

  await joinAndAwait(page, channel);
  await peer.kick(channel, specNick(), "before reload");
  // LIVE baseline: the event-time broadcast reached a subscribed socket.
  await expectKickedRow(page, channel);

  // RELOAD — drops the WS and `windowStateByChannel`; the session survives
  // with the window at `:kicked` and there is no KICK left to replay.
  await page.reload();
  await expectShellReady(page);

  // HEADLINE: RED before the fix (the row evaporated), GREEN once the user
  // topic re-emits `kicked` on a cold subscribe. `data-window-state` pins
  // WHICH not-joined state came back: the greyed class alone is shared by
  // pending / failed / kicked / parked.
  const row = sidebarWindow(page, NETWORK_SLUG, channel);
  await expect(row).toHaveCount(1, { timeout: 15_000 });
  await expect(row).toHaveAttribute("data-window-state", "kicked");
  await expect(row.locator(".sidebar-window-greyed")).toBeVisible();
});
