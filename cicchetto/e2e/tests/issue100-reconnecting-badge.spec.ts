// #100 — reconnecting badge (presentational). Asserts the transient
// per-network "reconnecting…" sidebar badge appears while a Session is
// (re)establishing the upstream socket and clears once connected.
//
// The badge is driven by the server's `connection_progress`
// user-topic event: "connecting" (a Session.Server client-start
// attempt) → reconnectingByNetwork()[slug] = true → badge shows;
// "connected" (001 RPL_WELCOME) → false → badge clears. It is
// PRESENTATIONAL ONLY — distinct from the durable connection_state
// (which stays :connected through a transient reconnect); the badge is
// an ephemeral overlay cic mirrors, never originates.
//
// Driver: the proven park→Reconnect cycle. `/disconnect` parks the
// network (selection redirects to Home, sidebar network header stays
// visible + greyed). Clicking the Home Reconnect chip fires
// Networks.connect → eager SpawnOrchestrator → a fresh Session.Server
// whose do_start_client broadcasts `connecting` — so the badge appears
// on the network-header row during the multi-second connect + SASL +
// register window against the real bahamut testnet, then clears on 001.
//
// This exercises exactly the #100 reconnect path end-to-end: a session
// that is not currently connected coming back up, surfaced to the user.
//
// CLEANUP: afterEach reconnects the network (best-effort) and polls
// GET /channels until autojoin restores #bofh — same discipline as
// cp15-b6-parked-disconnect-reconnect so the next spec inherits a live
// session.

import { test, expect } from "../fixtures/test";
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const PARK_REASON = "testing reconnect badge #100";

// 90s — body (~5s) + Reconnect connect window + afterEach autojoin
// poll (~30s) + testnet-load safety margin. Same budget as the sibling
// park→reconnect spec.
test.setTimeout(90_000);

test.afterEach(async () => {
  // Best-effort reconnect + poll #bofh back to joined so a mid-run
  // failure doesn't leave the network parked for the next spec (same
  // rationale as cp15-b6-parked-disconnect-reconnect).
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
      const bofh = channels.find((c) => c.name === SEED_CHANNEL);
      if (bofh?.joined) return;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
});

test("#100 — reconnecting badge shows while a parked network reconnects, then clears on connect", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });
  const channelRow = sidebarWindow(page, NETWORK_SLUG, SEED_CHANNEL);
  await expect(channelRow).toHaveCount(1);

  const networkSection = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
  const reconnectingBadge = networkSection.locator('[data-testid="reconnecting-badge"]');

  // Baseline: connected → no reconnecting badge.
  await expect(reconnectingBadge).toHaveCount(0);

  // Park the network. Selection redirects to Home; the sidebar network
  // header row stays rendered (greyed), so the badge has a home to
  // appear on when the reconnect fires.
  await composeSend(page, `/disconnect ${NETWORK_SLUG} ${PARK_REASON}`, { expectUnmount: true });

  const parkedCard = page.locator(".home-pane-network-row-parked", {
    has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
  });
  await expect(parkedCard).toHaveCount(1, { timeout: 10_000 });
  const reconnectBtn = parkedCard.getByRole("button", { name: `Reconnect ${NETWORK_SLUG}` });
  await expect(reconnectBtn).toBeEnabled();

  // Install a MutationObserver latch BEFORE triggering the reconnect. The
  // "reconnecting…" badge is inherently transient — it shows on `connecting`
  // and clears on `001`, a window that can be sub-second on a healthy
  // testnet. Racing `toBeVisible` against that flash is flaky by
  // construction; the observer catches the badge the instant it enters the
  // DOM regardless of how briefly it lives, latching a window flag we then
  // await. This asserts the real outcome (the badge DID surface on the
  // reconnect) deterministically.
  await page.evaluate(() => {
    const w = window as unknown as { __cic_reconnectBadgeSeen?: boolean };
    w.__cic_reconnectBadgeSeen = false;
    const seen = () =>
      document.querySelector('[data-testid="reconnecting-badge"]') !== null;
    if (seen()) {
      w.__cic_reconnectBadgeSeen = true;
      return;
    }
    const obs = new MutationObserver(() => {
      if (seen()) {
        w.__cic_reconnectBadgeSeen = true;
        obs.disconnect();
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  });

  // Reconnect → fresh SpawnOrchestrator → Session.Server do_start_client
  // broadcasts `connecting` → the badge appears during the upstream
  // connect + SASL + register window.
  await reconnectBtn.click();

  // The latch flips true the moment the badge enters the DOM — proves the
  // transient "reconnecting…" badge surfaced on the reconnect.
  await page.waitForFunction(
    () => (window as unknown as { __cic_reconnectBadgeSeen?: boolean }).__cic_reconnectBadgeSeen === true,
    undefined,
    { timeout: 20_000 },
  );

  // On 001 RPL_WELCOME the server broadcasts `connected` → badge clears.
  // Steady-state assertion (deterministic, not a flash).
  await expect(reconnectingBadge).toHaveCount(0, { timeout: 20_000 });

  // Sanity: the network actually came back — channel row ungreys after
  // autojoin (proves the reconnect completed, not just that the badge
  // vanished).
  await expect(channelRow.locator(".sidebar-window-greyed")).toHaveCount(0, { timeout: 15_000 });
});
