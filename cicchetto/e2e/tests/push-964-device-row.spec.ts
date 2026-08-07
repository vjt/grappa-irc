// push-964 — the device row stops being byte-identical to its twin.
//
// `parseUserAgent` collapses the UA to `Browser on OS`, so two instances of
// the same browser on the same OS render the SAME row; the only escape hatch
// was the full UA in `title=`, which is hover-only and therefore absent on
// touch — where the drawer mostly lives. #964 point 3 + its follow-up put two
// always-visible disambiguators on the row, both from data already on the
// wire:
//
//   * the activity instant — `last_used_at`, falling back to `created_at`
//     while nothing has been pushed to the device yet;
//   * a "this device" marker on the row THIS browser registered (matched by
//     endpoint→id, the same proof `disablePush` uses to never delete a row it
//     cannot prove ours).
//
// Both assertions are on rendered TEXT, so this spec is engine-independent —
// no @webkit twin (that pairing belongs to UA-dependent defects like #963's
// `fieldtext`, not to data rendering).
//
// Why an e2e and not only a unit test: the "last used" branch needs the
// server to have stamped `last_used_at`, and the ONLY thing that stamps it is
// a real delivery (peer DM → Push.Triggers → Push.Sender → push-catcher).
//
// Why a SECOND browser context for the last leg, instead of reloading the
// first: on boot `installPushResubscribe` renews a dropped-but-wanted
// subscription, and the push stub's "subscribed" flag is per-document — so a
// reload would look like a drop, POST a fresh row with `supersedes`, and
// replace the very row whose `last_used_at` we are asserting. A clean context
// carries no opt-in intent, so it renews nothing and reads the same server
// row. It also proves the other half of the marker contract: the marker is
// per-BROWSER, not per-user, so the same account elsewhere sees no marker.

import { expect, test } from "../fixtures/test";
import { loginAs, openSettingsSection, selectChannel } from "../fixtures/cicchettoPage";
import { IrcPeer } from "../fixtures/ircClient";
import {
  awaitDeviceLastUsed,
  awaitPushDelivery,
  enablePushFromSettings,
  pushCatcherEndpoint,
  resetPushCatcher,
  resetPushSubscriptions,
  setPageVisibility,
  stubPushManager,
} from "../fixtures/push";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const PEER_NICK = "n964-dmer";
const SUB_ID = "964-device-row";

test("device row shows the activity instant + marks the device you are on", async ({
  page,
  context,
  browser,
}) => {
  const vjt = getSeededVjt();
  await resetPushCatcher();
  await resetPushSubscriptions(vjt.token);
  await stubPushManager(context, { endpoint: pushCatcherEndpoint(SUB_ID) });
  await context.grantPermissions(["notifications"]);

  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0], { ownNick: NETWORK_NICK });

  await enablePushFromSettings(page, context, { id: SUB_ID, token: vjt.token });

  // ── Freshly registered: nothing has been pushed here yet, so the row reads
  // the creation instant — and it is OUR row, so it carries the marker.
  await openSettingsSection(page, "push");
  const row = page.locator('[data-testid="devices-list"] li').first();
  await expect(row.getByTestId("device-activity")).toHaveText(/^added \d+[smhd]/);
  await expect(row.getByTestId("device-current")).toHaveText(/this device/);
  // Exactly one row may claim it — a marker on a second device would be the
  // "which of these two Firefoxes am I?" bug wearing a green dot.
  await expect(page.getByTestId("device-current")).toHaveCount(1);

  // ── A real delivery stamps `last_used_at` on the row.
  const peer = await IrcPeer.connect({ nick: PEER_NICK });
  try {
    // Background the device: a VISIBLE one suppresses the push at source.
    await setPageVisibility(page, false);
    peer.privmsg(NETWORK_NICK, "hi from n964-dmer");
    expect((await awaitPushDelivery(SUB_ID)).length).toBeGreaterThanOrEqual(1);
    // Barrier: Sender bumps the row AFTER the vendor 200, so the catcher
    // seeing a delivery does not yet mean the DB write has landed.
    await awaitDeviceLastUsed(vjt.token);
  } finally {
    await peer.disconnect("964 done");
  }

  // ── Same account, a different browser: the row now reads the delivery
  // instant, and NOTHING here claims to be "this device".
  const observerCtx = await browser.newContext();
  try {
    const observer = await observerCtx.newPage();
    await loginAs(observer, vjt);
    await openSettingsSection(observer, "push");
    const observed = observer.locator('[data-testid="devices-list"] li').first();
    await expect(observed.getByTestId("device-activity")).toHaveText(/^last used \d+[smhd]/);
    await expect(observer.getByTestId("device-current")).toHaveCount(0);
  } finally {
    await observerCtx.close();
  }
});
