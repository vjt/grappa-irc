// Issue #38 — a +k autojoin channel that fails to (re)JOIN gets stuck
// in the sidebar and can't be dismissed with ×.
//
// Faithful repro of the production scenario (vjt's #it-opers): a +k
// channel sits in `credential.autojoin_channels`. grappa NEVER persists
// +k keys (server.ex), so on every (re)connect the autojoin loop JOINs
// it with NO key → bahamut 475 ERR_BADCHANNELKEY → not joined. That
// lights up BOTH sidebar sources for the same channel:
//
//   A. GET /channels merges autojoin_channels ∪ live members →
//      returns it {joined:false, source:autojoin} → channelsBySlug →
//      Sidebar LIVE branch renders a greyed row (the × on this row
//      routes through handleCloseChannel → DELETE /channels).
//   B. the 475 emits a `join_failed` typed event → windowStateByChannel
//      [chan] = "failed" → the authoritative greyed synthetic row.
//
// #38 is whether the × clears BOTH sources. If it clears one but not
// the other, the row survives → "can't dismiss". This spec ASSERTS the
// dismiss outcome only; it prescribes no fix. DANGER (handoff): the
// Sidebar dedup (channelsBySlug vs windowState) is fragile — the
// windowState-wins arm was reverted for ghost rows. Do NOT "fix" #38
// by reviving it.
//
// Repro construction:
//   1. peer founds NEW_CHANNEL +k (auto-op basis, as cp15-b6).
//   2. admin PATCH vjt's credential autojoin = [#bofh, NEW_CHANNEL].
//      An autojoin-only edit is `:left_alone` server-side — a DB write
//      with NO session restart — so this alone does NOT fire the JOIN.
//   3. /disconnect + Home Reconnect → a fresh SpawnOrchestrator reads
//      the DB autojoin → JOIN NEW_CHANNEL with no key → 475 → both
//      sidebar sources light up on the same channel.
//   4. × the greyed row → assert it disappears.
//
// We can't stage the failing channel via resetSubject: its
// await_autojoin polls every autojoin entry to :joined and would 504 on
// a perpetually-475 +k channel. Hence admin PATCH (no wait) for setup.
//
// Runs on chromium desktop (no @webkit tag).
//
// CLEANUP: the wrapped `test` fixture auto-resets vjt after every spec
// (restores autojoin to ["#bofh"] — dropping NEW_CHANNEL even if the ×
// failed — clears last_joined, and restarts the session, which drops
// the failed NEW_CHANNEL window). afterEach only tears down the peer.

import { test, expect } from "../fixtures/test";
import {
  composeSend,
  confirmModal,
  confirmModalYes,
  loginAs,
  selectChannel,
  sidebarCloseButton,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import {
  AUTOJOIN_CHANNELS,
  getSeededAdmin,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const KEY = "k38-secret-key";
const NEW_CHANNEL = `#k38-${crypto.randomUUID().slice(0, 8)}`;
// Single-network e2e seeder → credential network_id is always 1
// (seedData.ts getSeededM9bSessionId comment).
const NETWORK_ID = 1;
const PARK_REASON = "issue38 reconnect repro";

// Park + Reconnect + autojoin round-trip + the auto-reset teardown all
// cost real wall-clock on the testnet — mirror the parked-reconnect
// template's generous budget.
test.setTimeout(120_000);

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
});

// The User UUID the admin credentials endpoint keys on == the login
// subject `id` stashed in the seeded vjt's subjectJson.
function vjtUserId(): string {
  return (JSON.parse(getSeededVjt().subjectJson) as { id: string }).id;
}

test("issue #38 — × dismisses a 475-failed +k autojoin channel row", async ({ page }) => {
  const admin = getSeededAdmin();
  const { setCredentialAutojoin } = await import("../fixtures/grappaApi");

  // 1. Peer founds the +k channel.
  peer = await IrcPeer.connect({ nick: `k38peer-${crypto.randomUUID().slice(0, 6)}` });
  await peer.join(NEW_CHANNEL);
  await peer.mode(NEW_CHANNEL, "+k", KEY);

  // 2. Stage NEW_CHANNEL into vjt's operator-config autojoin (DB only;
  //    an autojoin-only edit does not restart the session, so the JOIN
  //    is NOT attempted yet).
  await setCredentialAutojoin(admin.token, vjtUserId(), NETWORK_ID, [SEED_CHANNEL, NEW_CHANNEL]);

  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // 3. Park + Reconnect so a fresh session spawns and runs the autojoin
  //    loop against the updated DB list. JOIN NEW_CHANNEL (no key) →
  //    475 → not joined. /disconnect redirects selection to Home, whose
  //    parked card carries the Reconnect chip.
  await composeSend(page, `/disconnect ${NETWORK_SLUG} ${PARK_REASON}`, { expectUnmount: true });
  const parkedCard = page.locator(".home-pane-network-row-parked", {
    has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
  });
  await expect(parkedCard).toHaveCount(1, { timeout: 10_000 });
  await parkedCard.getByRole("button", { name: `Reconnect ${NETWORK_SLUG}` }).click();

  // 4. Reconnect completed: the network section ungreys once the fresh
  //    session reaches :connected (mirrors the parked-reconnect
  //    template's completion gate).
  const networkSection = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
  await expect(networkSection).not.toHaveClass(/sidebar-network-greyed/, { timeout: 20_000 });

  // The seeded channel re-JOINed (live, not greyed) — confirms autojoin
  // ran on the fresh session.
  await expect(sidebarWindow(page, NETWORK_SLUG, SEED_CHANNEL).locator(".sidebar-window-greyed"))
    .toHaveCount(0, { timeout: 20_000 });

  // NEW_CHANNEL lands as a greyed, not-joined row. Both sidebar sources
  // are proven here: `toHaveCount(1)` confirms source A (the GET
  // /channels autojoin merge → channelsBySlug) collapsed with the would-
  // be pseudo-row into a single LIVE-branch row (the dedup); and since
  // the network itself is un-greyed (asserted above), `.sidebar-window-
  // greyed` can only come from `windowStateByChannel[key] ∈
  // {failed,kicked,parked}` — i.e. it is the proxy for source B (the
  // join_failed typed event from the 475). Both must be live for this
  // to hold, which is exactly the #38 condition.
  const stuckRow = sidebarWindow(page, NETWORK_SLUG, NEW_CHANNEL);
  await expect(stuckRow).toHaveCount(1, { timeout: 20_000 });
  await expect(stuckRow.locator(".sidebar-window-greyed")).toBeVisible({ timeout: 10_000 });

  // 5. THE #38 ASSERTION — the × dismisses the row. If it survives
  //    (either sidebar source left dangling), this times out and #38 is
  //    reproduced. If it vanishes, #38 is already fixed and this spec is
  //    the regression guard.
  //
  // Assert the × is present first: a greyed autojoin row with NO close
  // button would itself be a #38-class failure (un-dismissable), and a
  // bare `.click()` timeout reads as an opaque locator error instead.
  const closeBtn = sidebarCloseButton(page, NETWORK_SLUG, NEW_CHANNEL);
  await expect(closeBtn).toBeVisible({ timeout: 5_000 });
  await closeBtn.click();
  // #195 — the channel × now opens a leave-confirm modal; the row dismisses
  // on Yes. (NEW_CHANNEL is a channelsBySlug greyed autojoin row →
  // handleCloseChannel, so it gets the same confirm gate as a live leave.)
  await expect(confirmModal(page)).toBeVisible();
  await confirmModalYes(page);
  await expect(sidebarWindow(page, NETWORK_SLUG, NEW_CHANNEL)).toHaveCount(0, { timeout: 10_000 });
});
