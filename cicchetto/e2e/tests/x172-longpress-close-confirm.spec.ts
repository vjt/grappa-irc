// #172 — hold-to-confirm window close (kill spurious taps).
//
// A bare tap on the close × used to close a window instantly, so a mobile
// fat-finger spuriously lost windows. The fix gates touch/pen closes behind a
// HELD press (src/lib/holdToClose.ts, HOLD_TO_CLOSE_MS = 500ms); a mouse click
// stays instant. This spec is the TIMING/WIRING guard — it drives synthetic
// touch pointer events at two durations and asserts the gate discriminates:
//   - QUICK press (< threshold)     → window still present (NOT closed)
//   - SUSTAINED press (> threshold) → window closed
// A mutually-validating pair: reverting the fix reds the "quick press ≠ close"
// half (a bare tap would close again). Real long-press FEEL (magnifier/
// haptics) is a DEVICE test (vjt), not reproducible in webkit emulation
// (feedback_playwright_webkit_not_ios_scroll).
//
// The gate keys off pointerType, not the device — so both the desktop
// (.sidebar-close) and mobile (.bottom-bar-close) surfaces are exercised with
// the same synthetic-touch helpers; sidebarCloseButton() is layout-aware.
//
// Deliberately closes a DEDICATED, non-autojoin channel (joined before login),
// NOT the shared seed channel #bofh — so this spec can never destabilise
// #bofh for the specs that run after it (workers:1, serial). afterEach PARTs
// the dedicated channel so it doesn't linger as autojoin.

import type { Page } from "@playwright/test";
import { expect, test } from "../fixtures/test";
import {
  holdClosePress,
  loginAs,
  quickTapClose,
  selectChannel,
  sidebarCloseButton,
  sidebarWindow,
} from "../fixtures/cicchettoPage";
import { joinChannel, partChannel } from "../fixtures/grappaApi";
import { getSeededVjt, NETWORK_NICK, NETWORK_SLUG } from "../fixtures/seedData";

// Distinct channel per surface so the two serial tests never share state.
const DESKTOP_CHANNEL = "#x172-hold-d";
const MOBILE_CHANNEL = "#x172-hold-w";

test.afterEach(async () => {
  const vjt = getSeededVjt();
  // Idempotent cleanup (partChannel tolerates 404) — drop both in case a test
  // failed before its own hold-close fired.
  await partChannel(vjt.token, NETWORK_SLUG, DESKTOP_CHANNEL);
  await partChannel(vjt.token, NETWORK_SLUG, MOBILE_CHANNEL);
});

async function quickThenHold(page: Page, channel: string) {
  const vjt = getSeededVjt();
  // Join the dedicated channel BEFORE login so loginAs's channelsBySlug fetch
  // already carries it.
  await joinChannel(vjt.token, NETWORK_SLUG, channel);
  await loginAs(page, vjt);
  await selectChannel(page, NETWORK_SLUG, channel, { ownNick: NETWORK_NICK });

  const tab = sidebarWindow(page, NETWORK_SLUG, channel);
  await expect(tab).toBeVisible({ timeout: 10_000 });
  const closeBtn = sidebarCloseButton(page, NETWORK_SLUG, channel);
  await expect(closeBtn).toBeVisible();

  // QUICK press — a fat-finger tap. The window must survive.
  await quickTapClose(closeBtn);
  await expect(tab).toBeVisible({ timeout: 3_000 });

  // SUSTAINED press — a deliberate hold. The window closes (channels_changed
  // broadcast drops it from the window list).
  await holdClosePress(closeBtn);
  await expect(sidebarWindow(page, NETWORK_SLUG, channel)).toHaveCount(0, { timeout: 10_000 });
}

test("#172 — quick press keeps the window; a sustained hold closes it (desktop)", async ({
  page,
}) => {
  // Two real hold delays (120ms + 800ms) + a join/select round-trip; on the
  // slow webkit-iphone target this legitimately approaches the default 30s
  // budget, so grant the 3× slow allowance rather than race the clock.
  test.slow();
  await quickThenHold(page, DESKTOP_CHANNEL);
});

test("@webkit #172 — quick press keeps the window; a sustained hold closes it (bottom bar)", async ({
  page,
}) => {
  test.slow();
  await quickThenHold(page, MOBILE_CHANNEL);
});
