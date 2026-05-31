// Post-bundle desktop fix (2026-05-31) — archive surface on desktop.
//
// Two regressions captured here that jsdom unit tests can't see:
//
//   1. ShellChrome's `[data-testid="shell-chrome-archive"]` (the
//      top-right 📂 button) is MOBILE-ONLY. On desktop the Sidebar
//      already exposes parked rows inline via
//      `<details class="sidebar-archive">`, so the chrome button is
//      redundant noise. Pre-fix it rendered on desktop too.
//   2. Sidebar's archive `<ul>` was missing the `sidebar-network-section`
//      class. The canonical row style in `themes/default.css` L505 is
//      `.sidebar-network-section li .sidebar-window-btn`; without that
//      class the UA defaults bled through (white background, system
//      serif font). The unit test catches the class string; only a real
//      browser confirms `getComputedStyle` resolves to monospace +
//      transparent bg.
//
// Desktop-only spec (no `@webkit` tag) — runs on the chromium project,
// which uses `devices["Desktop Chrome"]` (1280×720 viewport, well above
// the (max-width: 768px) mobile breakpoint).

import { expect, test } from "../fixtures/test";
import { loginAs, selectChannel, sidebarWindow } from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0];

test.afterEach(async () => {
  // Restore the seed-time joined state so later specs keep working.
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL);
});

test("desktop — ShellChrome archive button is hidden across every window kind", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // The button must stay hidden on every selection kind a desktop user
  // can land on: home (post-login default), then a channel, query is
  // covered transitively (same predicate, same gate), and the server
  // tab (the only kind that, on mobile, surfaces the button — verifies
  // the desktop gate is universal, not selection-shape dependent).

  // Home selection (post-login).
  await expect(page.getByTestId("shell-chrome-archive")).toHaveCount(0);

  // Channel selection.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(1);
  await expect(page.getByTestId("shell-chrome-archive")).toHaveCount(0);

  // Server tab selection — on mobile this is where the button surfaces
  // (UX-2 spec). On desktop, still gone.
  const serverTab = sidebarWindow(page, NETWORK_SLUG, "Server");
  await serverTab.click();
  await expect(page.getByTestId("shell-chrome-archive")).toHaveCount(0);

  // Cog (the always-visible chrome button) is still there — proves the
  // assertion above is the gate firing, not the chrome bar being
  // missing wholesale.
  await expect(page.getByTestId("shell-chrome-cog")).toBeVisible();
});

test("desktop — sidebar archive rows inherit the canonical monospace style", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // Two-part proof, both observable in a real browser only:
  //
  //   (a) The archive `<ul>` carries the `sidebar-network-section`
  //       class. Pre-fix the class was missing so the canonical row
  //       selector `.sidebar-network-section li .sidebar-window-btn`
  //       (default.css L505) never matched archive rows. The unit
  //       test asserts the JSX class string; here we read the live
  //       built DOM class.
  //
  //   (b) An archive row's `<button>` resolves `font-family` to a
  //       monospace stack via the canonical selector. Pre-fix it
  //       resolved to the UA default (system serif). Asserting on
  //       an archive row specifically (not a joined sidebar row)
  //       avoids the `.selected` overrides that flip `background`
  //       for the focused channel.

  // PART so a channel lands in the archive (the fixture seed leaves
  // #bofh joined; partChannel server-side broadcast moves it).
  await partChannel(vjt.token, NETWORK_SLUG, CHANNEL);
  await expect(sidebarWindow(page, NETWORK_SLUG, CHANNEL)).toHaveCount(0, { timeout: 5_000 });

  // Expand the per-network Archive <details>.
  const networkSection = page.locator(".sidebar-network-section", {
    has: page.locator(".sidebar-network-header", { hasText: NETWORK_SLUG }),
  });
  const archiveSection = networkSection.locator(
    "xpath=following-sibling::details[@class=\"sidebar-archive\"][1]",
  );
  await archiveSection.locator("summary").click();
  await expect(archiveSection).toHaveAttribute("open", "");

  // (a) — live DOM class on the archive ul.
  const archiveUl = archiveSection.locator("ul.sidebar-archive-list");
  await expect(archiveUl).toHaveCount(1);
  await expect(archiveUl).toHaveClass(/sidebar-network-section/);

  // (b) — computed font-family on an archive row's button matches
  // the canonical monospace stack. Pre-fix this resolved to UA-default
  // serif because the ul lacked the gating class.
  const archivedBtn = archiveSection.locator("button.sidebar-window-btn", { hasText: CHANNEL });
  await expect(archivedBtn).toHaveCount(1, { timeout: 5_000 });
  const fontFamily = await archivedBtn.evaluate((el) => getComputedStyle(el).fontFamily);
  expect(fontFamily.toLowerCase()).toMatch(/mono/);
});
