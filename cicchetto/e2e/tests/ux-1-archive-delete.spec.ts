// UX-1 (2026-05-17) — Archive delete × + permanent scrollback drop.
//
// Validates the full UX-1 surface in a real browser:
//   1. PART a seeded channel → server emits :parted → channel drops out
//      of the active sidebar list.
//   2. Expand the per-network Archive <details> → archive populates →
//      PARTed channel appears as an archive entry with a × delete
//      affordance.
//   3. Click × → InlineConfirmButton arms (label flips to "really
//      delete?").
//   4. Click again → DELETE /networks/:slug/archive/:target fires →
//      server drops the rows + broadcasts `archive_changed` → cic
//      re-fetches archive → the entry disappears.
//   5. Re-JOIN the channel and confirm the scrollback is EMPTY: this is
//      the smoking gun that the rows were actually deleted server-side
//      (vs the row merely vanishing from the cic-side cache).
//
// Per vjt scope decision: BOTH channel-kind AND query-kind get the
// delete affordance. Server-side dispatches by sigil. This spec covers
// the channel-kind path; the query-kind dispatch is covered by the
// controller test on the Elixir side (full cic-side dispatch parity
// is part of the broader cluster journey at UX-Z).
//
// Cleanup: re-JOIN the seeded channel in afterEach (mirror of CP15 B4
// pattern). The archive entry is gone for real — re-joining + sending
// a fresh message in this spec leaves a new row, which the next spec
// will inherit. That's fine; specs already cope with non-empty
// scrollback.

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  // Restore the seed-time joined state so later specs that assume
  // #bofh is joined keep working under retries.
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("UX-1 — × on archive entry confirms + deletes scrollback permanently", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Focus the channel first — ensures we're working from healthy
  // state + the join-line lands so we know there IS scrollback to
  // delete in step 5.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1);

  // PART so the channel moves into archive.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // Expand the per-network Archive <details>.
  const archiveSection = page
    .locator(".sidebar-network-section", { has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }) })
    .locator("details.sidebar-archive");
  await archiveSection.locator("summary").click();
  await expect(archiveSection).toHaveAttribute("open", "");

  const archivedEntry = archiveSection.locator("button.sidebar-window-btn", { hasText: CHANNEL });
  await expect(archivedEntry).toHaveCount(1, { timeout: 5_000 });

  // The delete button is testId-scoped and lives next to the row's
  // window button. Idle label is `×`; armed label is `really delete?`.
  const deleteButton = page.getByTestId(`archive-delete-${NETWORK_SLUG}-${CHANNEL}`);
  await expect(deleteButton).toHaveCount(1);
  await expect(deleteButton).toHaveText("×");

  // First click arms the confirm.
  await deleteButton.click();
  await expect(deleteButton).toHaveText("really delete?", { timeout: 2_000 });

  // Second click confirms → DELETE fires → server broadcasts
  // archive_changed → cic re-fetches → entry vanishes.
  await deleteButton.click();
  await expect(archivedEntry).toHaveCount(0, { timeout: 5_000 });

  // Smoking gun: re-JOIN the channel and confirm scrollback is empty.
  // If the rows were still there, the next selectChannel would render
  // scrollback lines from before the PART.
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1, { timeout: 5_000 });
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // ScrollbackPane carries only the fresh JOIN line; pre-PART rows
  // are gone. Assert no `:message` kind rows remain (privmsg/action/
  // notice — content rows from before). join lines are presence
  // kinds, not message kinds, so they don't count.
  const messageRows = page.locator(".scrollback-line[data-kind='privmsg']");
  await expect(messageRows).toHaveCount(0, { timeout: 3_000 });
});
