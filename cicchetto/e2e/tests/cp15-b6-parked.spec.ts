// CP19 T32 — parked-window cic derivation cascade.
//
// Closes the gap CP15 B6's brief promised but couldn't author: the
// `cp15-b6-parked.spec.ts` shape was "mechanically authorable" only
// after the design pass landed in
// docs/plans/2026-05-09-t32-parked-window.md (Q1.B = derive from
// `connection_state`, no per-window `:parked` event from
// Session.Server.terminate/2).
//
// Scenario:
//   1. vjt logged in, autojoin lands → SEED_CHANNEL row appears as
//      live (no greyed class).
//   2. Operator types `/disconnect <network> <reason>` in compose.
//      Server-side: NetworksController.update → Networks.disconnect/2
//      → terminate Session.Server + flip credential.connection_state
//      to :parked + broadcast connection_state_changed on user-topic.
//      Cic-side: userTopic.ts → refetchNetworks() → networkBySlug
//      surfaces connection_state=parked + reason → Sidebar derivation
//      cascades.
//   3. Assert: network <section> gains .sidebar-network-greyed; channel
//      row gains .sidebar-window-greyed; ComposeBox gains
//      .compose-box-greyed; network header tooltip carries the reason.
//   4. Operator types `/connect <network>`. Server-side: Networks.connect
//      → eager SpawnOrchestrator → DB flip + broadcast. Cic-side:
//      networkBySlug.connection_state=connected → network derivation
//      drops; channel rows ungrey once autojoin lands.
//   5. Assert: network ungreys immediately; channel row ungreys after
//      autojoin (typed events flow through subscribe.ts as before).
//
// CHANNEL CLEANUP: only touches the seeded autojoin channel — no
// per-run setup needed. The `/connect` triggers a fresh
// SpawnOrchestrator → autojoin loop, which re-JOINs SEED_CHANNEL and
// gets the row back to its baseline live state.

import { test, expect } from "@playwright/test";
import { composeSend, loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const SEED_CHANNEL = AUTOJOIN_CHANNELS[0];
const PARK_REASON = "testing parked state cp19";

// Test timeout bumped to 90s — the cleanup afterEach polls for up to
// 30s waiting for SpawnOrchestrator → IRC connect → SASL → autojoin
// → JOIN echo → state.members write to complete. Default 30s test
// timeout would leave only seconds for afterEach after the body runs,
// then exhaust it during the autojoin wait. 90s = body (~5s) +
// afterEach poll (~30s) + safety margin for testnet load.
test.setTimeout(90_000);

test.afterEach(async () => {
  // If the spec failed mid-run the network may still be parked. The
  // testnet doesn't reset between specs — leaving a parked credential
  // would break every subsequent spec that expects autojoin to be
  // live. Best-effort reconnect via the same fixture; ignore failure
  // (already-connected returns :not_parked, that's fine).
  //
  // CRITICAL: also poll the channels REST endpoint until #bofh shows
  // up as joined. /connect spawns a fresh Session.Server but autojoin
  // is async — without polling, the next spec starts before #bofh is
  // back in state.members, and its loginAs sees a sidebar without
  // the autojoin row. Observed during full integration suite run:
  // skipping this poll cascaded 18 failures across m1-m9 + downstream
  // cp15-b6-* specs because every following spec inherits a
  // half-spawned Session.
  //
  // 60 × 500ms = 30s budget for SpawnOrchestrator → IRC connect →
  // SASL → autojoin → JOIN echo → state.members write. Empirically
  // ~3-5s on a healthy testnet; the 30s ceiling absorbs upstream
  // rate-limit penalties accumulated by prior specs' churn.
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

test("CP19 T32 — /disconnect cascades greyed; /connect ungreys network + autojoin restores channel", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Establish baseline: focus the seeded autojoin channel, wait for
  // the self-JOIN scrollback line, then verify the row is NOT greyed.
  await selectChannel(page, NETWORK_SLUG, SEED_CHANNEL, { ownNick: NETWORK_NICK });
  const channelRow = sidebarWindow(page, NETWORK_SLUG, SEED_CHANNEL);
  await expect(channelRow).toHaveCount(1);
  await expect(channelRow.locator(".sidebar-window-greyed")).toHaveCount(0);

  // Network header section + ComposeBox baseline: not greyed.
  const networkSection = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
  await expect(networkSection).not.toHaveClass(/sidebar-network-greyed/);
  const composeBox = page.locator(".compose-box");
  await expect(composeBox).not.toHaveClass(/compose-box-greyed/);

  // Operator parks the network via /disconnect. compose.ts dispatches
  // patchNetwork → server-side disconnect/2 → user-topic broadcast →
  // userTopic.ts refetchNetworks → networkBySlug surfaces parked.
  await composeSend(page, `/disconnect ${NETWORK_SLUG} ${PARK_REASON}`);

  // Network header gains .sidebar-network-greyed. The cascading CSS
  // rule (.sidebar-network-section.sidebar-network-greyed li
  // .sidebar-window-btn) paints channel rows muted+italic via the
  // network derivation overlay. windowStateByChannel may still hold
  // stale :joined values; the network derivation wins per CLAUDE.md
  // "derive don't duplicate". The class on the parent <section> is
  // the load-bearing contract; vitest covers the per-row visual at
  // the JSDOM level. e2e asserts only the class presence here so a
  // CSS theme rewrite doesn't false-positive the cascade.
  await expect(networkSection).toHaveClass(/sidebar-network-greyed/, { timeout: 10_000 });

  // ComposeBox cascades greyed. The selected channel's compose
  // shouldn't look ready-to-send when the network is parked.
  await expect(composeBox).toHaveClass(/compose-box-greyed/, { timeout: 10_000 });
  await expect(page.locator("p.compose-box-not-joined")).toBeVisible();

  // Tooltip on the network header carries the reason text. Implemented
  // as a `title=` attr (zero-bundle-cost; design pass deferred a
  // richer tooltip).
  //
  // UX-5 BH (2026-05-19): legacy `<h3>` per-network header was dropped
  // in UX-4 bucket C; the `title` attr now lives on
  // `.sidebar-network-header .sidebar-channel-name` (Sidebar.tsx
  // L319-326).
  const networkHeader = networkSection.locator(
    ".sidebar-network-header .sidebar-channel-name",
  );
  await expect(networkHeader).toHaveAttribute("title", PARK_REASON, { timeout: 5_000 });

  // Operator unparks via /connect. Eager SpawnOrchestrator → DB flip
  // + broadcast → userTopic.ts refetchNetworks → networkBySlug
  // surfaces :connected → network derivation drops immediately.
  await composeSend(page, `/connect ${NETWORK_SLUG}`);

  // Network section ungreys on the user-topic event (sub-second).
  await expect(networkSection).not.toHaveClass(/sidebar-network-greyed/, { timeout: 10_000 });

  // Channel row ungreys post-autojoin: SpawnOrchestrator spawns a
  // fresh Session.Server, the autojoin loop re-JOINs SEED_CHANNEL,
  // and the typed window-state event flows through subscribe.ts as
  // before. ComposeBox follows.
  await expect(composeBox).not.toHaveClass(/compose-box-greyed/, { timeout: 15_000 });
  await expect(page.locator("p.compose-box-not-joined")).toHaveCount(0);

  // Tooltip is gone (or empty) once the network is connected — the
  // derivation only attaches a `title=` when the network is in a
  // greyed state; when connected, the helper returns undefined and
  // Solid removes the attribute.
  await expect(networkHeader).not.toHaveAttribute("title", PARK_REASON);
});
