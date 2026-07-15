// Issue #255 — the bottom-bar horizontal swipe dies if the swipe STARTS
// on a tab's × close button.
//
// Root cause is CSS, not the click handler. `.bottom-bar-close` (mobile)
// and its desktop sibling `.sidebar-close` carried `touch-action: none`.
// That declaration was added in #172 (d3e8446) so a hold-to-confirm
// long-press on the × would not be stolen by the parent bar's pan
// scroll. #195 (4ab4ef0) REMOVED the long-press gesture (holdToClose.ts,
// the pointer handlers, the `.close-holding` cue) but LEFT the CSS
// behind. `touch-action` does not inherit and a child value overrides
// the ancestor's, so a touch landing on the × saw `touch-action: none`
// → the browser disabled panning for that gesture BEFORE any JS ran →
// the parent `.bottom-bar { touch-action: pan-x }` never scrolled. The
// × is now a plain instant-click button (CloseButton.tsx, onClick only),
// so `touch-action: none` served no purpose and was purely harmful.
//
// The fix aligns each × to its PARENT's scroll axis so a swipe that
// starts on the × passes through to the bar:
//   .bottom-bar-close → touch-action: pan-x  (matches .bottom-bar)
//   .sidebar-close    → touch-action: pan-y  (vertical sidebar scroll)
//
// Why a computed-`touch-action` assertion and NOT a synthetic swipe:
// Playwright's WebKit engine cannot reproduce real iOS touch-pan
// physics (a synthetic swipe + "did the bar scroll?" assertion is
// hollow and flaky — same posture as ux-5-bo / issue123 guard-3 /
// issue230). The DETERMINISTIC contract is the computed `touch-action`
// value: it is exactly what the browser consults to decide whether to
// pan BEFORE any JS runs. Assert that value on the real target in the
// real layout. Real-device confirm of the pan gesture rides the pending
// iOS device-verify batch (#245/#250/#253/#254/#255).
//
// Two surfaces, two projects (playwright.config.ts): the untagged test
// runs on chromium (desktop, .sidebar-close → pan-y); the @webkit test
// runs on webkit-iphone-15 (mobile, .bottom-bar-close → pan-x — the
// reported surface). Both go through scripts/integration.sh --grep "#255".

import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures/test";
import { loginAs, selectChannel, sidebarCloseButton } from "../fixtures/cicchettoPage";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// #bofh is autojoined → its tab renders a close-× on BOTH layouts.
const CHANNEL = AUTOJOIN_CHANNELS[0];

// Read the computed `touch-action` off the close × for the given
// channel window (layout-aware via sidebarCloseButton).
async function closeXTouchAction(page: Page, slug: string, channel: string): Promise<string> {
  const closeX = sidebarCloseButton(page, slug, channel);
  // A clean signal if the × ever went missing (would otherwise surface
  // as an opaque evaluate() timeout).
  await expect(closeX).toBeVisible({ timeout: 5_000 });
  return closeX.evaluate((el) => getComputedStyle(el).touchAction);
}

test("#255 — desktop .sidebar-close aligns touch-action to the sidebar's pan-y axis", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // PRE-FIX: "none" (orphaned #172 declaration). POST-FIX: "pan-y"
  // (matches the vertical sidebar scroll so a drag starting on the ×
  // still scrolls the window list on tablets).
  const ta = await closeXTouchAction(page, NETWORK_SLUG, CHANNEL);
  expect(ta).toBe("pan-y");
});

test("#255 @webkit — mobile .bottom-bar-close aligns touch-action to the bottom-bar's pan-x axis", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // PRE-FIX: "none" (orphaned #172 declaration) → the browser disabled
  // panning for a gesture landing on the × → the bar could not scroll
  // (the reported bug). POST-FIX: "pan-x" (matches .bottom-bar) → the
  // swipe passes through to the bar.
  const ta = await closeXTouchAction(page, NETWORK_SLUG, CHANNEL);
  expect(ta).toBe("pan-x");
});
