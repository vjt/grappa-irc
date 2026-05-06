// M9 — cicchetto-driven PART via the sidebar X-button.
//
// User clicks the `×` button next to a channel in the sidebar; cicchetto
// fires REST POST /networks/:slug/channels/:chan/part (Sidebar.tsx
// handleCloseChannel → postPart) which makes grappa send PART to the
// leaf. Leaf echoes the PART back, grappa persists + broadcasts on
// the channel topic, subscribe.ts BUG5a handler detects own PART and
// calls setSelectedChannel(null). The channels_changed broadcast
// drops the entry from the sidebar.
//
// Expected:
//   - PART row persists server-side (sender = NETWORK_NICK, kind =
//     :part, channel = #bofh)
//   - sidebar entry for #bofh disappears
//   - selectedChannel transitions to null → "select a channel..."
//     empty pane
//
// The path under test is the sidebar X-button click — distinct from
// `/part` slash-command in compose. M9 specifically pins the
// .sidebar-close click handler (Sidebar.tsx:107-113).

import { test, expect } from "@playwright/test";
import {
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

  // BUG5a self-PART dismiss: selection rolls back to null → Shell
  // renders the "select a channel" empty fallback (Shell.tsx:221).
  await expect(page.locator(".shell-main p.muted")).toContainText("select a channel", {
    timeout: 5_000,
  });
});
