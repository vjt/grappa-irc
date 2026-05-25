// CP19 T32 — parked-network cic derivation cascade.
//
// UX-7-F (2026-05-22) — spec rewritten for the post-UX-4-D contract.
// Pre-UX-4-D, `/disconnect` left selection on the parked channel and
// the spec asserted ComposeBox cascaded `.compose-box-greyed`. Post-
// UX-4-D (commit cdc5470), `cicchetto/src/lib/selection.ts:287-316`
// auto-redirects selection to Home whenever a network transitions to
// `:parked` or `:failed` — the user-intent encoded by every park
// trigger (sidebar ×, compose `/disconnect`, sidebar circuit-breaker
// park, `bin/grappa disconnect`) is "this network is done; surface
// the parked summary on Home." The ComposeBox unmounts because Home
// renders no compose; asserting `.compose-box-greyed` on a parked
// channel is asserting buggy behavior (the redirect IS the contract).
//
// vjt 2026-05-22 chose "keep redirect, fix spec" over "skip redirect
// for /disconnect" — the redirect is intentional UX and the spec is
// what was wrong. This spec is the authoritative encoding of the
// post-UX-4-D contract.
//
// Scenario:
//   1. vjt logged in, autojoin lands → SEED_CHANNEL row appears as
//      live (no greyed class).
//   2. Operator types `/disconnect <network> <reason>` in compose.
//      Server-side: NetworksController.update → Networks.disconnect/2
//      → terminate Session.Server + flip credential.connection_state
//      to :parked + broadcast connection_state_changed on user-topic.
//      Cic-side: userTopic.ts → refetchNetworks() → networkBySlug
//      surfaces connection_state=parked → selection.ts:287-316 fires
//      → selection jumps to Home.
//   3. Assert: selection is Home, HomePane renders the parked network
//      card (slug + nick + reason + Reconnect button). Sidebar still
//      shows the network section with `.sidebar-network-greyed`
//      (rows remain visible — operator can re-navigate to view
//      scrollback; greyed-cascade visual is intact).
//   4. Operator clicks `[Reconnect bahamut-test]` on the Home card
//      (mirrors the same patchNetwork verb /connect would invoke).
//      Server-side: Networks.connect → eager SpawnOrchestrator → DB
//      flip + broadcast. Cic-side: networkBySlug.connection_state =
//      connected → home card re-renders as connected.
//   5. Assert: sidebar network section ungreys; SEED_CHANNEL row
//      ungreys after autojoin (typed events flow through subscribe.ts
//      as before).
//
// Why click Reconnect instead of typing `/connect`: from Home, there
// IS no ComposeBox — the only way to issue `/connect` from the Home
// pane is via the typed Reconnect chip. Mirrors what every operator
// does in practice (they don't navigate back to the parked channel
// to type `/connect`; they tap the Home card).
//
// CHANNEL CLEANUP: only touches the seeded autojoin channel — no
// per-run setup needed. The Reconnect click triggers a fresh
// SpawnOrchestrator → autojoin loop, which re-JOINs SEED_CHANNEL and
// gets the row back to its baseline live state.

import { test, expect } from "../fixtures/test";
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

test("CP19 T32 — /disconnect parks network + redirects to Home; Reconnect ungreys + autojoin restores channel", async ({
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
  await expect(page.locator(".compose-box")).not.toHaveClass(/compose-box-greyed/);

  // Operator parks the network via /disconnect. compose.ts dispatches
  // patchNetwork → server-side disconnect/2 → user-topic broadcast →
  // userTopic.ts refetchNetworks → networkBySlug surfaces parked →
  // selection.ts:287-316 redirects to Home. ComposeBox unmounts mid-
  // await, so composeSend uses `expectUnmount: true` to wait for the
  // textarea-gone signal instead of textarea-empty (which would race
  // the unmount). Draft IS cleared in the composeByChannel signal
  // regardless — re-navigating to #bofh later shows an empty compose.
  await composeSend(page, `/disconnect ${NETWORK_SLUG} ${PARK_REASON}`, { expectUnmount: true });

  // Selection redirected to Home — HomePane renders the parked
  // network card. `.home-pane-network-row-parked` is the load-bearing
  // class (HomePane.tsx:110 — parked-specific styling hook). The card
  // carries the slug + nick + reason text + a typed Reconnect chip.
  const parkedCard = page.locator(".home-pane-network-row-parked", {
    has: page.locator(".home-pane-network-slug", { hasText: NETWORK_SLUG }),
  });
  await expect(parkedCard).toHaveCount(1, { timeout: 10_000 });
  await expect(parkedCard.locator(".home-pane-network-reason")).toHaveText(PARK_REASON);
  // Reviewer LOW-1 (UX-7-F): chip is rendered in the same synchronous
  // JSX block as the card so `toBeVisible()` is redundant with the
  // card-found assertion above. `toBeEnabled()` also asserts the
  // `pending()` disabled-state edge isn't surfaced (which would
  // indicate a click was already in flight — wrong state for the spec).
  const reconnectBtn = parkedCard.getByRole("button", { name: `Reconnect ${NETWORK_SLUG}` });
  await expect(reconnectBtn).toBeEnabled();

  // Sidebar network section gains .sidebar-network-greyed. The
  // cascading CSS rule (.sidebar-network-section.sidebar-network-
  // greyed li .sidebar-window-btn) paints channel rows muted+italic
  // via the network derivation overlay. Operator can still see + re-
  // navigate to scrollback for the parked channels; the greyed visual
  // is the cue "this network is parked, no live messages."
  await expect(networkSection).toHaveClass(/sidebar-network-greyed/, { timeout: 10_000 });

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

  // Operator unparks via the Home card's Reconnect chip. Server-side:
  // Networks.connect → eager SpawnOrchestrator → DB flip + broadcast.
  // Cic-side: networkBySlug.connection_state = :connected → network
  // derivation drops greyed cascade; the parked Home card re-renders
  // as a connected row.
  await reconnectBtn.click();

  // Sidebar network section ungreys on the user-topic event (sub-
  // second).
  await expect(networkSection).not.toHaveClass(/sidebar-network-greyed/, { timeout: 10_000 });

  // Parked card flips off the Home pane (the network re-renders as
  // a connected `home-pane-network-row-connected` row, not parked).
  await expect(parkedCard).toHaveCount(0, { timeout: 10_000 });

  // Tooltip is gone (or empty) once the network is connected — the
  // derivation only attaches a `title=` when the network is in a
  // greyed state; when connected, the helper returns undefined and
  // Solid removes the attribute.
  await expect(networkHeader).not.toHaveAttribute("title", PARK_REASON);

  // Channel row ungreys post-autojoin: SpawnOrchestrator spawns a
  // fresh Session.Server, the autojoin loop re-JOINs SEED_CHANNEL,
  // and the typed window-state event flows through subscribe.ts as
  // before.
  await expect(channelRow.locator(".sidebar-window-greyed")).toHaveCount(0, { timeout: 15_000 });
});
