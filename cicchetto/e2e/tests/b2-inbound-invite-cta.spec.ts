// No-silent-drops B6.4 / B5 HIGH-9 — Playwright coverage for B2
// (inbound INVITE [Join] CTA).
//
// #78 (folds #128) rerouted inbound INVITE: a peer's INVITE we did NOT
// request no longer lands in the $server window. The server now persists
// the INVITE row AT THE INVITED CHANNEL (route-by-channel-reference) and
// flips that channel to a not-joined `:invited` window state — a greyed
// sidebar tab the operator can /join on their own time (NO auto-focus,
// the single persisted INVITE row is the one unread item). Cic's
// ScrollbackPane `renderRawEvent` still renders the `[Join]` CTA
// (`.scrollback-invite-join`) for the INVITE verb — now inside the
// channel buffer instead of $server.
//
// E2E shape:
//   1. operator focused on a real channel
//   2. peer issues `INVITE <ownNick> #b2-target`
//   3. a greyed `:invited` tab for #b2-target appears in the sidebar
//      (NOT auto-focused)
//   4. operator selects that tab; the INVITE row + [Join] button render
//      in the channel buffer
//   5. click [Join] → channel mounts as joined + stays focused
//
// Per `feedback_cicchetto_browser_smoke`: vitest jsdom doesn't render the
// CSS layout the greyed tab + [Join] button depend on, nor the
// click-to-join WS round-trip — exactly the class of bug jsdom misses.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "b2-inviter";
const TARGET_CHANNEL = "#b2-target";

test("B2 — inbound INVITE opens a greyed :invited tab; [Join] inside it mounts + focuses the channel", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Confirm login on a real channel first. The INVITE no longer lands in
  // $server (#78), so there's no $server switch — the invited channel's
  // own greyed tab is the surface.
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

    // #78: a greyed :invited tab for the invited channel appears in the
    // sidebar — NOT auto-focused. The pseudo-row carries the
    // `.sidebar-window-greyed` class (not-joined state).
    const invitedTab = sidebarWindow(page, NETWORK_SLUG, TARGET_CHANNEL);
    await expect(invitedTab).toBeVisible({ timeout: 5_000 });
    // Genuine-gate assertion (#78 redo). `.sidebar-window-greyed` is shared
    // by EVERY not-joined pseudo-row state (pending/invited/failed/kicked/
    // parked), so asserting only the class would pass even if the
    // inbound-INVITE path produced the wrong state — or none, with the row
    // greyed for an unrelated reason. data-window-state pins the row to the
    // real `:invited` derivation: server do_route(:invite) → {:invited, ch}
    // → window_invited on the user topic → cic setInvited. If any link in
    // that chain breaks, this attribute is absent/wrong and the spec goes
    // RED here instead of riding the generic greyed class to a false green.
    await expect(invitedTab).toHaveAttribute("data-window-state", "invited");
    await expect(invitedTab.locator(".sidebar-window-greyed")).toBeVisible();

    // Operator selects the invited tab on their own time. awaitWsReady is
    // false — the channel is NOT joined yet, so there's no self-JOIN line.
    await selectChannel(page, NETWORK_SLUG, TARGET_CHANNEL, { awaitWsReady: false });

    // The INVITE row + [Join] button render in the channel buffer (per
    // ScrollbackPane.tsx renderRawEvent INVITE arm).
    const joinBtn = page.locator(".scrollback-invite-join").first();
    await expect(joinBtn).toBeVisible({ timeout: 5_000 });
    await expect(joinBtn).toContainText("Join");

    // The row text mentions the inviter + channel.
    const row = page
      .locator('[data-testid="scrollback-line"]')
      .filter({ hasText: PEER_NICK })
      .filter({ hasText: TARGET_CHANNEL })
      .first();
    await expect(row).toBeVisible();

    // Click [Join] → cic posts /join. The channel transitions from the
    // greyed :invited pseudo-row to a live joined window and stays
    // focused (the operator was already in this window).
    await joinBtn.click();

    const newWindow = sidebarWindow(page, NETWORK_SLUG, TARGET_CHANNEL);
    await expect(newWindow).toBeVisible({ timeout: 5_000 });
    await expect(newWindow).toHaveClass(/selected/, { timeout: 5_000 });
    // Joined now → the greyed class falls off (live channelsBySlug row).
    await expect(newWindow.locator(".sidebar-window-greyed")).toHaveCount(0, { timeout: 5_000 });
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
