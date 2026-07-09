// #195 — explicit confirm modal for destructive window closes (replaces the
// removed #172 hold-to-close gesture).
//
// The #172 hold-gate read as a broken × on touch (a tap did nothing; a finger
// drift past 10px cancelled the 500ms hold — see the #195 field reports), so
// closing is now a plain click that opens an explicit confirm modal. This spec
// pins the two destructive close sites end to end, asserting VISIBLE outcomes:
//
//   (a) CHANNEL leave: click × → "Do you want to leave #chan?" modal →
//       Cancel keeps the window → click × again → Yes → PART + window gone.
//   (b) NETWORK disconnect: click the network-header × → "Disconnect from
//       <slug>?" modal → Cancel keeps it connected → Yes → network parks
//       (Home parked-card + greyed sidebar section).
//
// A mutually-validating pair per half: the Cancel branch proves the modal
// GATES the action (no PART / no park on cancel); the Yes branch proves it
// FIRES it. Reverting the fix (instant close on click) reds the Cancel halves.
//
// The channel test uses a DEDICATED non-autojoin channel so it never
// destabilises the shared seed #bofh; the network test parks the shared
// network and the afterEach reconnects it (same pattern as
// cp15-b6-parked-disconnect-reconnect), polling until autojoin restores #bofh.

import { expect, test } from "../fixtures/test";
import {
  confirmModal,
  confirmModalBody,
  confirmModalCancel,
  confirmModalYes,
  loginAs,
  selectChannel,
  sidebarCloseButton,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, partChannel, patchNetworkConnectionState } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const LEAVE_CHANNEL = "#x195-leave";
const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

// The network Yes-path parks the shared network + the autojoin restore is
// async (SpawnOrchestrator → connect → SASL → autojoin → JOIN echo), so grant
// the same 90s budget cp15-b6-parked-disconnect-reconnect uses.
test.setTimeout(90_000);

test.afterEach(async () => {
  const vjt = getSeededVjt();
  // Idempotent cleanup, best-effort (both tolerate already-in-state):
  //   1. Drop the dedicated leave-channel in case a test failed pre-Yes.
  //   2. Reconnect the shared network in case the network test parked it,
  //      then poll #bofh back to joined so the next serial spec inherits a
  //      live session (skipping the poll cascades failures — see cp15-b6).
  await partChannel(vjt.token, NETWORK_SLUG, LEAVE_CHANNEL).catch(() => {});
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

test("#195 — channel ×: Cancel keeps the window, Yes leaves it", async ({ page }) => {
  test.slow();
  const vjt = getSeededVjt();
  // Join the dedicated channel BEFORE login so loginAs's channelsBySlug fetch
  // already carries it.
  await joinChannel(vjt.token, NETWORK_SLUG, LEAVE_CHANNEL);
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, LEAVE_CHANNEL, { ownNick: NETWORK_NICK });

  const tab = sidebarWindow(page, NETWORK_SLUG, LEAVE_CHANNEL);
  await expect(tab).toBeVisible({ timeout: 10_000 });
  const closeBtn = sidebarCloseButton(page, NETWORK_SLUG, LEAVE_CHANNEL);
  await expect(closeBtn).toBeVisible();

  // Click × → confirm modal with the interpolated channel name. NO PART yet.
  await closeBtn.click();
  await expect(confirmModal(page)).toBeVisible();
  await expect(confirmModalBody(page)).toHaveText(`Do you want to leave ${LEAVE_CHANNEL}?`);

  // Cancel → modal dismisses, window survives (the gate held; no PART fired).
  await confirmModalCancel(page);
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(tab).toBeVisible();

  // Click × again → Yes → PART fires, the channels_changed broadcast + own-PART
  // echo drop the window from the sidebar.
  await closeBtn.click();
  await expect(confirmModal(page)).toBeVisible();
  await confirmModalYes(page);
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(sidebarWindow(page, NETWORK_SLUG, LEAVE_CHANNEL)).toHaveCount(0, {
    timeout: 10_000,
  });
});

test("#195 — network ×: Cancel keeps it connected, Yes disconnects (parks)", async ({ page }) => {
  test.slow();
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // Land somewhere stable so the network section is mounted.
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });

  const networkSection = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
  await expect(networkSection).not.toHaveClass(/sidebar-network-greyed/);

  const disconnectBtn = page
    .locator("li.sidebar-network-header", { hasText: NETWORK_SLUG })
    .locator(".sidebar-close");
  await expect(disconnectBtn).toBeVisible();

  // Click × → confirm modal with the interpolated network slug. NOT parked yet.
  await disconnectBtn.click();
  await expect(confirmModal(page)).toBeVisible();
  await expect(confirmModalBody(page)).toHaveText(`Disconnect from ${NETWORK_SLUG}?`);

  // Cancel → modal dismisses, network stays connected (section not greyed).
  await confirmModalCancel(page);
  await expect(confirmModal(page)).toHaveCount(0);
  await expect(networkSection).not.toHaveClass(/sidebar-network-greyed/);

  // Click × again → Yes → disconnect fires: the network parks, selection
  // redirects to Home, and the sidebar section greys (the park cascade —
  // same visible contract as cp15-b6-parked-disconnect-reconnect).
  await disconnectBtn.click();
  await expect(confirmModal(page)).toBeVisible();
  await confirmModalYes(page);
  await expect(confirmModal(page)).toHaveCount(0);

  const parkedCard = page.locator(".home-pane-network-row-parked", {
    has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
  });
  await expect(parkedCard).toHaveCount(1, { timeout: 15_000 });
});
