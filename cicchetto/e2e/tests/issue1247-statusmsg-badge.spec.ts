// #1247 — an ops-only NOTICE (`NOTICE @#chan`) must READ as ops-only.
//
// #218 fixed the routing half: the row lands in the channel window. It did
// NOT record WHICH level delivered it — `strip_statusmsg_target/2` peeled the
// sigil to route and dropped it, so neither the scrollback row nor the PubSub
// payload carried it and cic had nothing to badge with. The information was
// destroyed at ingress, not merely unrendered.
//
// Two things only a real stack proves, and this is the acceptance gate for
// both (feedback_ux_e2e_mandatory):
//   1. the DELIVERY is genuinely ops-only — bahamut relays `@#chan` to
//      channel ops alone, so the row exists at all only because the peer
//      opped us first. jsdom cannot exercise upstream STATUSMSG delivery.
//   2. LIVE and RELOADED agree. The badge on arrival comes off the PubSub
//      payload; the badge after a reload comes off the persisted row read
//      back over REST. If the level rode only the broadcast, the second
//      assertion fails and the defect is merely displaced — which is the
//      whole point of the issue's "a reload and a live message must say the
//      same thing".
//
// Shape (mirrors issue218-statusmsg-notice, whose setup this inherits):
//   1. a peer founds a fresh per-run channel → the founder auto-ops (@)
//   2. the operator (vjt-grappa) joins it as a plain member
//   3. the peer ops vjt-grappa so bahamut DELIVERS the `@#chan` notice
//   4. the peer sends `NOTICE @#chan :…` → the row renders badged
//   5. reload → the same row, read back from the store, is still badged

import {
  composeSend,
  loginAs,
  scrollbackLine,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { partChannel } from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import { AUTOJOIN_CHANNELS, NETWORK_SLUG } from "../fixtures/seedData";
import { expect, specNick, specUser, test } from "../fixtures/test";

test("#1247 — an ops-only NOTICE is badged on arrival AND after a reload", async ({ page }) => {
  // Per-run unique channel + peer nick: a module-level constant makes the
  // spec un-`--repeat-each`-able (a second pass would re-found a channel it
  // already parted and race a 433 on the peer nick).
  const suffix = crypto.randomUUID().slice(0, 6);
  const channel = `#s1247-${suffix}`;
  const peerNick = `s1247p${suffix.slice(0, 5)}`;
  const body = `ops-only heads up ${suffix}`;

  const vjt = specUser();
  await loginAs(page, vjt);
  // Focus the autojoin channel first to confirm login + WS-ready and mount
  // the compose box before issuing the /join (issue240 boot order — after
  // login cic lands on Home, which renders no ComposeBox).
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: specNick() });

  const peer = await IrcPeer.connect({ nick: peerNick });
  try {
    // The founding JOINer auto-ops on the testnet leaf (NO_CHANOPS_WHEN_SPLIT
    // undef'd — the basis issue218 / cp15-b6 rely on), so the peer holds @ and
    // can both op vjt and send a STATUSMSG.
    await peer.join(channel);

    await composeSend(page, `/join ${channel}`);
    await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toBeVisible({ timeout: 15_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });

    // Op vjt-grappa: STATUSMSG `@` reaches only members at op status, so
    // without this the notice never arrives and the spec would pass vacuously
    // on the negative assertions alone.
    await peer.mode(channel, "+o", specNick());

    peer.notice(`@${channel}`, body);

    // LIVE: the badge off the broadcast.
    const liveRow = scrollbackLine(page, "notice", body);
    await expect(liveRow).toBeVisible({ timeout: 15_000 });
    await expect(liveRow.getByTestId("statusmsg-badge")).toHaveText("ops-only");

    // RELOADED: the badge off the persisted row. Pre-fix BOTH of these fail;
    // with the level on the broadcast only, this one alone fails.
    await page.reload();
    await expect(page.locator(".sidebar-network-header").first()).toBeVisible({ timeout: 10_000 });
    await selectChannel(page, NETWORK_SLUG, channel, { ownNick: specNick() });

    const reloadedRow = scrollbackLine(page, "notice", body);
    await expect(reloadedRow).toBeVisible({ timeout: 15_000 });
    await expect(reloadedRow.getByTestId("statusmsg-badge")).toHaveText("ops-only");
  } finally {
    await peer.disconnect("issue1247 done");
    // `/join` persists the channel into vjt's autojoin set; PART restores
    // pre-test state. Idempotent — swallow 404 if the test bailed early.
    await partChannel(vjt.token, NETWORK_SLUG, channel).catch(() => {});
  }
});
