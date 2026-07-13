// #222 — hide join/part/quit/nick-change signalling on large channels by
// default, with a per-channel opt-in to re-show. CLIENT-SIDE render decision:
// grappa STILL delivers the presence events over the wire (no wire change, no
// server change); cic decides whether to RENDER them.
//
// This e2e is the interactive witness for the per-channel toggle + the
// render-layer filter + localStorage persistence. It exercises REAL presence
// events (a peer joins + parts #bofh) — NOT 50 spawned peers: 50 nicks from
// one IP risks bahamut flood/autokill (feedback_e2e_multinet_live_needs_
// distinct_nicks), and there is no window-exposed member-count seam in the e2e
// harness to inflate membership. The size-default MATH (49 shown / 50 hidden +
// the precedence truth table) is proven authoritatively in the vitest boundary
// test (src/__tests__/presenceFilter.test.ts); this spec owns the interactive
// toggle/persistence path.
//
// Assertions (all VISIBLE outcomes, CLAUDE.md "assert outcomes not calls"):
//   1. small channel, default shown → a peer join + part row IS visible
//   2. toggle per-channel "hide presence" ON → those rows disappear
//      (toHaveCount 0), the real PRIVMSG row REMAINS (narrow suppression set)
//   3. reload the page (persistence) → still hidden
//   4. toggle OFF → the join/part rows reappear
//
// RED proof (pre-filter code): the toggle button + render filter don't exist,
// so step 2 (click the toggle → rows vanish) fails — the rows stay visible and
// the toggle locator never resolves. Implement → GREEN.
//
// Per feedback_ux_e2e_mandatory: every cic UX-touching change ships with a
// Playwright e2e via scripts/integration.sh.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

test("#222 — per-channel toggle hides join/part rows, persists across reload, PRIVMSG stays", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const channel = AUTOJOIN_CHANNELS[0];
  await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

  // A dedicated peer produces REAL join + part presence events on #bofh.
  // Distinct single nick — no flood risk. try/finally tears it down.
  const peerNick = "pres222peer";
  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    await peer.join(channel);

    // Peer PRIVMSG — the content row that MUST survive suppression (the
    // narrow set is join/part/quit/nick_change only; privmsg is not noise).
    const privmsgBody = "presence-filter-witness-222";
    peer.privmsg(channel, privmsgBody);

    await peer.part(channel, "leaving 222 witness");

    const joinRow = page
      .locator('[data-testid="scrollback-line"][data-kind="join"]')
      .filter({ hasText: peerNick });
    const partRow = page
      .locator('[data-testid="scrollback-line"][data-kind="part"]')
      .filter({ hasText: peerNick });
    const privmsgRow = page
      .locator('[data-testid="scrollback-line"][data-kind="privmsg"]')
      .filter({ hasText: privmsgBody });

    // 1. small channel (< 50 members), pref unset → presence shown by default.
    await expect(joinRow).toHaveCount(1, { timeout: 10_000 });
    await expect(partRow).toHaveCount(1, { timeout: 10_000 });
    await expect(privmsgRow).toHaveCount(1, { timeout: 10_000 });

    const toggle = page.locator('[data-testid="presence-toggle"]');
    await expect(toggle).toBeVisible({ timeout: 5_000 });

    // 2. toggle "hide presence" ON → join/part vanish, PRIVMSG stays.
    await toggle.click();
    await expect(joinRow).toHaveCount(0, { timeout: 5_000 });
    await expect(partRow).toHaveCount(0, { timeout: 5_000 });
    await expect(privmsgRow).toHaveCount(1);

    // 3. persistence — reload re-boots cic, re-fetches the persisted rows,
    //    re-reads the localStorage pref → join/part STILL hidden. NB: with
    //    presence hidden, the OWN-nick join line is suppressed too (uniform
    //    suppression — DESIGN_NOTES #222), so we can't gate focus on it;
    //    select without awaiting the (now-hidden) own-join line and use the
    //    persisted PRIVMSG row as the scrollback-ready signal instead.
    await page.reload();
    await selectChannel(page, NETWORK_SLUG, channel, { awaitWsReady: false });
    await expect(privmsgRow).toHaveCount(1, { timeout: 10_000 });
    await expect(joinRow).toHaveCount(0);
    await expect(partRow).toHaveCount(0);

    // 4. toggle OFF → the join/part rows reappear.
    const toggleAfterReload = page.locator('[data-testid="presence-toggle"]');
    await expect(toggleAfterReload).toBeVisible({ timeout: 5_000 });
    await toggleAfterReload.click();
    await expect(joinRow).toHaveCount(1, { timeout: 5_000 });
    await expect(partRow).toHaveCount(1, { timeout: 5_000 });
  } finally {
    await peer.disconnect("222 witness done");
  }
});
