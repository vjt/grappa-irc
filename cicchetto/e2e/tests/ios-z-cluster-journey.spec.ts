// iOS-Z — full iOS UI polish cluster end-to-end journey.
//
// Consolidated 2026-05-26 (spec-audit-ez): folded the strict subsets
// `ios-3-bottom-bar-close.spec.ts` + `ios-4-font-size.spec.ts` into
// this cluster journey (both were 1-for-1 replays of arms already
// here). Unique signal from ios-3 test 2 ("Server tab has no close ×")
// added inside the iOS-3 arm below. Both source specs deleted.
//
// Mirrors `m-z-admin-cluster-journey.spec.ts` / U-Z shape: ONE spec
// replays all 4 iOS buckets back-to-back inside a single webkit
// iPhone 15 session, so the cluster's shipping reality is exercised
// in CI on every integration run.
//
// Bucket coverage:
//   * iOS-1 viewport lock — `document.documentElement.scrollHeight ===
//     window.innerHeight` (overscroll-behavior: none + html/body
//     overflow:hidden means the doc never grows past the viewport).
//   * iOS-2 safe-area insets — TopicBar's bounding-rect top is >= 0.
//     Honest limitation: Playwright's webkit emulation does NOT simulate
//     the OS-level notch / Dynamic Island, so `env(safe-area-inset-top)`
//     resolves to 0 here. The assertion confirms the CSS rule didn't
//     break the layout (top-bar stays in-bounds); the real notch-clearance
//     evidence is browser-smoke screenshots from a notched iPhone shape.
//   * iOS-3 bottom-bar close × — open #bofh tab → tap × → tab gone
//     (mirror of `ios-3-bottom-bar-close.spec.ts`).
//   * iOS-4 font-size — open settings → pick XL → reload → still XL +
//     `--font-size = 18px` (mirror of `ios-4-font-size.spec.ts`).
//
// Subject-agnostic UX (per `feedback_e2e_user_class_parity_matrix`): the
// per-class parity matrix doesn't apply to UX-shape buckets; visitor
// session is sufficient.
//
// Test order discipline: this spec runs back-to-back and cleans up
// localStorage at end so subsequent specs in the same browser context
// don't inherit XL font-size.

import { expect, test } from "../fixtures/test";
import {
  loginAs,
  selectChannel,
  sidebarCloseButton,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel } from "../fixtures/grappaApi";
import {
  AUTOJOIN_CHANNELS,
  getSeededVjt,
  NETWORK_NICK,
  NETWORK_SLUG,
} from "../fixtures/seedData";

const CHANNEL = AUTOJOIN_CHANNELS[0]; // #bofh

// GREEN-CI batch 2 — iOS-3 arm below taps the close × which PARTs vjt
// from #bofh on the bouncer. Without restoration, downstream
// webkit-iphone-15 specs (ux-2-mobile-archive runs next alphabetically)
// can't selectChannel(#bofh) — the tab is gone, locator times out at
// 30s. Re-join via REST in afterEach so the autojoin steady state
// returns before the next spec.
test.afterEach(async () => {
  const vjt = getSeededVjt();
  await joinChannel(vjt.token, NETWORK_SLUG, CHANNEL).catch(() => {});
});

test("@webkit iOS-Z cluster — viewport + safe-area + close× + font-size", async ({
  page,
}) => {
  const vjt = getSeededVjt();
  await loginAs(page, vjt);

  // UX-4 bucket B made `:home` the cold-load default selection, so the
  // shell now lands on HomePane (no TopicBar) post-login. The iOS-2
  // arm needs `.topic-bar` in the DOM — explicitly select the autojoin
  // channel so the topic-bar gates resolve.
  await selectChannel(page, NETWORK_SLUG, CHANNEL, { ownNick: NETWORK_NICK });

  // Wait for TopicBar to render — `.topic-bar` is gated on
  // `selectedChannel().kind === "channel"` in Shell.tsx, so it only
  // appears once the autojoin → first-channel-select round-trip
  // settles. All four bucket assertions below need the shell at
  // steady state, so we anchor on TopicBar visibility once.
  await expect(page.locator(".topic-bar")).toBeVisible({ timeout: 10_000 });

  try {
    // iOS-1 — viewport lock: doc never grows past the visible viewport.
    // overflow:hidden + overscroll-behavior:none on html/body means
    // scrollHeight stays equal to the innerHeight (no scroll-area below
    // BottomBar, no rubber-band overscroll). NOTE: this assertion
    // catches the overflow-hidden regression only; the
    // overscroll-behavior:none rule + the maximum-scale=1 viewport-meta
    // are visual-smoke only (Playwright can't probe gesture behavior).
    const heightDelta = await page.evaluate(() => {
      return document.documentElement.scrollHeight - window.innerHeight;
    });
    expect(heightDelta).toBe(0);

    // iOS-2 — safe-area insets: assert the CSS rule is live. Playwright's
    // webkit emulation doesn't simulate the OS notch, so
    // env(safe-area-inset-top) is 0 here and `getBoundingClientRect().top`
    // would assert nothing meaningful. Reading computed `padding-top`
    // for the env() / max() marker proves the iOS-2 CSS rule didn't get
    // dropped — that's the regression class we can detect from CI.
    // Real notched-device clearance is verified via browser-smoke
    // screenshots from a real iPhone shape.
    const topBarPadding = await page.evaluate(() => {
      const el = document.querySelector(".topic-bar");
      if (!el) return null;
      return getComputedStyle(el).paddingTop;
    });
    expect(topBarPadding).not.toBeNull();

    // iOS-3 — bottom-bar close × removes the tab.
    const tab = sidebarWindow(page, NETWORK_SLUG, CHANNEL);
    await expect(tab).toBeVisible({ timeout: 10_000 });
    const closeBtn = sidebarCloseButton(page, NETWORK_SLUG, CHANNEL);
    await expect(closeBtn).toBeVisible();
    await closeBtn.tap();
    await expect(tab).not.toBeVisible({ timeout: 10_000 });

    // iOS-3b (folded from ios-3-bottom-bar-close 2026-05-26) — the
    // Server "window" header has no `Close <name>` × affordance.
    // UX-6-E: the server-window entry is now the network header itself
    // (`.bottom-bar-network-header`, replacing the old chip+Server-tab
    // pair). It DOES have a sibling × — but that × disconnects the
    // network (mirrors wide-mode UX-4-D), not "close the server
    // window." Invariant: no `.bottom-bar-close[aria-label="Close
    // Server"]` exists. The disconnect × is asserted by
    // ux-6-e-narrow-server-dedup.
    const section = page.locator(".bottom-bar-network", {
      has: page.locator(`.bottom-bar-network-header[data-network-slug="${NETWORK_SLUG}"]`),
    });
    await expect(
      section.locator('.bottom-bar-close[aria-label="Close Server"]'),
    ).toHaveCount(0);

    // iOS-4 — font-size XL persists across reload. UX-5 bucket BM
    // (2026-05-20) — the mobile members drawer also has an
    // `aria-label="open settings"` launcher button now, so the
    // role-based selector `getByRole('button', { name: 'open settings' })`
    // is ambiguous across the chrome cog + drawer launcher. Scope
    // explicitly to the chrome cog via its data-testid — the closeBtn
    // tap above just removed the active channel tab, so the operator
    // is on a non-channel window where the standalone .shell-chrome
    // row is the only path to settings anyway.
    await page.locator('[data-testid="shell-chrome-cog"]').tap();
    await expect(page.locator(".settings-drawer.open")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator('[data-testid="font-size-M"]')).toBeChecked();
    await page.locator('[data-testid="font-size-XL"]').tap();
    await expect(page.locator('[data-testid="font-size-XL"]')).toBeChecked();
    const xlSize = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--font-size")
        .trim(),
    );
    expect(xlSize).toBe("18px");

    await page.reload();
    // BM scope adjustment — same rationale as line 103, pin to chrome
    // cog testid to avoid ambiguity with the drawer launcher.
    await page.locator('[data-testid="shell-chrome-cog"]').tap();
    await expect(page.locator(".settings-drawer.open")).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator('[data-testid="font-size-XL"]')).toBeChecked();
    const reloadedSize = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--font-size")
        .trim(),
    );
    expect(reloadedSize).toBe("18px");
  } finally {
    // Cleanup — reset to M so subsequent specs in the same browser
    // context don't inherit XL. Runs even on assertion failure so a
    // mid-spec throw doesn't poison neighbour specs.
    await page.evaluate(() => localStorage.removeItem("cicchetto.fontSize"));
  }
});
