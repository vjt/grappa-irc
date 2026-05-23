// P-0e + P-0f — invite-ack ephemeral row. When the operator issues
// `/invite peer #channel` and upstream relays it, Bahamut sends back
// 341 RPL_INVITING. P-0f flipped the route from per-channel topic to
// USER topic + $server window mount, because operators usually invite
// peers to channels they are NOT in (per-channel routing was a silent
// drop in the common case — `feedback_silent_retry_anti_pattern`).
//
// This e2e drives the full path:
//   1. operator joins a fresh test channel (becomes +o as first-joiner)
//   2. peer connects (Bahamut INVITE requires target nick to exist)
//   3. operator switches to $server window
//   4. operator issues `/invite <peer> #fresh-channel` via composeSend
//   5. server's 341 handler fires → broadcast on Topic.user/1 → cic
//      appends an invite-ack synthetic row in $server scrollback
//
// Per `feedback_ux_e2e_mandatory`: every cic UX-touching change ships
// with a Playwright e2e via scripts/integration.sh.
//
// FLAKE-C bucket 4 (2026-05-23) — original spec issued /invite from
// #bofh where vjt-grappa is NOT op (m9b-grappa won the autojoin race
// for the +o slot post-M-cluster seed expansion; see FLAKE-C bucket
// 2 / `members-prefix-regression` for the full root cause). Bahamut
// silently drops INVITE from a non-op inviter — no 341 ack ever
// comes back, store stays empty, row never mounts. Spec passed only
// intermittently when other test state perturbed the race in odd
// ways.
//
// Fix: vjt joins a fresh dedicated channel (`#p0e-invite-test`)
// AHEAD of any other user → vjt is the first joiner → Bahamut grants
// +o → vjt has the privileges to /invite. Channel name is
// per-spec-distinct so concurrent test runs don't collide on +o
// ownership.

import { expect, test } from "@playwright/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "p0e-invitee";
const CHANNEL = "#p0e-invite-test";

test("P-0e + P-0f — /invite to a peer surfaces invite-ack row in the $server window", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Join a fresh channel so vjt is the first user → Bahamut grants
  // +o → vjt can issue /invite. selectChannel won't work for a
  // channel that doesn't have a sidebar slot yet, so /join via
  // composeSend from any focused window. NETWORK_NICK is needed for
  // selectChannel's join-line wait on the prior step.
  await selectChannel(page, NETWORK_SLUG, "#bofh", { ownNick: NETWORK_NICK });
  await composeSend(page, `/join ${CHANNEL}`);
  // Wait for the new channel's sidebar entry to appear (proves the
  // JOIN landed + windowState transitioned to :joined; the sidebar
  // row gates on the windowState presence).
  await expect(
    page.locator(".sidebar-network-section li").filter({ hasText: CHANNEL }),
  ).toHaveCount(1, { timeout: 10_000 });

  // Bahamut requires the INVITE target to exist on-network — offline
  // nicks return 401 ERR_NOSUCHNICK and there's no 341 ack. Connect
  // a peer first; we don't need it to join anything, just exist.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Switch to $server window — the invite-ack row mounts there
    // (P-0f flipped the route from per-channel to user-topic +
    // $server window mount). awaitWsReady:false since server-window
    // has no join-line heuristic.
    await selectChannel(page, NETWORK_SLUG, "Server", { awaitWsReady: false });

    // Issue /invite from $server. compose.ts:447-454 tolerates
    // non-channel-window context when channel arg is explicit
    // (P-0f no-silent-drops bucket 0).
    await composeSend(page, `/invite ${PEER_NICK} ${CHANNEL}`);

    // Invite-ack row mounts inline in $server scrollback via
    // ScrollbackPane.tsx:1252-1254 `<Show when={props.kind ===
    // "server"}>`. 10s absorbs the WS round-trip latency.
    const row = page.locator("[data-testid='invite-ack-row']").first();
    await expect(row).toBeVisible({ timeout: 10_000 });
    await expect(row).toContainText("→");
    await expect(row).toContainText("invited");
    await expect(row).toContainText(PEER_NICK);
    // P-0f — row text includes the target channel since $server
    // aggregates invites issued to any channel.
    await expect(row).toContainText(CHANNEL);
  } finally {
    await peer.disconnect("P-0e done");
  }
});
