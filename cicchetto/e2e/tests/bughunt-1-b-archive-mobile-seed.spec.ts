// BUGHUNT-1 B — Archive modal seed-on-open (mobile).
//
// Root cause: the mobile archive chip (ShellChrome's
// `[data-testid="shell-chrome-archive"]`) calls
// `setArchiveModalNetwork(slug)` but does NOT call `loadArchive(slug)`.
// Only `Sidebar.tsx`'s `<details>` onToggle path fires the load. On
// mobile the sidebar is hidden behind the BottomBar so operators
// never reach the load. First open shows "no archived windows" until
// the user archives a new window, which triggers `archive_changed`
// (re-fetch) and the bug *appears* fixed.
//
// Fix: dedicated `createEffect` in `ArchiveModal.tsx` that fires
// `void loadArchive(slug)` on edge-trigger open (null → slug). This
// spec asserts the chip-tap path populates the list without ANY
// prior sidebar interaction.
//
// `@webkit` tag opts into the iPhone-15 project (mobile viewport +
// touch + isMobile() = true). Desktop chromium project skips this
// spec via `grepInvert: /@webkit/`.

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  // Restore the seed-time joined state so later specs that assume
  // #bofh is joined keep working under retries. Mirror of cp15-b4.
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("@webkit BUGHUNT-1 B — mobile archive chip seeds list on first open", async ({ page }) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Select the channel + PART it so there's a guaranteed archive
  // entry to populate the list with. selectChannel awaits the WS
  // join confirmation so we know the channel is live before PART.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1);

  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);

  // Wait for archive entry to exist server-side (channels_changed
  // propagates). We deliberately do NOT expand the sidebar — that
  // would prefetch the archive list and mask the bug under test.
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // Tap the mobile archive chip. On mobile this is the ShellChrome
  // button (always-visible top-right). The chip only renders when
  // archiveSlugForSelection() is truthy — i.e. a non-home/non-admin
  // window is selected. The selectChannel above satisfies that even
  // post-PART (selection points at the now-archived channel).
  const chip = page.locator('[data-testid="shell-chrome-archive"]');
  await expect(chip).toBeVisible();
  await chip.tap();

  // Modal must be open AND the PARTed channel must appear in the
  // list — without any prior sidebar expand. This is the regression
  // pin: pre-fix, the list was empty until archive_changed re-fired.
  const archivedEntry = page
    .locator(".archive-modal-row")
    .filter({ hasText: CHANNEL });
  await expect(archivedEntry).toHaveCount(1, { timeout: 5_000 });
});

test("BUGHUNT-1 B — desktop Sidebar archive expand still works (no regression)", async ({ page }) => {
  // Desktop chromium path (no @webkit tag = stays in default project).
  // Mirror of cp15-b4-archive-section to pin that the createEffect
  // addition didn't break the existing Sidebar-driven load path.
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // Expand sidebar archive details — pre-fix path. Same locators as cp15-b4.
  const networkSection = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
  const archiveSection = networkSection.locator(
    'xpath=following-sibling::details[@class="sidebar-archive"][1]',
  );
  await archiveSection.locator("summary").click();
  await expect(archiveSection).toHaveAttribute("open", "");

  const archivedEntry = archiveSection.locator("button.sidebar-window-btn", { hasText: CHANNEL });
  await expect(archivedEntry).toHaveCount(1, { timeout: 5_000 });
});
