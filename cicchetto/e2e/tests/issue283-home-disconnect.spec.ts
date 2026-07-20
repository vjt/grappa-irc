// #283 (2026-07-20) — per-network Disconnect on the Home pane's
// ConnectedRow, symmetric with the [Reconnect] chip already on
// DisconnectedRow (UX-5 BR). Before this, the Home pane could Reconnect a
// parked network but not Disconnect a connected one — the only per-network
// disconnect lived on the sidebar / bottom-bar × (T32). This closes that
// asymmetry: the Home pane is now self-sufficient (Reconnect ⇄ Disconnect).
//
// vjt decision (issue #283): REUSE the #195 confirm modal
// (windowClose.confirmDisconnectNetwork → "Disconnect from <slug>?"), the
// SAME verb the × fires — NOT raw disconnectNetwork (accidental-tap guard).
// Fire-and-forget behind the modal (matches the ×), NOT Reconnect's
// awaited-PATCH pending/error chip. Subject-agnostic since #211 phase 6
// ruling D (park-one for both user + visitor); the HomePane unit tests
// prove the button renders + fires identically for a visitor subject, so —
// per the ux-5-br-home-reconnect precedent — ONE registered arm covers the
// end-to-end wiring here (server park path is one shared code path).
//
// Load-bearing assertions: (1) the Disconnect button is VISIBLE on the
// connected row; (2) clicking it opens the confirm modal with the right
// target; (3) Cancel is the SAFE default — it dismisses WITHOUT parking
// (the #195 guard, the whole reason we reuse confirmDisconnectNetwork);
// (4) confirming actually parks the network (REST is source-of-truth);
// (5) the row swaps to the parked state with a Reconnect chip.

import { expect, test } from "../fixtures/test";
import {
  confirmModal,
  confirmModalBody,
  confirmModalCancel,
  confirmModalYes,
  loginAs,
  waitForUserTopicReady,
} from "../fixtures/cicchettoPage";
import { patchNetworkConnectionState, type SeededUser } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

const GRAPPA_BASE_URL = "http://grappa-test:4000";
const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];

async function fetchNetworkState(token: string, slug: string): Promise<string | null> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  if (!res?.ok) return null;
  const rows = (await res.json()) as Array<{ slug: string; connection_state: string }>;
  return rows.find((r) => r.slug === slug)?.connection_state ?? null;
}

async function fetchChannels(token: string): Promise<Array<{ name: string; joined: boolean }>> {
  const res = await fetch(`${GRAPPA_BASE_URL}/networks/${NETWORK_SLUG}/channels`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`fetchChannels: ${res.status}`);
  return (await res.json()) as Array<{ name: string; joined: boolean }>;
}

// Restore the seeded network to :connected + autojoin re-lands so the next
// spec sees a healthy baseline. Mirrors ux-5-br-home-reconnect afterEach.
async function restoreNetwork(vjt: SeededUser): Promise<void> {
  await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, {
    connection_state: "connected",
  }).catch(() => {});

  for (let attempt = 0; attempt < 60; attempt++) {
    const channels = await fetchChannels(vjt.token).catch(() => null);
    if (channels?.find((c) => c.name === SEED_CHANNEL)?.joined) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Timeout matches the reconnect sibling — a park + respawn dance is slow.
test.setTimeout(90_000);

test.afterEach(async () => {
  const vjt = getSeededVjt();
  await restoreNetwork(vjt);
});

test("#283 — Home ConnectedRow Disconnect: confirm modal parks the network, Cancel does not", async ({
  page,
}) => {
  const vjt = getSeededVjt();

  // Ensure the seeded network is connected so the Home row renders a
  // ConnectedRow (with the new Disconnect button), not a parked card.
  await patchNetworkConnectionState(vjt.token, NETWORK_SLUG, {
    connection_state: "connected",
  }).catch(() => {});
  await expect
    .poll(async () => fetchNetworkState(vjt.token, NETWORK_SLUG), { timeout: 30_000 })
    .toBe("connected");

  // Login lands in a channel window for a connected network; navigate to
  // the Home pane via the sidebar 🏠 row (desktop / chromium default).
  await loginAs(page, vjt);
  await page.locator(".sidebar-home-btn").click();
  const homePane = page.locator(".home-pane-registered");
  await expect(homePane).toBeVisible({ timeout: 10_000 });

  // The connected row for the seeded network carries the connected
  // classList + the new Disconnect button.
  const connectedRow = homePane.locator(".home-pane-network-row-connected", {
    has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
  });
  await expect(connectedRow).toBeVisible({ timeout: 5_000 });

  const disconnectBtn = connectedRow.getByRole("button", {
    name: new RegExp(`disconnect ${NETWORK_SLUG}`, "i"),
  });
  await expect(disconnectBtn).toBeVisible();

  // Gate on the user-topic JOIN ACK before the state-changing action —
  // the connection_state_changed broadcast that swaps the row to parked
  // must reach a subscribed socket (Phoenix.PubSub doesn't replay to late
  // subscribers). Same defense as the reconnect sibling.
  await waitForUserTopicReady(page, vjt.name);

  // ── #195 guard: Cancel is the SAFE default — it must NOT park ──────────
  await disconnectBtn.click();
  await expect(confirmModal(page)).toBeVisible({ timeout: 5_000 });
  await expect(confirmModalBody(page)).toContainText(`Disconnect from ${NETWORK_SLUG}?`);
  await confirmModalCancel(page);
  await expect(confirmModal(page)).toHaveCount(0, { timeout: 5_000 });
  // The negative assertion must be load-bearing: give any (regressed)
  // async park a real window to land before asserting it did NOT. A
  // point-in-time check at t≈0 would green even if Cancel wrongly fired a
  // fire-and-forget park (the park + row swap only lands ~1s later, as the
  // confirm path below shows). You cannot poll for an absence — a bounded
  // settle is the correct tool for "nothing happened".
  await page.waitForTimeout(1_000);
  // Row stayed connected; the network is still up (source-of-truth REST).
  await expect(connectedRow).toBeVisible();
  await expect(disconnectBtn).toBeVisible();
  expect(await fetchNetworkState(vjt.token, NETWORK_SLUG)).toBe("connected");

  // ── Confirm actually parks the network ────────────────────────────────
  await disconnectBtn.click();
  await expect(confirmModal(page)).toBeVisible({ timeout: 5_000 });
  await confirmModalYes(page);

  // REST is authoritative: the network transitioned to :parked. The WS
  // event is the derived-and-faster signal that swaps the UI row.
  await expect
    .poll(async () => fetchNetworkState(vjt.token, NETWORK_SLUG), { timeout: 30_000 })
    .toBe("parked");

  // The connected row is replaced by the parked card + its Reconnect chip
  // (the row sub-component unmounts on connection_state_changed → the
  // symmetric affordance the Home pane already had).
  await expect(connectedRow).toHaveCount(0, { timeout: 30_000 });
  const parkedRow = homePane.locator(".home-pane-network-row-parked", {
    has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
  });
  await expect(parkedRow).toBeVisible({ timeout: 10_000 });
  await expect(
    parkedRow.getByRole("button", { name: new RegExp(`reconnect ${NETWORK_SLUG}`, "i") }),
  ).toBeVisible();
});
