// #482 — an inbound INVITE must leave a DURABLE trace: its surface has to
// survive a cold WS re-subscribe (reload / backgrounded PWA / reconnect).
// vjt's live symptom: *"non appare il canale nella bottom bar […] e non
// appare manco niente nella status window"* — the invite evaporated on
// reload because `:invited` was broadcast on the user topic ONCE, at INVITE
// time, and was absent from the cold-subscribe snapshot.
//
// The fix (#482): `push_user_snapshot` backfills `window_invited` for every
// `:invited` window (mirroring the #229 umode cold-snapshot).
//
// #902 kept that backfill and changed the surface it feeds — the greyed
// `:invited` tab became a top banner with [Join] — and REVERTED #482's other
// half, the second `$server` copy of the INVITE row. Both halves of that are
// asserted below, so the revert cannot quietly take the backfill with it.
//
// The witness is the #229 pattern applied to INVITE — designed so ONLY the
// cold-snapshot backfill can satisfy it:
//   1. a peer INVITEs the operator to a channel it is not in → the banner
//      appears LIVE (event-time broadcast, socket subscribed);
//   2. the page RELOADS — the WS + cic's in-memory `windowStateByChannel`
//      are torn down; the upstream `Session.Server` survives, still holding
//      `#target` at `:invited`. There is NO live INVITE echo in the reloaded
//      session, so the ONLY path that can repopulate the banner is the
//      user-topic after-join cold-snapshot. Pre-fix: gone → RED.
//      Post-fix: back → GREEN;
//   3. the restored banner still NAMES the inviter (#902) — a nick that can
//      only have come from server-side window metadata on this path;
//   4. the channel's own buffer still holds the persisted INVITE row + CTA.
//
// Needs the live upstream + a session surviving a browser reload, which
// jsdom/vitest cannot do (per feedback_cicchetto_browser_smoke).

import { expect, test } from "../fixtures/test";
import {
  expectShellReady,
  inviteBanner,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// Per-run-unique — bahamut lingers channel/nick state after disconnect, so
// static literals collide on rapid reruns (feedback: per-run-unique names).
const PEER_NICK = `inv482-${crypto.randomUUID().slice(0, 6)}`;
const TARGET_CHANNEL = `#inv482-${crypto.randomUUID().slice(0, 8)}`;

test("#482 — the inbound INVITE surface survives a reload (cold-snapshot backfill), inviter and all", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Confirm login on a real channel first (self-JOIN echo present) so the
  // upstream session is live before the INVITE.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Bahamut requires the inviter to be on the channel it invites to (else
    // 442 ERR_NOTONCHANNEL), so the peer joins first, then relays the raw
    // INVITE to the operator's session.
    await peer.join(TARGET_CHANNEL);
    peer.rawInvite(NETWORK_NICK, TARGET_CHANNEL);

    // LIVE: the invite banner appears (event-time window_invited on the user
    // topic; the socket is subscribed, so this arm is the baseline, not the
    // #482 witness). Keyed on `data-banner-id`, the per-entry identity, so it
    // pins THIS channel's invite rather than any banner.
    const banner = inviteBanner(page, NETWORK_SLUG, TARGET_CHANNEL);
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText(PEER_NICK);

    // RELOAD — tears down the WS + windowStateByChannel; the upstream
    // Session.Server survives holding #target at :invited. There is no live
    // INVITE echo in the reloaded session, so the ONLY path that can bring
    // the invite back is the user-topic after-join cold-snapshot. This is the
    // P0 witness (#482).
    await page.reload();
    await expectShellReady(page);

    // HEADLINE (RED pre-#482 — the surface evaporated on reload): the invite
    // is back from the cold-snapshot, WITHOUT any INVITE in the reloaded
    // session.
    const bannerAfter = inviteBanner(page, NETWORK_SLUG, TARGET_CHANNEL);
    await expect(bannerAfter).toBeVisible({ timeout: 15_000 });

    // #902 — and it still NAMES the inviter. This assertion is why the nick
    // had to become window metadata (`WindowState.invited_by`) rather than
    // staying a field of the persisted scrollback row: on this path there is
    // no INVITE message in hand, and `invited_windows/2` rebuilds the payload
    // from session state alone. Pre-#902 that state did not hold the nick, so
    // no amount of client work could put it here. If the sibling map is ever
    // dropped or a mutator stops maintaining it, THIS goes red — the live arm
    // above would not, because there the nick rides the event.
    await expect(bannerAfter).toContainText(PEER_NICK);
    await expect(bannerAfter).toContainText(TARGET_CHANNEL);

    // The channel's own buffer still holds the persisted INVITE row + the
    // [Join now] CTA. #902 dropped the $server DUPLICATE (#482 had restored
    // it) but deliberately kept this one — it is history, not notification,
    // and it is what the archive surfaces once the banner is gone.
    await selectChannel(page, NETWORK_SLUG, TARGET_CHANNEL, { awaitWsReady: false });
    const joinBtn = page.locator(".scrollback-invite-join").first();
    await expect(joinBtn).toBeVisible({ timeout: 10_000 });
    await expect(joinBtn).toContainText(/join/i);

    const row = page
      .locator('[data-testid="scrollback-line"]')
      .filter({ hasText: PEER_NICK })
      .filter({ hasText: TARGET_CHANNEL })
      .first();
    await expect(row).toBeVisible();
  } finally {
    // Cleanup: #482 makes :invited windows survive-on-reload, so a lingering
    // one would now pollute sibling specs' cold-loads (pre-#482 they
    // evaporated). Join → part fully clears the server-side window_state;
    // the peer must still be connected for bahamut to relay the JOIN. Both
    // steps are best-effort (idempotent if the test bailed early).
    try {
      await selectChannel(page, NETWORK_SLUG, TARGET_CHANNEL, { awaitWsReady: false });
      const joinBtn = page.locator(".scrollback-invite-join").first();
      if (await joinBtn.isVisible().catch(() => false)) {
        await joinBtn.click();
        await expect(sidebarWindow(page, NETWORK_SLUG, TARGET_CHANNEL)).toHaveClass(/selected/, {
          timeout: 10_000,
        });
      }
    } catch {
      // ignore — fall through to the API part + peer teardown
    }
    await partChannel(vjt.token, NETWORK_SLUG, TARGET_CHANNEL).catch(() => {});
    await peer.disconnect("482 done");
  }
});
