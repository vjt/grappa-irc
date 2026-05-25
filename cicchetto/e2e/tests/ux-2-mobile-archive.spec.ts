// UX-2 (2026-05-17) — Mobile archive surface (top-right button → modal).
//
// Originally targeted a per-network `.bottom-bar-archive-chip`. UX-4
// bucket L (2026-05-19, commit `17aefeb`) moved the archive entry-point
// out of BottomBar's per-network chips into the always-visible
// ShellChrome bar at the top of `.shell-main` (selector
// `[data-testid="shell-chrome-archive"]`). The button resolves the
// network from the currently-selected window, then opens
// `ArchiveModal` (full overlay) listing entries with × delete
// affordance per row. Confirm flow still re-uses UX-1's
// `deleteArchiveEntry` + `InlineConfirmButton`.
//
// Flow under test:
//   1. PART seed channel → :parted → channel moves out of channelsBySlug.
//   2. Select the network's server window so ShellChrome resolves a
//      non-null archive slug (home/admin/mentions hide the button).
//   3. Tap the ShellChrome archive button → modal opens, lists PARTed channel.
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
// path here exercises ShellChrome + ArchiveModal end-to-end. The full
// visitor/nickserv/registered loop runs in the UX-4-Z composed journey.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("@webkit UX-2 — ShellChrome archive button opens modal + delete drops entry", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Focus the channel so we know it's live + scrollback fanned out.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toBeVisible({ timeout: 10_000 });

  // PART so the channel moves into archive. After PART, the cic
  // selection redirect (bucket E close-watcher) moves focus away from
  // the closed channel. ShellChrome's archive button only renders when
  // the selected window has a network context (channel / query /
  // server) — home/admin/mentions hide it. Tap the server tab to
  // guarantee the button surfaces.
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).not.toBeVisible({ timeout: 10_000 });

  // Select the network's $server tab so ShellChrome resolves the
  // archive slug to NETWORK_SLUG (bucket C collapsed the network
  // header into a server-tab on mobile too: BottomBar renders the
  // user-facing label "Server" for the kind="server" tab).
  const serverTab = sidebarWindow(page, NETWORK_SLUG, "Server");
  await serverTab.tap();

  // ShellChrome archive button is in the top-right of `.shell-main`.
  // Single global button (bucket L) — bound to selectedChannel's
  // network. Test-id `shell-chrome-archive` is the stable contract.
  const archiveBtn = page.getByTestId("shell-chrome-archive");
  await expect(archiveBtn).toBeVisible({ timeout: 10_000 });
  await archiveBtn.tap();

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
