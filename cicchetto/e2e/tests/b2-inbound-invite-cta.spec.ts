// No-silent-drops B6.4 / B5 HIGH-9 — Playwright coverage for B2
// (inbound INVITE [Join] CTA).
//
// #78 (folds #128) rerouted inbound INVITE: a peer's INVITE we did NOT
// request no longer lands in the $server window. The server persists the
// INVITE row AT THE INVITED CHANNEL (route-by-channel-reference) and flips
// that channel to a not-joined `:invited` window state.
//
// #902 changed WHAT THE OPERATOR SEES, and this spec follows it. The greyed
// `:invited` sidebar tab is gone; the invite is announced by an entry in the
// stacked top banner region reading "<nick> is inviting you to #chan", with
// a [Join] action and the standard ×. The reason is the report that filed
// the issue: several people were invited and nobody noticed, because a
// greyed row among other greyed rows pulls no attention and the channel-row
// copy is invisible until you open a window you have no reason to open.
//
// E2E shape:
//   1. operator focused on a real, unrelated channel — and STAYS there,
//      because the banner must be visible from any window
//   2. peer issues `INVITE <ownNick> #b2-target`
//   3. a banner for #b2-target appears, NAMING the inviter; no sidebar row
//      exists for the channel and focus does not move
//   4. click the banner's [Join] → the channel mounts as joined + focused,
//      and the banner clears itself because the window left `:invited`
//   5. the INVITE row is still in the CHANNEL's own buffer — #902 keeps it
//      as history; only the $server duplicate was dropped
//
// Per `feedback_cicchetto_browser_smoke`: vitest jsdom doesn't render the
// banner region's stacking or the click-to-join WS round-trip — exactly the
// class of bug jsdom misses.

import { expect, test } from "../fixtures/test";
import {
  inviteBanner,
  inviteBannerJoin,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "b2-inviter";
const TARGET_CHANNEL = "#b2-target";

test("B2 — inbound INVITE raises a banner naming the inviter; its [Join] mounts + focuses the channel", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Confirm login on a real channel first. The INVITE lands in neither
  // $server (#78, and #902 removed the copy #482 had restored) nor the
  // sidebar (#902 removed the greyed tab) — the banner is the surface, and
  // it is deliberately visible from ANY window, which is why we sit on an
  // unrelated channel for the whole test.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Bahamut requires the inviter to be in the channel they're inviting
    // to (or be an oper). Have the peer join first so the INVITE relay
    // isn't rejected with 442 ERR_NOTONCHANNEL.
    await peer.join(TARGET_CHANNEL);

    // Raw INVITE: `INVITE <target_nick> <channel>`. irc-framework doesn't
    // expose a typed invite() helper; raw goes straight to bahamut which
    // relays to the operator's session.
    peer.rawInvite(NETWORK_NICK, TARGET_CHANNEL);

    // #902: the invite raises a banner. `inviteBanner` keys on
    // `data-banner-id` (`invite:<slug>:<channel>`), the per-ENTRY identity —
    // NOT `data-source`, which every stacked invite shares. That pins the
    // whole chain: server do_route(:invite) → {:invited, ch, inviter} →
    // window_invited on the user topic → cic setInvited → the registry's
    // derivation off windowStateByChannel. Break any link and this locator
    // never resolves, instead of some generic banner class riding to a false
    // green.
    const banner = inviteBanner(page, NETWORK_SLUG, TARGET_CHANNEL);
    await expect(banner).toBeVisible({ timeout: 5_000 });

    // The copy NAMES the inviter. This is the half that needed the server
    // leg: the nick reaches cic on the `window_invited` payload, because the
    // banner renders before the channel's buffer is ever fetched and cannot
    // read it off the persisted INVITE row.
    await expect(banner).toContainText(PEER_NICK);
    await expect(banner).toContainText(TARGET_CHANNEL);

    // NOT auto-focused, and NOT a sidebar row: the operator is still on the
    // channel they started in, and the invited channel has no window.
    await expect(sidebarWindow(page, NETWORK_SLUG, TARGET_CHANNEL)).toHaveCount(0);

    // Click the banner's [Join] → cic posts /join and foregrounds the
    // channel. This is the SAME verb (`channelJoin.acceptInvite`) the
    // scrollback invite row's CTA calls.
    await inviteBannerJoin(page, NETWORK_SLUG, TARGET_CHANNEL).click();

    const newWindow = sidebarWindow(page, NETWORK_SLUG, TARGET_CHANNEL);
    await expect(newWindow).toBeVisible({ timeout: 5_000 });
    await expect(newWindow).toHaveClass(/selected/, { timeout: 5_000 });
    // Joined now → a live row, not a greyed one.
    await expect(newWindow.locator(".sidebar-window-greyed")).toHaveCount(0, { timeout: 5_000 });

    // The banner clears itself: the window left `:invited`, so the registry
    // stops deriving the entry. Nothing dismissed it — that is what makes it
    // derived rather than owned state.
    await expect(banner).toHaveCount(0, { timeout: 5_000 });

    // The INVITE row survives in the CHANNEL's own buffer — #902 keeps that
    // one as HISTORY (only the $server duplicate went). We are focused on
    // the channel now, so it must be on screen with its inline CTA.
    const row = page
      .locator('[data-testid="scrollback-line"]')
      .filter({ hasText: PEER_NICK })
      .filter({ hasText: TARGET_CHANNEL })
      .first();
    await expect(row).toBeVisible({ timeout: 5_000 });
  } finally {
    await peer.disconnect("B2 done");
    // Test isolation: the [Join] click persists `#b2-target` into the
    // operator's autojoin set + keeps it joined upstream for the
    // duration of the testnet container. Subsequent specs (notably
    // names-ux N-3) cold-load with `#b2-target` already :joined,
    // and since `Session.list_channels/2` returns alphabetically,
    // `#b2-target` < `#bofh` ⇒ the auto-select effect picks
    // `#b2-target` instead. PART here restores pre-test state. The
    // helper swallows 404 (idempotent if test bailed before [Join]
    // click).
    await partChannel(vjt.token, NETWORK_SLUG, TARGET_CHANNEL).catch(() => {});
  }
});
