// Issue #16 — MembersPane stuck "loading…" after a keyed (+k) JOIN.
//
// Symptom (reported 2026-05-19, AFTER F1 + CP15 B3 landed): you /join
// a +k channel, the JOIN succeeds, but the members pane never seeds —
// it sits on "loading…" (MembersPane.tsx:171, the `list().length===0
// while state==="joined"` fallback) until a manual `/names`.
//
// Investigation (CP67, prod rpc): bahamut DOES send the 353/366 burst
// on a keyed JOIN — members seed server-side in <2s. So the bug is cic
// not RENDERING the snapshot, not the server omitting it. The live
// `members_seeded` broadcast (per-channel topic) reaches the freshly-
// subscribed socket; the COLD path is where the residual hides — a
// page reload re-subscribes the per-channel topic and the snapshot must
// re-arrive via the Channel after_join push (`push_members_if_seeded`,
// grappa_web/channels/grappa_channel.ex), NOT the one-shot live
// broadcast. A single happy-path run can pass even if the race exists;
// the cold resubscribe is the deterministic trigger.
//
// This spec asserts BOTH: members seed on the live keyed JOIN, then
// SURVIVE a reload (cold WS resubscribe). A "loading…" stall on either
// arm = #16 reproduced.
//
// Runs on chromium desktop (no @webkit tag) — the members pane renders
// directly in `.shell-members .members-pane`, no mobile drawer.
//
// CLEANUP: the wrapped `test` fixture auto-resets vjt after every spec
// (restores autojoin to ["#bofh"], clears last_joined, restarts the
// session) — so the dynamically-joined NEW_CHANNEL is dropped for free.
// afterEach only tears down the peer.

import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const KEY = "k16-secret-key";
const NEW_CHANNEL = `#k16-${crypto.randomUUID().slice(0, 8)}`;

// Reload + double members assertion + testnet latency — give it more
// than the default 30s without leaning on the reconnect-class budgets.
test.setTimeout(60_000);

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
});

test("issue #16 — members pane seeds on a keyed JOIN and survives a cold WS resubscribe (no stuck loading…)", async ({
  page,
}) => {
  // Peer founds the +k channel BEFORE cic joins. The founding JOINer
  // auto-ops on the testnet (NO_CHANOPS_WHEN_SPLIT undef'd — the same
  // basis cp15-b6-* relies on to set +i without /oper), so it can set
  // the key.
  peer = await IrcPeer.connect({ nick: `k16peer-${crypto.randomUUID().slice(0, 6)}` });
  await peer.join(NEW_CHANNEL);
  await peer.mode(NEW_CHANNEL, "+k", KEY);

  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Need a focused window (ComposeBox) to issue /join — focus the
  // seeded autojoin channel first.
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // cic /join carries the key (compose.ts postJoin(..., cmd.key)).
  await composeSend(page, `/join ${NEW_CHANNEL} ${KEY}`);

  // Focus the keyed channel; awaitWsReady gates on the self-JOIN line,
  // which proves the scrollback REST fetch landed AND the per-channel
  // WS topic subscription completed.
  await selectChannel(page, NETWORK_SLUG, NEW_CHANNEL, { ownNick: NETWORK_NICK });

  // LIVE-path baseline: the 353/366 burst arrived on the freshly-
  // subscribed per-channel topic and members_seeded seeded the store.
  // The pane shows the member list (peer + self), NOT "loading…".
  await assertMembersSeeded(page, peer.nick);

  // COLD-path — the #16 surface. Reload forces a cold WS resubscribe:
  // cic re-boots (addInitScript re-seeds the auth localStorage), re-
  // subscribes the per-channel topic, and the members snapshot must
  // re-arrive via the Channel after_join push (push_members_if_seeded)
  // — the live members_seeded broadcast only fires once, at JOIN time.
  // If the after_join push doesn't re-deliver, the pane is stuck on
  // "loading…".
  await page.reload();
  await expect(page.locator(".sidebar-network-header").first()).toBeVisible({ timeout: 10_000 });
  await selectChannel(page, NETWORK_SLUG, NEW_CHANNEL, { ownNick: NETWORK_NICK });

  await assertMembersSeeded(page, peer.nick);
});

// The pane is mounted, shows the member list (peer + own nick), and is
// NOT stuck on the "loading…" fallback. `member-name` rows only render
// inside the `list().length > 0` arm, so their presence is the direct
// negation of the #16 stall.
async function assertMembersSeeded(page: Page, peerNick: string): Promise<void> {
  const membersPane = page.locator(".shell-members .members-pane");
  await expect(membersPane).toBeVisible({ timeout: 10_000 });
  await expect(membersPane.locator(".member-name", { hasText: peerNick })).toBeVisible({
    timeout: 10_000,
  });
  await expect(membersPane.locator(".member-name", { hasText: NETWORK_NICK })).toBeVisible();
  await expect(membersPane.locator("p.muted", { hasText: "loading" })).toHaveCount(0);
}
