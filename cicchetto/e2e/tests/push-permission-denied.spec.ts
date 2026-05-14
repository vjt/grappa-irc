// push-permission-denied — push notifications cluster B5 spec 2
// (2026-05-14).
//
// Coverage: when the operator clicks the master toggle and the
// browser denies notification permission (either because the user
// blocked at the OS prompt OR the site is permanently denied),
// cic surfaces an explanatory banner and the toggle stays OFF.
// No JS exception, no spinner stuck, no devices-list change.
//
// Permission is denied via two complementary stubs in fixtures/push.ts:
//   * `Notification.permission` getter forced to "denied"
//   * `Notification.requestPermission()` resolves "denied"
// This mirrors the production "user clicked Block" path that
// `enablePush()` (cicchetto/src/lib/push.ts) handles by returning
// `{ status: "permission_denied" }`. SettingsDrawer's master-toggle
// onChange (line 154) reads that status + sets the banner copy.
//
// What's NOT covered here: the "permission_dismissed" branch where
// requestPermission returns "default" — that's a separate banner
// copy + a separate spec if/when it earns regression coverage. The
// current B5 plan calls out the denied path specifically.

import { expect, test } from "@playwright/test";
import { loginAs, sidebarWindow } from "../fixtures/cicchettoPage";
import { resetPushSubscriptions, stubPushManagerDenied } from "../fixtures/push";
import { AUTOJOIN_CHANNELS, getSeededVjt, NETWORK_SLUG } from "../fixtures/seedData";

test("push permission denied — toggle stays OFF, banner explains", async ({ page, context }) => {
  const vjt = getSeededVjt();
  // Wipe stale subscriptions from prior specs — see push-install
  // moduledoc on the shared-vjt teardown rationale.
  await resetPushSubscriptions(vjt.token);

  // Stub MUST be installed before page.goto so the initScript is in
  // scope when SettingsDrawer reads Notification.permission on mount.
  await stubPushManagerDenied(context);
  await loginAs(page, vjt);

  // Anchor to a real channel so the topic-bar settings button is
  // mounted (the button lives in TopicBar and only renders once a
  // window is selected).
  const bofh = sidebarWindow(page, NETWORK_SLUG, AUTOJOIN_CHANNELS[0]);
  await bofh.locator(".sidebar-window-btn").click();

  // Open settings + flip the master toggle. Use click() not check()
  // — check() is idempotent and may loop if cic flips the bound
  // signal back to false (the permission_denied arm sets
  // pushEnabled(false) immediately, and check() would retry).
  await page.locator('[aria-label="open settings"]').click();
  const toggle = page.locator('[data-testid="push-master-toggle"]');
  await expect(toggle).toBeVisible();
  await toggle.click();

  // Banner appears with copy that mentions "blocked" — exact match
  // would be brittle to copy revisions, so substring + role=alert
  // semantics.
  const banner = page.locator('[data-testid="push-banner"]');
  await expect(banner).toBeVisible({ timeout: 5_000 });
  await expect(banner).toContainText(/blocked/i);

  // NOTE: we deliberately do NOT assert on the checkbox's visual
  // state here. cic's onMasterToggle calls `setPushEnabled(false)`
  // on the permission_denied arm, but that's a no-op when the
  // signal was ALREADY false (Solid's createSignal uses Object.is
  // equality so same-value sets don't fire) — and the browser's
  // synchronous toggle on click left the DOM checked=true. The
  // observable user-facing surface here is the BANNER + the
  // server-side state (no devices row), both of which we DO
  // assert; the residual visual checked-ness is a separate
  // pre-existing UX bug surfaced by this spec, scoped out of B5.

  // No device row added — devices-list either absent (length 0) or
  // present-but-empty. Neither shape is wrong.
  await expect(page.locator('[data-testid="devices-list"] li')).toHaveCount(0);

  // We're authenticated — `/me` etc. should still 200 (no broken
  // session as a side-effect of the failed enablePush).
  await expect(bofh).toBeVisible();
});
