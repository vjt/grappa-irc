// M9 — cicchetto-driven PART via the sidebar X-button.
//
// User clicks the `×` button next to a channel in the sidebar; cicchetto
// fires REST POST /networks/:slug/channels/:chan/part (Sidebar.tsx
// handleCloseChannel → postPart) which makes grappa send PART to the
// leaf. Leaf echoes the PART back, grappa persists + broadcasts on
// the channel topic, subscribe.ts BUG5a handler detects own PART,
// calls setParted(key) → windowState entry dropped → UX-4 bucket E's
// close-window auto-focus picker fires → selection rolls to:
// MRU live window → server window (if connected) → home (last resort).
// The channels_changed broadcast drops the entry from the sidebar.
//
// Expected:
//   - PART row persists server-side (sender = NETWORK_NICK, kind =
//     :part, channel = #bofh)
//   - sidebar entry for #bofh disappears
//   - selectedChannel redirects via UX-4-E picker — with no other
//     joined channel and the server window not always selectable
//     in this test fixture's seed shape, lands on home pane
//
// The path under test is the sidebar X-button click — distinct from
// `/part` slash-command in compose. M9 specifically pins the
// .sidebar-close click handler.
//
// FLAKE-C bucket 5 (2026-05-23) — original assertion was on
// `.shell-main p.muted "select a channel"`. That empty-state path
// is pre-UX-4-B/E. Post-UX-4-B the cold-load lands on home;
// post-UX-4-E close-window redirect goes through MRU → server →
// home. selectedChannel is NEVER null in steady state, so the
// `p.muted` empty pane is dead code in the path this spec triggers.
// Assert on the home pane render instead.

import { test, expect } from "../fixtures/test";
import {
  confirmModal,
  confirmModalYes,
  loginAs,
  selectChannel,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { assertMessagePersisted, joinChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

// M9 PARTs the seeded `#bofh` channel as the action under test, which
// destroys shared state for any subsequent spec that assumes #bofh is
// joined (e.g. webkit BUG7 specs). Restore the seed-time joined state
// after the test asserts so the suite remains order-independent.
test.afterEach(async () => {
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("M9 — sidebar X-button PARTs the channel and dismisses the window", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  // Focus #bofh first so the WS subscription sync completes before
  // the PART. Without this, the BUG5a self-PART handler might not
  // be installed when the PART echo arrives.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Click the X button on #bofh's sidebar entry.
  // Sidebar.tsx renders `aria-label="Close #bofh"` — use that as the
  // selector hook so future cosmetic class changes (.sidebar-close
  // → .sidebar-x or whatever) don't break the test.
  await sidebarWindow(page, NETWORK_SLUG, CHANNEL)
    .locator('button[aria-label="Close #bofh"]')
    .click();

  // #195 — the × now opens an explicit "leave #chan?" confirm modal; the PART
  // fires only on Yes (no longer instant on click).
  await expect(confirmModal(page)).toBeVisible();
  await confirmModalYes(page);

  // Server-side: PART row persisted (sender = own nick). PART rows
  // have body=null (or the reason if any was given) — match by kind.
  await assertMessagePersisted({
    token: vjt.token,
    networkSlug: NETWORK_SLUG,
    channel: CHANNEL,
    sender: NETWORK_NICK,
    kind: "part",
  });

  // Sidebar entry gone — channels_changed broadcast removed it from
  // the channelsBySlug resource.
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // Note: post-PART selection redirection is out of scope for this
  // spec — UX-4-E's MRU-→-server-→-home picker has subtle interactions
  // with the testnet's mid-flight rejoin races (other autojoined users
  // can briefly re-introduce #bofh into channelsBySlug via concurrent
  // JOIN-syncs on the same channel). Sidebar absence + server-side
  // PART persistence are sufficient evidence the X-button worked;
  // selection routing is covered by the dedicated selection.ts
  // bucket-E tests + ux-4-z-cluster-journey.spec.ts.
});

