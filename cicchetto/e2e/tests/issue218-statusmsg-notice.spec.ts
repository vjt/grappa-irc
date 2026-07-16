// #218 — a NOTICE addressed to a STATUSMSG target (a membership sigil
// prefixing a channel, e.g. `@#chan` ops-only, `+#chan` voice) must land
// in the CHANNEL window, NOT the network/$server tab or a per-peer query
// window.
//
// Root cause was server-side (`Grappa.Session.EventRouter`): the two
// `:notice` clauses dispatched on the target's FIRST byte against the
// channel-sigil set `#&!+`, so `@#chan` (byte 0 `@`) failed the channel
// guard and fell through to the non-channel arm → a query window keyed on
// the sender. The fix strips a leading STATUSMSG sigil (sourced from
// ISUPPORT, bahamut default `@+`) before the channel-prefix test.
//
// E2E shape (the VISIBLE outcome, per feedback_ux_e2e_mandatory — jsdom
// can't exercise the upstream STATUSMSG delivery + WS fan-out):
//   1. a peer founds a fresh per-run channel → it auto-ops the founder (@)
//   2. the operator (vjt-grappa) joins that channel as a member
//   3. the peer ops vjt-grappa (+o) so bahamut *delivers* the ops-only
//      `@#chan` notice to vjt (STATUSMSG @ reaches only channel ops)
//   4. the peer sends `NOTICE @#chan :ops-only …`
//   5. the row persists on the CHANNEL (server-side, REST-verified) and
//      renders in the focused channel window's scrollback
//   6. it does NOT leak into the $server window
//
// Pre-fix, step 5's server-side assertion would TIME OUT: the row
// persisted to a query window keyed on the peer's nick, never `#chan`.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, scrollbackLine, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { assertMessagePersisted, partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// Fresh per-run channel so the founder-op + autojoin side-effects don't
// pollute other specs (mirrors issue16 / cp15-b6). Lowercased — grappa
// case-folds channel keys.
const SUFFIX = Date.now() % 100000;
const CHANNEL = `#s218-${SUFFIX}`;
const PEER_NICK = `s218p${SUFFIX}`;
const NOTICE_BODY = `ops-only heads up ${SUFFIX}`;

test(`#218 issue218 — a NOTICE to a STATUSMSG target (@#chan) lands in the channel window, not the network tab`, async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready and to
  // mount the compose box before issuing the /join (mirrors issue240 boot
  // order — after login cic lands on Home, which renders no ComposeBox).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // The founding JOINer auto-ops on the testnet leaf (NO_CHANOPS_WHEN_SPLIT
    // undef'd — the same basis issue16 / cp15-b6 rely on), so the peer holds
    // @ and can both op vjt and send a STATUSMSG.
    await peer.join(CHANNEL);

    // vjt joins the peer-founded channel as a plain member, then focuses it.
    // `ownNick` gates selection on vjt's own self-JOIN line landing.
    await composeSend(page, `/join ${CHANNEL}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible({ timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

    // Op vjt-grappa so bahamut delivers the ops-only `@#chan` notice to it —
    // STATUSMSG `@` reaches only members at op status.
    await peer.mode(CHANNEL, "+o", NETWORK_NICK);

    // The peer (an op) emits the ops-only notice at the STATUSMSG target.
    peer.notice(`@${CHANNEL}`, NOTICE_BODY);

    // Server-side proof (channel-scoped, focus-independent): the row
    // persists on `#chan`, sender = the peer. Pre-fix this timed out — the
    // row went to a query window keyed on the peer's nick.
    await assertMessagePersisted({
      token: vjt.token,
      networkSlug: NETWORK_SLUG,
      channel: CHANNEL,
      sender: PEER_NICK,
      body: NOTICE_BODY,
      kind: "notice",
    });

    // Visible outcome: the notice renders in the focused CHANNEL window.
    await expect(scrollbackLine(page, "notice", NOTICE_BODY)).toBeVisible({ timeout: 5_000 });

    // And it did NOT leak into the network/$server window (the reported
    // symptom). Focus $server and negate — mirror of issue221-whois-badges.
    await selectChannel(page, NETWORK_SLUG, "$server", { awaitWsReady: false });
    await expect(page.getByTestId("scrollback")).not.toContainText(NOTICE_BODY);
  } finally {
    await peer.disconnect("issue218 done");
    // `/join` persists CHANNEL into vjt's autojoin set; PART restores
    // pre-test state so it doesn't survive into the next run. Idempotent —
    // swallow 404 if the test bailed before the join landed.
    await partChannel(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
  }
});
