// #30 — Tab completes CHANNEL names, not only nicks.
//
// Reported by Mezmerize on #it-opers: typing `#sni`<Tab> did nothing.
// `tabComplete` read the member list unconditionally, so a sigil'd token
// had no candidate set at all. The fix switches the candidate SET on the
// token's leading sigil: a channel token draws from the channels JOINED on
// this window's network (the server-owned `windowStateByChannel`
// projection), a bare token still draws from the member list.
//
// Both halves are asserted in ONE flow, and the second half is what makes
// this spec non-hollow: a spec that only proved "`#t30…`<Tab> completes"
// would still pass against a candidate set built from "every channel ever
// seen". An INVITED channel — known to the client, present in the very same
// `windowStateByChannel` map, NOT joined — is the negative case: refusing it
// is the `state === "joined"` FILTER, not mere absence of the key.
//
// WHY INVITED AND NOT PARTED (measured, #898). The first cut parted the
// channel and re-Tabbed the same prefix, barriered on the sidebar row
// vanishing. That barrier reads a DIFFERENT projection than the assert:
// the row for a joined channel comes from `channelsBySlug` (Sidebar.tsx,
// user topic `channels_changed`) while the candidate set reads
// `windowStateByChannel` (compose.ts, the per-channel PART echo), and
// Sidebar.tsx says outright there is no cross-topic ordering between the
// two. A stale `joined` entry has NO DOM footprint at all — joined is
// excluded from the pseudo-rows — so no barrier on the parted channel can
// exist. Probing the same keystroke on a deadline measured the gap at
// 60ms / 2180ms / 4929ms / 3981ms / 3972ms across five repeats: real, and
// wide. The invite surface IS `windowStateByChannel` rendered, so here the
// barrier and the assert read ONE projection and the refusal is single-shot
// truth rather than a race the fast machine happens to win.
//
// #902 moved that surface from the greyed `:invited` sidebar row to the
// stacked top BANNER, which is derived off the same map — the barrier is
// unchanged in kind, only in selector (`inviteBanner`, keyed on the
// per-entry `data-banner-id`). It is deliberately not a sidebar row of any
// other sort: see the note at the barrier itself.
//
// The trailing `" "` (never the nick path's `": "`) is asserted verbatim:
// a channel is a topic of conversation, never an addressee.
//
// Live-stack only: the candidate set is fed by the server's window_state
// broadcasts over the WS, and the invited half needs a real upstream INVITE
// round-trip. jsdom/vitest can seed the store but cannot prove the store is
// the thing the completion reads in a real browser on a real socket.

import { IrcPeer } from "../fixtures/ircClient";
import {
  composeSend,
  composeTextarea,
  inviteBanner,
  loginAs,
  selectChannel,
} from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

test.setTimeout(90_000);

test("#30 — Tab completes a JOINED channel, and refuses an INVITED one", async ({ page }) => {
  const vjt = getSeededVjt();
  // Per-run identity so a stale row from an earlier run can never satisfy
  // either half, and so two `--repeat-each` workers entering this line in
  // the same millisecond cannot collide — on a shared stack a duplicate
  // peer nick is a 433 and a shared prefix would make the refusal
  // ambiguous. The typed prefixes are the stable heads; the stamp is the
  // part only this run can supply.
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  // DISTINCT heads: `j` and `i`. A shared head would let the joined channel
  // satisfy the invited prefix, and the refusal would fail for a reason
  // that has nothing to do with the joined-only rule.
  const joinedPrefix = `#t30j-${stamp}`;
  const joinedChannel = `${joinedPrefix}-sniffo`;
  const invitedPrefix = `#t30i-${stamp}`;
  const invitedChannel = `${invitedPrefix}-sniffo`;

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const ta = composeTextarea(page);
  await expect(ta).toBeVisible();

  const peer = await IrcPeer.connect({ nick: `t30p${stamp}` });
  try {
    await composeSend(page, `/join ${joinedChannel}`);
    // Fully JOINED (not the greyed :pending pseudo-row): selectChannel with
    // ownNick requires the self-JOIN line + the WS-ready seam.
    await selectChannel(page, NETWORK_SLUG, joinedChannel, { ownNick: NETWORK_NICK });

    // Type in a DIFFERENT window: the candidate set is network-scoped, not
    // "the channel you are looking at".
    await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

    await ta.click();
    await ta.fill(joinedPrefix);
    await ta.press("Tab");
    // Completed to the full channel with a PLAIN trailing space. Pre-#30
    // this stayed at the typed prefix.
    await expect(ta).toHaveValue(`${joinedChannel} `, { timeout: 5_000 });
    await expect(ta).toBeFocused();

    // Now a channel the client KNOWS about but is not in. Bahamut requires
    // the inviter to be in the channel (or be an oper), so the peer joins
    // first or the INVITE relay comes back 442 ERR_NOTONCHANNEL.
    await peer.join(invitedChannel);
    peer.rawInvite(NETWORK_NICK, invitedChannel);

    // THE BARRIER, on the store under test. #902 removed the greyed
    // `:invited` pseudo-row this used to wait on; the invite banner replaced
    // it and serves the same purpose for the same reason. `activeBanners()`
    // derives one entry per invited key straight off `windowStateByChannel`
    // (`windowState.invitedWindows`), so the banner IS that map rendered —
    // and `data-banner-id` names the exact (network, channel) rather than a
    // class every banner shares. Once it is visible the key is in the very
    // map the completion filters, so the refusal below is a fact about the
    // FILTER, with no cross-topic race left to lose.
    //
    // Do NOT substitute a sidebar row here: a row for a JOINED channel comes
    // from `channelsBySlug` on the user topic, a different topic with no
    // ordering guarantee against the per-channel broadcasts that drive
    // `windowStateByChannel` (stated in Sidebar.tsx). That is exactly the
    // race this barrier exists to remove.
    const invited = inviteBanner(page, NETWORK_SLUG, invitedChannel);
    await expect(invited).toBeVisible({ timeout: 15_000 });

    // Known, keyed, NOT joined: the draft is left exactly as typed.
    await ta.click();
    await ta.fill(invitedPrefix);
    await ta.press("Tab");
    await expect(ta).toHaveValue(invitedPrefix);

    // POSITIVE CONTROL for the refusal above. "The value did not change" also
    // describes a dead keybinding, an unmounted handler, or a page that never
    // finished booting — so prove the completion engine was ALIVE at that
    // moment by nick-completing in the same textarea on the next keystroke.
    // Without this, the negative half could pass for the wrong reason. It
    // doubles as the regression guard that #30 did not break nicks.
    const nickPrefix = NETWORK_NICK.slice(0, NETWORK_NICK.length - 2);
    await ta.fill(nickPrefix);
    await ta.press("Tab");
    await expect(ta).toHaveValue(`${NETWORK_NICK}: `, { timeout: 5_000 });
  } finally {
    await composeSend(page, `/part ${joinedChannel}`).catch(() => {});
    await peer.disconnect("done").catch(() => {});
  }
});
