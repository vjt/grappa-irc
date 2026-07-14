// #221 gap (c) — /who <mask> end-to-end. A masked WHO must surface the
// WhoModal with the matched peers, not the pre-#221 "total silence" (no
// 352, no 315, nothing in cic). This drives the full chain: cic /who
// <mask> → GrappaChannel :who_target validation → Client.send_who (mask
// forwarded, not channel-gated) → upstream → 352 (channel field "*" for a
// mask) + 315 (echoes the mask) → who_fold single-in-flight correlation →
// who_reply → WhoModal.
//
// Runs on the shared bahamut leaf: the mask fix is network-agnostic (the
// break was grappa-side outbound-gating + inbound correlation), so the
// standard seeded fixture is the stablest surface for the UI proof. The
// solanum-specific numeric coverage lives in issue221-solanum-whois.spec.ts.
//
// Asserts:
//   - the WhoModal renders (feedback, NOT silence — the core of the bug);
//   - the connected peer's row is present (the mask matched + relayed).

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test("#221 — /who <mask> surfaces the WhoModal with matched peers (not silence)", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Unique nick + a distinctive gecos token so the mask can target the
  // peer's realname/host and the row locator can't false-positive off an
  // unrelated user (mirror of issue175's unique-suffix pattern).
  const suffix = crypto.randomUUID().slice(0, 6);
  const peerNick = `maskwho-${suffix}`;
  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    // Join the shared channel so the peer is visible to the WHO scan and
    // reachable on the leaf.
    await peer.join(CHANNEL);

    // A nick-mask WHO: `maskwho-*` matches the peer by nick. Pre-#221 this
    // returned TOTAL SILENCE — the channel-only outbound gate rejected the
    // mask before it left the bouncer. Now it forwards and correlates.
    await composeSend(page, `/who maskwho-${suffix}*`);

    const modal = page.getByTestId("who-modal");
    // The modal appearing at all is the headline proof: feedback, not the
    // pre-#221 silence.
    await expect(modal).toBeVisible({ timeout: 8_000 });

    // The matched peer's row is present — the "*"-channel 352 rows folded
    // into the mask's single-in-flight accumulator and relayed.
    const peerRow = modal.locator(".who-modal-row", { hasText: peerNick });
    await expect(peerRow).toBeVisible({ timeout: 5_000 });
  } finally {
    await peer.disconnect("#221 who-mask done");
  }
});
