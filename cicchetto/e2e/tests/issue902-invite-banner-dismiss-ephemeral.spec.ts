// #902 — the invite banner's × writes NOTHING. This file was
// `issue511-invited-dismiss-durable.spec.ts` and asserted the OPPOSITE; the
// rename is the honest record of a contract that was deliberately reversed,
// not of a test that was tidied.
//
// #511's subject was the greyed `:invited` pseudo-row. Dismissing it had to
// be DURABLE: pre-#511 the × was client-only (`forceParted`), the upstream
// `Session.Server` kept `window_states[ch] = :invited`, and #482's
// cold-subscribe backfill re-emitted `window_invited` on the next reload —
// the dismissed TAB came back, which is a bug when the thing coming back is
// a permanent row in your sidebar. #511 routed the × through the DELETE so
// the server key was cleared.
//
// #902 removed that pseudo-row. An invite is a BANNER now, and vjt ruled its
// controls explicitly: `[Join]` joins and closes, `×` closes without
// joining, and NEITHER writes persisted state — "an invite is allowed to be
// lost", the peer can simply invite again. So the same observable behaviour
// #511 called a bug is now the intended one, because what returns is a
// transient notification rather than an accumulating window.
//
// What this spec therefore guards is the REVERSAL, which is worth guarding
// precisely because the old shape looks so reasonable: route the banner's ×
// through `dismissPseudoWindow`/`partAndForget` "for consistency with the
// other close verbs" and you have silently made any peer's invite
// destructible by a stray click, with no undo. That regression is invisible
// to a unit test — the client-local dismissed-set behaves identically either
// way; only the server key differs, and only a reload reveals it.
//
// TWO invites, only ONE dismissed — the KEPT invite is the condition-based
// co-witness inherited from #511. Both `window_invited` events ride the SAME
// ordered user-topic cold-snapshot burst (`push_session_snapshot` →
// `WindowState.invited_windows/2`), a DIFFERENT cold-load cycle from the
// REST `/channels` chain that repaints the autojoin tab. Waiting for the
// KEPT banner proves that very burst was dispatched + processed, so the
// verdict on the DISMISSED one is read at a proven-settled moment rather
// than raced against a slower snapshot. Here BOTH must return; the
// co-witness is what makes "it came back" a fact about the SERVER KEY rather
// than about the burst happening to be fast.
//
// Needs the live upstream + a session surviving a browser reload, which
// jsdom/vitest cannot do (per feedback_cicchetto_browser_smoke).

import { expect, test } from "../fixtures/test";
import {
  expectShellReady,
  inviteBanner,
  inviteBannerDismiss,
  loginAs,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// Per-run-unique — bahamut lingers channel/nick state after disconnect, so
// static literals collide on rapid reruns (feedback: per-run-unique names).
const PEER_NICK = `inv902-${crypto.randomUUID().slice(0, 6)}`;
const DISMISSED_CHANNEL = `#inv902d-${crypto.randomUUID().slice(0, 8)}`;
const KEPT_CHANNEL = `#inv902k-${crypto.randomUUID().slice(0, 8)}`;

test("#902 — dismissing an invite banner writes nothing: it returns after a reload, and dismissing one never hides the other", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Confirm login on a real channel first (self-JOIN echo present) so the
  // upstream session is live before the INVITEs.
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Bahamut requires the inviter to be on the channel it invites to (else
    // 442 ERR_NOTONCHANNEL), so the peer joins both first, then relays the
    // two raw INVITEs to the operator's session.
    await peer.join(DISMISSED_CHANNEL);
    await peer.join(KEPT_CHANNEL);
    peer.rawInvite(NETWORK_NICK, DISMISSED_CHANNEL);
    peer.rawInvite(NETWORK_NICK, KEPT_CHANNEL);

    // LIVE: TWO banners, stacked. This is the only place in the suite where a
    // single banner SOURCE has more than one live entry — the case that
    // forced the registry's dismiss identity to widen from source to entry.
    const dismissed = inviteBanner(page, NETWORK_SLUG, DISMISSED_CHANNEL);
    const kept = inviteBanner(page, NETWORK_SLUG, KEPT_CHANNEL);
    await expect(dismissed).toBeVisible({ timeout: 10_000 });
    await expect(kept).toBeVisible({ timeout: 10_000 });

    // Dismiss ONLY the first. A source-keyed dismissed-set would take BOTH
    // down here — the unit suite proves that on the derivation, this proves
    // it on the rendered stack, where the × is a real click on a real element
    // and the two banners are siblings in one container.
    await inviteBannerDismiss(page, NETWORK_SLUG, DISMISSED_CHANNEL).click();
    await expect(dismissed).toHaveCount(0, { timeout: 5_000 });
    await expect(kept).toBeVisible();

    // RELOAD — tears down the WS + cic's in-memory dismissed-set and
    // `windowStateByChannel`; the upstream `Session.Server` survives, still
    // holding BOTH channels at `:invited` if the × truly wrote nothing.
    await page.reload();
    await expectShellReady(page);

    // BARRIER (condition-based co-witness): the KEPT invite reappears from
    // the user-topic cold-snapshot burst. Its visibility proves the burst was
    // dispatched + processed, so the verdict below is read at a settled
    // moment.
    await expect(inviteBanner(page, NETWORK_SLUG, KEPT_CHANNEL)).toBeVisible({ timeout: 15_000 });

    // HEADLINE: the dismissed invite is BACK. Red the moment someone routes
    // the banner's × through the PART path — which would clear the server key
    // and make a peer's invite destructible by one stray click.
    await expect(inviteBanner(page, NETWORK_SLUG, DISMISSED_CHANNEL)).toBeVisible({
      timeout: 15_000,
    });
  } finally {
    // Both channels are still :invited server-side (that is the point of this
    // test), so clear BOTH or they pollute sibling specs' cold-loads — the
    // #482 cleanup rationale, which the reversal makes MORE necessary, not
    // less: nothing in the test clears them any more.
    await partChannel(vjt.token, NETWORK_SLUG, DISMISSED_CHANNEL).catch(() => {});
    await partChannel(vjt.token, NETWORK_SLUG, KEPT_CHANNEL).catch(() => {});
    await peer.disconnect("902 done");
  }
});
