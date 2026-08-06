// #511 for the states #902 does NOT touch — dismissing a JOIN-FAILED channel
// must be DURABLE across a reload.
//
// #902 deleted `issue511-invited-dismiss-durable.spec.ts` because it reverses
// that contract for `:invited` (the banner's × writes nothing and the invite
// returns). But #511's mechanism is still live for `:failed`/`:kicked`, and
// deleting its only end-to-end witness would have been deleted coverage of a
// LIVE contract. This file is the replacement.
//
// WHY THE AUTOJOIN SHAPE, AND NOT THE PSEUDO-ROW (measured, not assumed):
// the obvious spec — × a `:failed` PSEUDO-row, reload, assert it stays gone —
// is VACUOUS. After a reload a `:failed` state is unreachable by the client,
// so nothing can resurrect the row whether or not the × reached the server:
//   * `GrappaChannel.push_session_snapshot/2` pushes only `umode_changed`,
//     `supported_umodes_changed` and `invited_windows` on the user topic —
//     no `:failed`, no `:kicked`;
//   * `WindowState.to_wire/3` DOES re-assert `:failed`, but only on the
//     PER-CHANNEL topic, which requires a per-channel subscription;
//   * `subscribe.ts` joins one per-channel topic per entry in
//     `channelsBySlug`, and its pre-subscribe loop explicitly skips
//     `:failed`/`:kicked` ("they already had a subscription").
// A pseudo-row exists precisely BECAUSE its channel is absent from
// `channelsBySlug` (present, the Sidebar collapses it into the LIVE branch —
// #38's own dedup analysis). No entry, no subscription, no snapshot, no
// resurrection. So `ux-5-bk-join-fail-dupe` is NOT one `page.reload()` away
// from being this spec; that reload would assert nothing.
//
// The one shape where the durability IS observable is #38's production
// scenario: a +k channel in `autojoin_channels` that 475s on every connect.
// It sits in `channelsBySlug`, so the greyed row is the LIVE branch and its ×
// runs `confirmLeaveChannel` → `closeChannelWindow` → the SAME `partAndForget`
// DELETE. Client-only (the pre-#511 mutation): the autojoin entry survives, so
// the next cold load repaints the row. With the DELETE: the server de-autojoins
// AND `PartCleanup.cleanup_local` → `WindowState.set_parted` clears the window
// key, so neither source can bring it back.
//
// WHAT THIS SPEC DOES NOT ISOLATE, stated so nobody reads more into a green:
// it cannot separate `set_parted`'s contribution from the de-autojoin's — the
// one DELETE does both, and the de-autojoin alone already explains the
// absence. It constrains the COMPOSITION (× → DELETE → server → cold load),
// which is exactly the link that had no witness left.
//
// Needs the live upstream + a session surviving a browser reload, which
// jsdom/vitest cannot do (per feedback_cicchetto_browser_smoke).
//
// Runs on chromium desktop (no @webkit tag).
//
// CLEANUP: the wrapped `test` fixture auto-resets vjt after every spec
// (restores autojoin to ["#bofh"], so BOTH staged channels are dropped even if
// an assertion failed mid-spec, and restarts the session). afterEach only tears
// down the peer.

import { expect, test } from "../fixtures/test";
import {
  composeSend,
  confirmModal,
  confirmModalYes,
  expectShellReady,
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
const KEY = "k511-secret-key";
// Per-run-unique — bahamut lingers channel state after a window disconnects,
// so static literals collide on rapid reruns.
const DISMISSED_CHANNEL = `#k511d-${crypto.randomUUID().slice(0, 8)}`;
const KEPT_CHANNEL = `#k511k-${crypto.randomUUID().slice(0, 8)}`;
// Single-network e2e seeder → credential network_id is always 1
// (seedData.ts getSeededM9bSessionId comment).
const NETWORK_ID = 1;
const PARK_REASON = "issue511 failed-dismiss reconnect repro";

// Park + Reconnect + a two-channel autojoin round-trip + a full reload + the
// auto-reset teardown all cost real wall-clock on the testnet. #38's spec pays
// 120s for one channel; this one carries a second channel and a reload.
test.setTimeout(180_000);

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
});

// The User UUID the admin credentials endpoint keys on == the login subject
// `id` stashed in the seeded vjt's subjectJson.
function vjtUserId(): string {
  return (JSON.parse(getSeededVjt().subjectJson) as { id: string }).id;
}

test("#511 — a dismissed JOIN-FAILED autojoin row does NOT return after a reload, while a non-dismissed sibling does", async ({
  page,
}) => {
  const admin = getSeededAdmin();
  const { setCredentialAutojoin } = await import("../fixtures/grappaApi");

  // 1. Peer founds BOTH +k channels (auto-opped as the founding JOINer on
  //    testnet bahamut; see cp15-b6-pending-to-failed-invite-only for the
  //    NO_CHANOPS_WHEN_SPLIT rationale).
  peer = await IrcPeer.connect({ nick: `k511p-${crypto.randomUUID().slice(0, 6)}` });
  await peer.join(DISMISSED_CHANNEL);
  await peer.mode(DISMISSED_CHANNEL, "+k", KEY);
  await peer.join(KEPT_CHANNEL);
  await peer.mode(KEPT_CHANNEL, "+k", KEY);

  // 2. Stage both into vjt's operator-config autojoin (DB only; an
  //    autojoin-only edit is `:left_alone` server-side — no session restart —
  //    so the JOINs are NOT attempted yet).
  await setCredentialAutojoin(admin.token, vjtUserId(), NETWORK_ID, [
    SEED_CHANNEL,
    DISMISSED_CHANNEL,
    KEPT_CHANNEL,
  ]);

  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // 3. Park + Reconnect so a fresh session reads the updated DB autojoin and
  //    JOINs both +k channels with no key → 475 ERR_BADCHANNELKEY each.
  await composeSend(page, `/disconnect ${NETWORK_SLUG} ${PARK_REASON}`, { expectUnmount: true });
  const parkedCard = page.locator(".home-pane-network-row-parked", {
    has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
  });
  await expect(parkedCard).toHaveCount(1, { timeout: 10_000 });
  await parkedCard.getByRole("button", { name: `Reconnect ${NETWORK_SLUG}` }).click();

  // Reconnect completed: the network section ungreys once the fresh session
  // reaches :connected (the parked-reconnect template's completion gate).
  const networkSection = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
  await expect(networkSection).not.toHaveClass(/sidebar-network-greyed/, { timeout: 20_000 });

  // 4. ANTI-VACUITY GUARD — both failed channels are present and greyed,
  //    proving the `sidebarWindow` selector matches when a row IS there (the
  //    same selector the post-reload absence check uses). The network itself
  //    is un-greyed (asserted above), so `.sidebar-window-greyed` here can
  //    only come from the not-joined state, not from a parked cascade.
  const dismissedRow = sidebarWindow(page, NETWORK_SLUG, DISMISSED_CHANNEL);
  const keptRow = sidebarWindow(page, NETWORK_SLUG, KEPT_CHANNEL);
  await expect(dismissedRow).toHaveCount(1, { timeout: 20_000 });
  await expect(dismissedRow.locator(".sidebar-window-greyed")).toBeVisible({ timeout: 10_000 });
  await expect(keptRow).toHaveCount(1, { timeout: 20_000 });
  await expect(keptRow.locator(".sidebar-window-greyed")).toBeVisible({ timeout: 10_000 });

  // 5. Dismiss ONLY the first. The row is a channelsBySlug LIVE-branch entry,
  //    so its × is the #195 confirm-gated leave → closeChannelWindow →
  //    partAndForget (the DELETE). The KEPT row is untouched.
  const closeBtn = sidebarCloseButton(page, NETWORK_SLUG, DISMISSED_CHANNEL);
  await expect(closeBtn).toBeVisible({ timeout: 5_000 });
  await closeBtn.click();
  await expect(confirmModal(page)).toBeVisible();
  await confirmModalYes(page);
  await expect(dismissedRow).toHaveCount(0, { timeout: 10_000 });
  await expect(keptRow).toHaveCount(1);

  // 6. RELOAD — tears down the WS and cic's in-memory state; the upstream
  //    Session.Server survives. Pre-#511 (a client-only drop) the DELETE never
  //    happened, so the autojoin entry and the server's `:failed` window key
  //    both survived and the row was repainted here.
  await page.reload();
  await expectShellReady(page);

  // 7. BARRIER (condition-based co-witness) — the KEPT failed channel comes
  //    back, from the SAME `channelsBySlug` cold-load fetch that would repaint
  //    the dismissed one if the DELETE had not landed. Its visibility proves
  //    that fetch was dispatched and rendered, which is what makes the absence
  //    below deterministic instead of a race against a slower cold load.
  const keptRowAfter = sidebarWindow(page, NETWORK_SLUG, KEPT_CHANNEL);
  await expect(keptRowAfter).toHaveCount(1, { timeout: 20_000 });
  await expect(keptRowAfter.locator(".sidebar-window-greyed")).toBeVisible({ timeout: 10_000 });

  // 8. HEADLINE (RED under the client-only mutation) — with the co-witness
  //    proven rendered, the dismissed row is definitively gone.
  await expect(sidebarWindow(page, NETWORK_SLUG, DISMISSED_CHANNEL)).toHaveCount(0);
});
