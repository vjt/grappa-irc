// #325 — the per-channel presence toggle (🙈, #222) must suppress
// join/part/quit/nick-change churn ONLY. It must NOT take the #237 on-JOIN
// inline topic line down with it.
//
// The bug: the #237 topic line was anchored by scanning the RENDERED rows for
// the operator's own-JOIN row; #222 filters that JOIN row out when presence is
// hidden, so the anchor vanished and the topic line was never spliced in —
// collateral suppression. The fix anchors to the newest own-JOIN in the
// UNFILTERED buffer, so the line survives the hide.
//
// This is the interactive witness. It reuses #237's join-time-only topic setup
// (a PEER creates a fresh channel and sets the topic BEFORE vjt joins, so vjt
// learns the topic only via the join-time 332 → topicByChannel → the inline
// row — the sole path that can satisfy it) AND #222's real presence churn (a
// peer join + part) + the per-channel toggle.
//
// RED proof (pre-fix): after toggling presence OFF the topic-join row vanishes
// alongside the JOIN rows — the `topicJoinRow(...).filter({ hasText })` locator
// drops to count 0. Post-fix it stays count 1 while join/part go to 0.
//
// Per feedback_ux_e2e_mandatory: every cic UX-touching change ships with a
// Playwright e2e via scripts/integration.sh. Anti-#bofh-pollution: a per-run
// UNIQUE channel; vjt PARTs it in `finally` and every peer disconnects.

import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarWindow,
  topicJoinRow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test("#325 — presence-hide suppresses join/part churn but keeps the #237 topic line", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  const channel = `#t325-${Date.now()}`;
  const topicOnJoin = `#325 topic set before join ${Date.now()} — must survive presence-hide`;
  const churnNick = `t325churn-${Date.now() % 100000}`;
  const privmsgBody = `presence-survivor-325-${Date.now()}`;

  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready before /join
  // (mirrors issue237 boot order).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  // A creator peer makes the channel (→ op) and sets the topic BEFORE vjt joins,
  // so vjt learns the topic only via the join-time 332 (the #237 path).
  const creator = await IrcPeer.connect({ nick: `t325peer-${Date.now() % 100000}` });
  const churn = await IrcPeer.connect({ nick: churnNick });
  try {
    await creator.join(channel);
    await creator.topic(channel, topicOnJoin);

    await composeSend(page, `/join ${channel}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

    // The #237 topic line prints inline on join, full text.
    const topicRow = topicJoinRow(page).filter({ hasText: topicOnJoin });
    await expect(topicRow).toBeVisible({ timeout: 15_000 });

    // REAL presence churn: a dedicated peer joins, speaks, then parts — a
    // single distinct nick (no flood risk). Its join + part rows are the ones
    // the toggle must hide; its PRIVMSG is the survivor (narrow suppression set).
    await churn.join(channel);
    churn.privmsg(channel, privmsgBody);
    await churn.part(channel, "leaving 325 witness");

    const joinRow = page
      .locator('[data-testid="scrollback-line"][data-kind="join"]')
      .filter({ hasText: churnNick });
    const partRow = page
      .locator('[data-testid="scrollback-line"][data-kind="part"]')
      .filter({ hasText: churnNick });
    const privmsgRow = page
      .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
      .filter({ hasText: privmsgBody });

    // 1. presence shown by default (small channel) → churn rows + topic visible.
    await expect(joinRow).toHaveCount(1, { timeout: 15_000 });
    await expect(partRow).toHaveCount(1, { timeout: 15_000 });
    await expect(privmsgRow).toHaveCount(1, { timeout: 15_000 });
    await expect(topicRow).toHaveCount(1);

    // 2. toggle presence OFF → join/part vanish; PRIVMSG stays; and CRUCIALLY
    //    the #237 topic line STILL shows (the #325 fix — pre-fix it vanished).
    const toggle = page.locator('[data-testid="presence-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 5_000 });
    await toggle.click();
    await expect(joinRow).toHaveCount(0, { timeout: 5_000 });
    await expect(partRow).toHaveCount(0, { timeout: 5_000 });
    await expect(privmsgRow).toHaveCount(1);
    await expect(topicRow).toHaveCount(1);
    await expect(topicRow).toBeVisible();
  } finally {
    await composeSend(page, `/part ${channel}`).catch(() => {});
    await churn.disconnect("325 churn done").catch(() => {});
    await creator.disconnect("325 creator done").catch(() => {});
  }
});
