// #248 (P0) — the connect-welcome LUSERS burst must NOT auto-surface the
// LusersCard over the message view.
//
// Bug: on connect Bahamut auto-emits its 7-numeric LUSERS sequence at
// registration. grappa NEVER self-issues LUSERS, so it forwards that
// unsolicited burst as the SAME `lusers_bundle` user-topic event an
// operator-issued /lusers produces. Pre-#248 cic stored EVERY bundle →
// the LusersCard floated in the top-pinned scrollback overlay the moment
// the operator landed, covering the buffer. Onboarding users read the
// covered view as "my sent messages aren't showing up" (reported P0).
//
// Fix (client-only, lusersBundle.ts + userTopic.ts + compose.ts): the
// store surfaces a bundle ONLY when the operator solicited it
// (markLusersRequested on /lusers, consume-once). The connect-welcome
// burst is never preceded by a request → dropped silently.
//
// Faithful reproduction (the WS-subscribe race means a bundle only
// reaches the browser when it is subscribed DURING a registration): the
// proven park→Reconnect cycle (issue100-reconnecting-badge). Parking
// terminates the IRC Session.Server but keeps the browser's user-topic
// subscription; clicking Home Reconnect respawns the session, Bahamut
// re-sends the welcome LUSERS burst, and grappa broadcasts the
// (unsolicited) `lusers_bundle` to the subscribed browser — the exact
// production path that covered onboarding users' buffers.
//
// Determinism: autojoin (channel re-JOIN → sidebar row ungreys) happens
// AFTER registration server-side, hence after the welcome LUSERS burst.
// So once the row is joined again, the welcome bundle has already been
// delivered + dispatched: asserting the card is absent then can't
// false-pass on the old (surfacing) code, which would have stored the
// bundle and rendered the card on re-select.
//
// Positive control: an operator-solicited /lusers still surfaces the
// card — proving the fix suppresses only the auto-emit, not the feature
// (guards against a lazy "disable lusers entirely" regression).
//
// Per feedback_ux_e2e_mandatory: every cic UX-behavior change ships with
// a Playwright e2e via scripts/integration.sh.

import { expect, test } from "../fixtures/test";
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const PARK_REASON = "testing #248 lusers auto-surface";

// 90s — body (~10s) + park→reconnect connect window + afterEach autojoin
// poll (~30s) + testnet-load margin. Same budget as the sibling
// park→reconnect specs (issue100, ux-5-bc).
test.setTimeout(90_000);

test.afterEach(async () => {
  // Best-effort restore: reconnect + poll #bofh back to joined so a
  // mid-run failure doesn't leave the network parked for the next spec
  // (same discipline as issue100-reconnecting-badge).
  const vjt = getSeededVjt();
  const { patchNetworkConnectionState } = await import("../fixtures/grappaApi");
  await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, {
    connection_state: "connected",
  }).catch(() => {});

  const channelsUrl = `http://grappa-test:4000/networks/${NETWORK_SLUG}/channels`;
  for (let attempt = 0; attempt < 60; attempt++) {
    const res = await fetch(channelsUrl, {
      headers: { authorization: `Bearer ${vjt.token}` },
    }).catch(() => null);
    if (res?.ok) {
      const channels = (await res.json()) as Array<{ name: string; joined: boolean }>;
      if (channels.find((c) => c.name === SEED_CHANNEL)?.joined) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
});

test("#248 — connect-welcome LUSERS does not auto-surface the LusersCard; operator /lusers still does", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  const channelRow = sidebarWindow(page, NETWORK_SLUG, SEED_CHANNEL);
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  const lusersCard = page.locator("[data-testid='lusers-card']");

  // Baseline: landed on the channel with no LUSERS card covering it. The
  // seeded session registered before THIS browser subscribed, so no
  // welcome bundle was delivered here yet.
  await expect(lusersCard).toHaveCount(0);

  // Park the network. Selection redirects to Home; the browser's
  // user-topic subscription survives (only the IRC Session.Server dies),
  // so the reconnect's welcome LUSERS burst will reach it.
  await composeSend(page, `/disconnect ${NETWORK_SLUG} ${PARK_REASON}`, { expectUnmount: true });

  const parkedCard = page.locator(".home-pane-network-row-parked", {
    has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
  });
  await expect(parkedCard).toHaveCount(1, { timeout: 10_000 });
  const reconnectBtn = parkedCard.getByRole("button", { name: `Reconnect ${NETWORK_SLUG}` });
  await expect(reconnectBtn).toBeEnabled();

  // Reconnect → fresh Session.Server → Bahamut re-registers and re-sends
  // the welcome LUSERS burst → grappa broadcasts the unsolicited
  // `lusers_bundle` to the (subscribed) browser.
  await reconnectBtn.click();

  // Wait for the reconnect to FULLY settle: the autojoin channel row
  // ungreys (window_state → joined). Autojoin runs AFTER registration,
  // so by now the welcome LUSERS burst has been delivered + dispatched.
  await expect(channelRow.locator(".sidebar-window-greyed")).toHaveCount(0, { timeout: 30_000 });

  // Re-select the rejoined channel so a ScrollbackPane is mounted — the
  // card, had the welcome bundle surfaced, would render in its top-pinned
  // overlay here.
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  // THE FIX: the unsolicited connect-welcome LUSERS did NOT surface the
  // card. Pre-#248 the bundle was stored → the card floats over the top
  // of the message view (count 1) and this assertion fails.
  await expect(lusersCard).toHaveCount(0);

  // Positive control: an operator-solicited /lusers DOES surface the card
  // (markLusersRequested → applyLusersBundle). Proves the fix suppresses
  // only the auto-emit, not the feature.
  await composeSend(page, "/lusers");
  await expect(lusersCard).toBeVisible({ timeout: 10_000 });
});
