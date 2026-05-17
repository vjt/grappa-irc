// UX-2 (2026-05-17) — Mobile archive surface (chip → modal).
//
// Mobile (webkit iPhone 15) BottomBar carries a `.bottom-bar-archive-chip`
// per network when that network has at least one archived (non-active)
// entry. Tap opens `ArchiveModal` (full overlay) listing entries with a
// × delete affordance per row. Confirm flow re-uses UX-1's
// `deleteArchiveEntry` + `InlineConfirmButton`.
//
// Flow under test:
//   1. PART seed channel → :parted → channel moves out of channelsBySlug.
//   2. Archive chip appears in BottomBar for the network (visibleArchive
//      derives 1 entry).
//   3. Tap chip → modal opens, lists the PARTed channel.
//   4. Tap × → InlineConfirmButton arms ("really delete?").
//   5. Tap again → DELETE fires → server broadcasts `archive_changed` →
//      cic re-fetches → entry vanishes from the modal.
//   6. Close modal (× in header) → modal closed.
//
// Cleanup: re-JOIN the channel in afterEach so later specs see #bofh
// joined (mirror of UX-1 / iOS-3 pattern).
//
// Per-class parity matrix per `feedback_e2e_user_class_parity_matrix`:
// UX-2 is a UI shape bucket — not an IRC-function spec. The visitor
// path here exercises BottomBar + ArchiveModal end-to-end. The full
// visitor/nickserv/registered loop runs in the UX-Z composed journey.

import { expect, test } from "@playwright/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("@webkit UX-2 — BottomBar archive chip opens modal + delete drops entry", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Focus the channel so we know it's live + scrollback fanned out.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible({ timeout: 10_000 });

  // PART so the channel moves into archive.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).not.toBeVisible({ timeout: 10_000 });

  // Chip appears inside the per-network bottom-bar section once the
  // archive REST refetch fires (driven by the `archive_changed`
  // broadcast on PART). Eager-load in BottomBar.tsx primes the list.
  const networkSection = page.locator(".bottom-bar-network", {
    has: page.locator(".bottom-bar-network-chip", { hasText: NETWORK_SLUG }),
  });
  const chip = networkSection.locator(".bottom-bar-archive-chip");
  await expect(chip).toBeVisible({ timeout: 10_000 });
  await expect(chip).toContainText("Archive");

  // Tap chip → modal opens.
  await chip.tap();

  const modal = page.locator(".archive-modal");
  await expect(modal).toBeVisible({ timeout: 5_000 });
  await expect(modal.locator(".archive-modal-header h2")).toContainText(NETWORK_SLUG);

  // PARTed channel listed in the modal.
  const row = modal.locator(".archive-modal-row", { hasText: CHANNEL });
  await expect(row).toHaveCount(1);

  // Delete button — UX-1's InlineConfirmButton, test-id scoped per
  // (slug, target). Idle label "×"; armed label "really delete?".
  const deleteBtn = page.getByTestId(`archive-modal-delete-${NETWORK_SLUG}-${CHANNEL}`);
  await expect(deleteBtn).toHaveText("×");
  await deleteBtn.tap();
  await expect(deleteBtn).toHaveText("really delete?", { timeout: 2_000 });

  // Second tap → server DELETE → archive_changed broadcast → cic
  // re-fetches → row disappears from the modal.
  await deleteBtn.tap();
  await expect(row).toHaveCount(0, { timeout: 5_000 });

  // Modal close × clears the modal-open signal.
  await modal.getByLabel("close archive").tap();
  await expect(modal).not.toBeVisible({ timeout: 3_000 });
});
