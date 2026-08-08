// issue1038-mute-is-per-network — the mute key carries the network (#1038).
//
// The sibling of `push-866-conversation-mute.spec.ts`. That spec proves a mute
// can hold a channel back; this one proves the mute does NOT reach past the
// network it was made on. They differ in exactly one variable, and it is the
// one #1038 added.
//
// Why an e2e is the only place this can be proven:
//
//   * the mute is created through the SettingsDrawer picker, so the composite
//     key cic emits, the key the server normalises at write, and the key
//     `Grappa.Push.Triggers` composes from an arriving row are all shown to be
//     the SAME string. Unit tests on either side pin their own idea of the
//     shape; only this can catch the two stacks disagreeing — which is exactly
//     the failure #1038 introduces if one side is missed.
//   * the assertion is on PUSH delivery, decided server-side. A client-only
//     per-network mute would look right in the sidebar and still ring the
//     phone for the network the operator silenced — or, in the other
//     direction, silence the phone for the one they did not.
//   * the two networks must be REAL. `azzurra` and `azzurra2` sit on different
//     ircds, so `#1038-both` there genuinely is two channels with two member
//     sets, not one room reached twice.
//
// The oracle is temporal, because the push-catcher cannot say which network a
// delivery came from (the payload is encrypted and no spec decodes it): the
// MUTED network speaks first and must produce nothing, then the OTHER network
// speaks and must produce a delivery. Deliveries accumulate, so the ordering
// makes the two arms unambiguous without decoding anything.
//
// Removing the network from the key turns the SECOND arm red: with a
// network-blind key the mute made on azzurra also silences azzurra2 and the
// push never arrives. Removing the mute entirely turns the FIRST arm red.
//
// Isolated user (`mute1038`), because the spec accretes two networks and the
// automatic subject reset re-spawns every credential a subject holds without
// ever removing an accreted one — doing this to the shared vjt would leave two
// permanent sessions behind and redden the admin-sessions leak canary.

import { loginAs, openSettingsSection, selectChannel } from "../fixtures/cicchettoPage";
import {
  accreteNetwork,
  clearMutedConversations,
  GRAPPA_BASE_URL,
  muteKey,
  partChannel,
  patchNetworkConnectionState,
} from "../fixtures/grappaApi";
import { IrcPeer } from "../fixtures/ircClient";
import {
  assertNoPushDelivery,
  awaitPushDelivery,
  enablePushFromSettings,
  pushCatcherEndpoint,
  resetPushCatcher,
  resetPushSubscriptions,
  setPageVisibility,
  stubPushManager,
} from "../fixtures/push";
import {
  getSeededMute1038User,
  MUTE1038_HOST_A,
  MUTE1038_HOST_B,
  MUTE1038_NETWORK_A,
  MUTE1038_NETWORK_B,
  MUTE1038_USER,
} from "../fixtures/seedData";
import { expect, test } from "../fixtures/test";

// The SAME name on both networks — that is the whole point. A different name
// per network would prove nothing the #866 spec does not already prove.
const SHARED_CHANNEL = "#1038-both";
const PEER_A = "i1038-peer-a";
const PEER_B = "i1038-peer-b";
const SUB_ID = "mute-per-network";

// The operator's nick is the account name on both networks (accretion's
// default). They are different ircds, so there is no 433 to dodge.
const OWN_NICK = MUTE1038_USER;

// Local, like the other multinet specs: `getNetworks` is a three-line read
// that each of them keeps to itself rather than a fixture everyone shares.
type NetRow = { slug: string; connection_state: string };

async function getNetworks(token: string): Promise<NetRow[]> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`getNetworks: ${res.status} ${await res.text()}`);
  return (await res.json()) as NetRow[];
}

async function waitForConnected(token: string, slug: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const rows = await getNetworks(token);
    if (rows.find((r) => r.slug === slug)?.connection_state === "connected") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`waitForConnected: ${slug} never reached connected`);
}

// JOIN via REST, retrying on 404: the credential row reaches `:connected`
// before the upstream reaches 001, so a bare join races the register. Same
// poll-until-ready discipline as the #211 phase-7 multinet spec.
async function joinChannelWhenReady(
  token: string,
  slug: string,
  channel: string,
): Promise<void> {
  let last = "";
  for (let i = 0; i < 60; i++) {
    const res = await fetch(`${GRAPPA_BASE_URL}/networks/${slug}/channels`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ name: channel }),
    });
    if (res.ok) return;
    last = `${res.status} ${await res.text()}`;
    if (res.status !== 404) throw new Error(`joinChannelWhenReady: ${slug}/${channel} → ${last}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`joinChannelWhenReady: ${slug}/${channel} never joinable (last: ${last})`);
}

test("a mute made on one network leaves the same channel on the other still pushing", async ({
  page,
  context,
}) => {
  const user = getSeededMute1038User();
  await resetPushCatcher();
  await resetPushSubscriptions(user.token);
  await stubPushManager(context, { endpoint: pushCatcherEndpoint(SUB_ID) });
  await context.grantPermissions(["notifications"]);

  // Both networks live, then the same channel joined on both. `accreteNetwork`
  // treats 409 as success and the connection PATCH is idempotent, so the whole
  // setup is `--repeat-each`-safe.
  for (const slug of [MUTE1038_NETWORK_A, MUTE1038_NETWORK_B]) {
    await accreteNetwork(user.token, slug);
    await patchNetworkConnectionState(user.token, slug, { connection_state: "connected" });
    await waitForConnected(user.token, slug);
    await joinChannelWhenReady(user.token, slug, SHARED_CHANNEL);
  }

  await loginAs(page, user);
  await selectChannel(page, MUTE1038_NETWORK_A, SHARED_CHANNEL, { ownNick: OWN_NICK });
  await enablePushFromSettings(page, context, { id: SUB_ID, token: user.token });

  // One peer per ircd: the two channels are genuinely separate rooms, so a
  // single peer cannot speak into both.
  const peerA = await IrcPeer.connect({ nick: PEER_A, host: MUTE1038_HOST_A });
  const peerB = await IrcPeer.connect({ nick: PEER_B, host: MUTE1038_HOST_B });

  try {
    await peerA.join(SHARED_CHANNEL);
    await peerB.join(SHARED_CHANNEL);

    await openSettingsSection(page, "push");

    // Leave `channel_mentions` at its default (ON) — the point is that a
    // mention WOULD have pushed and only the mute stops it. Unchecking it
    // would make the first arm pass for the wrong reason.
    await expect(page.locator('[data-testid="pref-channel-mentions"]')).toBeChecked();

    const picker = page.locator('[data-testid="pref-mute-picker"]');
    const keyA = muteKey(MUTE1038_NETWORK_A, SHARED_CHANNEL);
    const keyB = muteKey(MUTE1038_NETWORK_B, SHARED_CHANNEL);

    // THE picker assertion of #1038, and it fails on the pre-fix bundle for a
    // reason worth naming: the old picker DEDUPED by the bare channel name, so
    // one shared name across two networks collapsed into ONE option and the
    // second key below did not exist to be offered.
    await expect(picker.locator(`option[value="${keyA}"]`)).toHaveCount(1);
    await expect(picker.locator(`option[value="${keyB}"]`)).toHaveCount(1);

    await picker.selectOption(keyA);

    // The row is drawn from the SERVER's echo, so its presence proves the PUT
    // landed and came back normalised under the composite key — no sleep, no
    // arbitrary timeout. This is also the barrier for the push arms below.
    await expect(page.locator(`[data-testid="pref-muted-${keyA}"]`)).toBeVisible({
      timeout: 10_000,
    });
    // ...and the other network's copy is demonstrably NOT muted. On the
    // pre-fix stack there was no such thing as "the other network's copy".
    await expect(page.locator(`[data-testid="pref-muted-${keyB}"]`)).toHaveCount(0);
    // The row names its network, which is the only thing on screen that can
    // tell the operator WHICH of the two identically-named rooms is silenced.
    await expect(page.locator(`[data-testid="pref-muted-net-${keyA}"]`)).toHaveText(
      MUTE1038_NETWORK_A,
    );

    await page.locator('[data-testid="settings-drawer-backdrop"]').click({ force: true });

    // Background the device so #182's foreground suppression is not what
    // decides either arm.
    await setPageVisibility(page, false);

    // Arm 1 — a MENTION on the MUTED network. Silent.
    peerA.privmsg(SHARED_CHANNEL, `${OWN_NICK}: you will not hear this one`);
    await assertNoPushDelivery(SUB_ID, 1_500);

    // Arm 2 — the identical mention, same channel NAME, other network. This is
    // the assertion the pre-#1038 key fails: with a network-blind mute the
    // entry made on A silences B too and nothing arrives. It also keeps arm 1
    // honest — without it, arm 1 would pass if push were broken outright.
    peerB.privmsg(SHARED_CHANNEL, `${OWN_NICK}: but you will hear this one`);
    const deliveries = await awaitPushDelivery(SUB_ID);
    expect(deliveries.length).toBeGreaterThanOrEqual(1);
  } finally {
    await peerA.disconnect("#1038 done");
    await peerB.disconnect("#1038 done");
    // Mutes are persisted per subject and outlive the spec; the sessions are
    // parked so this user leaves no live rows behind for the admin-sessions
    // canary to count.
    await clearMutedConversations(user.token).catch(() => {});
    for (const slug of [MUTE1038_NETWORK_A, MUTE1038_NETWORK_B]) {
      await partChannel(user.token, slug, SHARED_CHANNEL).catch(() => {});
      await patchNetworkConnectionState(user.token, slug, {
        connection_state: "parked",
        reason: "#1038 spec done",
      }).catch(() => {});
    }
  }
});
