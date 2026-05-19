// CP15 B4 — Archive section: PART → archive entry appears → click → scrollback.
//
// Validates the full B4 surface in a real browser:
//   1. PART a seeded channel → server emits :parted effect → channel
//      drops out of the active sidebar list.
//   2. Expand the per-network "Archive" <details> → cic fires
//      GET /networks/:slug/archive → archivedBySlug() populates →
//      the just-PARTed channel appears as an archive entry.
//   3. Click the archived entry → setSelectedChannel fires → the
//      ScrollbackPane opens for that channel (read-only; the actual
//      "Join" button visual + revive-on-send is B5's surface, not
//      tested here).
//
// Active/Archive boundary contract (intent doc):
//   - PART = user intent → window archived.
//   - $server is always active, never archived (filtered out by
//     `Scrollback.list_archive/3` regardless of active_keyset).
//
// Cleanup: re-JOIN the seeded channel in afterEach so subsequent
// specs that assume #bofh is joined keep working (mirror of M9's
// pattern).

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  // Restore the seed-time joined state so later specs that assume
  // #bofh is joined (e.g. M1, BUG7) keep working under retries.
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("CP15-B4 — PART moves channel to Archive section; click opens scrollback", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Focus the channel first so the WS subscription is live + the
  // selectChannel awaitWsReady gate confirms the join-line landed
  // (proves prior state is healthy before PART).
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1);

  // PART via REST (skips the cic UI path under test in M9; here the
  // archive surface is what's under test, not the PART-via-X-button
  // mechanic). Server emits :parted → window drops out of active
  // sidebar.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);

  // Active sidebar entry gone after channels_changed propagates.
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // Expand the per-network Archive <details>. Native `<summary>` click
  // toggles `details.open` AND fires the `toggle` event our handler
  // listens for; loadArchive fires once on the open transition.
  //
  // UX-5 BH (2026-05-19): `.sidebar-network` renamed to
  // `.sidebar-network-section`; the legacy `<h3>` per-network header
  // was dropped in UX-4 bucket C and replaced by `.sidebar-network-header`
  // (this spec's `<h3>` lookup was pre-existing rot since UX-4 C, fixed
  // in BH per cluster mandate "Fix root causes, not examples").
  // Archive `<details>` also lifted out of the killed `<section>`
  // wrapper; it's now a flat sibling of the per-network `<ul>` inside
  // the `<For>`. Scoped via xpath sibling axis from the network `<ul>`
  // for forward-compat against multi-network seeds (single network in
  // this seed today but the parity matrix is heading toward N>1, and
  // reviewer-loop MED-1 from BH flagged the multi-network drift risk).
  const networkSection = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
  const archiveSection = networkSection.locator("xpath=following-sibling::details[@class=\"sidebar-archive\"][1]");
  await archiveSection.locator("summary").click();
  await expect(archiveSection).toHaveAttribute("open", "");

  // Archived channel appears as a clickable entry inside the Archive
  // section (same `.sidebar-channel-name` class as active rows but
  // styled `.parted` to signal read-only state).
  const archivedEntry = archiveSection.locator("button.sidebar-window-btn", {
    hasText: CHANNEL,
  });
  await expect(archivedEntry).toHaveCount(1, { timeout: 5_000 });

  // Click archived row → selection moves to the channel → ScrollbackPane
  // mounts + REST loads scrollback. TopicBar shows the channel name
  // even though it's no longer in active state (read-only window).
  await archivedEntry.click();
  await expect(page.locator(".topic-bar")).toContainText(CHANNEL, { timeout: 5_000 });

  // $server is system surface, never archived per intent doc — pin
  // the rule here so a future regression in `Scrollback.list_archive/3`
  // surfaces in e2e too.
  await expect(
    archiveSection.locator("button.sidebar-window-btn", { hasText: "Server" }),
  ).toHaveCount(0);
});
