// CP15 B6 — typed window-state events: joined → kicked transition.
//
// Asserts that when a peer KICKs vjt from a fresh channel:
//   1. Peer (founding JOINer = auto-opped) creates the channel + cic
//      vjt /joins it. Cic state goes pending → joined for vjt's window.
//   2. Peer KICKs vjt. Server-side: bahamut emits the KICK on the
//      channel topic; grappa's event_router routes target == state.nick
//      to a `:kicked` effect; apply_effects flips window_states to
//      :kicked AND broadcasts `kind: "kicked"` on the per-channel
//      topic with by + reason fields.
//   3. Cic-side: subscribe.ts arms `setKicked(key, by, reason)` →
//      windowStateByChannel flips to "kicked" → ComposeBox renders
//      `.compose-box-greyed` + "(not joined)" inline label;
//      MembersPane "not joined" muted; sidebar row gets
//      `.sidebar-window-greyed`. The window STAYS in active sidebar
//      (intent doc: KICK is other-party action, doesn't archive).
//   4. The KICK message renders in scrollback with the kicker nick +
//      reason; assert presence by reason string substring.
//
// CHANNEL CLEANUP: random per-run suffix; peer disconnects in
// afterEach (its quit drops the channel since vjt got kicked).

import { test, expect } from "@playwright/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const NEW_CHANNEL = `#cp15-b6-k-${crypto.randomUUID().slice(0, 8)}`;
const KICK_REASON = "go away cp15b6";

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
  // Defensive PART — if the kick assertion failed mid-run vjt may
  // still be on the channel and the autojoin row would persist into
  // the next spec.
  const vjt = getSeededVjt();
  await partChannel(vjt.token, NETWORK_SLUG, NEW_CHANNEL).catch(() => {});
});

test("CP15 B6 — peer KICKs vjt; window flips to kicked, stays in active sidebar greyed", async ({
  page,
}) => {
  // Peer joins first → bahamut grants @ ops (NO_CHANOPS_WHEN_SPLIT
  // disabled in the testnet bahamut, so the founding JOINer auto-ops).
  peer = await IrcPeer.connect({ nick: `cp15b6k-${crypto.randomUUID().slice(0, 6)}` });
  await peer.join(NEW_CHANNEL);

  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // Cic /join — vjt joins the channel as second user, no @ ops. The
  // sidebar row appears + state goes pending → joined when the JOIN
  // echo lands. selectChannel-style awaitWsReady is encoded in the
  // member-pane assertion below: members_seeded landing means the
  // joined-state UI surface is live.
  await composeSend(page, `/join ${NEW_CHANNEL}`);

  // Bug A fix (post-bucket-H regression cluster): wait on the
  // WS-truth signal (per-channel self-JOIN scrollback line means
  // the JOIN echo arrived AND windowState flipped to joined AND
  // BUG4 auto-focused the new window). Same gate-on-WS-truth
  // pattern as cp15-b5 — the original 5s sidebar+members pane
  // assertions raced bahamut-test's JOIN-handshake pipeline
  // (4 hops: bahamut JOIN echo → grappa delegate → channels_changed
  // broadcast → REST refetch + members_seeded WS push) under CI
  // parallel pressure (max_cases:2). The page snapshot at failure
  // time consistently showed members-pane WITH vjt-grappa already
  // rendered, just past the 5s window.
  await expect(
    page
      .locator('[data-testid="scrollback-line"][data-kind="join"]')
      .filter({ hasText: NETWORK_NICK })
      .filter({ hasText: NEW_CHANNEL })
      .first(),
  ).toBeVisible({ timeout: 10_000 });

  const row = sidebarWindow(page, NETWORK_SLUG, NEW_CHANNEL);
  await expect(row).toHaveCount(1, { timeout: 10_000 });
  // Confirm the join landed before the KICK fires — without this gate
  // a fast peer.kick race would catch vjt before bahamut completes the
  // JOIN handshake (the kick would 401 nosuchnick on the server side).
  const membersPane = page.locator(".members-pane");
  await expect(membersPane.locator("li", { hasText: NETWORK_NICK })).toBeVisible({
    timeout: 10_000,
  });

  // Peer KICKs vjt. Server-side: event_router self-target KICK arm
  // emits `:kicked` effect → apply_effects broadcasts
  // `kind: "kicked"` + window_states flip.
  await peer.kick(NEW_CHANNEL, NETWORK_NICK, KICK_REASON);

  // Sidebar row stays put (KICK doesn't archive — intent doc) but
  // gets the greyed class.
  await expect(row).toHaveCount(1, { timeout: 5_000 });
  await expect(row.locator(".sidebar-window-greyed")).toBeVisible({ timeout: 5_000 });

  // ComposeBox: greyed + "(not joined)" inline label.
  const composeBox = page.locator(".compose-box");
  await expect(composeBox).toHaveClass(/compose-box-greyed/, { timeout: 5_000 });
  await expect(page.locator("p.compose-box-not-joined")).toBeVisible();

  // MembersPane is suppressed entirely after KICK (post
  // cic-members-panel-scope-fix 2026-05-08). Pre-fix the pane stayed
  // mounted with a "not joined" muted stub; the right-hand 14rem grid
  // column stayed reserved for nothing. Post-fix Shell.tsx omits the
  // `<MembersPane>` mount via the `isActiveChannelJoined()` predicate
  // and adds `.shell-no-members` to collapse the column.
  await expect(membersPane).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".shell.shell-no-members, .shell-mobile")).toHaveCount(1);

  // KICK message visible in scrollback with the reason. data-kind is
  // "kick" per ScrollbackPane.tsx's typed-line case for kick events.
  const kickLine = page
    .locator('[data-testid="scrollback-line"][data-kind="kick"]')
    .filter({ hasText: KICK_REASON });
  await expect(kickLine).toBeVisible({ timeout: 5_000 });
});
