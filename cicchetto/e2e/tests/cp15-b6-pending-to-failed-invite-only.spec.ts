// CP15 B6 — typed window-state events: pending → failed (invite-only).
//
// Asserts that `/join #...` against a channel set `+i` (invite-only)
// drives the windowState transition pending → failed:
//   1. IrcPeer joins a fresh channel + sets `+i` BEFORE cic /join.
//   2. Cic operator types `/join #invite-channel`. compose.ts fires
//      `setPending` synchronously; the sidebar synthetic-pending row
//      OR the channels_changed heartbeat would normally render the
//      channel.
//   3. Server-side: bahamut emits 473 ERR_INVITEONLYCHAN; the session's
//      event_router routes it (in_flight_joins entry matches), emits
//      `{:join_failed, channel, reason, 473}`; apply_effects persists a
//      `:notice` scrollback row + broadcasts `kind: "join_failed"` on
//      the per-channel topic. State map flips to `:failed`.
//   4. Cic-side: subscribe.ts arms `setFailed` → windowStateByChannel
//      flips to "failed" → ComposeBox renders `.compose-box-greyed` +
//      "(not joined)" inline label; MembersPane renders "not joined"
//      muted text; sidebar row gets `.sidebar-window-greyed`.
//   5. The notice line carries the literal upstream reason
//      ("Cannot join channel (+i)") — assert it shows as a notice row
//      in the failed channel's scrollback.
//
// CHANNEL CLEANUP: random per-run suffix; afterEach has the peer PART
// the channel + cic operator never joined so no autojoin row exists.

import { test, expect } from "../fixtures/test";
import {
  composeSend,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const NEW_CHANNEL = `#cp15-b6-i-${crypto.randomUUID().slice(0, 8)}`;

let peer: IrcPeer | null = null;

test.afterEach(async () => {
  if (peer) {
    await peer.disconnect("e2e cleanup").catch(() => {});
    peer = null;
  }
});

test("CP15 B6 — /join transitions pending → failed for invite-only channel; ComposeBox + MembersPane + sidebar reflect failed state", async ({
  page,
}) => {
  // Peer creates the +i channel BEFORE cic attempts /join. The peer is
  // the founding JOINer → bahamut grants @ ops automatically. (The
  // testnet bahamut compiles with NO_CHANOPS_WHEN_SPLIT undef'd so
  // fresh channels reliably auto-op the first user; on stock bahamut
  // the 5-minute split-recovery timer would deny ops for the entire
  // duration of the e2e run. See infra/bahamut/options.h_hub.)
  peer = await IrcPeer.connect({ nick: `cp15b6i-${crypto.randomUUID().slice(0, 6)}` });
  await peer.join(NEW_CHANNEL);
  await peer.mode(NEW_CHANNEL, "+i");

  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // The cic /join arm fires setPending immediately + setSelectedChannel
  // — cic focuses the would-be channel before the upstream 473 lands.
  await composeSend(page, `/join ${NEW_CHANNEL}`);

  // The failed channel row shows up in the sidebar (synthetic pending
  // OR channels_changed heartbeat — either path renders the entry).
  // After the 473 lands, the row stays put (failed windows aren't
  // archived) but gets `.sidebar-window-greyed`.
  //
  // Codebase review 2026-05-08 CP15-B6 follow-up: pre-fix this asserted
  // `row count == 1` first, THEN `.sidebar-window-greyed` second. Both
  // appearance paths (synthetic pending row from `setPending` AND the
  // typed `join_failed` flip to greyed) raced under a sub-second WS
  // window — the count assertion would race with the synchronous
  // `setPending` while the `join_failed` typed event was still in
  // flight, occasionally landing the row's first render BEFORE the
  // greyed class was applied. Sibling `cp15-b6-kicked-greyed-state.spec.ts`
  // exercises the same render path reliably because the kick happens
  // post-:joined (no sub-second pending overlap).
  //
  // Fix: gate on the greyed-row sentinel (presence + class atomic) as
  // a single combined wait_for. The greyed class is only applied AFTER
  // the typed `join_failed` event lands, so seeing it is the
  // "state machine has flipped" signal — strictly stronger than the
  // standalone count==1 assertion AND naturally implies it.
  const row = sidebarWindow(page, NETWORK_SLUG, NEW_CHANNEL);
  const greyedRow = row.locator(".sidebar-window-greyed");
  await expect(greyedRow).toBeVisible({ timeout: 10_000 });
  await expect(row).toHaveCount(1);

  // ComposeBox: greyed + "(not joined)" inline label. Greying applies
  // when state ∈ {failed, kicked, parked}.
  const composeBox = page.locator(".compose-box");
  await expect(composeBox).toHaveClass(/compose-box-greyed/, { timeout: 5_000 });
  await expect(page.locator("p.compose-box-not-joined")).toBeVisible();

  // MembersPane is suppressed entirely for non-joined states (post
  // cic-members-panel-scope-fix 2026-05-08): failed / kicked / parked
  // channels carry no member-list-shaped UI, so the right-hand pane
  // doesn't mount. The desktop grid collapses via .shell-no-members
  // (CSS column reclamation). Pre-fix this test asserted the
  // "not joined" muted stub, which Shell rendered unconditionally —
  // that was the buggy behavior surfaced during cluster #4 smoke.
  await expect(page.locator(".shell-members .members-pane")).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator(".shell.shell-no-members, .shell-mobile")).toHaveCount(1);

  // Failure reason as a notice scrollback line. Bahamut sends
  // "Cannot join channel (+i)" — the cic-side row carries the reason
  // verbatim in body, data-kind="notice". The notice is persisted
  // server-side at JOIN-failure time; cic fetches it via the
  // ScrollbackPane mount's loadInitialScrollback REST. Larger timeout
  // (10s) than the visual-state assertions because the notice round-
  // trip goes upstream → bouncer → DB persist → REST fetch, while
  // state events take only the WS broadcast path. Inter-spec runs
  // under load have hit a 5s timeout here when the testnet has
  // accumulated state from prior specs.
  const failureNotice = page
    .locator('[data-testid="scrollback-line"][data-kind="notice"]')
    .filter({ hasText: /\(\+i\)/ });
  await expect(failureNotice).toBeVisible({ timeout: 10_000 });
});
