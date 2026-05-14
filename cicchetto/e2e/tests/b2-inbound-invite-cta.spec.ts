// No-silent-drops B6.4 / B5 HIGH-9 — Playwright coverage for B2
// (inbound INVITE [Join] CTA).
//
// B2 fix landed in commit b031d89: when a peer issues INVITE
// against the operator, the server now emits a typed `:notice` row
// on $server with `meta.raw_verb = "INVITE"` (post-B6.1 reshape).
// Cic's ScrollbackPane :notice-arm renderRawEvent recognises the
// INVITE verb and renders a `[Join]` CTA button (CSS class
// `.scrollback-invite-join`); clicking it calls postJoin +
// setSelectedChannel so the operator joins the invited channel +
// the cic window auto-focuses.
//
// E2E shape:
//   1. operator focused on $server window
//   2. peer issues `INVITE <ownNick> #b2-target`
//   3. cic appends an INVITE row with [Join] button
//   4. click [Join] → channel mounts in sidebar + auto-focused
//
// Per `feedback_cicchetto_browser_smoke`: vitest jsdom doesn't
// render the CSS layout that the [Join] button depends on; the
// click-to-mount round-trip is exactly the class of bug jsdom
// misses.

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "b2-inviter";
const TARGET_CHANNEL = "#b2-target";

test("B2 — inbound INVITE shows [Join] CTA; click mounts channel + focuses it", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Confirm login on a real channel first, then switch to $server
  // (where INVITE rows land per B2's EventRouter routing).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });
  await selectChannel(page, NETWORK_SLUG, "Server", { awaitWsReady: false });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Bahamut requires the inviter to be in the channel they're
    // inviting to (or be an oper). Have the peer join first so the
    // INVITE relay isn't rejected with 442 ERR_NOTONCHANNEL.
    await peer.join(TARGET_CHANNEL);

    // Raw INVITE: `INVITE <target_nick> <channel>`. irc-framework
    // doesn't expose a typed invite() helper; raw goes straight to
    // bahamut which relays to the operator's session.
    peer.rawInvite(NETWORK_NICK, TARGET_CHANNEL);

    // The $server window receives a :notice row with
    // .scrollback-invite-join button (per ScrollbackPane.tsx:343).
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

    // Click [Join] → cic posts /join + setSelectedChannel. The new
    // channel appears in the sidebar AND becomes focused.
    await joinBtn.click();

    const newWindow = sidebarWindow(page, NETWORK_SLUG, TARGET_CHANNEL);
    await expect(newWindow).toBeVisible({ timeout: 5_000 });

    // Auto-focus check: the joined channel becomes the active sidebar
    // entry. Sidebar marks the active <li> with the `selected` class.
    await expect(newWindow).toHaveClass(/selected/, { timeout: 5_000 });
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
    // click). Surfaced by no-silent-drops B6.11 closing the wireNarrow
    // gap that had been masking this leak; pre-B6.11 the [Join]
    // click silently failed (server_event row dropped at WS edge),
    // so b2 left no trace and N-3 was accidentally green.
    await partChannel(vjt.token, NETWORK_SLUG, TARGET_CHANNEL).catch(() => {});
  }
});
